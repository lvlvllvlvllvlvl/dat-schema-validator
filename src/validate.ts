import * as csv from "csv-stringify";
import * as fs from "fs/promises";
import path from "path";
import { SchemaFile, SchemaTable } from "pathofexile-dat-schema";
import { decompressSliceInBundle, getFileInfo, readIndexBundle } from "pathofexile-dat/bundles.js";
import {
  DatFile,
  Header,
  analyzeDatFile,
  getHeaderLength,
  readColumn,
  readDatFile,
  setWasmExports,
  validateHeader,
} from "pathofexile-dat/dat.js";
import { changes } from './changes.js';

const BUNDLE_DIR = "Bundles2";

class FileLoader {
  private bundleCache = new Map<string, ArrayBuffer>();

  constructor(
    private bundleLoader: IBundleLoader,
    private index: {
      bundlesInfo: Uint8Array;
      filesInfo: Uint8Array;
    },
  ) { }

  static async create(bundleLoader: IBundleLoader) {
    console.log("Loading bundles index...");

    const indexBin = await bundleLoader.fetchFile("_.index.bin");
    const indexBundle = await decompressSliceInBundle(new Uint8Array(indexBin));
    const _index = readIndexBundle(indexBundle);

    return new FileLoader(bundleLoader, {
      bundlesInfo: _index.bundlesInfo,
      filesInfo: _index.filesInfo,
    });
  }

  private async fetchBundle(name: string) {
    let bundleBin = this.bundleCache.get(name);
    if (!bundleBin) {
      bundleBin = await this.bundleLoader.fetchFile(name);
      this.bundleCache.set(name, bundleBin);
    }
    return bundleBin;
  }

  async getFileContents(fullPath: string) {
    const location = getFileInfo(fullPath, this.index.bundlesInfo, this.index.filesInfo);
    const bundleBin = await this.fetchBundle(location.bundle);
    return await decompressSliceInBundle(new Uint8Array(bundleBin), location.offset, location.size);
  }

  clearBundleCache() {
    this.bundleCache.clear();
  }
}

interface IBundleLoader {
  fetchFile: (name: string) => Promise<ArrayBuffer>;
}

class CdnBundleLoader {
  private constructor(
    private cacheDir: string,
    private patchVer: string,
  ) { }

  static async create(cacheRoot: string, patchVer: string) {
    const cacheDir = path.join(cacheRoot, patchVer);
    try {
      await fs.access(cacheDir);
    } catch {
      console.log("Creating new bundle cache...");
      await fs.rm(cacheRoot, { recursive: true, force: true });
      await fs.mkdir(cacheDir, { recursive: true });
    }
    return new CdnBundleLoader(cacheDir, patchVer);
  }

