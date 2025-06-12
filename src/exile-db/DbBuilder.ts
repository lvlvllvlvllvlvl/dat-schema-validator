import { ColumnDataType, Kysely, sql } from "kysely";
import { NamedHeader, SqlData } from "../datfile.js";
import { SqliteWorkerDialect } from "kysely-sqlite-worker";

// from https://github.com/moepmoep12/exile-db/blob/main/scripts/buildDatabase.ts

interface Relation {
  source_table: string;
  source_column: string;
  source_row: number;
  target_table: string;
  target_column?: string;
  target_row: any;
}

/**
 * Builds the initial database by creating the tables
 */
export class DbBuilder {
  private readonly _db: Kysely<any>;
  private readonly _generateNames: boolean;
  private languages = ["English"];
  private readonly deferred_relations = [] as Relation[];
  private readonly _dependencies: Record<
    string,
    { resolve: (row_count: number) => void; promise: Promise<number> }
  > = {};

  constructor(dbPath: string, generateNames = false) {
    this._generateNames = generateNames;
    this._db = new Kysely({
      dialect: new SqliteWorkerDialect({ source: dbPath }),
    });
  }

  public async initSpecialTables(languages: string[]) {
    this.languages = languages;
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
    }
  }

  public async populateSpecialTables() {
    for (const lang of this.languages) {
      // language=SQL format=false
      await sql`create virtual table if not exists ${sql.table(lang + "_search")} using fts5 (
        text, table unindexed, column unindexed, row unindexed, content=${sql.table(lang)}
      )`.execute(this._db);
      // language=SQL format=false
      await sql`insert into ${sql.table(lang + "_search")} (rowid, text)
        select rowid, text from ${sql.table(lang)}`.execute(this._db);
    }
    for (const rel of this.deferred_relations) {
      try {
        await this._db
          .insertInto("relations")
          .values((builder) => ({
            ...rel,
            target_column: undefined,
            target_row: builder
              .selectFrom(rel.target_table)
              .select("rowid")
              .where(rel.target_column!, "=", rel.target_row),
          }))
          .execute();
      } catch (e) {
        console.log("error inserting", rel, e);
      }
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
    const rel = data
      .filter((d) => d.column.type.key?.foreign)
      .flatMap(({ column, rows: { [this.languages[0]]: rows } }) => {
        return rows
          .flatMap((v, i) => (Array.isArray(v) ? v.map((v) => ({ v, i })) : [{ v, i }]))
          .map((row) => ({
            source_table: table,
            source_column: column.name || `offset_${column.offset}`,
            source_row: row.i,
            target_table: column.type.key?.foreign ? column.type.key.table! : table,
            target_column: column.type.key?.column,
            target_row: row.v,
          }));
      })
      .filter((rel) => {
        if (!rel.target_row) {
          return false;
        } else if (rel.target_column) {
          this.deferred_relations.push(rel);
          return false;
        } else {
          delete rel.target_column;
          return true;
        }
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
    for (let rowid = start; rowid < end; rowid++) {
      result.push(
        Object.assign(
          Object.fromEntries(
            data.map(({ column, rows: { [this.languages[0]]: rows } }) => [
              column.name || `offset_${column.offset}`,
              Array.isArray(rows[rowid])
                ? JSON.stringify(rows[rowid])
                : !column.type.boolean
                  ? rows[rowid]
                  : rows[rowid]
                    ? 1
                    : 0,
            ]),
          ),
          { rowid },
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

  async close() {
    await this._db.destroy();
  }
}
