import { ZstdDec } from "@oneidentity/zstd-js/decompress";
import * as fs from "fs/promises";
import path from "path";
import { SchemaTable } from "pathofexile-dat-schema";
import * as newBundles from "pathofexile-dat/bundles.js";
import { ColumnStats, DatFile, Header, getHeaderLength, readColumn } from "pathofexile-dat/dat.js";
import * as oldBundles from "pathofexile-dat7/bundles.js";
import { PossibleHeaders, graphqlType, headerTypes, possibleColumnHeaders } from "./heuristic.js";
import { isBefore } from "./versions.js";

const BUNDLE_DIR = "Bundles2";
export const sleep = (ms?: number) =>
  new Promise((resolve) => (ms ? setTimeout(resolve, ms) : setImmediate(resolve)));

interface ManifestLine {
  path: string;
  phash: string;
  sha256: string;
  size: number;
  comp: boolean;
}

const inyaBuilds = "https://inya.zao.se/poe-meta/builds/public";
const inyaManifest = (mfid: string) => `https://inya.zao.se/poe-index/${mfid}-loose.ndjson.zst`;
const inyaFile = (sha256: string, suffix: string) =>
  `https://inya.zao.se/poe-data/${sha256.slice(0, 2)}/${sha256}.bin${suffix}`;

async function retryFetch(url: string) {
  for (let i = 0; i < 5; i++) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return response;
      }
      console.warn("error downloading", url, await response.text());
    } catch (e) {
      console.warn("error downloading", url, e);
    }

    await sleep(1000 * Math.pow(2, i));
  }
  throw url;
}

export class FileLoader {
  private bundleCache = new Map<string, ArrayBuffer>();

  constructor(
    private bundleLoader: IBundleLoader,
    private bundles: typeof newBundles | typeof oldBundles,
    private newVerson: boolean,
    private index: {
      bundlesInfo: Uint8Array;
      filesInfo: Uint8Array;
      pathReps: Uint8Array;
      dirsInfo: Uint8Array;
    }
  ) {}

  static async create(bundleLoader: IBundleLoader) {
    const newVersion = isBefore("3.21.0", bundleLoader.patchVer);
    const bundles = newVersion ? newBundles : oldBundles;
    const indexBin = await bundleLoader.fetchFile("_.index.bin");
    const indexBundle = await bundles.decompressSliceInBundle(new Uint8Array(indexBin));
    const _index = bundles.readIndexBundle(indexBundle);
    const pathReps = await bundles.decompressSliceInBundle(_index.pathRepsBundle);

    return new FileLoader(bundleLoader, bundles, newVersion, {
      bundlesInfo: _index.bundlesInfo,
      filesInfo: _index.filesInfo,
      pathReps: pathReps,
      dirsInfo: _index.dirsInfo,
    });
  }

  async getFileContents(fullPath: string) {
    const location = this.bundles.getFileInfo(
      this.newVerson ? fullPath.toLowerCase() : fullPath,
      this.index.bundlesInfo,
      this.index.filesInfo
    );
    const bundleBin = await this.bundleLoader.fetchFile(location.bundle);
    return await this.bundles.decompressSliceInBundle(
      new Uint8Array(bundleBin),
      location.offset,
      location.size
    );
  }

  listFiles(dir: string) {
    return this.bundles.getDirContent(
      this.newVerson ? dir.toLowerCase() : dir,
      this.index.pathReps,
      this.index.dirsInfo
    ).files;
  }

  clearBundleCache() {
    this.bundleCache.clear();
  }
}

export interface IBundleLoader {
  fetchFile: (name: string) => Promise<ArrayBuffer>;
  patchVer: string;
}

export class CdnBundleLoader {
  private constructor(
    private cacheDir: string,
    public patchVer: string,
    private manifest?: Record<string, string>,
    private zstd?: ZstdDec
  ) {}

  private filePromise: { [name: string]: Promise<any> | undefined } = {};

