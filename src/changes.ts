import * as fs from "fs/promises";

interface Build {
    game_version: string;
    shape_revision: number;
    time_updated: number;
}
interface File {
    "fixed_size": number
    "row_count": number
    "row_width": number
    "var_offset": number
    "var_size": number
}
interface BuildChanges extends Build {
    added?: { [filename: string]: File }
    removed?: { [filename: string]: File }
    changed?: { [prop in keyof File]?: { [filename: string]: [number, number] } }
}
const { builds }: { builds: { [id: string]: Build; }; } = await fs.readFile("dat-meta/global.json").then(buf => JSON.parse(buf.toString()));

const keys = <K extends string>(l: Record<K, any>, r: Record<K, any>) => Array.from(new Set(Object.keys(l).concat(Object.keys(r)))).sort() as K[]
export const changes: { builds: { [id: string]: BuildChanges; }; } = { builds: {} };

let prevFiles = {}
for (const id of Object.keys(builds)) {
    const data: BuildChanges = builds[id]
    const { files }: { files: { [filename: string]: File } } = await fs.readFile(`dat-meta/builds/build-${id}.json`).then(buf => JSON.parse(buf.toString()))
    for (const file of keys(files, prevFiles)) {
        const curr = files[file]
        const prev = prevFiles[file]
        if (curr && !prev) {
            changes.builds[id] = data
            data.added = data.added || {}
            data.added[file] = curr
        } else if (!curr && prev) {
            changes.builds[id] = data
            data.removed = data.removed || {}
            data.removed[file] = prev
        } else if (curr && prev) {
            for (const key of keys(curr, prev)) {
                if (curr[key] !== prev[key]) {
                    changes.builds[id] = data
                    data.changed = data.changed || {}
                    data.changed[key] = data.changed[key] || {}
                    data.changed[key]![file] = [prev[key], curr[key]]
                }
            }
        } else {
            console.log(curr, prev)
        }
    }
    prevFiles = files
}

await fs.writeFile("changes.json", JSON.stringify(changes, undefined, 2));
