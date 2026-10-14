import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  mkdir,
  realpath,
  stat,
  readFile,
  writeFile,
  rename,
  readdir,
  open,
} from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import type { Attachment } from "./types.js";
export class Files {
  private saving: Promise<unknown> = Promise.resolve();
  constructor(
    readonly root: string,
    readonly quota = 2 * 1024 ** 3,
  ) {}
  async save(
    bytes: Uint8Array,
    name: string,
    mime: string,
    kind: "image" | "file",
  ): Promise<Attachment> {
    const operation = this.saving.then(() =>
      this.persist(bytes, name, mime, kind),
    );
    this.saving = operation.catch(() => {});
    return operation;
  }
  private async persist(
    bytes: Uint8Array,
    name: string,
    mime: string,
    kind: "image" | "file",
  ): Promise<Attachment> {
    const max = kind === "image" ? 20 * 1024 ** 2 : 100 * 1024 ** 2;
    if (bytes.byteLength > max) throw new Error("ATTACHMENT_TOO_LARGE");
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    let used = 0;
    for (const file of await readdir(this.root))
      used += (await stat(join(this.root, file))).size;
    if (used + bytes.byteLength > this.quota) throw new Error("STORAGE_FULL");
    const id = randomUUID(),
      path = join(this.root, id),
      tmp = path + ".part";
    await writeFile(tmp, bytes, { mode: 0o600, flag: "wx" });
    await rename(tmp, path);
    return {
      id,
      name: name.replace(/[\x00-\x1f/\\]/g, "_").slice(0, 200) || "附件",
      mime,
      size: bytes.byteLength,
      path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      kind,
    };
  }
  async snapshot(path: string, roots: string[]): Promise<Attachment> {
    const resolved = await realpath(path);
    let permitted = false;
    for (const root of roots) {
      const base = await realpath(root);
      const r = relative(base, resolved);
      if (r !== "" && !r.startsWith("..") && !isAbsolute(r)) permitted = true;
    }
    if (!permitted) throw new Error("ATTACHMENT_PATH_DENIED");
    const info = await stat(resolved);
    if (!info.isFile()) throw new Error("NOT_A_FILE");
    if (info.size > 100 * 1024 ** 2) throw new Error("ATTACHMENT_TOO_LARGE");
    const { basename, extname } = await import("node:path");
    const ext = extname(resolved).toLowerCase();
    const mime: Record<string, string> = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".webp": "image/webp",
      ".gif": "image/gif",
    };
    return this.save(
      await boundedFile(resolved, 100 * 1024 ** 2),
      basename(resolved),
      mime[ext] ?? "application/octet-stream",
      mime[ext] ? "image" : "file",
    );
  }
  async read(a: Attachment) {
    const path = await realpath(a.path);
    const root = await realpath(this.root);
    const r = relative(root, path);
    if (!r || r.startsWith("..") || isAbsolute(r))
      throw new Error("ATTACHMENT_PATH_DENIED");
    const b = await boundedFile(path, Math.min(a.size, 100 * 1024 ** 2));
    if (
      b.length !== a.size ||
      createHash("sha256").update(b).digest("hex") !== a.sha256
    )
      throw new Error("ATTACHMENT_CORRUPT");
    return b;
  }
}

async function boundedFile(path: string, limit: number): Promise<Buffer> {
  const file = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    if ((await realpath(path)) !== path)
      throw new Error("ATTACHMENT_PATH_DENIED");
    const info = await file.stat();
    if (!info.isFile()) throw new Error("NOT_A_FILE");
    if (info.size > limit) throw new Error("ATTACHMENT_CORRUPT");
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of file.createReadStream({
      autoClose: false,
      highWaterMark: 1024 * 1024,
    })) {
      size += chunk.length;
      if (size > limit) throw new Error("ATTACHMENT_TOO_LARGE");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, size);
  } finally {
    await file.close();
  }
}
