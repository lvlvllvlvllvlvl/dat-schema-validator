import { MultiBar, Presets, SingleBar } from "cli-progress";
import { parse as csvParse } from "csv-parse/sync";
import * as csv from "csv-stringify";
import { rmSync } from "fs";
import * as fs from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { SCHEMA_URL, SchemaFile } from "pathofexile-dat-schema";
import {
  analyzeDatFile,
  readDatFile,
  setWasmExports,
  validateHeader,
} from "pathofexile-dat/dat.js";
import { argv, exit } from "process";
import { onExit } from "signal-exit";
import { ShapeChange } from "./changes.js";
import {
  CdnBundleLoader,
  FileLoader,
  NamedHeader,
  exportAllRows,
  importHeaders,
  sleep,
} from "./datfile.js";
import { Enumeration, Table, exportGQL } from "./graphql.js";
import { PossibleHeaders, getPossibleHeaders, guessType } from "./heuristic.js";

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

const R = { recursive: true };
const RF = { recursive: true, force: true };

const args = argv[1].includes("validate.ts") ? argv.slice(2) : null;
const tablesToProcess = args?.map((a) => a.toLowerCase());
const langsToProcess = tablesToProcess;
const progressBars =
  args && !args.find((v) => v === "-q" || v === "--quiet")
    ? new MultiBar(
        {
          format: "[{bar}] {percentage}% | {value}/{total} | {step} | {table}",
        },
        Presets.rect
      )
    : null;
let lastFrame = performance.now();
const progress: {
  promises: Promise<any>[];
  requests?: SingleBar;
  processing?: SingleBar;
  output?: SingleBar;
  push: (task: Promise<any>, table?: string) => void;
  increment: (bar: "requests" | "processing" | "output", ...args) => void;
} = {
  promises: [],
  push: (task, table = "") => {
    if (progressBars && !progress.output) {
      progress.output = progressBars.create(progress.promises.length + 1, 0, {
        step: "writing files",
        table: "...",
      });
    } else {
      progress.output?.setTotal(progress.promises.length + 1);
    }
    progress.promises.push(task.then(() => progress.increment("output", { table })));
  },
  increment: (bar, ...args) => {
    progress[bar]?.increment(...args);
    if (progressBars && performance.now() - lastFrame > 200) {
      progressBars.update();
      lastFrame = performance.now();
    }
  },
};
if (args?.find((v) => v === "-h" || v === "--help")) {
  console.log(
    "Usage: npx tsx src/validate.ts [-q|--quiet] [-s|--schema <schema.json>] [-t|--table <tables>] [-l|--lang <languages>] [-v|--version <version>]"
  );
  console.log("Known languages:", TRANSLATIONS.map((t) => t.name).join(", "));
  console.log(
    "If a version is specified, data will be read from inya.zao.se, otherwise the latest version from the poe cdn will be used"
  );
  exit();
}

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

let version: string;
const versionArg = (args?.findIndex((s) => s === "-v" || s === "--version") ?? -1) + 1;
if (args && versionArg) {
  version = args[versionArg];
} else {
  version = await fetch(
    "https://raw.githubusercontent.com/poe-tool-dev/latest-patch-version/main/latest.txt"
  ).then((r) => r.text());
}

let schema: SchemaFile;
let schemaDir = path.join("history", version);
let schemaPrefix = "";
const schemaArg = (args?.findIndex((s) => s === "-s" || s === "--schema") ?? -1) + 1;
if (args && schemaArg) {
  if (args[schemaArg].startsWith("http://") || args[schemaArg].startsWith("https://")) {
    schema = await fetch(args[schemaArg]).then((r) => r.json());
  } else {
    schemaDir = path.parse(args[schemaArg]).dir;
    schemaPrefix = path.parse(args[schemaArg]).name.replace("schema", "");
    schema = JSON.parse(await fs.readFile(args[schemaArg], "utf8"));
  }
} else {
  schema = await fetch(SCHEMA_URL).then((r) => r.json());
  await fs.mkdir(schemaDir, R);
  progress.push(
    fs.writeFile(
      path.join(schemaDir, schemaPrefix + "schema.json"),
      JSON.stringify(schema, null, 2)
    )
  );
}

const loader = await FileLoader.create(
  await CdnBundleLoader.create(path.join(".cache"), version, !!versionArg)
);
const wasm = await fs.readFile("node_modules/pathofexile-dat/dist/analysis.wasm");
const { instance } = await WebAssembly.instantiate(wasm);
setWasmExports(instance.exports as any);

const getType = ({ type }: NamedHeader) =>
  Object.keys(type)
    .filter((key) => type[key])
    .map((key) => (key === "key" && !type.key?.foreign ? "self" : key))
    .join("/");

let includeTranslations = args?.find((v) => v === "-l" || v === "--lang" || v === "--langs")
  ? TRANSLATIONS.filter((t) => langsToProcess?.includes(t.name.toLowerCase()))
  : TRANSLATIONS;

const tmp = await fs.mkdtemp(path.join(tmpdir(), "dat-validator-"));
onExit(() => {
  rmSync(tmp, RF);
});
const heuristics = path.join(tmp, "heuristics");
await fs.mkdir(`${heuristics}/csv`, R);
await fs.mkdir(`${heuristics}/schema/json`, R);
await fs.mkdir(`${heuristics}/schema/graphql`, R);

