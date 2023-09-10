import { Presets, SingleBar } from "cli-progress";
import { parse as csvParse } from "csv-parse/sync";
import * as csv from "csv-stringify";
import * as fs from "fs/promises";
import path from "path";
import { SCHEMA_URL, SchemaFile } from "pathofexile-dat-schema";
import {
  analyzeDatFile,
  readDatFile,
  setWasmExports,
  validateHeader,
} from "pathofexile-dat/dat.js";
import { argv, exit } from "process";
import { ShapeChange } from "./changes.js";
import {
  CdnBundleLoader,
  FileLoader,
  NamedHeader,
  exportAllRows,
  importHeaders,
} from "./datfile.js";
import { Enumeration, Table, exportGQL } from "./graphql.js";
import { getPossibleHeaders, guessType } from "./heuristic.js";

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

const args = argv[1].includes("validate.ts") ? argv.slice(2).map((v) => v.toLowerCase()) : null;
const progress =
  args && !args.find((v) => v === "-q" || v === "--quiet")
    ? new SingleBar(
        {
          format: "[{bar}] {percentage}% | {value}/{total} | {step} | {table}",
        },
        Presets.rect
      )
    : null;
if (args?.find((v) => v === "-h" || v === "--help")) {
  console.log(
    "Usage: npx tsx src/validate.ts [-q|--quiet] [-t|--table <tables>] [-l|--lang <languages>]"
  );
  console.log("Known languages:", TRANSLATIONS.map((t) => t.name).join(", "));
  exit();
}
const promises = [] as Promise<any>[];

const errors = [] as string[];
const tablesSeen = new Set<string>();
const tables = [] as Table[];
const enumerations = [] as Enumeration[];
const headerMap = {} as { [name: string]: NamedHeader[] };
const metafiles = Object.fromEntries(
  (await fs.readdir("meta")).map((f) => [
    f.toLowerCase().replaceAll(".csv", ""),
    path.join("meta", f),
  ])
);

const version = await fetch(
  "https://raw.githubusercontent.com/poe-tool-dev/latest-patch-version/main/latest.txt"
).then((r) => r.text());
const schema: SchemaFile = await fetch(SCHEMA_URL).then((r) => r.json());

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

let includeTranslations = args?.find((v) => v === "-l" || v === "--lang" || v === "--langs")
  ? TRANSLATIONS.filter((t) => args?.includes(t.name.toLowerCase()))
  : TRANSLATIONS;

await fs.rm("heuristics", { recursive: true, force: true });
await fs.mkdir("heuristics/csv", { recursive: true });
await fs.mkdir("heuristics/schema/json", { recursive: true });
await fs.mkdir("heuristics/schema/graphql", { recursive: true });

const tableMap: { [name: string]: Table & Enumeration } = Object.assign(
  Object.fromEntries(schema.tables.map((t) => [`data/${t.name}.dat64`.toLowerCase(), t])),
  Object.fromEntries(schema.enumerations.map((t) => [`data/${t.name}.dat64`.toLowerCase(), t]))
);
loader.clearBundleCache();
const allTables = !args?.find((v) => v === "-t" || v === "--table" || v === "--tables");
const files = loader
  .listFiles("data")
  .filter(
    (f) => f.endsWith(".dat64") && (allTables || args?.includes(path.parse(f).name.toLowerCase()))
  )
  .sort();
