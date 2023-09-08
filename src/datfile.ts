import { SchemaTable } from "pathofexile-dat-schema";
import { ColumnStats, DatFile, Header, getHeaderLength, readColumn } from "pathofexile-dat/dat.js";
import { PossibleHeaders, graphqlType, headerTypes, possibleColumnHeaders } from "./heuristic.js";

export function exportAllRows(headers: NamedHeader[], datFile: DatFile, name: string) {
  const columns = headers.map((header) => {
    const data = readColumn(header, datFile);
    if (data.length > 1 && !header.type.array) {
      const seen = new Set();
      header.unique = true;
      for (const d of data) {
        if (seen.has(d)) {
          header.unique = false;
          break;
        }
        seen.add(d);
      }
    }
    return {
      name: header.name,
      header,
      data,
    };
  });

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
        idx === 0
          ? col.name
            ? col.name
            : graphqlType(col.header)
          : col.header?.type?.decimal
          ? formatFloat(col.data[idx - 1])
          : col.data[idx - 1]
      )
    );
}

function formatFloat(float?: any) {
  if (Array.isArray(float)) {
    return float.map(formatFloat);
  } else if (isNaN(float)) {
    return float;
  } else {
    return parseFloat(float.toFixed(4));
  }
}

export interface NamedHeader extends Header {
  name?: string;
  unknownArray?: boolean;
  noData?: boolean;
  unique?: boolean;
  size?: number;
  type: Header["type"] & {
    key?: {
      name?: string;
    };
  };
}

export function importHeaders(sch: SchemaTable): NamedHeader[];
export function importHeaders(
  sch: SchemaTable,
  datFile: DatFile,
  stats: ColumnStats[]
): PossibleHeaders;
export function importHeaders(
  sch: SchemaTable,
  datFile?: DatFile,
  stats?: ColumnStats[]
): PossibleHeaders {
  const headers = [] as PossibleHeaders;

  let offset = 0;
  for (const column of sch.columns) {
    if (column.type === "array" && datFile && stats) {
      headers.push(
        possibleColumnHeaders(
          offset,
          stats,
          datFile,
          Object.values(headerTypes).filter((t) => t.array)
        )[0] || []
      );
    } else {
      headers.push({
        name: column.name || "",
        offset,
        unknownArray: column.type === "array",
        type:
          column.type === "array"
            ? headerTypes["[i32]"]
            : {
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
    }
    if (datFile) {
      const header = headers[headers.length - 1];
      if (Array.isArray(header)) {
        offset += header[0]?.size || 0;
      } else {
        const size = getHeaderLength(header, datFile);
        header.size = size;
        offset += size;
      }
    }
  }
  return headers;
}
