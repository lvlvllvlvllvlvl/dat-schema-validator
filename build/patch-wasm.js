import fs from "fs";

const base64 = fs
  .readFileSync("node_modules/pathofexile-dat/dist/analysis.wasm")
  .toString("base64");

const js = fs.readFileSync("node_modules/pathofexile-dat/dist/dat-analysis/wasm.js").toString();

fs.writeFileSync(
  "node_modules/pathofexile-dat/dist/dat-analysis/wasm.js",
  js.replaceAll(
    "(await WebAssembly.instantiateStreaming(fetch(new URL('../analysis.wasm', import.meta.url)))).instance",
    `new WebAssembly.Instance(new WebAssembly.Module(Buffer.from('${base64}', 'base64')))`
  )
);
