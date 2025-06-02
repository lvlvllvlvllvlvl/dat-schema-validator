import { MultiBar, Presets } from "cli-progress";
import { parse as csvParse } from "csv-parse/sync";
import * as csv from "csv-stringify";
import { rmSync } from "fs";
import * as fs from "fs/promises";
import path from "path";
import { SCHEMA_URL, SchemaFile } from "pathofexile-dat-schema";
import { analyzeDatFile, readDatFile, validateHeader } from "pathofexile-dat/dat.js";
import { argv, exit } from "process";
import { onExit } from "signal-exit";
import { ShapeChange } from "./changes.js";
import {
  CdnBundleLoader,
  exportAllRows,
  FileLoader,
  importHeaders,
  NamedHeader,
  sleep,
} from "./datfile.js";
import { Enumeration, exportGQL, Table } from "./graphql.js";
import { getPossibleHeaders, guessType, PossibleHeaders } from "./heuristic.js";
import { DbBuilder } from "./exile-db/DbBuilder.js";

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
] as const;

const R = { recursive: true };
const RF = { recursive: true, force: true };

const args = argv[1].includes("validate.ts") ? argv.slice(2) : null;
const tablesToProcess = args?.map((a) => a.toLowerCase());
const langsToProcess = tablesToProcess;
const quiet = Boolean(args?.find((v) => v === "-q" || v === "--quiet"));
const progressBars =
  args && !quiet
    ? new MultiBar(
        {
          format: "[{bar}] {percentage}% | {value}/{total} | {step} | {table}",
        },
        Presets.rect,
      )
    : null;
let lastFrame = performance.now();
const progress = {
  promises: [] as Promise<any>[],
  requests: progressBars?.create(9999, 0, {
    step: "loading files",
    table: "...",
  }),
  processing: progressBars?.create(999, 0, {
    step: "processing data",
    table: "...",
  }),
  output: progressBars?.create(99, 0, {
    step: "writing files",
    table: "...",
  }),
  push: (task: Promise<any>, table: string) => {
    progress.output?.setTotal(progress.promises.length + 1);
    progress.promises.push(task.then(() => progress.increment("output", { table })));
  },
  increment: (bar: string, ...args: any[]) => {
    progress[bar]?.increment(...args);
    if (progressBars && performance.now() - lastFrame > 200) {
      progressBars.update();
      lastFrame = performance.now();
    }
  },
};
if (args?.find((v) => v === "-h" || v === "--help")) {
  console.log(
    "Usage: npx tsx src/validate.ts [-2|--poe2] [-q|--quiet] [-s|--schema <schema.json>] [-t|--table <tables>] [-l|--lang <languages>] [-v|--version <version>] [--annotate]",
  );
  console.log("Known languages:", TRANSLATIONS.map((t) => t.name).join(", "));
  console.log(
    "If a version is specified, data will be read from inya.zao.se, otherwise the latest version from the poe cdn will be used",
  );
  exit();
}

const poe2 = args?.indexOf("-2")! >= 0 || args?.indexOf("--poe2")! >= 0;
const errors = [] as string[];
const tablesSeen = new Set<string>();
const tables = [] as Table[];
const enumerations = [] as Enumeration[];
const headerMap = {} as { [name: string]: NamedHeader[] };
const metafileDir = poe2 ? "meta2" : "meta";
const metafiles = Object.fromEntries(
  (await fs.readdir(metafileDir)).map((f) => [
    f.toLowerCase().replaceAll(".csv", ""),
    path.join(metafileDir, f),
  ]),
);

let version: string;
const versionArg = (args?.findIndex((s) => s === "-v" || s === "--version") ?? -1) + 1;
if (args && versionArg) {
  version = args[versionArg];
} else {
  const url = await fetch("https://ggpk.exposed/version?poe=" + (poe2 ? 2 : 1)).then((r) =>
    r.text(),
  );
  version = url
    .split("/")
    .filter((v) => v.match(/\d+(\.\d+)+/))
    .pop()!;
  if (!version) {
    console.log("cdn url:", url, "game version:", version);
    process.exit(1);
  }
  progress.push(fs.writeFile(`version${poe2 ? 2 : ""}.txt`, version), "version.txt");
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
      JSON.stringify(schema, null, 2),
    ),
    "schema.json",
  );
}

