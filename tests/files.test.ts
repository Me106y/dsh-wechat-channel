import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, symlink, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Files } from "../src/core/files.js";
test("outbound file snapshot excludes escaping symlinks and validates saved bytes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "wechat-files-"));
  try {
    const project = join(root, "project");
    await mkdir(project);
    await writeFile(join(root, "secret"), "secret");
    try {
      await symlink(join(root, "secret"), join(project, "link"));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EPERM" && code !== "EACCES") throw error;
      t.skip("symlinks need Developer Mode or elevation on Windows");
      return;
    }
    const f = new Files(join(root, "blobs"));
    await assert.rejects(
      f.snapshot(join(project, "link"), [project]),
      /PATH_DENIED/,
    );
    await writeFile(join(project, "result.txt"), "result");
    const a = await f.snapshot(join(project, "result.txt"), [project]);
    assert.equal((await f.read(a)).toString(), "result");
    await writeFile(a.path, "tampered");
    await assert.rejects(f.read(a), /CORRUPT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("attachment quota rejects further storage without publishing an object", async () => {
  const root = await mkdtemp(join(tmpdir(), "wechat-quota-"));
  try {
    const f = new Files(root, 3);
    await assert.rejects(
      f.save(Buffer.from("four"), "a", "application/octet-stream", "file"),
      /STORAGE_FULL/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
