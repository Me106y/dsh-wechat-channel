import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";

export const DSH_VERSION = "0.2.0-rc.2";
/** Validated component baseline; components only have to agree with each other inside {@link DSH_LINE}. */
export const COMPONENT_VERSION = "0.2.0-rc.2";
/** Runtime line the `@deepseek-ai/dsh-agent` peer range also names; moving it needs a fresh compatibility pass. */
export const DSH_LINE = "0.2.";
/** Whether a manifest version belongs to the supported runtime line. */
function onLine(version) {
  return typeof version === "string" && version.startsWith(DSH_LINE);
}
export async function inspectRuntime(cli) {
  const manifest = JSON.parse(
    await readFile(resolve(dirname(cli), "../package.json"), "utf8"),
  );
  if (manifest.name !== "@deepseek-ai/dsh" || !onLine(manifest.version))
    throw new Error(
      `Expected DSH ${DSH_LINE}x (validated against ${DSH_VERSION}); found ${manifest.version ?? "unknown"}`,
    );
  const require = createRequire(cli);
  const versions = { dsh: manifest.version };
  let component;
  for (const name of ["dsh-agent", "dsh-web-app", "dsh-settings"]) {
    const path = require.resolve(`@deepseek-ai/${name}/package.json`);
    const pkg = JSON.parse(await readFile(path, "utf8"));
    if (!onLine(pkg.version))
      throw new Error(
        `DSH ${name} ${pkg.version ?? "unknown"} is outside the supported ${DSH_LINE}x line`,
      );
    if (component === void 0) component = pkg.version;
    else if (pkg.version !== component)
      throw new Error(
        `DSH installation is mixed: ${name} ${pkg.version}; other components are ${component}`,
      );
    versions[name] = pkg.version;
  }
  return { cli, versions };
}
export async function resolveRuntime() {
  if (process.env.DSH_CLI) return inspectRuntime(resolve(process.env.DSH_CLI));
  const candidates = [
    join(homedir(), ".dsh/profiles/node_modules/@deepseek-ai/dsh/lib/bin.js"),
  ];
  const cache = join(homedir(), ".npm/_npx");
  for (const entry of await readdir(cache).catch(() => []))
    candidates.push(
      join(cache, entry, "node_modules/@deepseek-ai/dsh/lib/bin.js"),
    );
  for (const candidate of candidates)
    try {
      return await inspectRuntime(candidate);
    } catch {}
  throw new Error(
    `No compatible DSH ${DSH_VERSION} installation found. Install using npm_config_registry=https://registry.npmjs.org npx --yes @deepseek-ai/dsh@${DSH_VERSION} --version, or set DSH_CLI to its lib/bin.js.`,
  );
}

/** Profile-local runtime copies break non-global Symbol/WeakMap ownership even at equal versions. */
export async function assertProfileRuntimeIsShared(
  runtime,
  home = process.env.DSH_HOME?.trim() || join(homedir(), ".dsh"),
) {
  const { realpath } = await import("node:fs/promises");
  const root = join(home, "profiles/web/node_modules/@deepseek-ai");
  const require = createRequire(runtime.cli);
  const duplicated = [];
  for (const entry of await readdir(root).catch(() => [])) {
    let hostPackage;
    try {
      hostPackage = require.resolve(`@deepseek-ai/${entry}/package.json`);
    } catch {
      continue;
    }
    try {
      const local = await realpath(join(root, entry, "package.json"));
      if (local !== (await realpath(hostPackage)))
        duplicated.push(`@deepseek-ai/${entry}`);
    } catch {}
  }
  if (duplicated.length)
    throw new Error(
      `DSH profile contains duplicate runtime packages: ${duplicated.join(", ")}. These must resolve to the same installation as the Host before startup; equal version numbers are insufficient. See docs/runbook/runtime-deduplication.md.`,
    );
}