const loader = await FileLoader.create(
  await CdnBundleLoader.create(path.join(".cache"), version, !!versionArg),
);

const getType = ({ type }: NamedHeader) =>
  Object.keys(type)
    .filter((key) => type[key])
    .map((key) => (key === "key" && !type.key?.foreign ? "self" : key))
    .join("/");

const includeTranslations: readonly (typeof TRANSLATIONS)[number][] = args?.find(
  (v) => v === "-l" || v === "--lang" || v === "--langs",
)
  ? TRANSLATIONS.filter((t) => langsToProcess?.includes(t.name.toLowerCase()))
  : TRANSLATIONS;

await fs.mkdir("tmp", R);
const tmp = await fs.mkdtemp(path.join("tmp", "dat-validator-"));
onExit(() => {
  rmSync(tmp, RF);
});
const heuristics = path.join(tmp, "heuristics");
await fs.mkdir(`${heuristics}/csv`, R);
await fs.mkdir(`${heuristics}/schema/json`, R);
await fs.mkdir(`${heuristics}/schema/graphql`, R);

const validFor = poe2 ? (t: any) => t.validFor & 2 : (t: any) => t.validFor & 1;
const tableMap: { [name: string]: Table & Enumeration } = Object.assign(
  Object.fromEntries(
    schema.tables.filter(validFor).map((t) => [`data/${t.name}.datc64`.toLowerCase(), t]),
  ),
  Object.fromEntries(
    schema.enumerations?.filter(validFor)?.map((t) => [`data/${t.name}.datc64`.toLowerCase(), t]) ||
      [],
  ),
);
loader.clearBundleCache();
const allTables = !args?.find((v) => v === "-t" || v === "--table" || v === "--tables");
let files = loader
  .listFiles("Data")
  .filter(
    (f) =>
      f.endsWith(".datc64") &&
      (allTables || tablesToProcess?.includes(path.parse(f).name.toLowerCase())),
  )
  .sort();
progress.requests?.setTotal(files.length * includeTranslations.length);
progress.processing?.setTotal(files.length);

const dbPath = `poe${poe2 ? 2 : 1}.sqlite`;
await fs.rm(dbPath, { force: true });
const db = new DbBuilder(dbPath, true);
await db.createSpecialTables(includeTranslations.map((t) => t.name));