  async fetchFile(name: string): Promise<ArrayBuffer> {
    const cachedFilePath = path.join(this.cacheDir, name.replace(/\//g, "@"));

    try {
      await fs.access(cachedFilePath);
      const bundleBin = await fs.readFile(cachedFilePath);
      return bundleBin;
    } catch { }

    console.log(`Loading from CDN: ${name} ...`);

    const webpath = `${this.patchVer}/${BUNDLE_DIR}/${name}`;
    const response = await fetch(`http://patchcdn.pathofexile.com/${webpath}`);
    if (!response.ok) {
      console.error(`Failed to fetch ${name} from CDN.`);
      process.exit(1);
    }
    const bundleBin = await response.arrayBuffer();
    await fs.writeFile(cachedFilePath, Buffer.from(bundleBin, 0, bundleBin.byteLength));
    return bundleBin;
  }
}

const TRANSLATIONS = [
  { name: "English", path: "data" },
  { name: "French", path: "data/french" },
  { name: "German", path: "data/german" },
  { name: "Japanese", path: "data/japanese" },
  { name: "Korean", path: "data/korean" },
  { name: "Portuguese", path: "data/portuguese" },
  { name: "Russian", path: "data/russian" },
  { name: "Spanish", path: "data/spanish" },
  { name: "Thai", path: "data/thai" },
  { name: "Traditional Chinese", path: "data/traditional chinese" },
];

const missing = [] as string[];
const errors = [] as string[];

console.log("Loading schema for dat files");
const version = await fetch(
  "https://raw.githubusercontent.com/poe-tool-dev/latest-patch-version/main/latest.txt",
).then((r) => r.text());
const schema: SchemaFile = await fetch(
  "https://github.com/poe-tool-dev/dat-schema/releases/download/latest/schema.min.json",
).then((r) => r.json());

await fs.writeFile("schema.json", JSON.stringify(schema, null, 2));

const loader = await FileLoader.create(
  await CdnBundleLoader.create(path.join(process.cwd(), "/.cache"), version),
);

const wasm = await fs.readFile("node_modules/pathofexile-dat/dist/analysis.wasm");
const { instance } = await WebAssembly.instantiate(wasm);
setWasmExports(instance.exports as any);

const getType = ({ type }: NamedHeader) =>
  Object.keys(type)
    .filter((key) => type[key])
    .map((key) => (key === "key" && !type.key?.foreign ? "self" : key))
    .join("/");

const includeTranslations = [TRANSLATIONS[0]];
for (const tr of includeTranslations) {
  await fs.rm(path.join(tr.path), { recursive: true, force: true });
  await fs.mkdir(path.join(tr.path), { recursive: true });
}
for (const tr of includeTranslations) {
  loader.clearBundleCache();
  for (const table of schema.tables.sort(({ name: a }, { name: b }) =>
    a.localeCompare(b, undefined, { sensitivity: "base" }),
  )) {
    try {
      console.log(`validating ${table.name}`);
      const buf = await loader.getFileContents(`${tr.path}/${table.name}.dat64`).catch((e) => {
        if ((e as Error).message === "never") {
          missing.push("missing file " + table.name + ".dat64");
        } else {
          console.error(e);
        }
      });
      if (!buf) continue;
      const datFile = readDatFile(".dat64", buf);
      const columnStats = await analyzeDatFile(datFile);
      let invalid = table.columns.length;
      const headers = importHeaders(table, datFile).filter((header, i) => {
        try {
          if (!validateHeader(header, columnStats)) {
            invalid = Math.min(invalid, i);
            const build = Object.keys(changes.builds).findLast(build => changes.builds[build].changed?.fixed_size?.[`Data/${table.name}.dat64`])
            const lastChanged = build ? ` Last changed in build ${build} (${changes.builds[build].game_version})` : ""
            errors.push(
              `${table.name}.dat64 column ${i + 1} ${header.name || "<unknown>"}: ${getType(
                header,
              )} not valid at offset ${header.offset}.${lastChanged}`,
            );
          } else {
            return table.columns[i].type !== "array";
          }
        } catch (e) {
          console.error("Validation error", header, e);
        }
      });

      //Remove all columns after first invalid column
      if (invalid < table.columns.length) {
        table.columns = table.columns.slice(0, invalid);
      }

      try {
        await fs.writeFile(
          path.join(process.cwd(), tr.path, `${table.name}.csv`),
          csv.stringify(exportAllRows(headers, datFile), {
            cast: {
              string: (v) => JSON.stringify(v).slice(1, -1),
            },
            quoted_empty: true,
            quoted_string: true,
          }),
        );
      } catch (e) {
        console.error(table.name, headers, e);
      }
    } catch (e) {
      console.error(table.name, e);
    }
  }
}

function exportAllRows(headers: NamedHeader[], datFile: DatFile) {
  const columns = headers.map((header) => ({
    name: header.name,
    data: readColumn(header, datFile),
  }));

  columns.unshift({
    name: "_index",
    data: Array(datFile.rowCount)
      .fill(undefined)
      .map((_, idx) => idx),
  });

  return Array(datFile.rowCount)
    .fill(undefined)
    .map((_, idx) => Object.fromEntries(columns.map((col) => [col.name, col.data[idx]])));
}

interface NamedHeader extends Header {
  name: string;
}

function importHeaders(sch: SchemaTable, datFile: DatFile): NamedHeader[] {
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
        boolean: column.type === "bool" ? {} : undefined,
        key:
          column.type === "row" || column.type === "foreignrow"
            ? {
              foreign: column.type === "foreignrow",
            }
            : undefined,
      },
    });
    offset += getHeaderLength(headers[headers.length - 1], datFile);
  }
  return headers;
}

await fs.writeFile("errors.txt", errors.join("\n"));
await fs.writeFile("missing.txt", missing.join("\n"));
await fs.writeFile("filtered-schema.json", JSON.stringify(schema, null, 2));
await fs.writeFile("version.txt", version);
