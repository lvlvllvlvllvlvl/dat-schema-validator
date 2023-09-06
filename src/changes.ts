import * as csv from "csv-stringify";
import * as fs from "fs/promises";
import path from "path";
interface Build {
  game_version: string;
  shape_revision: number;
  time_updated: number;
}
interface Shape {
  fixed_size: number;
  row_count: number;
  row_width: number;
  var_offset: number;
  var_size: number;
}
export type ShapeChange = (Shape | {}) & { version: string };
interface BuildChanges extends Build {
  added?: { [filename: string]: Shape };
  removed?: { [filename: string]: Shape };
  changed?: { [prop in keyof Shape]?: { [filename: string]: [number, number] } };
}
// https://github.com/pale-court/dat-meta
const { builds }: { builds: { [id: string]: Build } } = await fs
  .readFile("dat-meta/global.json")
  .then((buf) => JSON.parse(buf.toString()));

const keys = <K extends string>(l: Record<K, any>, r: Record<K, any>) =>
  Array.from(new Set(Object.keys(l).concat(Object.keys(r)))).sort() as K[];
export const changes: { builds: { [id: string]: BuildChanges } } = { builds: {} };

const datfiles: { [key: string]: ShapeChange[] } = {};

let prevFiles = {};
for (const id of Object.keys(builds)) {
  const data: BuildChanges = builds[id];
  const version = data.game_version.split(" ")[0];
  const { files }: { files: { [filename: string]: Shape } } = await fs
    .readFile(`dat-meta/builds/build-${id}.json`)
    .then((buf) => JSON.parse(buf.toString()));
  for (const file of keys(files, prevFiles)) {
    const curr = files[file];
    const prev = prevFiles[file];
    const basename = path.parse(file).name;
    const datfile = (datfiles[basename] = datfiles[basename] || []);
    if (curr && !prev) {
      datfile.push({ version, ...curr });
      changes.builds[id] = data;
      data.added = data.added || {};
      data.added[file] = curr;
    } else if (!curr && prev) {
      datfile.push({ version });
      changes.builds[id] = data;
      data.removed = data.removed || {};
      data.removed[file] = prev;
    } else if (curr && prev) {
      for (const key of keys(curr, prev)) {
        if (curr[key] !== prev[key]) {
          if (!datfile.find((f) => f.version === version)) {
            datfile.push({ version, ...curr });
          }
          changes.builds[id] = data;
          data.changed = data.changed || {};
          data.changed[key] = data.changed[key] || {};
          data.changed[key]![file] = [prev[key], curr[key]];
        }
      }
    }
  }
  prevFiles = files;
}

await Promise.all(
  Object.entries(datfiles).map(([file, contents]) =>
    fs.writeFile(path.join("meta", file + ".csv"), csv.stringify(contents, { header: true }))
  )
);
await fs.writeFile("changes.json", JSON.stringify(changes, undefined, 2));
