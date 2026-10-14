import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
await mkdir("lib", { recursive: true });
await build({
  entryPoints: ["src/host/index.ts"],
  outfile: "lib/index.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "external",
});
await build({
  entryPoints: ["src/worker/main.ts"],
  outfile: "lib/worker.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "external",
});
const result = await build({
  entryPoints: ["src/client/index.tsx"],
  bundle: true,
  platform: "browser",
  format: "cjs",
  target: "es2022",
  external: ["react", "react/jsx-runtime"],
  write: false,
});
await writeFile(
  "lib/client.js",
  `window.__ModuleLoader__.load({id:"dsh-wechat-channel",factory:function(require){var module={exports:{}};var exports=module.exports;\n${result.outputFiles[0].text}\nreturn module.exports;}});\n`,
);
