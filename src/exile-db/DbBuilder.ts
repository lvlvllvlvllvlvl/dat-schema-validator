import { ColumnDataType, Kysely, sql, SqliteDialect } from "kysely";
import Database from "better-sqlite3";
import { NamedHeader, SqlData } from "../datfile.js";

// from https://github.com/moepmoep12/exile-db/blob/main/scripts/buildDatabase.ts

/**
 * Builds the initial database by creating the tables
 */
export class DbBuilder {
  private readonly _db: Kysely<any>;
  private readonly _generateNames: boolean;
  private _lang = "English";
  private readonly _dependencies: Record<
    string,
    { resolve: (row_count: number) => void; promise: Promise<number> }
  > = {};

  constructor(dbPath: string, generateNames = false) {
    this._generateNames = generateNames;
    this._db = new Kysely({
      dialect: new SqliteDialect({
        database: new Database(dbPath),
      }),
    });
  }

  public async createSpecialTables(languages: string[]) {
    this._lang = languages[0];
    await this._db.schema
      .createTable("relations")
      .ifNotExists()
      .addColumn("source_table", "text")
      .addColumn("source_column", "text")
      .addColumn("source_row", "integer")
      .addColumn("target_table", "text")
      .addColumn("target_row", "integer")
      .execute();
    for (const lang of languages) {
      await this._db.schema
        .createTable(lang)
        .ifNotExists()
        .addColumn("text", "text")
        .addColumn("table", "text")
        .addColumn("column", "text")
        .addColumn("row", "integer")
        .execute();
      // language=SQL format=false
      await sql`create virtual table if not exists ${sql.table(lang + "_search")} using fts5(
        text, table unindexed, column unindexed, row unindexed, content=${sql.table(lang)}
      )`.execute(this._db);
      // language=SQL format=false
      await sql`create trigger if not exists ${sql.table(lang + "_trigger")}
        after insert
        on ${sql.table(lang)}
      begin
        insert into ${sql.table(lang + "_search")} (rowid, text)
        values (new.rowid, new.text);
      end`.execute(this._db);
    }
  }

  public async createTable(table: string, data: SqlData[]) {
    if (!this._generateNames) data = data.filter((d) => d.column.name);

    if (!data.length) {
      return;
    }

    let builder = this._db.schema.createTable(table).ifNotExists();

    for (const { column } of data) {
      const columnType = this._getDataType(column.type);
      if (!columnType) {
        throw new Error(
          `Failed to get datatype for column ${JSON.stringify(column)} in table ${table}`,
        );
      }

      builder = builder.addColumn(column.name || `offset_${column.offset}`, columnType, (col) =>
        column.unique ? col.unique() : col,
      );
    }

    await builder.execute();

    const text: Record<string, Record<string, any>[]> = {};
    for (const {
      column: { name, offset },
      rows,
    } of data.filter((d) => d.column.localized)) {
      const column = name || `offset_${offset}`;
      for (const [lang, values] of Object.entries(rows)) {
        const result = (text[lang] = text[lang] || []);
        values.forEach((value, row) => {
          for (const text of Array.isArray(value) ? value : [value]) {
            result.push({
              text,
              table,
              column,
              row,
            });
          }
        });
      }
    }
    const rel: Record<string, any>[] = data
      .filter((d) => d.column.type.key?.foreign)
      .flatMap(({ column, rows: { [this._lang]: rows } }) => {
        return rows
          .flatMap((v, i) => (Array.isArray(v) ? v.map((v) => ({ v, i })) : [{ v, i }]))
          .map((row) => ({
            source_table: table,
            source_column: column.name || `offset_${column.offset}`,
            source_row: row.i,
            target_table: column.type.key?.foreign ? column.type.key.table : table,
            target_row: row.v,
          }));
      });

    for (const [lang, values] of Object.entries(text)) {
      await this._insertBatched(lang, values);
    }
    if (rel.length) await this._insertBatched("relations", rel);

    const col_count = data.length;
    const row_count = Object.values(data[0].rows)[0].length;
    const batchSize = Math.floor(999 / col_count);
    for (let index = 0; index < row_count; index += batchSize) {
      const values = this._getValues(data, index, Math.min(index + batchSize, row_count));
      try {
        await this._db.insertInto(table).values(values).execute();
      } catch (e) {
        console.error(values, e);
      }
    }

    if (this._dependencies[table]) {
      this._dependencies[table].resolve(row_count);
    }
  }

  private async _insertBatched(table: string, data: Record<string, any>[]) {
    const col_count = Object.keys(data[0]).length;
    const row_count = data.length;
    const batchSize = Math.floor(999 / col_count);
    for (let index = 0; index < row_count; index += batchSize) {
      await this._db
        .insertInto(table)
        .values(data.slice(index, index + batchSize))
        .execute();
    }
  }

  private _getValues(data: SqlData[], start: number, end: number) {
    const result: Record<string, any>[] = [];
    for (let i = start; i < end; i++) {
      result.push(
        Object.fromEntries(
          data.map(({ column, rows: { [this._lang]: rows } }) => [
            column.name || `offset_${column.offset}`,
            Array.isArray(rows[i])
              ? JSON.stringify(rows[i])
              : !column.type.boolean
                ? rows[i]
                : rows[i]
                  ? 1
                  : 0,
          ]),
        ),
      );
    }
    return result;
  }

  /**
   * @returns Datatype to use in sqlite for the columns
   */
  private _getDataType(type: Readonly<NamedHeader["type"]>): ColumnDataType {
    if (type.array) return "json";
    if (type.interval) return "json";
    if (type.boolean) return "boolean";
    if (type.string) return "text";
    if (type.integer) return "integer";
    if (type.decimal) return "decimal";
    if (type.key) return "integer";
    throw new Error(`Unknown type ${JSON.stringify(type)}`);
  }
}
