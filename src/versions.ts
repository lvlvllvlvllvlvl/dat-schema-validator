import { parse as csvParse } from "csv-parse/sync";
import * as fs from "fs/promises";
import path from "path";
import { SchemaFile } from "pathofexile-dat-schema";
import { ShapeChange } from "./changes.js";

const metafiles = Promise.all(
  (await fs.readdir("meta")).map(
    async (name) =>
      [
        path.parse(name).name,
        await fs
          .readFile(path.join("meta", name))
          .then((file) => csvParse(file, { columns: true })),
      ] as [string, ShapeChange[]]
  )
);

const schemas = Promise.all(
  (await fs.readdir("history/dat-schema")).map(
    async (name) =>
      [
        name,
        await fs
          .readFile(path.join("history/dat-schema", name), "utf8")
          .then((file) => JSON.parse(file)),
      ] as [string, SchemaFile]
  )
);

function compareVersion<T = string>(invert?: boolean, fn: (t: T) => string = String) {
  return (a: T, b: T) => {
    if (!a && !b) {
      return 0;
    } else if (!a) {
      return 1;
    } else if (!b) {
      return -1;
    }
    const l = fn(invert ? b : a).split(".");
    const r = fn(invert ? a : b).split(".");
    for (let i = 0; i < Math.max(l.length, r.length); i++) {
      const lstr = l[i] ?? "0";
      const rstr = r[i] ?? "0";
      const lint = parseInt(lstr);
      const rint = parseInt(rstr);
      if (lint !== rint) {
        return lint - rint;
      } else if (lstr !== rstr) {
        return lstr.localeCompare(rstr);
      }
    }
    return 0;
  };
}

const first = Object.fromEntries((await metafiles).map(([name, data]) => [name, data[0].version]));
const output: Record<string, SchemaFile> = {};

for (const [name, schema] of (await schemas).sort(([a], [b]) => a.localeCompare(b))) {
  const version = schema.tables.map(({ name }) => first[name]).sort(compareVersion(true))[0];
  const dir = path.join("history", version);
  await fs.mkdir(dir, { recursive: true });
  output[path.join(dir, name)] = schema;
}

await Promise.all(
  Object.entries(output).map(([name, schema]) => fs.writeFile(name, JSON.stringify(schema), "utf8"))
);