  static async create(cacheRoot: string, patchVer: string, inya?: boolean) {
    const cacheDir = path.join(cacheRoot, patchVer);
    try {
      await fs.access(cacheDir);
    } catch {
      await fs.mkdir(cacheDir, { recursive: true });
    }
    let manifest: any = undefined;
    let zstd: any = undefined;
    if (inya) {
      zstd = import("@oneidentity/zstd-js/decompress").then(({ ZstdInit }) => ZstdInit());
      const build = await retryFetch(inyaBuilds)
        .then((r) => r.json())
        .then((builds) => Object.values(builds))
        .then((builds: any[]) => builds.find((build) => build.version.split(" ")[0] === patchVer));
      if (!build) {
        console.error("Version not found", patchVer);
        process.exit(1);
      }
      manifest = await Object.entries(build.manifests)
        .map(([k, v]) => `${k}/${v}`)
        .reduce(async (mf, mfid) => await this.getManifest(mfid, await zstd, mf), {});
    }
    return new CdnBundleLoader(cacheDir, patchVer, manifest, await zstd);
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

    const bundleBin = await (this.manifest ? this.fetchInya(name) : this.fetchCDN(name));

    await fs.writeFile(cachedFilePath, Buffer.from(bundleBin, 0, bundleBin.byteLength));

    return bundleBin;
  }

  static async getManifest(mfid: string, { ZstdStream }: ZstdDec, manifest) {
    const ndjson = await retryFetch(inyaManifest(mfid))
      .then((r) => r.arrayBuffer())
      .then((r) => Buffer.from(ZstdStream.decompress(new Uint8Array(r))).toString());

    ndjson
      .split("\n")
      .filter((l) => l)
      .map((l) => JSON.parse(l))
      .forEach((l: ManifestLine) => {
        const path = inyaFile(l.sha256, l.comp ? ".zst" : "");
        manifest[l.path] = path;
        manifest[l.phash] = path;
      });
    return manifest;
  }

  async fetchInya(name: string) {
    const url = this.manifest?.[`${BUNDLE_DIR}/${name}`];
    if (!url) {
      throw name + " not found in the manifest";
    }
    const response = await retryFetch(url);
    if (url.endsWith(".zst")) {
      return await response
        .arrayBuffer()
        .then((r) => this.zstd!.ZstdStream.decompress(new Uint8Array(r)).buffer);
    } else {
      return await response.arrayBuffer();
    }
  }

  async fetchCDN(name: string) {
    const webpath = `${this.patchVer}/${BUNDLE_DIR}/${name}`;
    const response = await retryFetch(`https://patch.poecdn.com/${webpath}`);
    return await response.arrayBuffer();
  }
}

export function exportAllRows(
  headers: NamedHeader[],
  datFiles: { name: string; datFile: DatFile }[],
  name: string,
  annotate = false
) {
  const columns = headers.flatMap((header) => {
    const data = datFiles.map(({ name, datFile }) => ({ name, rows: readColumn(header, datFile) }));

    const seen = datFiles.map((d) => new Set());
    if (annotate) {
      header.unique = header.unique || (data[0].rows.length > 1 && !header.type.array);
    }
    data.find(({ rows }, i) => {
      rows.find((row, j) => {
        if (Array.isArray(row)) {
          if (annotate && row.find((cell, k) => cell !== data[0].rows[j]![k])) {
            header.localized = true;
          }
        } else {
          if (seen[i].has(row)) {
            header.unique = false;
          }
          if (annotate && row !== data[0].rows[j]) {
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

const VALID_TYPES = ["bool", "string", "i32", "f32", "row", "foreignrow", "enumrow"];

export function importHeaders(sch: SchemaTable): NamedHeader[];
export function importHeaders(
  sch: SchemaTable,
  err: (...args) => void,
  datFiles: DatFile[],
  stats: ColumnStats[][]
): PossibleHeaders;
export function importHeaders(
  sch: SchemaTable,
  err: (...args) => void = console.warn,
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
      let type: NamedHeader["type"];
      if (!VALID_TYPES.includes(column.type)) {
        if (column.type === "array" || column.array) {
          type = headerTypes["[i32]"];
        } else {
          if (column.name) {
            err(sch.name, column.name, "unknown type", column.type);
          }
          const size = column.type.match(/\d+/);
          if (!size) {
            err("Can't guess size for column type", column.type);
          } else {
            offset += parseInt(size[0]) / 8;
          }
          break;
        }
      } else {
        type = {
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
        };
      }
      headers.push({
        name: column.name || "",
        offset,
        unknownArray: column.type === "array",
        unique: column.unique,
        type,
      });
    }
    if (datFiles?.[0]) {
      const header = headers[headers.length - 1];
      if (Array.isArray(header)) {
        offset += header[0]?.size || 0;
      } else {
        const size = getHeaderLength(header, datFiles[0]);
        header.size = size;
        offset += size;
      }
      if (offset >= datFiles[0].rowLength) {
        break;
      }
    }
  }
  return headers;
}
