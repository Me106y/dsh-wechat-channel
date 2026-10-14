// src/host/index.ts
import { join as join4, resolve as resolve2 } from "node:path";
import { homedir } from "node:os";
import {
  mkdirSync as mkdirSync3,
  openSync,
  closeSync,
  readFileSync as readFileSync2,
  writeFileSync as writeFileSync2,
  unlinkSync
} from "node:fs";

// src/dsh/index.ts
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
var record = (value) => value !== null && typeof value === "object" ? value : {};
var messages = (value) => Array.isArray(value) ? value.map(record) : [];
function reconcileEvents(sessionId, messageId, events) {
  const result = { sessionId, messageId, state: "absent" };
  const queues = {
    "next-turn": [],
    "next-step": []
  };
  let openTurn;
  const replies = [];
  for (const event of events) {
    const data = record(event.data);
    if (event.type === "turn/start") openTurn = data.turn;
    if (event.type === "agent/inbox/spliced") {
      const queue = queues[String(data.target)];
      if (!queue || typeof data.start !== "number") continue;
      const inserted = messages(data.inserted);
      const removed = queue.splice(
        data.start,
        typeof data.removedCount === "number" ? data.removedCount : 0,
        ...inserted
      );
      if (inserted.some((m) => m.id === messageId)) {
        result.state = "queued";
        result.seq = event.seq;
      }
      if (removed.some((m) => m.id === messageId)) {
        result.seq = event.seq;
        if (data.outcome === "canceled") result.state = "cancelled";
        else if (openTurn !== void 0) {
          result.state = "running";
          result.turn = openTurn;
        } else result.state = "unknown";
      }
    }
    if (event.type === "user/message" && data.id === messageId) {
      result.state = "running";
      result.turn = openTurn;
      result.seq = event.seq;
    }
    if (event.type === "assistant/message" && result.turn !== void 0 && data.turn === result.turn) {
      for (const block of messages(record(data.message).content))
        if (block.type === "text" && typeof block.text === "string")
          replies.push(block.text);
    }
    if (event.type === "turn/end") {
      if (result.turn === data.turn) {
        const reason = record(data.reason);
        result.state = reason.kind === "completed" ? "completed" : reason.kind === "aborted" ? "cancelled" : "failed";
        result.reason = String(reason.kind ?? "unknown");
        result.text = replies.join("\n\n");
        result.seq = event.seq;
      }
      openTurn = void 0;
    }
  }
  return result;
}
async function* emptyUplink() {
}
var DshAdapter = class {
  constructor(context) {
    this.context = context;
    if (!context.agents?.get || !context.sessionController?.resolveAgent || !context.sessions?.flush || !context.attachments?.saveImages || !context.attachments?.saveFileStream || !context.sessionQuery?.listSessions || !context.typertGateway?.wireStream || !context.connection?.createSharedFetchHandler)
      throw new Error(
        "DSH_INCOMPATIBLE: requires DSH 0.2.0-rc.2 agents, sessions, attachments, sessionQuery, sessionController, typertGateway and connection"
      );
    this.unlisten = context.on("session/event", (session, event) => {
      const ids = this.watched.get(session.id);
      if (!ids || ![
        "agent/inbox/spliced",
        "user/message",
        "assistant/message",
        "deliverables/presented",
        "turn/end"
      ].includes(event.type))
        return;
      const history = session.snapshotEvents().some((e) => e.seq === event.seq) ? session.snapshotEvents() : [...session.snapshotEvents(), event];
      const values = [...ids].map(
        (id) => reconcileEvents(session.id, id, history)
      );
      const prior = this.durableQueues.get(session.id) ?? Promise.resolve();
      const next = prior.then(async () => {
        if (!await this.context.sessions.flush(session))
          throw new Error("DSH_DURABILITY_UNCONFIRMED");
        if (event.type === "deliverables/presented")
          this.publishPresented(session, event, history);
        for (const value of values) this.publish(value);
      }).catch((error) => {
        this.emit({
          type: "error",
          error: `DSH event durability failed: ${String(error)}`
        });
      });
      this.durableQueues.set(session.id, next);
    });
    this.ready = new Promise((resolve3, reject) => {
      this.readyResolve = resolve3;
      this.readyReject = reject;
    });
    void this.ready.catch(() => {
    });
  }
  acquiring = /* @__PURE__ */ new Map();
  watched = /* @__PURE__ */ new Map();
  listeners = /* @__PURE__ */ new Set();
  last = /* @__PURE__ */ new Map();
  pending = /* @__PURE__ */ new Map();
  notifiedInteractions = /* @__PURE__ */ new Set();
  answered = /* @__PURE__ */ new Set();
  controller = new AbortController();
  unlisten;
  closed = false;
  clientId;
  interactionsStarted = false;
  ready;
  readyResolve;
  readyReject;
  durableQueues = /* @__PURE__ */ new Map();
  subscribe(listener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  emit(event) {
    for (const fn of this.listeners) {
      try {
        fn(event);
      } catch {
      }
    }
  }
  publish(value) {
    const key = `${value.sessionId}/${value.messageId}`;
    const serialized = JSON.stringify(value);
    if (this.last.get(key) === serialized) return;
    this.last.set(key, serialized);
    this.emit({ type: "submission", ...value });
  }
  publishPresented(session, event, history) {
    const data = record(event.data);
    if (event.type !== "deliverables/presented" || typeof data.turn !== "number" || !Number.isSafeInteger(data.turn) || typeof data.callId !== "string" || !session.header?.cwd)
      return;
    const files = messages(data.files).flatMap((file) => {
      if (typeof file.path !== "string" || !file.path.trim()) return [];
      return [
        {
          path: file.path,
          ...typeof file.description === "string" ? { description: file.description } : {}
        }
      ];
    });
    if (!files.length) return;
    const matches = [...this.watched.get(session.id) ?? []].filter(
      (id) => reconcileEvents(session.id, id, history).turn === data.turn
    );
    if (matches.length !== 1) return;
    const messageId = matches[0];
    this.emit({
      type: "deliverables/presented",
      sessionId: session.id,
      messageId,
      turn: data.turn,
      callId: data.callId,
      cwd: session.header.cwd,
      files
    });
  }
  async acquire(sessionId) {
    if (this.closed) throw new Error("DSH_ADAPTER_CLOSED");
    if (!sessionId) throw new Error("DSH_SESSION_REQUIRED");
    const existing = this.acquiring.get(sessionId);
    if (existing) return existing;
    const loading = this.context.sessionController.resolveAgent(sessionId).then((result) => {
      if (this.closed) throw new Error("DSH_ADAPTER_CLOSED");
      if ("error" in result) throw result.error;
      return result.agent;
    }).finally(() => this.acquiring.delete(sessionId));
    this.acquiring.set(sessionId, loading);
    return loading;
  }
  async getTargets() {
    const live = this.context.agents.list().map((agent) => ({
      sessionId: agent.id,
      cwd: agent.session.header?.cwd,
      status: agent.status
    }));
    const records = await this.context.sessionQuery.listSessions(
      this.controller.signal
    );
    const all = new Map(
      records.filter((item) => item.header.origin !== "subagent").map((item) => [
        item.header.id,
        { sessionId: item.header.id, cwd: item.header.cwd, status: "idle" }
      ])
    );
    for (const item of live) all.set(item.sessionId, item);
    return [...all.values()];
  }
  currentSubmission(agent) {
    if (this.context.agents.get(agent.id) !== agent) return void 0;
    return [...this.watched.get(agent.id) ?? []].find(
      (id) => reconcileEvents(agent.id, id, agent.session.snapshotEvents()).state === "running"
    );
  }
  async watch(sessionId, messageId) {
    const ids = this.watched.get(sessionId) ?? /* @__PURE__ */ new Set();
    ids.add(messageId);
    this.watched.set(sessionId, ids);
    const agent = await this.acquire(sessionId);
    if (!this.interactionsStarted) {
      this.interactionsStarted = true;
      void this.consumeInteractions();
    }
    await this.ready;
    await this.durableQueues.get(sessionId);
    const state = await this.reconcile(sessionId, messageId);
    if (state.state !== "absent" && !await this.context.sessions.flush(agent.session))
      throw new Error("DSH_DURABILITY_UNCONFIRMED");
    const history = agent.session.snapshotEvents();
    for (const event of history)
      if (event.type === "deliverables/presented")
        this.publishPresented(agent.session, event, history);
    this.publish(state);
    for (const [rpcId, payload] of this.pending)
      this.publishInteraction(rpcId, payload);
    return state;
  }
  async reconcile(sessionId, messageId) {
    const agent = await this.acquire(sessionId);
    const result = reconcileEvents(
      sessionId,
      messageId,
      agent.session.snapshotEvents()
    );
    if (result.state !== "absent" && !await this.context.sessions.flush(agent.session))
      throw new Error("DSH_DURABILITY_UNCONFIRMED");
    return result;
  }
  async submit(input) {
    if (!input.messageId || !input.sessionId)
      throw new Error("DSH_INPUT_ID_REQUIRED");
    const agent = await this.acquire(input.sessionId);
    const existing = await this.watch(input.sessionId, input.messageId);
    if (existing.state !== "absent") return existing;
    const content = [];
    if (input.text?.trim()) content.push({ type: "text", text: input.text });
    for (const attachment of input.attachments ?? []) {
      if (!isAbsolute(attachment.path))
        throw new Error("DSH_ATTACHMENT_PATH_MUST_BE_ABSOLUTE");
      if (attachment.kind === "image") {
        const [ref] = await this.context.attachments.saveImages([
          {
            data: await readFile(attachment.path),
            mediaType: attachment.mediaType,
            name: attachment.name
          }
        ]);
        if (!ref) throw new Error("DSH_ATTACHMENT_SAVE_FAILED");
        content.push({ type: "image", attachment: ref });
      } else {
        const ref = await this.context.attachments.saveFileStream({
          data: createReadStream(attachment.path),
          name: attachment.name,
          signal: this.controller.signal
        });
        content.push({ type: "file", attachment: ref });
      }
    }
    if (!content.length) throw new Error("DSH_EMPTY_MESSAGE");
    const again = reconcileEvents(
      input.sessionId,
      input.messageId,
      agent.session.snapshotEvents()
    );
    if (again.state !== "absent") return again;
    agent.followup({
      id: input.messageId,
      role: "user",
      source: { kind: "user" },
      content
    });
    return this.reconcile(input.sessionId, input.messageId);
  }
  async cancel(sessionId, messageId) {
    if (!this.watched.get(sessionId)?.has(messageId)) return false;
    const agent = await this.acquire(sessionId);
    if (agent.inbox.remove(messageId)) {
      if (!await this.context.sessions.flush(agent.session))
        throw new Error("DSH_DURABILITY_UNCONFIRMED");
      return true;
    }
    const state = reconcileEvents(
      sessionId,
      messageId,
      agent.session.snapshotEvents()
    );
    if (state.state !== "running") return false;
    agent.cancel({ kind: "user" }, { keepInbox: true });
    return true;
  }
  async openInteractions() {
    for (let attempt = 0; ; attempt++) {
      let iterator;
      try {
        const stream = await this.context.typertGateway.wireStream.open(
          "$events",
          { args: {} },
          emptyUplink(),
          void 0,
          this.controller.signal
        );
        iterator = stream[Symbol.asyncIterator]();
        const first = await iterator.next();
        if (first.done)
          throw new Error("DSH interaction stream ended before readiness");
        const active = iterator;
        return (async function* () {
          try {
            yield first.value;
            while (true) {
              const item = await active.next();
              if (item.done) return;
              yield item.value;
            }
          } finally {
            await active.return?.();
          }
        })();
      } catch (error) {
        await iterator?.return?.();
        if (attempt >= 49 || this.controller.signal.aborted || record(error).code !== "gateway/service-unavailable")
          throw error;
        await delay(100, void 0, { signal: this.controller.signal });
      }
    }
  }
  async consumeInteractions() {
    try {
      const stream = await this.openInteractions();
      for await (const raw of stream) {
        const frame = record(raw);
        if (frame.type === "ready" && typeof frame.clientId === "string") {
          this.clientId = frame.clientId;
          this.readyResolve();
          continue;
        }
        const rpcId = String(frame.eventId ?? "");
        if (frame.type === "cancel") {
          const payload2 = this.pending.get(rpcId);
          this.pending.delete(rpcId);
          this.notifiedInteractions.delete(rpcId);
          this.answered.delete(rpcId);
          if (payload2?.sessionId)
            this.emit({
              type: "interaction-resolved",
              sessionId: payload2.sessionId,
              rpcId,
              payload: payload2
            });
          continue;
        }
        if (frame.type !== "waterfall") continue;
        const sessionId = String(frame.agentId ?? "");
        const supported = frame.event === "approval/request" || frame.event === "user-questions/request";
        if (!supported || !this.watched.has(sessionId)) {
          await this.sendOutcome(rpcId, { kind: "next" });
          continue;
        }
        const payload = {
          ...record(frame.request),
          sessionId,
          type: frame.event === "approval/request" ? "approval/requested" : "question/requested"
        };
        this.pending.set(rpcId, payload);
        const agent = this.context.agents.get(sessionId);
        if (agent && !await this.context.sessions.flush(agent.session))
          throw new Error("DSH_DURABILITY_UNCONFIRMED");
        this.publishInteraction(rpcId, payload);
        if (!this.notifiedInteractions.has(rpcId)) {
          this.pending.delete(rpcId);
          await this.sendOutcome(rpcId, { kind: "next" });
        }
      }
      if (!this.closed) throw new Error("DSH interaction stream ended");
    } catch (error) {
      this.readyReject(error);
      if (!this.closed)
        this.emit({
          type: "error",
          error: `DSH interaction stream stopped: ${String(error)}`
        });
    }
  }
  async sendOutcome(rpcId, outcome) {
    if (!this.clientId) throw new Error("DSH_INTERACTION_STREAM_NOT_READY");
    const response = await this.context.connection.createSharedFetchHandler("/api").fetch(
      new Request("http://localhost/api/$events/result", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "client-request",
          rpcId: randomUUID(),
          method: "$events/result",
          payload: {
            args: { clientId: this.clientId, eventId: rpcId, outcome }
          }
        })
      })
    );
    const body2 = record(await response.json());
    if (!response.ok || record(body2.result).ok !== true)
      throw new Error("DSH_INTERACTION_RESPONSE_FAILED");
  }
  publishInteraction(rpcId, payload) {
    const sessionId = payload.sessionId;
    if (!sessionId || this.notifiedInteractions.has(rpcId)) return;
    const agent = this.context.agents.get(sessionId);
    if (!agent) return;
    const messageId = [...this.watched.get(sessionId) ?? []].find(
      (id) => reconcileEvents(sessionId, id, agent.session.snapshotEvents()).state === "running"
    );
    if (!messageId) return;
    this.notifiedInteractions.add(rpcId);
    this.emit({
      type: "interaction",
      sessionId,
      messageId,
      rpcId,
      kind: payload.type === "approval/requested" ? "approval" : "question",
      payload
    });
  }
  async answerApproval(rpcId, outcome) {
    if (outcome !== "allowed-once" && outcome !== "rejected")
      throw new Error("INVALID_APPROVAL_OUTCOME");
    const pending = this.pending.get(rpcId);
    if (!this.notifiedInteractions.has(rpcId) || !pending || pending.type !== "approval/requested")
      return false;
    return this.answer(rpcId, outcome);
  }
  async answerQuestions(rpcId, answer) {
    const pending = this.pending.get(rpcId);
    if (!this.notifiedInteractions.has(rpcId) || !pending || pending.type !== "question/requested")
      return false;
    return this.answer(rpcId, answer);
  }
  async answer(rpcId, value) {
    if (!this.pending.has(rpcId) || this.answered.has(rpcId)) return false;
    this.answered.add(rpcId);
    await this.sendOutcome(rpcId, { kind: "result", value });
    return true;
  }
  async dispose() {
    this.closed = true;
    this.controller.abort();
    this.unlisten();
    await Promise.allSettled([...this.durableQueues.values()]);
    await Promise.allSettled([...this.acquiring.values()]);
    this.listeners.clear();
    this.pending.clear();
  }
};

