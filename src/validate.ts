import { parse as csvParse } from "csv-parse/sync";
import * as csv from "csv-stringify";
import * as fs from "fs/promises";
import path from "path";
import { SchemaFile } from "pathofexile-dat-schema";
import {
  decompressSliceInBundle,
  getDirContent,
  getFileInfo,
  readIndexBundle,
} from "pathofexile-dat/bundles.js";
import {
  analyzeDatFile,
  readDatFile,
  setWasmExports,
  validateHeader,
} from "pathofexile-dat/dat.js";
import { ShapeChange } from "./changes.js";
import { NamedHeader, exportAllRows, importHeaders } from "./datfile.js";
import { getPossibleHeaders, guessType } from "./heuristic.js";

const BUNDLE_DIR = "Bundles2";
const promises = [] as Promise<any>[];

class FileLoader {
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
    console.log("Loading bundles index...");

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

  listFiles(dir: string) {
    return getDirContent("data", this.index.pathReps, this.index.dirsInfo).files;
  }

  clearBundleCache() {
    this.bundleCache.clear();
  }
}

interface IBundleLoader {
  fetchFile: (name: string) => Promise<ArrayBuffer>;
}

class CdnBundleLoader {
  private constructor(private cacheDir: string, private patchVer: string) {}

  private filePromise = Promise.resolve();

  static async create(cacheRoot: string, patchVer: string) {
    const cacheDir = path.join(cacheRoot, patchVer);
    try {
      await fs.access(cacheDir);
    } catch {
      console.log("Creating new bundle cache...");
      await fs.mkdir(cacheDir, { recursive: true });
    }
    return new CdnBundleLoader(cacheDir, patchVer);
  }

