import { parse as csvParse } from "csv-parse/sync";
import { SCHEMA_URL, SchemaEnumeration, SchemaFile, SchemaTable } from "pathofexile-dat-schema";
import { NamedHeader, importHeaders } from "./datfile.js";

import * as fs from "fs/promises";
import path from "path";
export interface Table extends SchemaTable {
  tags?: string[];
  added?: string;
}
export interface Enumeration extends SchemaEnumeration {
  added?: string;
}

function stringify(strings: string[]) {
  return '["' + strings.join('", "') + '"]';
}

export function tableGQL(table: Table, headers: NamedHeader[]) {
  let fields = headers
    .map((header, i) => {
      const col = table.columns?.[i];
      
      let type = "";
      if (col?.references?.table) {
        type = col.references.table;
      } else if (header.unknownArray) {
        type = "_";
      } else if (header.type.boolean) {
        type = "bool";
      } else if (header.type.string) {
        type = "string";
      } else if (header.type.integer?.size === 1) {
        type = header.type.integer.unsigned ? "u8" : "i8";
      } else if (header.type.integer?.size === 2) {
        type = header.type.integer.unsigned ? "u16" : "i16";
      } else if (header.type.integer?.size === 4) {
        type = header.type.integer.unsigned ? "u32" : "i32";
      } else if (header.type.integer?.size === 8) {
        type = header.type.integer.unsigned ? "u64" : "i64";
      } else if (header.type.decimal?.size === 4) {
        type = "f32";
      } else if (header.type.decimal?.size === 8) {
        type = "f64";
      } else if (header.type.key) {
        type = header.type.key.foreign ? header.type.key.name ?? "rid" : table.name;
      }

      const directives = [] as string[];
      if (col) {
        if (col.references && "column" in col.references) {
          directives.push(`ref(column: "${col.references.column}")`);
        }
        if (
          col.unique ||
          (header.unique && (col.name?.includes("Id") || col.name?.includes("ID")))
        ) {
          if (header.unique === false) {
            console.warn(
              table.name,
              "column",
              i,
              "-",
              col.name,
              "marked unique, but non-unique values were found"
            );
          } else {
            directives.push("unique");
          }
        }
        if (col.localized || header.localized) {
          directives.push("localized");
        }
        if (col?.file) {
          directives.push(`file(ext: "${col.file}")`);
        }
        if (col?.files) {
          directives.push(`files(ext: ${stringify(col.files)})`);
        }
      } else {
        if (header.unique) {
          directives.push("unique");
        }
        if (header.localized) {
          directives.push("localized");
        }
      }

      const directive = directives.length ? " @" + directives.join(" @") : "";
      const description = col?.description
        ? col.description.includes('"')
          ? `  """\n  ${col.description}\n  """\n`
          : `  "${col.description}"\n`
        : "";
      const comment = header.noData ? " # All rows empty" : "";
      if (!type) {
        throw `No type found for column ${i}, ${header.name}`;
      } else if (header.type.array) {
        return `${description}  ${header.name || "_"}: [${type}]${directive}${comment}`;
      } else {
        return `${description}  ${header.name || "_"}: ${type}${directive}${comment}`;
      }
    })
    .filter(Boolean)
    .join("\n");

  const comment = table.added
    ? `# Added ${table.added.slice(0, table.added.indexOf(".", 2))}\n`
    : "";
  const tableTags = table.tags?.length ? ` @tags(list: ${stringify(table.tags)})` : "";
  return `${comment}type ${table.name}${tableTags} {\n${fields}\n}\n`;
}

export function enumGQL({ name, indexing, enumerators }: Enumeration) {
  const values = enumerators?.length
    ? `\n  ${enumerators.map((v) => v || "_").join("\n  ")}\n`
    : " _ ";
  return `enum ${name} @indexing(first: ${indexing || 0}) {${values}}\n`;
}

export async function exportGQL(
  tables: Table[],
  enumerations: Enumeration[],
  getHeaders: (table: Table) => NamedHeader[],
  dest: string
) {
  const files = {} as any;
  const sources = csvParse(await fs.readFile("gqlsources.csv"));
  const sourceMap = {} as any;
  for (const [file, type, name] of sources) {
    files[file] = files[file] || [];
    sourceMap[name] = { file, type, name, index: files[file].length };
    files[file].push(undefined);
  }

  for (const table of tables) {
    if (table.name in sourceMap) delete table.added;
    const gql = tableGQL(table, getHeaders(table));
    const mapping = sourceMap[table.name];
    delete sourceMap[table.name];
    if (mapping) {
      files[mapping.file][mapping.index] = gql;
    } else {
      files["_Core.gql"].push(gql);
    }
  }
  for (const enumeration of enumerations) {
    const gql = enumGQL(enumeration);
    const mapping = sourceMap[enumeration.name];
    delete sourceMap[enumeration.name];
    if (mapping) {
      files[mapping.file][mapping.index] = gql;
    } else {
      files["_Core.gql"].push(gql);
    }
  }
  await Promise.all(
    Object.entries(files).map(([file, gql]) =>
      fs.writeFile(path.join(dest, file), (gql as string[]).filter((v) => v).join("\n"))
    )
  );
}

if (process.argv[1].includes("graphql.ts")) {
  console.log("Confirm that parsing the original schema replicates the original graphql");
  const { tables, enumerations }: SchemaFile = await fetch(SCHEMA_URL).then((r) => r.json());
  await exportGQL(tables, enumerations, importHeaders, "../dat-schema/dat-schema/");
}