// src/core/service.ts
import { randomUUID as randomUUID5, createHash as createHash2 } from "node:crypto";
import { isAbsolute as isAbsolute3, join as join3, resolve } from "node:path";
import QRCode from "qrcode";

// src/core/store.ts
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID as randomUUID2 } from "node:crypto";
var Store = class {
  db;
  constructor(path) {
    mkdirSync(dirname(path), { recursive: true, mode: 448 });
    this.db = new DatabaseSync(path);
    chmodSync(path, 384);
    this.db.exec(
      `PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;`
    );
    const version = Number(
      this.db.prepare("PRAGMA user_version").get()?.user_version
    );
    if (version > 1) throw new Error("SCHEMA_TOO_NEW");
    this.db.exec(`CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
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
  transaction(fn) {
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
  get(key, fallback) {
    const r = this.db.prepare("SELECT value FROM meta WHERE key=?").get(key);
    return r ? JSON.parse(String(r.value)) : fallback;
  }
  set(key, value) {
    this.db.prepare(
      "INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
    ).run(key, JSON.stringify(value));
  }
  get epoch() {
    return this.get("epoch", 1);
  }
  bind(sessionId, revision) {
    return this.transaction(() => {
      const old = this.get("binding", void 0);
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
      this.db.prepare(
        "UPDATE messages SET state='cancelled' WHERE state NOT IN ('sent','completed','failed','cancelled')"
      ).run();
      this.db.prepare("UPDATE interactions SET state='expired'").run();
    });
  }
  ingestBatch(oldCursor, newCursor, epoch, entries, contextCipher) {
    return this.transaction(() => {
      if (epoch !== this.epoch) throw new Error("STALE_EPOCH");
      const cursor = this.get("cursor", "");
      if (cursor !== oldCursor) {
        if (cursor === newCursor) return [];
        throw new Error("STALE_CURSOR");
      }
      const binding = this.get("binding", null);
      const ids = [];
      for (const e of entries) {
        const id = randomUUID2();
        const result = this.db.prepare(
          `INSERT OR IGNORE INTO messages(id,epoch,direction,provider_id,session_id,text,state,created_at,payload,client_id,submission_id,dsh_message_id) VALUES(?,?,'in',?,?,?,'received',?,?,?,?,?)`
        ).run(
          id,
          epoch,
          e.providerId,
          binding?.sessionId ?? null,
          e.text,
          Date.now(),
          JSON.stringify(e.payload),
          randomUUID2(),
          id,
          randomUUID2()
        );
        if (result.changes) ids.push(id);
      }
      if (contextCipher) this.set("context", contextCipher);
      this.set("cursor", newCursor);
      return ids;
    });
  }
  message(id) {
    const row = this.db.prepare("SELECT rowid,* FROM messages WHERE id=?").get(id);
    return row ? this.decode(row) : void 0;
  }
  messageBySource(source) {
    const row = this.db.prepare("SELECT rowid,* FROM messages WHERE source=?").get(source);
    return row ? this.decode(row) : void 0;
  }
  submission(sessionId, dshMessageId) {
    const row = this.db.prepare(
      "SELECT rowid,* FROM messages WHERE direction='in' AND epoch=? AND session_id=? AND dsh_message_id=?"
    ).get(this.epoch, sessionId, dshMessageId);
    return row ? this.decode(row) : void 0;
  }
  list(options = {}) {
    const rows = this.db.prepare(
      `SELECT rowid,* FROM messages WHERE rowid<? AND (?='' OR state=?) AND (?='' OR direction=?) ORDER BY rowid DESC LIMIT ?`
    ).all(
      options.before ?? Number.MAX_SAFE_INTEGER,
      options.state ?? "",
      options.state ?? "",
      options.direction ?? "",
      options.direction ?? "",
      Math.min(options.limit ?? 50, 100)
    );
    return {
      items: rows.map((r) => this.decode(r)),
      nextCursor: rows.length ? Number(rows.at(-1)?.rowid) : void 0
    };
  }
  incoming() {
    return this.db.prepare(
      "SELECT rowid,* FROM messages WHERE direction='in' AND epoch=? AND state NOT IN ('completed','cancelled') ORDER BY rowid"
    ).all(this.epoch).map((r) => this.decode(r));
  }
  outgoing() {
    return this.db.prepare(
      "SELECT rowid,* FROM messages WHERE direction='out' AND epoch=? AND state NOT IN ('sent','cancelled') ORDER BY rowid"
    ).all(this.epoch).map((r) => this.decode(r));
  }
  update(id, state, error = null) {
    this.db.prepare("UPDATE messages SET state=?,error=? WHERE id=?").run(state, error, id);
  }
  attachments(id, items) {
    this.db.prepare("UPDATE messages SET attachments=? WHERE id=?").run(JSON.stringify(items), id);
  }
  attachment(id) {
    for (const row of this.db.prepare("SELECT attachments FROM messages").iterate()) {
      const found = JSON.parse(String(row.attachments)).find(
        (a) => a.id === id
      );
      if (found) return found;
    }
    return void 0;
  }
  enqueue(input) {
    const id = randomUUID2();
    this.db.prepare(
      `INSERT OR IGNORE INTO messages(id,epoch,direction,session_id,text,state,created_at,source,submission_id,attachments,payload,client_id) VALUES(?,?,'out',?,?,'queued',?,?,?,?,?,?)`
    ).run(
      id,
      this.epoch,
      input.sessionId ?? null,
      input.text,
      Date.now(),
      input.source,
      input.submissionId ?? null,
      JSON.stringify(input.attachments ?? []),
      JSON.stringify(input.payload ?? null),
      randomUUID2()
    );
    return String(
      this.db.prepare("SELECT id FROM messages WHERE source=?").get(input.source)?.id
    );
  }
  retry(id, allowDuplicate = false) {
    const m = this.message(id);
    if (!m || m.direction !== "out" || m.epoch !== this.epoch)
      throw new Error("NOT_FOUND");
    if (m.state === "uncertain" && !allowDuplicate)
      throw new Error("DUPLICATE_CONFIRMATION_REQUIRED");
    if (!["failed", "uncertain", "retry_wait", "waiting_context"].includes(
      m.state
    ))
      throw new Error("INVALID_STATE");
    this.db.prepare(
      "UPDATE messages SET state='queued',attempts=0,next_attempt=0,error=NULL WHERE id=?"
    ).run(id);
  }
  attempt(id) {
    this.db.prepare(
      "UPDATE messages SET state='sending',attempts=attempts+1 WHERE id=?"
    ).run(id);
  }
  defer(id, state, error, delay2) {
    this.db.prepare("UPDATE messages SET state=?,error=?,next_attempt=? WHERE id=?").run(state, error, Date.now() + delay2, id);
  }
  recoverSending() {
    this.transaction(() => {
      for (const message of this.outgoing()) {
        const proof = this.get(`delivery-diagnostic:${message.id}`, null);
        if (message.state === "uncertain" && proof?.phase === "send" && proof.reason === "Send acceptance not confirmed") {
          this.update(message.id, "sent");
          this.set(`delivery-diagnostic:${message.id}`, {
            ...proof,
            reconciled: "ilink-omitted-ret-default-zero"
          });
        }
      }
    });
    this.db.prepare(
      "UPDATE messages SET state='cancelled' WHERE direction='out' AND source LIKE 'interaction:%' AND state NOT IN ('sent','cancelled')"
    ).run();
    this.db.prepare(
      "UPDATE messages SET state='received' WHERE direction='in' AND state='preparing'"
    ).run();
    this.db.prepare(
      "UPDATE messages SET state='uncertain',error='DELIVERY_UNCERTAIN' WHERE state='sending'"
    ).run();
    this.db.prepare(
      "UPDATE interactions SET state='expired' WHERE state IN ('pending','submitted','resolving','uncertain')"
    ).run();
  }
  cancelInteractionDelivery(id) {
    this.db.prepare(
      "UPDATE messages SET state='cancelled' WHERE direction='out' AND json_extract(payload,'$.interactionId')=? AND state NOT IN ('sent','sending','cancelled')"
    ).run(id);
  }
  counts() {
    return Object.fromEntries(
      this.db.prepare(
        "SELECT state,COUNT(*) AS n FROM messages WHERE epoch=? GROUP BY state"
      ).all(this.epoch).map((r) => [String(r.state), Number(r.n)])
    );
  }
  close() {
    this.db.close();
  }
  decode(r) {
    return {
      id: String(r.id),
      epoch: Number(r.epoch),
      direction: r.direction,
      providerId: r.provider_id,
      sessionId: r.session_id,
      text: String(r.text),
      state: r.state,
      error: r.error,
      createdAt: Number(r.created_at),
      attachments: JSON.parse(String(r.attachments)),
      source: r.source,
      submissionId: r.submission_id,
      dshMessageId: r.dsh_message_id,
      payload: r.payload ? JSON.parse(String(r.payload)) : null,
      attempts: Number(r.attempts),
      nextAttempt: Number(r.next_attempt),
      clientId: String(r.client_id)
    };
  }
};

// src/core/vault.ts
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  mkdirSync as mkdirSync2,
  chmodSync as chmodSync2
} from "node:fs";
import { join } from "node:path";
var Vault = class {
  key;
  constructor(root) {
    mkdirSync2(root, { recursive: true, mode: 448 });
    const file = join(root, "key");
    try {
      this.key = readFileSync(file);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      this.key = randomBytes(32);
      writeFileSync(file, this.key, { mode: 384, flag: "wx" });
    }
    if (this.key.length !== 32) throw new Error("INVALID_VAULT_KEY");
    chmodSync2(file, 384);
  }
  seal(data) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const body2 = Buffer.concat([
      cipher.update(JSON.stringify(data), "utf8"),
      cipher.final()
    ]);
    return Buffer.concat([iv, cipher.getAuthTag(), body2]).toString("base64");
  }
  open(value) {
    const b = Buffer.from(value, "base64");
    const c = createDecipheriv("aes-256-gcm", this.key, b.subarray(0, 12));
    c.setAuthTag(b.subarray(12, 28));
    return JSON.parse(
      Buffer.concat([c.update(b.subarray(28)), c.final()]).toString("utf8")
    );
  }
};

// src/core/files.ts
import { createHash, randomUUID as randomUUID3 } from "node:crypto";
import { constants } from "node:fs";
import {
  mkdir,
  realpath,
  stat,
  writeFile,
  rename,
  readdir,
  open
} from "node:fs/promises";
import { join as join2, relative, isAbsolute as isAbsolute2 } from "node:path";
var Files = class {
  constructor(root, quota = 2 * 1024 ** 3) {
    this.root = root;
    this.quota = quota;
  }
  saving = Promise.resolve();
  async save(bytes, name2, mime, kind) {
    const operation = this.saving.then(
      () => this.persist(bytes, name2, mime, kind)
    );
    this.saving = operation.catch(() => {
    });
    return operation;
  }
  async persist(bytes, name2, mime, kind) {
    const max = kind === "image" ? 20 * 1024 ** 2 : 100 * 1024 ** 2;
    if (bytes.byteLength > max) throw new Error("ATTACHMENT_TOO_LARGE");
    await mkdir(this.root, { recursive: true, mode: 448 });
    let used = 0;
    for (const file of await readdir(this.root))
      used += (await stat(join2(this.root, file))).size;
    if (used + bytes.byteLength > this.quota) throw new Error("STORAGE_FULL");
    const id = randomUUID3(), path = join2(this.root, id), tmp = path + ".part";
    await writeFile(tmp, bytes, { mode: 384, flag: "wx" });
    await rename(tmp, path);
    return {
      id,
      name: name2.replace(/[\x00-\x1f/\\]/g, "_").slice(0, 200) || "\u9644\u4EF6",
      mime,
      size: bytes.byteLength,
      path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      kind
    };
  }
  async snapshot(path, roots) {
    const resolved = await realpath(path);
    let permitted = false;
    for (const root of roots) {
      const base = await realpath(root);
      const r = relative(base, resolved);
      if (r !== "" && !r.startsWith("..") && !isAbsolute2(r)) permitted = true;
    }
    if (!permitted) throw new Error("ATTACHMENT_PATH_DENIED");
    const info = await stat(resolved);
    if (!info.isFile()) throw new Error("NOT_A_FILE");
    if (info.size > 100 * 1024 ** 2) throw new Error("ATTACHMENT_TOO_LARGE");
    const { basename, extname } = await import("node:path");
    const ext = extname(resolved).toLowerCase();
    const mime = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".webp": "image/webp",
      ".gif": "image/gif"
    };
    return this.save(
      await boundedFile(resolved, 100 * 1024 ** 2),
      basename(resolved),
      mime[ext] ?? "application/octet-stream",
      mime[ext] ? "image" : "file"
    );
  }
  async read(a) {
    const path = await realpath(a.path);
    const root = await realpath(this.root);
    const r = relative(root, path);
    if (!r || r.startsWith("..") || isAbsolute2(r))
      throw new Error("ATTACHMENT_PATH_DENIED");
    const b = await boundedFile(path, Math.min(a.size, 100 * 1024 ** 2));
    if (b.length !== a.size || createHash("sha256").update(b).digest("hex") !== a.sha256)
      throw new Error("ATTACHMENT_CORRUPT");
    return b;
  }
};
async function boundedFile(path, limit) {
  const file = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
  );
  try {
    if (await realpath(path) !== path)
      throw new Error("ATTACHMENT_PATH_DENIED");
    const info = await file.stat();
    if (!info.isFile()) throw new Error("NOT_A_FILE");
    if (info.size > limit) throw new Error("ATTACHMENT_CORRUPT");
    const chunks = [];
    let size = 0;
    for await (const chunk of file.createReadStream({
      autoClose: false,
      highWaterMark: 1024 * 1024
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

// src/worker/rpc.ts
import { fork } from "node:child_process";
import { randomUUID as randomUUID4 } from "node:crypto";
import { fileURLToPath } from "node:url";
var failure = (code) => Object.assign(new Error(code), { kind: "uncertain" });
var WorkerRpc = class {
  constructor(epoch, workerUrl = new URL("./worker.js", import.meta.url)) {
    this.epoch = epoch;
    this.workerUrl = workerUrl;
  }
  child;
  pending = /* @__PURE__ */ new Map();
  configuration = {};
  ready;
  generation = 0;
  stopped;
  reconfiguring;
  rejectChild(child, error) {
    for (const [id, p] of this.pending)
      if (p.child === child) {
        clearTimeout(p.timer);
        this.pending.delete(id);
        p.reject(error);
      }
  }
  retire(child, error) {
    if (this.child === child) {
      this.child = void 0;
      this.ready = void 0;
      this.generation++;
    }
    this.rejectChild(child, error);
    const closing = new Promise((resolve3) => {
      child.once("exit", () => resolve3());
      child.once("error", () => resolve3());
      child.kill("SIGKILL");
      if (!child.pid) resolve3();
    });
    this.stopped = closing;
    void closing.finally(() => {
      if (this.stopped === closing) this.stopped = void 0;
    });
  }
  spawn() {
    const child = fork(fileURLToPath(this.workerUrl), [], {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      serialization: "advanced",
      execArgv: []
    });
    this.child = child;
    child.on("message", (m) => {
      if (!m || typeof m.id !== "string") return;
      const p = this.pending.get(m.id);
      if (!p || p.child !== child) return;
      clearTimeout(p.timer);
      this.pending.delete(m.id);
      if (m.epoch !== p.epoch || p.epoch !== this.epoch())
        p.reject(failure("STALE_EPOCH"));
      else if (m.error)
        p.reject(
          Object.assign(new Error(m.error.code), {
            kind: m.error.kind,
            remoteCode: m.error.remoteCode
          })
        );
      else p.resolve(m.result);
    });
    child.on("error", () => this.retire(child, failure("WORKER_SPAWN_ERROR")));
    child.on("exit", () => {
      if (this.child === child) {
        this.child = void 0;
        this.ready = void 0;
        this.generation++;
      }
      this.rejectChild(child, failure("WORKER_EXIT"));
    });
    return child;
  }
  request(child, method, payload, timeout) {
    const id = randomUUID4(), epoch = this.epoch();
    return new Promise((resolve3, reject) => {
      const timer = setTimeout(
        () => this.retire(child, failure("WORKER_TIMEOUT")),
        timeout
      );
      this.pending.set(id, {
        child,
        epoch,
        resolve: resolve3,
        reject,
        timer
      });
      try {
        child.send({ id, epoch, method, payload }, (error) => {
          if (error) this.retire(child, failure("WORKER_SEND_FAILED"));
        });
      } catch {
        this.retire(child, failure("WORKER_SEND_FAILED"));
      }
    });
  }
  async ensureReady() {
    const generation = this.generation;
    if (this.stopped) await this.stopped;
    if (generation !== this.generation) throw failure("WORKER_STOPPED");
    if (!this.ready) {
      const child = this.spawn();
      const ready = this.request(
        child,
        "configure",
        this.configuration,
        15e3
      ).then(() => {
        if (this.child !== child || generation !== this.generation)
          throw failure("WORKER_STOPPED");
        return child;
      });
      this.ready = ready;
      void ready.catch(() => {
        if (this.child === child)
          this.retire(child, failure("WORKER_CONFIGURE_FAILED"));
      });
    }
    return this.ready;
  }
  async call(method, payload, timeout) {
    if (method === "configure") {
      const stopping = this.stop(), generation = this.generation;
      const task = (async () => {
        await stopping;
        if (generation !== this.generation) throw failure("WORKER_STOPPED");
        this.configuration = payload;
        await this.ensureReady();
        return true;
      })();
      this.reconfiguring = task;
      try {
        return await task;
      } finally {
        if (this.reconfiguring === task) this.reconfiguring = void 0;
      }
    }
    const epoch = this.epoch();
    if (this.reconfiguring) await this.reconfiguring;
    const child = await this.ensureReady();
    if (child !== this.child || epoch !== this.epoch())
      throw failure("STALE_EPOCH");
    return this.request(
      child,
      method,
      payload,
      timeout ?? (["download", "upload"].includes(method) ? 15e4 : 6e4)
    );
  }
  async stop() {
    this.generation++;
    const child = this.child;
    this.child = void 0;
    this.ready = void 0;
    if (!child) {
      await this.stopped;
      return;
    }
    this.rejectChild(child, failure("WORKER_STOPPED"));
    const closing = new Promise((resolve3) => {
      const finish = () => {
        clearTimeout(timer);
        resolve3();
      };
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve3();
      }, 3e3);
      child.once("exit", finish);
      child.once("error", finish);
      child.kill("SIGTERM");
    });
    this.stopped = closing;
    await closing;
    if (this.stopped === closing) this.stopped = void 0;
  }
};

// src/core/service.ts
var WechatService = class {
  constructor(root, dsh, transport) {
    this.root = root;
    this.dsh = dsh;
    this.store = new Store(join3(root, "bridge.sqlite"));
    this.vault = new Vault(join3(root, "credentials"));
    this.files = new Files(join3(root, "blobs"));
    this.rpc = transport ?? new WorkerRpc(() => this.store.epoch);
    this.store.recoverSending();
    this.unsubscribe = dsh.subscribe((e) => this.event(e));
  }
  store;
  vault;
  files;
  rpc;
  transition = Promise.resolve();
  deliverableQueue = Promise.resolve();
  serial(fn) {
    const next = this.transition.then(fn, fn);
    this.transition = next.catch(() => {
    });
    return next;
  }
  pairingStart() {
    return this.serial(() => this.pairingStartImpl());
  }
  pairingConfirm() {
    return this.serial(() => this.pairingConfirmImpl());
  }
  unbind() {
    return this.serial(() => this.unbindImpl());
  }
  start() {
    return this.serial(() => this.startImpl());
  }
  stop() {
    return this.serial(() => this.stopImpl());
  }
  running = false;
  closed = false;
  generation = 0;
  pumpTimer;
  pumping = false;
  pollTask;
  connection = "stopped";
  qr;
  loginGeneration = 0;
  unsubscribe;
  interactions = /* @__PURE__ */ new Map();
  status() {
    const a = this.account();
    return {
      connection: this.connection,
      lastPollAt: this.store.get("lastPoll", void 0),
      ownerId: a?.ownerId,
      pairing: this.qr ? {
        qrDataUrl: this.qr.dataUrl,
        status: this.qr.status,
        ownerId: this.qr.candidate?.ownerId
      } : void 0,
      binding: this.store.get("binding", void 0) ?? void 0,
      counts: this.store.counts(),
      capabilities: {
        text: true,
        images: true,
        files: "native-attachment-reference",
        trace: "DSH native session",
        singleOwner: true
      }
    };
  }
  account() {
    const cipher = this.store.get("account", null);
    return cipher ? this.vault.open(cipher) : void 0;
  }
  async pairingStartImpl() {
    await this.stopImpl();
    this.loginGeneration++;
    const gen = this.loginGeneration;
    await this.rpc.call("configure", {});
    const qr = await this.rpc.call("qr", {});
    this.qr = {
      id: qr.qrcode,
      dataUrl: await QRCode.toDataURL(qr.qrcode_img_content),
      status: "wait"
    };
    void this.loginLoop(gen);
    return this.status();
  }
  async loginLoop(gen) {
    const until = Date.now() + 5 * 6e4;
    while (!this.closed && Date.now() < until && gen === this.loginGeneration && this.qr && !["confirmed", "expired", "failed"].includes(this.qr.status)) {
      try {
        const r = await this.rpc.call("qrStatus", {
          qrcode: this.qr.id
        });
        if (gen !== this.loginGeneration || !this.qr) return;
        this.qr.status = r.status;
        if (r.status === "confirmed") {
          if (!r.bot_token || !r.ilink_bot_id || !r.ilink_user_id)
            throw new Error("OWNER_UNVERIFIED");
          this.qr.candidate = {
            token: r.bot_token,
            botId: r.ilink_bot_id,
            ownerId: r.ilink_user_id,
            baseUrl: r.baseurl ?? "https://ilinkai.weixin.qq.com"
          };
          return;
        }
        if ([
          "need_verifycode",
          "verify_code_blocked",
          "scaned_but_redirect",
          "binded_redirect"
        ].includes(r.status)) {
          this.qr.status = "failed";
          return;
        }
      } catch (e) {
        if (gen !== this.loginGeneration) return;
        if (e.kind !== "network") {
          if (this.qr) this.qr.status = "failed";
          return;
        }
      }
      await pause(1500);
    }
    if (this.qr && gen === this.loginGeneration && Date.now() >= until)
      this.qr.status = "expired";
  }
  async pairingConfirmImpl() {
    if (!this.qr?.candidate || this.qr.status !== "confirmed")
      throw new Error("OWNER_UNVERIFIED");
    const a = this.qr.candidate;
    this.store.resetAccount();
    this.store.set("account", this.vault.seal(a));
    this.qr = void 0;
    this.loginGeneration++;
    return this.status();
  }
  async unbindImpl() {
    this.loginGeneration++;
    await this.stopImpl();
    this.qr = void 0;
    this.store.resetAccount();
    this.interactions.clear();
    return this.status();
  }
  async bind(sessionId, revision) {
    const targets = await this.dsh.getTargets();
    if (!targets.some((t) => t.sessionId === sessionId))
      throw new Error("SESSION_UNAVAILABLE");
    this.store.bind(sessionId, revision);
    return this.status();
  }
  async startImpl() {
    if (this.running) return this.status();
    const a = this.account();
    if (!a) throw new Error("OWNER_UNVERIFIED");
    if (!this.store.get("binding", null))
      throw new Error("SESSION_UNAVAILABLE");
    await this.rpc.call("configure", { token: a.token, baseUrl: a.baseUrl });
    this.running = true;
    this.connection = "connected";
    const gen = ++this.generation;
    try {
      await Promise.all(
        this.store.incoming().filter(
          (m) => m.sessionId && m.dshMessageId && ["accepted", "running", "uncertain"].includes(m.state)
        ).map((m) => this.dsh.watch(m.sessionId, m.dshMessageId))
      );
    } catch (error) {
      await this.stopImpl();
      throw error;
    }
    this.pollTask = this.pollLoop(gen);
    this.pumpTimer = setInterval(() => {
      void this.pump();
      this.expireInteractions();
    }, 1e3);
    void this.pump();
    return this.status();
  }
  async stopImpl() {
    this.running = false;
    this.generation++;
    this.connection = "stopped";
    if (this.pumpTimer) clearInterval(this.pumpTimer);
    await this.rpc.stop();
    await this.pollTask?.catch(() => {
    });
    while (this.pumping) await pause(20);
    return this.status();
  }
  async pollLoop(gen) {
    let failures = 0;
    while (this.running && gen === this.generation) {
      try {
        const cursor = this.store.get("cursor", ""), epoch = this.store.epoch;
        const data = await this.rpc.call("poll", { cursor });
        if (!this.running || gen !== this.generation) return;
        const owner = this.account()?.ownerId;
        const bot = this.account()?.botId;
        const valid = data.msgs.filter(
          (m) => m.from_user_id === owner && (!m.to_user_id || m.to_user_id === bot) && !m.group_id && m.message_type === 1 && m.message_state === 2
        );
        const entries = valid.map((m) => ({
          providerId: m.message_id ?? `unidentified:${createHash2("sha256").update(JSON.stringify(m)).digest("hex")}`,
          text: (m.item_list ?? []).filter((x) => x.type === 1).map((x) => x.text_item?.text ?? "").join("\n"),
          payload: this.vault.seal(m)
        }));
        const newestContext = valid.filter((m) => m.context_token).at(-1)?.context_token;
        this.store.ingestBatch(
          cursor,
          data.get_updates_buf,
          epoch,
          entries,
          newestContext ? this.vault.seal({ value: newestContext, epoch }) : void 0
        );
        if (newestContext) {
          for (const out of this.store.outgoing())
            if (out.state === "waiting_context")
              this.store.update(out.id, "queued");
        }
        failures = 0;
        this.connection = "connected";
        this.store.set("lastPoll", Date.now());
        void this.pump();
        if (!data.msgs.length) await pause(300);
      } catch (error) {
        if (!this.running || gen !== this.generation) return;
        failures++;
        this.connection = "reconnecting";
        if (error.remoteCode === -14) {
          this.connection = "auth_required";
          this.running = false;
          return;
        }
        await this.delay(Math.min(6e4, 1e3 * 2 ** Math.min(failures, 6)));
        if (!this.running || gen !== this.generation) return;
      }
    }
  }
  async pump() {
    if (this.pumping || !this.running) return;
    this.pumping = true;
    try {
      await this.receive();
      await this.deliver();
    } catch {
    } finally {
      this.pumping = false;
    }
  }
  async receive() {
    const blocked = /* @__PURE__ */ new Set();
    for (const m of this.store.incoming()) {
      if (!this.running) return;
      if (m.text.startsWith("/") && m.state === "received") {
        await this.command(m);
        continue;
      }
      const key = m.sessionId ?? "unbound";
      if (blocked.has(key)) continue;
      if (m.state === "failed" && this.store.get(`terminal:${m.id}`, false))
        continue;
      if (["failed", "uncertain", "preparing"].includes(m.state)) {
        blocked.add(key);
        continue;
      }
      if (["accepted", "running"].includes(m.state)) {
        if (m.sessionId && m.dshMessageId) {
          const obs = await this.dsh.reconcile(m.sessionId, m.dshMessageId);
          this.applyObservation(m, obs);
        }
        continue;
      }
      if (m.state !== "received" && m.state !== "ready") continue;
      try {
        if (!m.sessionId) throw new Error("SESSION_UNAVAILABLE");
        if (m.providerId?.startsWith("unidentified:"))
          throw new Error("UNSTABLE_MESSAGE_ID");
        if (m.state === "received") {
          this.store.update(m.id, "preparing");
          const raw = this.vault.open(m.payload);
          const attachments = [];
          for (const item of raw.item_list ?? []) {
            if (item.type === 1) continue;
            if (item.type !== 2 && item.type !== 4)
              throw new Error("UNSUPPORTED_MESSAGE");
            const kind = item.type === 2 ? "image" : "file";
            const bytes = await this.rpc.call("download", {
              item,
              maxBytes: kind === "image" ? 20 * 1024 ** 2 : 100 * 1024 ** 2
            });
            if (!this.running) {
              if (this.store.message(m.id)?.state === "preparing")
                this.store.update(m.id, "received");
              return;
            }
            if (this.store.message(m.id)?.state !== "preparing" || m.epoch !== this.store.epoch)
              break;
            const b = Buffer.from(bytes);
            const mime = kind === "image" ? imageMime(b) : "application/octet-stream";
            attachments.push(
              await this.files.save(
                b,
                kind === "file" ? item.file_item?.file_name ?? "\u6587\u4EF6" : "\u56FE\u7247",
                mime,
                kind
              )
            );
          }
          if (this.store.message(m.id)?.state !== "preparing" || m.epoch !== this.store.epoch)
            continue;
          if (!m.text.trim() && !attachments.length)
            throw new Error("EMPTY_MESSAGE");
          this.store.attachments(m.id, attachments);
          this.store.update(m.id, "ready");
        }
        const fresh = this.store.message(m.id);
        if (fresh.state !== "ready" || fresh.epoch !== this.store.epoch)
          continue;
        this.store.update(m.id, "uncertain", "SUBMISSION_UNCERTAIN");
        const observation = await this.dsh.submit({
          sessionId: fresh.sessionId,
          messageId: fresh.dshMessageId,
          text: fresh.text,
          attachments: fresh.attachments.map((a) => ({
            kind: a.kind,
            path: a.path,
            name: a.name,
            mediaType: a.mime
          }))
        });
        this.applyObservation(fresh, observation);
      } catch (e) {
        const current = this.store.message(m.id);
        if (!this.running && current.state === "preparing")
          this.store.update(m.id, "received");
        else if (!["uncertain", "cancelled"].includes(current.state))
          this.store.update(m.id, "failed", safeCode(e));
        blocked.add(key);
      }
    }
  }
  applyObservation(m, o) {
    if (this.closed || m.epoch !== this.store.epoch) return;
    const state = {
      absent: "uncertain",
      queued: "accepted",
      running: "running",
      completed: "completed",
      cancelled: "cancelled",
      failed: "failed",
      unknown: "uncertain"
    };
    this.store.transaction(() => {
      const priorSeq = this.store.get(`dsh-seq:${m.id}`, -1);
      if (typeof o.seq === "number" && o.seq < priorSeq) return;
      if (this.store.get(`terminal:${m.id}`, false) && !["completed", "failed", "cancelled"].includes(o.state))
        return;
      if (typeof o.seq === "number") this.store.set(`dsh-seq:${m.id}`, o.seq);
      if (typeof o.turn === "number")
        this.store.set(`dsh-turn:${m.id}`, o.turn);
      this.store.update(
        m.id,
        state[o.state],
        o.state === "unknown" || o.state === "absent" ? "SUBMISSION_UNCERTAIN" : o.state === "failed" ? o.reason ?? "DSH_EXECUTION_FAILED" : null
      );
      if (["completed", "failed", "cancelled"].includes(o.state)) {
        this.store.set(`terminal:${m.id}`, true);
        const text = o.text || {
          completed: "\u4EFB\u52A1\u5DF2\u5B8C\u6210\u3002",
          failed: "\u4EFB\u52A1\u6267\u884C\u5931\u8D25\uFF0C\u8BF7\u5728 DSH \u67E5\u770B\u8BE6\u60C5\u3002",
          cancelled: "\u4EFB\u52A1\u5DF2\u505C\u6B62\u3002"
        }[o.state];
        this.enqueueText(text, m, `result:${m.epoch}:${m.id}`);
      }
    });
  }
  enqueueText(text, m, source) {
    const chars = Array.from(text);
    for (let i = 0; i < chars.length; i += 2e3)
      this.store.enqueue({
        text: chars.slice(i, i + 2e3).join(""),
        sessionId: m.sessionId ?? void 0,
        submissionId: m.id,
        source: `${source}:${i / 2e3}`
      });
  }
  event(e) {
    if (this.closed) return;
    const ordered = e.type === "deliverables/presented" || e.type === "submission" && ["completed", "failed", "cancelled"].includes(e.state);
    if (!ordered) {
      this.processEvent(e);
      return;
    }
    const operation = this.deliverableQueue.then(() => this.processEvent(e));
    this.deliverableQueue = operation.catch((error) => {
      const key = e.type === "deliverables/presented" ? `${e.sessionId}:${e.callId}` : `${e.sessionId}:${e.messageId}`;
      this.store.set(`deliverable-error:${key}`, safeCode(error));
    });
  }
  async processEvent(e) {
    if (this.closed) return;
    if (e.type === "deliverables/presented") {
      await this.enqueuePresentedFiles(e);
    } else if (e.type === "submission") {
      const m = this.store.submission(e.sessionId, e.messageId);
      if (m) this.applyObservation(m, e);
    } else if (e.type === "interaction") {
      const m = this.store.submission(e.sessionId, e.messageId);
      if (!m || !this.running) return;
      if ([...this.interactions.values()].some((i) => i.rpcId === e.rpcId))
        return;
      const id = randomUUID5().slice(0, 8);
      const desc = interactionDescription(e.kind, e.payload);
      const item = {
        id,
        kind: e.kind,
        description: desc,
        expiresAt: Date.now() + 5 * 6e4,
        state: "pending",
        sessionId: e.sessionId,
        rpcId: e.rpcId,
        messageId: e.messageId,
        payload: e.payload
      };
      this.interactions.set(id, item);
      this.store.db.prepare("INSERT INTO interactions(id,payload,state) VALUES(?,?,?)").run(id, JSON.stringify(item), "pending");
      this.store.enqueue({
        text: `${desc}
${e.kind === "approval" ? `\u56DE\u590D /approve ${id} \u540C\u610F\uFF0C/deny ${id} \u62D2\u7EDD` : `\u56DE\u590D /answer ${id} \u4F60\u7684\u56DE\u7B54`}
5 \u5206\u949F\u5185\u6709\u6548\u3002`,
        submissionId: m.id,
        sessionId: e.sessionId,
        source: `interaction:${this.store.epoch}:${e.rpcId}:${id}`,
        payload: { control: true, interactionId: id }
      });
    } else if (e.type === "interaction-resolved") {
      for (const [id, item] of this.interactions)
        if (item.rpcId === e.rpcId) {
          item.state = "resolved";
          this.store.cancelInteractionDelivery(id);
          this.store.db.prepare("UPDATE interactions SET state='resolved' WHERE id=?").run(id);
        }
    }
  }
  async enqueuePresentedFiles(event) {
    const submission = this.store.submission(event.sessionId, event.messageId);
    if (!submission || !this.running) return;
    for (const [index, file] of event.files.entries()) {
      if (!this.running) return;
      const source = `presented:${submission.epoch}:${event.callId}:${index}`;
      if (this.store.messageBySource(source)) continue;
      const path = isAbsolute3(file.path) ? file.path : resolve(event.cwd, file.path);
      const attachment = await this.files.snapshot(path, [event.cwd]);
      this.store.enqueue({
        text: "",
        attachments: [attachment],
        sessionId: event.sessionId,
        submissionId: submission.id,
        source
      });
    }
    void this.pump();
  }
  listInteractions() {
    return {
      items: [...this.interactions.values()].map(
        ({ rpcId, payload, messageId, ...safe }) => safe
      )
    };
  }
  async resolveInteraction(id, decision, text) {
    const i = this.interactions.get(id);
    if (!i || i.state !== "pending" || i.expiresAt <= Date.now())
      throw new Error("INTERACTION_EXPIRED");
    i.state = "resolving";
    try {
      if (i.kind === "approval") {
        const ok = await this.dsh.answerApproval(
          i.rpcId,
          decision === "approve" ? "allowed-once" : "rejected"
        );
        if (ok === false) throw new Error("INTERACTION_EXPIRED");
      } else {
        if (!text?.trim()) throw new Error("ANSWER_REQUIRED");
        const questions = i.payload.questions ?? [];
        if (questions.length !== 1) throw new Error("ANSWER_IN_DSH_REQUIRED");
        const ok = await this.dsh.answerQuestions(i.rpcId, {
          answers: [{ id: questions[0].id, selected: [], custom: text }]
        });
        if (ok === false) throw new Error("INTERACTION_EXPIRED");
      }
      if (i.state !== "resolved") i.state = "submitted";
      this.store.cancelInteractionDelivery(id);
      this.store.db.prepare("UPDATE interactions SET state=? WHERE id=?").run(i.state, id);
    } catch (e) {
      i.state = safeCode(e) === "INTERACTION_EXPIRED" ? "expired" : safeCode(e) === "DSH_INTERACTION_RESPONSE_FAILED" ? "uncertain" : "pending";
      throw e;
    }
    return { ok: true };
  }
  expireInteractions() {
    for (const [id, i] of this.interactions)
      if (i.state === "pending" && Date.now() >= i.expiresAt) {
        i.state = "expired";
        this.store.cancelInteractionDelivery(id);
        this.store.db.prepare("UPDATE interactions SET state='expired' WHERE id=?").run(id);
        if (i.kind === "approval")
          void this.dsh.answerApproval(i.rpcId, "rejected").catch(() => {
          });
      }
  }
  async command(m) {
    try {
      const [command, id, ...rest] = m.text.trim().split(/\s+/);
      let text;
      if (command === "/stop") {
        await this.stopSession(m.sessionId ?? "");
        text = "\u5DF2\u8BF7\u6C42\u505C\u6B62\u5FAE\u4FE1\u53D1\u8D77\u7684\u4EFB\u52A1\u3002";
      } else if (command === "/approve" || command === "/deny") {
        await this.resolveInteraction(
          id,
          command === "/approve" ? "approve" : "deny"
        );
        text = "\u7B54\u590D\u5DF2\u63D0\u4EA4\uFF0C\u6700\u7EC8\u72B6\u6001\u4EE5 DSH \u4E3A\u51C6\u3002";
      } else if (command === "/answer") {
        await this.resolveInteraction(id, "answer", rest.join(" "));
        text = "\u56DE\u7B54\u5DF2\u63D0\u4EA4\u3002";
      } else if (command === "/status")
        text = `\u8FDE\u63A5\uFF1A${this.connection}
\u4F1A\u8BDD\uFF1A${m.sessionId ?? "\u672A\u7ED1\u5B9A"}`;
      else
        text = "\u652F\u6301 /status \u67E5\u770B\u72B6\u6001\uFF0C/stop \u505C\u6B62\u5FAE\u4FE1\u4EFB\u52A1\uFF1B\u5176\u4ED6\u6587\u5B57\u76F4\u63A5\u4EA4\u7ED9 DSH\u3002";
      this.store.update(m.id, "completed");
      this.enqueueText(text, m, `command:${m.id}`);
    } catch (e) {
      this.store.update(m.id, "failed", safeCode(e));
      this.enqueueText(
        "\u6307\u4EE4\u672A\u5B8C\u6210\uFF0C\u8BF7\u5728\u7535\u8111\u7AEF\u67E5\u770B\u5F53\u524D\u72B6\u6001\u3002",
        m,
        `command:${m.id}`
      );
    }
  }
  async stopSession(sessionId) {
    for (const m of this.store.incoming())
      if (m.sessionId === sessionId) {
        if (["accepted", "running", "uncertain"].includes(m.state))
          await this.dsh.cancel(sessionId, m.dshMessageId);
        else if (!m.text.startsWith("/")) this.store.update(m.id, "cancelled");
      }
    return { ok: true };
  }
  async deliver() {
    const account = this.account();
    if (!account) return;
    const contextCipher = this.store.get("context", null);
    const context = contextCipher ? this.vault.open(contextCipher) : void 0;
    const blocked = /* @__PURE__ */ new Set();
    const out = this.store.outgoing().sort(
      (a, b) => Number(Boolean(b.payload?.control)) - Number(Boolean(a.payload?.control))
    );
    for (const m of out) {
      if (!this.running) return;
      const key = m.submissionId ?? m.id;
      const control = Boolean(m.payload?.control);
      if (!control && blocked.has(key)) continue;
      if (!["queued", "retry_wait"].includes(m.state) || m.nextAttempt > Date.now()) {
        if (!control) blocked.add(key);
        continue;
      }
      if (!context || context.epoch !== m.epoch) {
        this.store.update(m.id, "waiting_context");
        blocked.add(key);
        continue;
      }
      let sendStarted = false;
      try {
        this.store.attempt(m.id);
        const items = [];
        if (m.text) items.push({ type: 1, text_item: { text: m.text } });
        for (const a of m.attachments) {
          const bytes = await this.files.read(a);
          items.push(
            await this.rpc.call("upload", {
              bytes,
              toUserId: account.ownerId,
              kind: a.kind,
              fileName: a.name
            })
          );
        }
        if (!this.running) {
          this.store.update(m.id, "queued");
          return;
        }
        sendStarted = true;
        await this.rpc.call("send", {
          toUserId: account.ownerId,
          contextToken: context.value,
          clientId: m.clientId,
          items
        });
        this.store.update(m.id, "sent");
      } catch (e) {
        const err = e;
        const current = this.store.message(m.id);
        this.store.set(`delivery-diagnostic:${m.id}`, {
          phase: sendStarted ? "send" : "prepare",
          kind: err.kind ?? "unknown",
          code: err.remoteCode ?? null,
          reason: deliveryReason(err),
          at: Date.now()
        });
        if (sendStarted && current.state === "sending" && (!err.kind || err.kind === "uncertain"))
          this.store.update(m.id, "uncertain", "DELIVERY_UNCERTAIN");
        else if (err.remoteCode === -2 || err.remoteCode === -14)
          this.store.update(
            m.id,
            "waiting_context",
            "DELIVERY_WAITING_CONTEXT"
          );
        else if (current.attempts >= 8 || err.kind === "protocol")
          this.store.update(m.id, "failed", safeCode(err));
        else
          this.store.defer(
            m.id,
            "retry_wait",
            safeCode(err),
            Math.min(6e4, 1e3 * 2 ** current.attempts)
          );
        blocked.add(key);
      }
    }
  }
  listMessages(options) {
    const result = this.store.list(options);
    return {
      items: result.items.map((m) => this.view(m)),
      nextCursor: result.nextCursor
    };
  }
  view(m) {
    return {
      id: m.id,
      direction: m.direction,
      text: m.text,
      state: m.state,
      createdAt: m.createdAt,
      sessionId: m.sessionId ?? void 0,
      submissionId: m.submissionId ?? void 0,
      deliveryId: m.direction === "out" ? m.id : void 0,
      error: m.error ?? void 0,
      attachments: m.attachments.map((a) => ({
        id: a.id,
        name: a.name,
        mime: a.mime,
        size: a.size,
        url: `/dsh-wechat-channel/api/attachments/${a.id}`
      }))
    };
  }
  async sendAttachment(sessionId, messageId, path, callId) {
    const m = this.store.submission(sessionId, messageId);
    if (!m) throw new Error("NO_WECHAT_SUBMISSION");
    const target = (await this.dsh.getTargets()).find(
      (t) => t.sessionId === sessionId
    );
    if (!target?.cwd) throw new Error("WORKSPACE_UNAVAILABLE");
    const a = await this.files.snapshot(path, [target.cwd]);
    this.store.enqueue({
      text: "",
      attachments: [a],
      sessionId,
      submissionId: m.id,
      source: `attachment:${m.epoch}:${callId}:${a.sha256}`
    });
    return { queued: true };
  }
  async delay(ms) {
    const until = Date.now() + ms;
    while (this.running && Date.now() < until)
      await pause(Math.min(100, until - Date.now()));
  }
  async retryMessage(id) {
    const m = this.store.message(id);
    if (!m || m.direction !== "in" || m.epoch !== this.store.epoch || m.state !== "failed")
      throw new Error("INVALID_STATE");
    if (m.sessionId && m.dshMessageId) {
      const obs = await this.dsh.reconcile(m.sessionId, m.dshMessageId);
      if (obs.state !== "absent") throw new Error("ALREADY_SUBMITTED");
    }
    this.store.update(id, "received");
    return { ok: true };
  }
  async cancelMessage(id) {
    const m = this.store.message(id);
    if (!m || m.direction !== "in" || m.epoch !== this.store.epoch)
      throw new Error("NOT_FOUND");
    if (m.sessionId && m.dshMessageId && ["accepted", "running", "uncertain"].includes(m.state))
      await this.dsh.cancel(m.sessionId, m.dshMessageId);
    this.store.update(id, "cancelled");
    return { ok: true };
  }
  async close() {
    await this.stop();
    this.closed = true;
    this.loginGeneration++;
    this.unsubscribe();
    await this.deliverableQueue.catch(() => {
    });
    await this.dsh.dispose();
    this.store.close();
  }
};
function safeCode(e) {
  const message = e instanceof Error ? e.message : "";
  return /^[A-Z_]{3,80}$/.test(message) ? message : "OPERATION_FAILED";
}
function imageMime(b) {
  if (b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return "image/png";
  if (b[0] === 255 && b[1] === 216) return "image/jpeg";
  if (b.subarray(0, 3).toString() === "GIF") return "image/gif";
  if (b.subarray(8, 12).toString() === "WEBP") return "image/webp";
  throw new Error("UNSUPPORTED_IMAGE");
}
function interactionDescription(kind, p) {
  if (kind === "approval")
    return `DSH \u8BF7\u6C42\u786E\u8BA4\uFF1A${String(p.toolName ?? "\u5DE5\u5177\u64CD\u4F5C")}
${String(p.reason ?? "\u8BF7\u5728\u7535\u8111\u7AEF\u6838\u5BF9\u64CD\u4F5C\u8BE6\u60C5")}`;
  const qs = p.questions;
  return qs?.map((q) => q.question ?? q.header ?? "\u8BF7\u56DE\u7B54").join("\n") ?? "DSH \u9700\u8981\u8865\u5145\u4FE1\u606F\uFF0C\u8BF7\u5728\u7535\u8111\u7AEF\u67E5\u770B\u8BE6\u60C5\u3002";
}
var pause = (ms) => new Promise((r) => setTimeout(r, ms));
function deliveryReason(error) {
  const value = error.message;
  if (/^iLink HTTP \d{3}$/.test(value) || /^iLink rejected request \(-?\d+\)$/.test(value) || /^WORKER_[A-Z_]+$/.test(value))
    return value;
  if ([
    "Send acceptance not confirmed",
    "Invalid iLink response",
    "iLink request interrupted or network unavailable"
  ].includes(value))
    return value;
  return "OPERATION_FAILED";
}

// src/host/http.ts
function allowedRequest(req) {
  const remote = req.socket.remoteAddress;
  if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote ?? ""))
    return false;
  let url;
  try {
    url = new URL(`http://${req.headers.host}`);
  } catch {
    return false;
  }
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return false;
  if (req.headers.origin && req.headers.origin !== url.origin) return false;
  if (req.method !== "GET" && (req.headers["x-dsh-wechat-channel"] !== "1" || !req.headers["content-type"]?.startsWith("application/json")))
    return false;
  return true;
}
async function body(req) {
  let n = 0;
  const chunks = [];
  for await (const chunk of req) {
    n += chunk.length;
    if (n > 65536) throw new Error("BODY_TOO_LARGE");
    chunks.push(chunk);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString() || "{}");
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("INVALID_BODY");
  return value;
}
var strings = (x) => typeof x === "string" ? x : "";
function handler(service, connection) {
  return async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    const json = (status, value) => {
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8"
      });
      res.end(JSON.stringify(value));
    };
    if (!allowedRequest(req)) {
      json(403, {
        error: { code: "FORBIDDEN", message: "\u4EC5\u5141\u8BB8\u672C\u673A DSH \u9875\u9762\u64CD\u4F5C" }
      });
      return;
    }
    const rejection = connection.requestRejection(req);
    if (rejection !== void 0) {
      json(rejection, {
        error: {
          code: rejection === 401 ? "UNAUTHORIZED" : "FORBIDDEN",
          message: rejection === 401 ? "\u8BF7\u4F7F\u7528 DSH \u542F\u52A8\u94FE\u63A5\u767B\u5F55\u540E\u91CD\u8BD5" : "\u4EC5\u5141\u8BB8\u672C\u673A DSH \u9875\u9762\u64CD\u4F5C"
        }
      });
      return;
    }
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      const path = url.pathname.replace(/^\/dsh-wechat-channel\/api/, "");
      let result;
      if (req.method === "GET") {
        if (path === "/status") result = service.status();
        else if (path === "/sessions")
          result = { items: await service.dsh.getTargets() };
        else if (path === "/interactions") result = service.listInteractions();
        else if (path === "/messages") {
          const n = Number(url.searchParams.get("before"));
          result = service.listMessages({
            before: Number.isFinite(n) && n > 0 ? n : void 0,
            state: url.searchParams.get("state") ?? void 0,
            direction: url.searchParams.get("direction") ?? void 0
          });
        } else if (path.startsWith("/attachments/")) {
          const a = service.store.attachment(
            decodeURIComponent(path.slice("/attachments/".length))
          );
          if (!a) throw new Error("NOT_FOUND");
          const bytes = await service.files.read(a);
          const image = [
            "image/png",
            "image/jpeg",
            "image/gif",
            "image/webp"
          ].includes(a.mime);
          res.writeHead(200, {
            "Content-Type": image ? a.mime : "application/octet-stream",
            "Content-Length": bytes.length,
            "Content-Disposition": `${image ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(a.name)}`,
            "Content-Security-Policy": "default-src 'none'; sandbox"
          });
          res.end(bytes);
          return;
        } else throw new Error("NOT_FOUND");
      } else if (req.method === "POST") {
        const data = await body(req);
        if (path === "/pairing/start") result = await service.pairingStart();
        else if (path === "/pairing/confirm")
          result = await service.pairingConfirm();
        else if (path === "/unbind" || path === "/pairing/unbind")
          result = await service.unbind();
        else if (path === "/connection/start") result = await service.start();
        else if (path === "/connection/stop") result = await service.stop();
        else if (path === "/connection/reconnect") {
          await service.stop();
          result = await service.start();
        } else if (path === "/binding")
          result = await service.bind(
            strings(data.sessionId),
            Number(data.expectedRevision ?? 0)
          );
        else if (/^\/deliveries\/[^/]+\/retry$/.test(path)) {
          service.store.retry(
            decodeURIComponent(path.split("/")[2]),
            data.allowDuplicate === true
          );
          result = { ok: true };
        } else if (/^\/messages\/[^/]+\/retry$/.test(path))
          result = await service.retryMessage(
            decodeURIComponent(path.split("/")[2])
          );
        else if (/^\/messages\/[^/]+\/cancel$/.test(path))
          result = await service.cancelMessage(
            decodeURIComponent(path.split("/")[2])
          );
        else if (/^\/sessions\/[^/]+\/stop$/.test(path))
          result = await service.stopSession(
            decodeURIComponent(path.split("/")[2])
          );
        else if (/^\/interactions\/[^/]+\/resolve$/.test(path)) {
          const decision = strings(data.decision);
          if (!["approve", "deny", "answer"].includes(decision))
            throw new Error("INVALID_DECISION");
          result = await service.resolveInteraction(
            decodeURIComponent(path.split("/")[2]),
            decision,
            strings(data.text)
          );
        } else throw new Error("NOT_FOUND");
      } else {
        json(405, {
          error: { code: "METHOD_NOT_ALLOWED", message: "\u4E0D\u652F\u6301\u8BE5\u64CD\u4F5C" }
        });
        return;
      }
      json(200, result);
    } catch (e) {
      const code = safeCode(e);
      json(code === "NOT_FOUND" ? 404 : 409, {
        error: { code, message: errorCopy[code] ?? `\u64CD\u4F5C\u672A\u5B8C\u6210\uFF08${code}\uFF09` }
      });
    }
  };
}
var errorCopy = {
  OWNER_UNVERIFIED: "\u8BF7\u5148\u626B\u7801\uFF0C\u5E76\u5728\u7535\u8111\u7AEF\u786E\u8BA4\u672C\u4EBA\u8EAB\u4EFD",
  SESSION_UNAVAILABLE: "\u8BF7\u5148\u9009\u62E9\u4E00\u4E2A\u53EF\u7528\u7684 DSH \u4F1A\u8BDD",
  REVISION_CONFLICT: "\u914D\u7F6E\u5DF2\u53D8\u66F4\uFF0C\u8BF7\u5237\u65B0\u9875\u9762",
  INTERACTION_EXPIRED: "\u786E\u8BA4\u8BF7\u6C42\u5DF2\u5931\u6548",
  ANSWER_IN_DSH_REQUIRED: "\u6B64\u95EE\u9898\u5305\u542B\u591A\u4E2A\u5B57\u6BB5\uFF0C\u8BF7\u5728 DSH \u4E2D\u56DE\u7B54",
  ALREADY_SUBMITTED: "\u8BE5\u6D88\u606F\u5DF2\u4EA4\u7ED9 DSH\uFF0C\u8BF7\u67E5\u770B\u6267\u884C\u7ED3\u679C\uFF0C\u4E0D\u80FD\u91CD\u590D\u63D0\u4EA4",
  DUPLICATE_CONFIRMATION_REQUIRED: "\u53D1\u9001\u7ED3\u679C\u672A\u77E5\uFF0C\u8BF7\u786E\u8BA4\u5FAE\u4FE1\u662F\u5426\u6536\u5230\u540E\u518D\u91CD\u53D1",
  ATTACHMENT_CORRUPT: "\u9644\u4EF6\u5DF2\u635F\u574F\uFF0C\u65E0\u6CD5\u8BFB\u53D6"
};