  async fetchFile(name: string): Promise<ArrayBuffer> {
    const cachedFilePath = path.join(this.cacheDir, name.replace(/\//g, "@"));

    //ensure previous file write has completed before reading
    await this.filePromise;

    try {
      await fs.access(cachedFilePath);
      const bundleBin = await fs.readFile(cachedFilePath);
      return bundleBin;
    } catch {}

    console.log(`Loading from CDN: ${name} ...`);

    const webpath = `${this.patchVer}/${BUNDLE_DIR}/${name}`;
    const response = await fetch(`http://patchcdn.pathofexile.com/${webpath}`);
    if (!response.ok) {
      console.error(`Failed to fetch ${name} from CDN.`);
      process.exit(1);
    }
    const bundleBin = await response.arrayBuffer();
    this.filePromise = fs.writeFile(
      cachedFilePath,
      Buffer.from(bundleBin, 0, bundleBin.byteLength)
    );
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

const errors = [] as string[];
const metas = new Set<string>();
const tablesSeen = new Set<string>();

console.log("Loading schema for dat files");
const version = await fetch(
  "https://raw.githubusercontent.com/poe-tool-dev/latest-patch-version/main/latest.txt"
).then((r) => r.text());
const schema: SchemaFile = await fetch(
  "https://github.com/poe-tool-dev/dat-schema/releases/download/latest/schema.min.json"
).then((r) => r.json());

promises.push(fs.writeFile("schema.json", JSON.stringify(schema, null, 2)));

const loader = await FileLoader.create(await CdnBundleLoader.create(path.join(".cache"), version));

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
  await fs.rm(tr.path, { recursive: true, force: true });
  await fs.rm("heuristics", { recursive: true, force: true });
  await fs.mkdir(tr.path, { recursive: true });
  await fs.mkdir(path.join("heuristics/csv", tr.path.replace("data", ".")), { recursive: true });
  await fs.mkdir("heuristics/schema/json", { recursive: true });
  await fs.mkdir("heuristics/schema/graphql", { recursive: true });
}
for (const tr of includeTranslations) {
  const tableMap = Object.fromEntries(
    schema.tables.map((t) => [`${tr.path}/${t.name}.dat64`.toLowerCase(), t])
  );
  loader.clearBundleCache();
  for (const file of loader.listFiles(tr.path).sort()) {
    try {
      const fileComponents = path.parse(file);
      if (fileComponents.ext !== ".dat64") continue;
      const table = tableMap[file.toLowerCase()] || { name: fileComponents.name, columns: [] };
      const buf = await loader.getFileContents(file).catch((e) => {
        console.error(e);
      });
      if (!buf) continue;
      tablesSeen.add(table.name);
      console.log("validating", table.name);
      const datFile = readDatFile(".dat64", buf);
      const columnStats = await analyzeDatFile(datFile);
      if (columnStats.length !== datFile.rowLength) {
        console.log(table.name, columnStats.length, datFile.rowLength);
      }
      let csvName = table.name + ".csv";
      const csvFile = await fs
        .readFile(path.join("meta", csvName))
        .catch(() => {
          csvName = path.join("meta", table.name.toLowerCase() + ".csv");
          console.warn("trying", csvName);
          return fs.readFile(csvName);
        })
        .catch(() => null);
      const meta: ShapeChange[] = csvFile ? csvParse(csvFile, { columns: true }) : [];

      let invalid = table.columns.length;
      const headers = importHeaders(table, datFile).filter((header, i) => {
        try {
          if (!validateHeader(header, columnStats)) {
            invalid = Math.min(invalid, i);
            const changeVer = meta?.findLast((v) => v.version !== version)?.version;
            const change = changeVer ? ` Last changed in version ${changeVer}` : "";
            errors.push(
              `${table.name}.dat64 column ${i + 1} ${header.name || "<unknown>"}: ${getType(
                header
              )} not valid at offset ${header.offset}.${change}`
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

      const possible = (
        await getPossibleHeaders(headers.slice(0, invalid), columnStats, datFile, datFile.rowLength)
      )[0];

      if (!possible) {
        console.log("Could not guess schema", table.name);
      } else if (possible.length) {
        const hdr = possible.map((p) => (Array.isArray(p) ? guessType(p, datFile) : p));
        promises.push(
          fs.writeFile(
            path.join("heuristics/schema/json", `${table.name}.json`),
            JSON.stringify(hdr, undefined, 2)
          )
        );
        promises.push(
          fs.writeFile(
            path.join("heuristics/csv", tr.path.replace("data", "."), `${table.name}.csv`),
            csv.stringify(exportAllRows(hdr, datFile), {
              cast: {
                string: (v) => JSON.stringify(v).slice(1, -1),
              },
              quoted_empty: true,
              quoted_string: true,
            })
          )
        );
      }

      const shape: ShapeChange = {
        version,
        row_count: datFile.rowCount,
        row_width: datFile.rowLength,
        fixed_size: datFile.dataFixed.length,
        var_offset: datFile.dataFixed.length + datFile.memsize / 2,
        var_size: datFile.dataVariable.length,
      };
      var latest = meta.length === 0 ? null : meta[meta.length - 1];
      const metaName = table.name + ".csv";
      metas.add(metaName);
      if (
        Object.keys(shape).find(
          (k) => k !== "version" && k !== "var_offset" && String(shape[k]) !== String(latest?.[k])
        )
      ) {
        meta.push(shape);
        if (csvFile && csvName !== metaName) {
          promises.push(fs.rm(csvName));
        }
        promises.push(
          fs.writeFile(path.join("meta", metaName), csv.stringify(meta, { header: true }))
        );
      }

      promises.push(
        fs.writeFile(
          path.join(tr.path, `${table.name}.csv`),
          csv.stringify(exportAllRows(headers, datFile), {
            cast: {
              string: (v) => JSON.stringify(v).slice(1, -1),
            },
            quoted_empty: true,
            quoted_string: true,
          })
        )
      );
    } catch (e) {
      console.error(file, e);
    }
  }
}

promises.push(fs.writeFile("errors.txt", errors.join("\n")));
promises.push(
  fs.writeFile(
    "missing.txt",
    schema.tables
      .map((t) => t.name)
      .filter((t) => !tablesSeen.has(t))
      .map((t) => `missing file ${t}.dat64`)
      .sort()
      .join("\n")
  )
);
promises.push(fs.writeFile("filtered-schema.json", JSON.stringify(schema, null, 2)));
promises.push(fs.writeFile("version.txt", version));
await promises;

const metafiles = await fs.readdir("meta");
await Promise.all(
  metafiles
    .filter((csv) => !metas.has(csv))
    .map(async (csv) => {
      const rows = csvParse(await fs.readFile(path.join("meta", csv)));
      if (rows[rows.length - 1].row_count) {
        rows.push({ version });
        await fs.writeFile(path.join("meta", csv), rows.stringify(rows, { header: true }));
      }
    })
);
