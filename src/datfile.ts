import * as fs from "fs/promises";
import path from "path";
import { SchemaTable } from "pathofexile-dat-schema";
import {
  decompressSliceInBundle,
  getDirContent,
  getFileInfo,
  readIndexBundle,
} from "pathofexile-dat/bundles.js";
import { ColumnStats, DatFile, Header, getHeaderLength, readColumn } from "pathofexile-dat/dat.js";
import { PossibleHeaders, graphqlType, headerTypes, possibleColumnHeaders } from "./heuristic.js";

const BUNDLE_DIR = "Bundles2";
const sleep = (ms: number) =>
  new Promise((resolve) => (ms ? setTimeout(resolve, ms) : setImmediate(resolve)));

export class FileLoader {
  private bundleCache = new Map<string, ArrayBuffer>();

  constructor(
    private bundleLoader: IBundleLoader,
    private index: {
      bundlesInfo: Uint8Array;
      filesInfo: Uint8Array;
      pathReps: Uint8Array;
      dirsInfo: Uint8Array;
    }
  ) {}

  static async create(bundleLoader: IBundleLoader) {
    const indexBin = await bundleLoader.fetchFile("_.index.bin");
    const indexBundle = await decompressSliceInBundle(new Uint8Array(indexBin));
    const _index = readIndexBundle(indexBundle);
    const pathReps = await decompressSliceInBundle(_index.pathRepsBundle);

    return new FileLoader(bundleLoader, {
      bundlesInfo: _index.bundlesInfo,
      filesInfo: _index.filesInfo,
      pathReps: pathReps,
      dirsInfo: _index.dirsInfo,
    });
  }

  async getFileContents(fullPath: string) {
    const location = getFileInfo(fullPath, this.index.bundlesInfo, this.index.filesInfo);
    const bundleBin = await this.bundleLoader.fetchFile(location.bundle);
    return await decompressSliceInBundle(new Uint8Array(bundleBin), location.offset, location.size);
  }

  listFiles(dir: string) {
    return getDirContent(dir, this.index.pathReps, this.index.dirsInfo).files;
  }

  clearBundleCache() {
    this.bundleCache.clear();
  }
}

export interface IBundleLoader {
  fetchFile: (name: string) => Promise<ArrayBuffer>;
}

export class CdnBundleLoader {
  private constructor(private cacheDir: string, private patchVer: string) {}

  private filePromise: { [name: string]: Promise<any> | undefined } = {};

  static async create(cacheRoot: string, patchVer: string) {
    const cacheDir = path.join(cacheRoot, patchVer);
    try {
      await fs.access(cacheDir);
    } catch {
      await fs.mkdir(cacheDir, { recursive: true });
    }
    return new CdnBundleLoader(cacheDir, patchVer);
  }

  async fetchFile(name: string): Promise<ArrayBuffer> {
    // Ensure only one fetch is running at a time per file
    return (this.filePromise[name] = (this.filePromise[name] || Promise.resolve()).then(() =>
      this.doFetchFile(name)
    ));
  }

  async doFetchFile(name: string): Promise<ArrayBuffer> {
    const cachedFilePath = path.join(this.cacheDir, name.replace(/\//g, "@"));

    try {
      await fs.access(cachedFilePath);
      return await fs.readFile(cachedFilePath);
    } catch {}

    const webpath = `${this.patchVer}/${BUNDLE_DIR}/${name}`;
    let response: Response | null = null;
    for (let i = 0; i < 5; i++) {
      try {
        response = await fetch(`http://patchcdn.pathofexile.com/${webpath}`);
        if (response.ok) {
          break;
        }
        console.warn("error downloading", name, await response.text());
      } catch (e) {
        console.warn("error downloading", name, e);
      }

      await sleep(1000 * Math.pow(2, i));
    }
    if (!response?.ok) {
      console.error(`Failed to fetch ${name} from CDN.`);
      throw await response?.text();
    }
    const bundleBin = await response.arrayBuffer();
    await fs.writeFile(cachedFilePath, Buffer.from(bundleBin, 0, bundleBin.byteLength));

    return bundleBin;
  }
}

export function exportAllRows(
  headers: NamedHeader[],
  datFiles: { name: string; datFile: DatFile }[],
  name: string
) {
  const columns = headers.flatMap((header) => {
    const data = datFiles.map(({ name, datFile }) => ({ name, rows: readColumn(header, datFile) }));

    const seen = datFiles.map((d) => new Set());
    header.unique = header.unique || (data[0].rows.length > 1 && !header.type.array);
    data.find(({ rows }, i) => {
      rows.find((row, j) => {
        if (Array.isArray(row)) {
          if (row.find((cell, k) => cell !== data[0].rows[j]![k])) {
            header.localized = true;
          }
        } else {
          if (seen[i].has(row)) {
            header.unique = false;
          }
          if (row !== data[0].rows[j]) {
            header.localized = true;
          }
        }
        seen[i].add(row);

        // if there's nothing more to learn, return true, ending the find loops
        return header.localized && !header.unique;
      });
    });

    return header.localized
      ? data.map(({ name, rows }) => ({ name: `${header.name} (${name})`, header, data: rows }))
      : {
          name: header.name,
          header,
          data: data[0].rows,
        };
  });

  columns.unshift({
    name: "rownum",
    data: Array(datFiles[0].datFile.rowCount)
      .fill(undefined)
      .map((_, idx) => idx),
  } as any);

  return Array(datFiles[0].datFile.rowCount + 1)
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
  localized?: boolean;
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
  datFiles: DatFile[],
  stats: ColumnStats[][]
): PossibleHeaders;
export function importHeaders(
  sch: SchemaTable,
  datFiles?: DatFile[],
  stats?: ColumnStats[][]
): PossibleHeaders {
  const headers = [] as PossibleHeaders;

  let offset = 0;
  for (const column of sch.columns) {
    if (column.type === "array" && datFiles && stats) {
      headers.push(
        possibleColumnHeaders(
          offset,
          stats,
          datFiles,
          Object.values(headerTypes).filter((t) => t.array)
        )[0] || []
      );
    } else {
      headers.push({
        name: column.name || "",
        offset,
        unknownArray: column.type === "array",
        unique: column.unique,
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
    if (datFiles?.[0]) {
      const header = headers[headers.length - 1];
      if (Array.isArray(header)) {
        offset += header[0]?.size || 0;
      } else {
        const size = getHeaderLength(header, datFiles?.[0]);
        header.size = size;
        offset += size;
      }
    }
  }
  return headers;
}
