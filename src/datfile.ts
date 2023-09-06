import { SchemaTable } from "pathofexile-dat-schema";
import { DatFile, Header, getHeaderLength, readColumn } from "pathofexile-dat/dat.js";
import { graphqlType } from "./heuristic.js";

export function exportAllRows(headers: NamedHeader[], datFile: DatFile) {
  const columns = headers.map((header) => ({
    name: header.name,
    header,
    data: readColumn(header, datFile),
  }));

  columns.unshift({
    name: "rownum",
    data: Array(datFile.rowCount)
      .fill(undefined)
      .map((_, idx) => idx),
  } as any);

  return Array(datFile.rowCount + 1)
    .fill(undefined)
    .map((_, idx) =>
      columns.map((col) =>
        idx === 0 ? (col.name ? col.name : graphqlType(col.header)) : col.data[idx - 1]
      )
    );
}

export interface NamedHeader extends Header {
  name?: string;
  type: Header["type"] & {
    key?: {
      name?: string;
    };
  };
}

export function importHeaders(sch: SchemaTable, datFile: DatFile): NamedHeader[] {
  const headers = [] as NamedHeader[];

  let offset = 0;
  for (const column of sch.columns) {
    headers.push({
      name: column.name || "",
      offset,
      type: {
        array: column.array,
        integer:
          // column.type === 'u8' ? { unsigned: true, size: 1 }
          // : column.type === 'u16' ? { unsigned: true, size: 2 }
          // : column.type === 'u32' ? { unsigned: true, size: 4 }
          // : column.type === 'u64' ? { unsigned: true, size: 8 }
          // : column.type === 'i8' ? { unsigned: false, size: 1 }
          // : column.type === 'i16' ? { unsigned: false, size: 2 }
          column.type === "i32"
            ? { unsigned: false, size: 4 }
            : // : column.type === 'i64' ? { unsigned: false, size: 8 }
            column.type === "enumrow"
            ? { unsigned: false, size: 4 }
            : undefined,
        decimal:
          column.type === "f32"
            ? { size: 4 }
            : // : column.type === 'f64' ? { size: 8 }
              undefined,
        string: column.type === "string" ? {} : undefined,
        boolean: column.type === "bool" ? true : undefined,
        key:
          column.type === "row" || column.type === "foreignrow"
            ? {
                foreign: column.type === "foreignrow",
                name: column.references?.table,
              }
            : undefined,
      },
    });
    offset += getHeaderLength(headers[headers.length - 1], datFile);
  }
  return headers;
}
