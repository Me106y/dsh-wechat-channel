import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertProfileRuntimeIsShared } from "../scripts/dsh-runtime.mjs";
test("runtime guard rejects same-version physical duplicates and accepts Host symlinks", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-runtime-guard-"));
  try {
    const modules = join(dir, "install/node_modules/@deepseek-ai"),
      host = join(modules, "dsh-scope");
    const home = join(dir, "home"),
      local = join(home, "profiles/web/node_modules/@deepseek-ai/dsh-scope");
    for (const p of [host, local]) {
      await mkdir(p, { recursive: true });
      await writeFile(
        join(p, "package.json"),
        JSON.stringify({
          name: "@deepseek-ai/dsh-scope",
          version: "0.1.5-rc.2",
        }),
      );
    }
    const cli = join(modules, "dsh/lib/bin.js");
    await mkdir(join(modules, "dsh/lib"), { recursive: true });
    await writeFile(cli, "");
    await assert.rejects(
      assertProfileRuntimeIsShared({ cli }, home),
      /duplicate runtime packages/,
    );
    await rm(local, { recursive: true });
    try {
      await symlink(host, local);
    } catch (error) {
      if (error.code !== "EPERM" && error.code !== "EACCES") throw error;
      t.skip("symlinks need Developer Mode or elevation on Windows");
      return;
    }
    await assert.doesNotReject(assertProfileRuntimeIsShared({ cli }, home));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
