import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  statSync,
  chmodSync,
} from "node:fs";
import { join } from "node:path";
export class Vault {
  private readonly key: Buffer;
  constructor(root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const file = join(root, "key");
    try {
      this.key = readFileSync(file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      this.key = randomBytes(32);
      writeFileSync(file, this.key, { mode: 0o600, flag: "wx" });
    }
    if (this.key.length !== 32) throw new Error("INVALID_VAULT_KEY");
    chmodSync(file, 0o600);
  }
  seal(data: unknown): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const body = Buffer.concat([
      cipher.update(JSON.stringify(data), "utf8"),
      cipher.final(),
    ]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
  }
  open<T>(value: string): T {
    const b = Buffer.from(value, "base64");
    const c = createDecipheriv("aes-256-gcm", this.key, b.subarray(0, 12));
    c.setAuthTag(b.subarray(12, 28));
    return JSON.parse(
      Buffer.concat([c.update(b.subarray(28)), c.final()]).toString("utf8"),
    ) as T;
  }
}
