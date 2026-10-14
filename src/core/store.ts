import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { Attachment, Binding, Message, MessageState } from "./types.js";

export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(
      `PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;`,
    );
    const version = Number(
      this.db.prepare("PRAGMA user_version").get()?.user_version,
    );
    if (version > 1) throw new Error("SCHEMA_TOO_NEW");
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY, epoch INTEGER NOT NULL, direction TEXT NOT NULL,
      provider_id TEXT,session_id TEXT,text TEXT NOT NULL,state TEXT NOT NULL,error TEXT,created_at INTEGER NOT NULL,
      attachments TEXT NOT NULL DEFAULT '[]',source TEXT UNIQUE,submission_id TEXT,dsh_message_id TEXT,payload TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,next_attempt INTEGER NOT NULL DEFAULT 0,client_id TEXT NOT NULL,
      UNIQUE(epoch,direction,provider_id));
      CREATE TABLE IF NOT EXISTS interactions(id TEXT PRIMARY KEY,payload TEXT NOT NULL,state TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS messages_queue ON messages(direction,state,created_at);
      PRAGMA user_version=1;`);
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const v = fn();
      this.db.exec("COMMIT");
      return v;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  get<T>(key: string, fallback: T): T {
    const r = this.db.prepare("SELECT value FROM meta WHERE key=?").get(key);
    return r ? (JSON.parse(String(r.value)) as T) : fallback;
  }
  set(key: string, value: unknown) {
    this.db
      .prepare(
        "INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, JSON.stringify(value));
  }
  get epoch() {
    return this.get("epoch", 1);
  }
  bind(sessionId: string, revision: number): Binding {
    return this.transaction(() => {
      const old = this.get<Binding | undefined>("binding", undefined);
      if ((old?.revision ?? 0) !== revision)
        throw new Error("REVISION_CONFLICT");
      const binding = { sessionId, revision: revision + 1 };
      this.set("binding", binding);
      return binding;
    });
  }
  resetAccount() {
    this.transaction(() => {
      this.set("epoch", this.epoch + 1);
      this.set("cursor", "");
      this.set("account", null);
      this.set("binding", null);
      this.set("context", null);
      this.db
        .prepare(
          "UPDATE messages SET state='cancelled' WHERE state NOT IN ('sent','completed','failed','cancelled')",
        )
        .run();
      this.db.prepare("UPDATE interactions SET state='expired'").run();
    });
  }
  ingestBatch(
    oldCursor: string,
    newCursor: string,
    epoch: number,
    entries: { providerId: string; text: string; payload: unknown }[],
    contextCipher?: string,
  ) {
    return this.transaction(() => {
      if (epoch !== this.epoch) throw new Error("STALE_EPOCH");
      const cursor = this.get("cursor", "");
      if (cursor !== oldCursor) {
        if (cursor === newCursor) return [];
        throw new Error("STALE_CURSOR");
      }
      const binding = this.get<Binding | null>("binding", null);
      const ids: string[] = [];
      for (const e of entries) {
        const id = randomUUID();
        const result = this.db
          .prepare(
            `INSERT OR IGNORE INTO messages(id,epoch,direction,provider_id,session_id,text,state,created_at,payload,client_id,submission_id,dsh_message_id) VALUES(?,?,'in',?,?,?,'received',?,?,?,?,?)`,
          )
          .run(
            id,
            epoch,
            e.providerId,
            binding?.sessionId ?? null,
            e.text,
            Date.now(),
            JSON.stringify(e.payload),
            randomUUID(),
            id,
            randomUUID(),
          );
        if (result.changes) ids.push(id);
      }
      if (contextCipher) this.set("context", contextCipher);
      this.set("cursor", newCursor);
      return ids;
    });
  }
  message(id: string): Message | undefined {
    const row = this.db
      .prepare("SELECT rowid,* FROM messages WHERE id=?")
      .get(id);
    return row ? this.decode(row) : undefined;
  }
  messageBySource(source: string): Message | undefined {
    const row = this.db
      .prepare("SELECT rowid,* FROM messages WHERE source=?")
      .get(source);
    return row ? this.decode(row) : undefined;
  }
  submission(sessionId: string, dshMessageId: string): Message | undefined {
    const row = this.db
      .prepare(
        "SELECT rowid,* FROM messages WHERE direction='in' AND epoch=? AND session_id=? AND dsh_message_id=?",
      )
      .get(this.epoch, sessionId, dshMessageId);
    return row ? this.decode(row) : undefined;
  }
  list(
    options: {
      before?: number;
      state?: string;
      direction?: string;
      limit?: number;
    } = {},
  ) {
    const rows = this.db
      .prepare(
        `SELECT rowid,* FROM messages WHERE rowid<? AND (?='' OR state=?) AND (?='' OR direction=?) ORDER BY rowid DESC LIMIT ?`,
      )
      .all(
        options.before ?? Number.MAX_SAFE_INTEGER,
        options.state ?? "",
        options.state ?? "",
        options.direction ?? "",
        options.direction ?? "",
        Math.min(options.limit ?? 50, 100),
      );
    return {
      items: rows.map((r) => this.decode(r)),
      nextCursor: rows.length ? Number(rows.at(-1)?.rowid) : undefined,
    };
  }
  incoming(): Message[] {
    return this.db
      .prepare(
        "SELECT rowid,* FROM messages WHERE direction='in' AND epoch=? AND state NOT IN ('completed','cancelled') ORDER BY rowid",
      )
      .all(this.epoch)
      .map((r) => this.decode(r));
  }
  outgoing(): Message[] {
    return this.db
      .prepare(
        "SELECT rowid,* FROM messages WHERE direction='out' AND epoch=? AND state NOT IN ('sent','cancelled') ORDER BY rowid",
      )
      .all(this.epoch)
      .map((r) => this.decode(r));
  }
  update(id: string, state: MessageState, error: string | null = null) {
    this.db
      .prepare("UPDATE messages SET state=?,error=? WHERE id=?")
      .run(state, error, id);
  }
  attachments(id: string, items: Attachment[]) {
    this.db
      .prepare("UPDATE messages SET attachments=? WHERE id=?")
      .run(JSON.stringify(items), id);
  }
  attachment(id: string): Attachment | undefined {
    for (const row of this.db
      .prepare("SELECT attachments FROM messages")
      .iterate()) {
      const found = (JSON.parse(String(row.attachments)) as Attachment[]).find(
        (a) => a.id === id,
      );
      if (found) return found;
    }
    return undefined;
  }
  enqueue(input: {
    text: string;
    sessionId?: string;
    submissionId?: string;
    source: string;
    attachments?: Attachment[];
    payload?: unknown;
  }) {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO messages(id,epoch,direction,session_id,text,state,created_at,source,submission_id,attachments,payload,client_id) VALUES(?,?,'out',?,?,'queued',?,?,?,?,?,?)`,
      )
      .run(
        id,
        this.epoch,
        input.sessionId ?? null,
        input.text,
        Date.now(),
        input.source,
        input.submissionId ?? null,
        JSON.stringify(input.attachments ?? []),
        JSON.stringify(input.payload ?? null),
        randomUUID(),
      );
    return String(
      this.db
        .prepare("SELECT id FROM messages WHERE source=?")
        .get(input.source)?.id,
    );
  }
  retry(id: string, allowDuplicate = false) {
    const m = this.message(id);
    if (!m || m.direction !== "out" || m.epoch !== this.epoch)
      throw new Error("NOT_FOUND");
    if (m.state === "uncertain" && !allowDuplicate)
      throw new Error("DUPLICATE_CONFIRMATION_REQUIRED");
    if (
      !["failed", "uncertain", "retry_wait", "waiting_context"].includes(
        m.state,
      )
    )
      throw new Error("INVALID_STATE");
    this.db
      .prepare(
        "UPDATE messages SET state='queued',attempts=0,next_attempt=0,error=NULL WHERE id=?",
      )
      .run(id);
  }
  attempt(id: string) {
    this.db
      .prepare(
        "UPDATE messages SET state='sending',attempts=attempts+1 WHERE id=?",
      )
      .run(id);
  }
  defer(id: string, state: MessageState, error: string, delay: number) {
    this.db
      .prepare("UPDATE messages SET state=?,error=?,next_attempt=? WHERE id=?")
      .run(state, error, Date.now() + delay, id);
  }
  recoverSending() {
    // 0.2.0/early 0.2.1 misclassified a parsed successful response with omitted ret.
    // Only the persisted diagnostic from that exact branch proves acceptance.
    this.transaction(() => {
      for (const message of this.outgoing()) {
        const proof = this.get<{
          phase?: string;
          reason?: string;
          reconciled?: string;
        } | null>(`delivery-diagnostic:${message.id}`, null);
        if (
          message.state === "uncertain" &&
          proof?.phase === "send" &&
          proof.reason === "Send acceptance not confirmed"
        ) {
          this.update(message.id, "sent");
          this.set(`delivery-diagnostic:${message.id}`, {
            ...proof,
            reconciled: "ilink-omitted-ret-default-zero",
          });
        }
      }
    });
    this.db
      .prepare(
        "UPDATE messages SET state='cancelled' WHERE direction='out' AND source LIKE 'interaction:%' AND state NOT IN ('sent','cancelled')",
      )
      .run();
    this.db
      .prepare(
        "UPDATE messages SET state='received' WHERE direction='in' AND state='preparing'",
      )
      .run();
    this.db
      .prepare(
        "UPDATE messages SET state='uncertain',error='DELIVERY_UNCERTAIN' WHERE state='sending'",
      )
      .run();
    this.db
      .prepare(
        "UPDATE interactions SET state='expired' WHERE state IN ('pending','submitted','resolving','uncertain')",
      )
      .run();
  }
  cancelInteractionDelivery(id: string) {
    this.db
      .prepare(
        "UPDATE messages SET state='cancelled' WHERE direction='out' AND json_extract(payload,'$.interactionId')=? AND state NOT IN ('sent','sending','cancelled')",
      )
      .run(id);
  }
  counts(): Record<string, number> {
    return Object.fromEntries(
      this.db
        .prepare(
          "SELECT state,COUNT(*) AS n FROM messages WHERE epoch=? GROUP BY state",
        )
        .all(this.epoch)
        .map((r) => [String(r.state), Number(r.n)]),
    );
  }
  close() {
    this.db.close();
  }
  private decode(r: Record<string, unknown>): Message {
    return {
      id: String(r.id),
      epoch: Number(r.epoch),
      direction: r.direction as "in" | "out",
      providerId: r.provider_id as string | null,
      sessionId: r.session_id as string | null,
      text: String(r.text),
      state: r.state as MessageState,
      error: r.error as string | null,
      createdAt: Number(r.created_at),
      attachments: JSON.parse(String(r.attachments)),
      source: r.source as string | null,
      submissionId: r.submission_id as string | null,
      dshMessageId: r.dsh_message_id as string | null,
      payload: r.payload ? JSON.parse(String(r.payload)) : null,
      attempts: Number(r.attempts),
      nextAttempt: Number(r.next_attempt),
      clientId: String(r.client_id),
    };
  }
}