// src/dsh/attachment-tool.ts
import { isAbsolute as isAbsolute4 } from "node:path";
function registerAttachmentTool(context, adapter, enqueue) {
  return context.tools.register({
    name: "wechat_send_attachment",
    description: "Send an existing local image or file to the owner of the current WeChat task. Use only when this task was received from WeChat. The path must be absolute and inside the current project. This queues delivery; it does not confirm receipt.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute path of the existing image or file to send"
        }
      },
      required: ["path"],
      additionalProperties: false
    },
    output: {
      schema: {
        type: "object",
        properties: { queued: { type: "boolean" } },
        required: ["queued"],
        additionalProperties: false
      },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }]
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      const path = args !== null && typeof args === "object" ? args.path : void 0;
      if (typeof path !== "string" || !isAbsolute4(path))
        throw new Error("WECHAT_ATTACHMENT_ABSOLUTE_PATH_REQUIRED");
      const messageId = exec.agent && adapter.currentSubmission(exec.agent);
      if (!exec.agent || !messageId)
        throw new Error("WECHAT_ATTACHMENT_REQUIRES_CURRENT_WECHAT_TASK");
      return enqueue(exec.agent.id, messageId, path, exec.callId);
    }
  });
}

// src/host/index.ts
var name = "dsh-wechat-channel";
var inject = [
  "agents",
  "sessions",
  "sessionQuery",
  "sessionController",
  "typertGateway",
  "attachments",
  "webServer",
  "connection",
  "tools"
];
function apply(ctx, config = {}) {
  const host = ctx;
  if (host.webServer.host !== "127.0.0.1")
    throw new Error("DSH_WECHAT_REQUIRES_LOOPBACK_HOST");
  const root = resolve2(
    config.dataDir ?? join4(
      process.env.DSH_HOME?.trim() || join4(homedir(), ".dsh"),
      "plugins",
      "wechat-channel"
    )
  );
  mkdirSync3(root, { recursive: true, mode: 448 });
  const lock = join4(root, "host.lock");
  try {
    const fd = openSync(lock, "wx", 384);
    writeFileSync2(fd, String(process.pid));
    closeSync(fd);
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    const pid = Number(readFileSync2(lock, "utf8"));
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch (err) {
      if (err.code === "ESRCH") alive = false;
    }
    if (alive || !Number.isSafeInteger(pid) || pid <= 0)
      throw new Error("WECHAT_HOST_ALREADY_RUNNING");
    unlinkSync(lock);
    const fd = openSync(lock, "wx", 384);
    writeFileSync2(fd, String(process.pid));
    closeSync(fd);
  }
  let service;
  let adapter;
  try {
    adapter = new DshAdapter(host);
    service = new WechatService(root, adapter);
  } catch (e) {
    unlinkSync(lock);
    throw e;
  }
  let unregister = () => {
  };
  let unregisterTool = () => {
  };
  ctx.effect(() => async () => {
    unregisterTool();
    unregister();
    await service.close();
    try {
      unlinkSync(lock);
    } catch {
    }
  });
  unregister = host.webServer.register({
    kind: "prefix",
    path: "/dsh-wechat-channel/api",
    handler: handler(service, host.connection)
  });
  unregisterTool = registerAttachmentTool(
    ctx,
    adapter,
    service.sendAttachment.bind(service)
  );
  if (config.autoStart && service.account() && service.status().binding)
    void service.start().catch(() => {
    });
}
export {
  apply,
  inject,
  name
};