progress?.start(files.length * includeTranslations.length, 0, {
  step: "loading files",
  table: "...",
});
const dataFiles = await Promise.all(
  files.map(async (file) => {
    const fileComponents = path.parse(file);
    const table = tableMap[file.toLowerCase()] || { name: fileComponents.name, columns: [] };
    const data = await Promise.all(
      includeTranslations.map(async (tr) => ({
        ...tr,
        buf: await loader
          .getFileContents(file.replace(/^data/, tr.path))
          .then(progress?.increment({ table: file.replace(/^data/, tr.path) })),
      }))
    );
    return { file, table, data };
  })
);
progress?.stop();
progress?.start(files.length, 0, { step: "processing", table: "Initializing..." });
await Promise.all(
  dataFiles.map(async ({ file, table, data }) => {
    try {
      const csvName = metafiles[table.name.toLowerCase()];
      const csvFile = csvName && (await fs.readFile(csvName));
      delete metafiles[table.name.toLowerCase()];
      const meta: ShapeChange[] = csvFile ? csvParse(csvFile, { columns: true }) : [];
      table.added = meta?.[0]?.version;
      if (csvName && csvName !== csvName.toLowerCase() && table.name === table.name.toLowerCase()) {
        table.name = path.parse(csvName).name;
      }

      tablesSeen.add(table.name);

      const datFiles = data.map((d) => readDatFile(".dat64", d.buf));
      const columnStats = datFiles.map(analyzeDatFile);
      if (
        !datFiles.every(
          (f) => f.rowLength === datFiles[0].rowLength || f.rowCount === datFiles[0].rowCount
        )
      ) {
        console.warn("Not all data is equal");
      }

      if (datFiles[0].rowLength) {
        let invalid = table.columns.length;
        const headers = importHeaders(table, datFiles, columnStats);
        headers.forEach((header, i) => {
          try {
            if (
              (Array.isArray(header) && !header.length) ||
              (!Array.isArray(header) && !columnStats.every((s) => validateHeader(header, s)))
            ) {
              invalid = Math.min(invalid, i);
              const changeVer = meta?.findLast((v) => v.version !== version)?.version;
              const change = changeVer ? ` Last changed in version ${changeVer}` : "";
              errors.push(
                Array.isArray(header)
                  ? `${table.name}.dat64 column ${i + 1} "<unknown>": array not valid.${change}`
                  : `${table.name}.dat64 column ${i + 1} ${header.name || "<unknown>"}: ${getType(
                      header
                    )} not valid at offset ${header.offset}.${change}`
              );
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
          await getPossibleHeaders(headers.slice(0, invalid), columnStats, datFiles)
        )[0];

        if (possible.length) {
          const hdr = possible.map((p) => (Array.isArray(p) ? guessType(p, datFiles[0]) : p));
          promises.push(
            fs.writeFile(
              path.join("heuristics/csv", `${table.name}.csv`),
              csv.stringify(
                exportAllRows(
                  hdr,
                  data.map(({ name }, i) => ({ name, datFile: datFiles[i] })),
                  table.name
                ),
                {
                  cast: {
                    string: (v) => JSON.stringify(v).slice(1, -1),
                  },
                  quoted_empty: true,
                  quoted_string: true,
                }
              )
            )
          );
          promises.push(
            fs.writeFile(
              path.join("heuristics/schema/json", `${table.name}.json`),
              JSON.stringify(hdr, undefined, 2)
            )
          );
          headerMap[table.name] = hdr;
          tables.push(table);
        } else {
          enumerations.push(table);
        }
      } else {
        enumerations.push(table);
      }

      const datFile = datFiles[0];
      const shape: ShapeChange = {
        version,
        row_count: datFile.rowCount,
        row_width: datFile.rowLength,
        fixed_size: datFile.dataFixed.length,
        var_offset: datFile.dataFixed.length + datFile.memsize / 2,
        var_size: datFile.dataVariable.length,
      };
      var latest = meta.length === 0 ? null : meta[meta.length - 1];
      const metaName = path.join("meta", table.name + ".csv");
      if (
        Object.keys(shape).find(
          (k) => k !== "version" && k !== "var_offset" && String(shape[k]) !== String(latest?.[k])
        )
      ) {
        meta.push(shape);
        if (csvFile && csvName !== metaName) {
          promises.push(fs.rm(csvName));
        }
        promises.push(fs.writeFile(metaName, csv.stringify(meta, { header: true })));
      }
    } catch (e) {
      console.error(file, e);
    } finally {
      progress?.increment({ table: table.name });
    }
  })
);
progress?.stop();

promises.push(
  exportGQL(
    tables.sort((a, b) => a.name.localeCompare(b.name)),
    enumerations.sort((a, b) => a.name.localeCompare(b.name)),
    (table) => headerMap[table.name],
    "heuristics/schema/graphql"
  )
);
errors.length && promises.push(fs.writeFile("errors.txt", errors.sort().join("\n")));
const missing = schema.tables
  .map((t) => t.name)
  .filter((t) => !tablesSeen.has(t))
  .map((t) => `missing file ${t}.dat64`)
  .sort();
missing.length && promises.push(fs.writeFile("missing.txt", missing.sort().join("\n")));
promises.push(fs.writeFile("filtered-schema.json", JSON.stringify(schema, null, 2)));
promises.push(fs.writeFile("version.txt", version));
await promises;

await Promise.all(
  Object.values(metafiles).map(async (filename) => {
    const rows = csvParse(await fs.readFile(filename));
    if (rows[rows.length - 1].row_count) {
      rows.push({ version });
      await fs.writeFile(filename, csv.stringify(rows, { header: true }));
    }
  })
);