const tableMap: { [name: string]: Table & Enumeration } = Object.assign(
  Object.fromEntries(schema.tables.map((t) => [`data/${t.name}.dat64`.toLowerCase(), t])),
  Object.fromEntries(
    schema.enumerations?.map((t) => [`data/${t.name}.dat64`.toLowerCase(), t]) || []
  )
);
loader.clearBundleCache();
const allTables = !args?.find((v) => v === "-t" || v === "--table" || v === "--tables");
const files = loader
  .listFiles("Data")
  .filter(
    (f) =>
      f.endsWith(".dat64") &&
      (allTables || tablesToProcess?.includes(path.parse(f).name.toLowerCase()))
  )
  .sort();
progress.requests = progressBars?.create(files.length * includeTranslations.length, 0, {
  step: "loading files",
  table: "...",
});
progress.processing = progressBars?.create(files.length, 0, {
  step: "processing data",
  table: "...",
});

let concurrentLoads = 0;
await Promise.all(
  files.map(async (file) => {
    const fileComponents = path.parse(file);
    const table = tableMap[file.toLowerCase()] || { name: fileComponents.name, columns: [] };
    const data = await Promise.all(
      includeTranslations.map(async (tr) => {
        while (concurrentLoads > 30) await sleep(100);
        concurrentLoads++;
        progress.increment("requests", { table: file.replace(/^data/, tr.path) });
        const buf = await loader.getFileContents(file.replace(/^data/, tr.path));
        concurrentLoads--;
        return { ...tr, buf };
      })
    );
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
        console.warn("Not all data are equal");
      }
      if (!columnStats.every((f) => f.length === columnStats[0].length)) {
        console.warn("Not all stats are equal");
      }
      if (columnStats[0].length !== datFiles[0].rowLength) {
        console.warn("Not stats data are equal");
      }
      table.columns = table.columns || [];

      if (datFiles[0].rowLength) {
        let invalid = table.columns.length;
        const headers = importHeaders(
          table,
          (...args) => errors.push(args.join(" ")),
          datFiles,
          columnStats
        );
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
          await getPossibleHeaders(
            headers.slice(0, invalid).reduce((arr, h) => {
              arr[Array.isArray(h) ? h[0].offset : h.offset] = h;
              return arr;
            }, [] as PossibleHeaders),
            columnStats,
            datFiles
          )
        )[0];

        if (possible.length) {
          const hdr = possible.map((p) => (Array.isArray(p) ? guessType(p, datFiles[0]) : p));
          progress.push(
            fs.writeFile(
              path.join(`${heuristics}/csv`, `${table.name}.csv`),
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
          progress.push(
            fs.writeFile(
              path.join(`${heuristics}/schema/json`, `${table.name}.json`),
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
        !args?.includes("--historical") &&
        Object.keys(shape).find(
          (k) => k !== "version" && k !== "var_offset" && String(shape[k]) !== String(latest?.[k])
        )
      ) {
        meta.push(shape);
        if (csvFile && csvName !== metaName) {
          progress.push(fs.rm(csvName));
        }
        progress.push(fs.writeFile(metaName, csv.stringify(meta, { header: true })));
      }
    } catch (e) {
      console.error(file, e);
    } finally {
      progress.increment("processing", { table: table.name });
    }
  })
);
progressBars?.stop();

progress.push(
  exportGQL(
    tables.sort((a, b) => a.name.localeCompare(b.name)),
    enumerations.sort((a, b) => a.name.localeCompare(b.name)),
    (table) => headerMap[table.name],
    `${heuristics}/schema/graphql`,
    (...args) => errors.push(args.join(" "))
  )
);
errors.length &&
  progress.push(
    fs.writeFile(path.join(schemaDir, schemaPrefix + "errors.txt"), errors.sort().join("\n"))
  );
const missing = schema.tables
  .map((t) => t.name)
  .filter((t) => !tablesSeen.has(t))
  .map((t) => `missing file ${t}.dat64`)
  .sort();
missing.length &&
  progress.push(
    fs.writeFile(path.join(schemaDir, schemaPrefix + "missing.txt"), missing.sort().join("\n"))
  );
progress.push(
  fs.writeFile(
    path.join(schemaDir, schemaPrefix + "filtered.json"),
    JSON.stringify(schema, null, 2)
  )
);
progress.push(fs.writeFile(path.join(schemaDir, schemaPrefix + "version.txt"), version));
await Promise.all(progress.promises);
progressBars?.update();

await fs.rm(path.join(schemaDir, "heuristics"), RF);
await fs.rename(heuristics, path.join(schemaDir, "heuristics"));

if (!args?.includes("--historical")) {
  await fs.rm("heuristics", RF);
  await fs.symlink(path.join(schemaDir, "heuristics"), "heuristics");
  await Promise.all(
    Object.values(metafiles).map(async (filename) => {
      const rows = csvParse(await fs.readFile(filename));
      if (rows[rows.length - 1].row_count) {
        rows.push({ version });
        await fs.writeFile(filename, csv.stringify(rows, { header: true }));
      }
    })
  );
}

process.exit();