let concurrentLoads = 0;
await Promise.all(
  files.map(async (file) => {
    const fileComponents = path.parse(file);
    const table = tableMap[file.toLowerCase()] || { name: fileComponents.name, columns: [] };
    const data = (
      await Promise.all(
        includeTranslations.map(async (tr) => {
          while (concurrentLoads > 30) await sleep(100);
          const fileName = file.replace(/^data/, tr.path);
          concurrentLoads++;
          try {
            progress.increment("requests", { table: fileName });
            const buf = await loader.getFileContents(fileName);
            return { ...tr, buf };
          } catch (e) {
            if (
              tr.name === "English" ||
              ("columns" in table && table.columns?.find((c) => c.localized))
            ) {
              console.log("File not found: " + fileName, tr, e);
              errors.push("File not found: " + fileName);
            }
            return null!;
          } finally {
            concurrentLoads--;
          }
        }),
      )
    ).filter((v) => v);
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

      const datFiles = data.map((d) => readDatFile(".datc64", d.buf));
      const columnStats = datFiles.map(analyzeDatFile);
      if (
        !datFiles.every(
          (f) => f.rowLength === datFiles[0].rowLength || f.rowCount === datFiles[0].rowCount,
        )
      ) {
        console.warn("Not all data are equal");
      }
      if (!columnStats.every((f) => f.length === columnStats[0].length)) {
        console.warn("Not all stats are equal");
      }
      if (columnStats.length && columnStats[0].length !== datFiles[0].rowLength) {
        console.warn("Not stats data are equal");
      }
      table.columns = table.columns || [];

      if (datFiles[0].rowLength) {
        const headers = importHeaders(
          table,
          (...args) => errors.push(args.join(" ")),
          datFiles,
          columnStats,
        );
        let invalid = Math.min(table.columns.length, headers.length);
        headers.forEach((header, i) => {
          try {
            if (
              (Array.isArray(header) && !header.length) ||
              (!Array.isArray(header) &&
                !columnStats.every(
                  (s) =>
                    validateHeader(header, s) &&
                    (!header.interval ||
                      validateHeader({ ...header, offset: header.offset + header.size! }, s)),
                ))
            ) {
              invalid = Math.min(invalid, i);
              const changeVer = meta?.findLast((v) => v.version !== version)?.version;
              const change = changeVer ? ` Last changed in version ${changeVer}` : "";
              errors.push(
                Array.isArray(header)
                  ? `${table.name}.datc64 column ${i + 1} "<unknown>": array not valid.${change}`
                  : `${table.name}.datc64 column ${i + 1} ${header.name || "<unknown>"}: ${getType(
                      header,
                    )} not valid at offset ${header.offset}.${change}`,
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
            datFiles,
          )
        )[0];

        if (possible?.length) {
          const hdr = possible.map((p) => (Array.isArray(p) ? guessType(p, datFiles[0]) : p));
          const [csvData, sqlData] = exportAllRows(
            hdr,
            data.map(({ name }, i) => ({ name, datFile: datFiles[i] })),
            args?.includes("--validate"),
          );
          progress.push(
            fs.writeFile(
              path.join(`${heuristics}/csv`, `${table.name}.csv`),
              csv.stringify(csvData, {
                cast: {
                  string: (v) => JSON.stringify(v).slice(1, -1),
                },
                quoted_empty: true,
                quoted_string: true,
              }),
            ),
            `${table.name}.csv`,
          );
          progress.push(db.createTable(table.name, sqlData), `${table.name}.json`);
          progress.push(
            fs.writeFile(
              path.join(`${heuristics}/schema/json`, `${table.name}.json`),
              JSON.stringify(hdr, undefined, 2),
            ),
            `${table.name}.json`,
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
      const latest = meta.length === 0 ? null : meta[meta.length - 1];
      const metaName = path.join(metafileDir, table.name + ".csv");
      if (
        !args?.includes("--historical") &&
        Object.keys(shape).find(
          (k) => k !== "version" && k !== "var_offset" && String(shape[k]) !== String(latest?.[k]),
        )
      ) {
        meta.push(shape);
        if (csvFile && csvName !== metaName) {
          progress.push(fs.rm(csvName), `delete ${csvName}`);
        }
        progress.push(fs.writeFile(metaName, csv.stringify(meta, { header: true })), metaName);
      }
    } catch (e) {
      console.error(file, e);
    } finally {
      progress.increment("processing", { table: table.name });
    }
  }),
);
progressBars?.stop();

progress.push(
  exportGQL(
    tables.sort((a, b) => a.name.localeCompare(b.name)),
    enumerations.sort((a, b) => a.name.localeCompare(b.name)),
    (table) => headerMap[table.name],
    `${heuristics}/schema/graphql`,
    (...args) => errors.push(args.join(" ")),
  ),
  "graphql",
);
errors.length &&
  progress.push(
    fs.writeFile(path.join(schemaDir, schemaPrefix + "errors.txt"), errors.sort().join("\n")),
    "errors.txt",
  );
const missing = schema.tables
  .filter(validFor)
  .map((t) => t.name)
  .filter((t) => !tablesSeen.has(t))
  .map((t) => `missing file ${t}.datc64`)
  .sort();
missing.length &&
  progress.push(
    fs.writeFile(path.join(schemaDir, schemaPrefix + "missing.txt"), missing.sort().join("\n")),
    "missing.txt",
  );
schema.tables = schema.tables.filter((t) => !(missing.includes(t.name) && validFor(t)));
progress.push(
  fs.writeFile(
    path.join(schemaDir, schemaPrefix + "filtered.json"),
    JSON.stringify(schema, null, 2),
  ),
  "filtered.json",
);
await Promise.all(progress.promises);
progressBars?.update();

await fs.rm(path.join(schemaDir, "heuristics"), RF);
await fs.rename(heuristics, path.join(schemaDir, "heuristics"));

if (!args?.includes("--historical")) {
  const sequel = poe2 ? "poe2" : "poe";
  await fs.rm(sequel, RF);
  await fs.cp(schemaDir, sequel, R);
  await Promise.all(
    Object.values(metafiles).map(async (filename) => {
      const rows = csvParse(await fs.readFile(filename));
      if (rows[rows.length - 1].row_count) {
        rows.push({ version });
        await fs.writeFile(filename, csv.stringify(rows, { header: true }));
      }
    }),
  );
}

process.exit();
