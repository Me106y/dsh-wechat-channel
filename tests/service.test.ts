import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WechatService,
  type AgentPort,
  type Transport,
} from "../src/core/service.js";
import type {
  DshEvent,
  DshReconciliation,
  DshSubmission,
} from "../src/dsh/types.js";
class Agent implements AgentPort {
  inputs: DshSubmission[] = [];
  states = new Map<string, DshReconciliation>();
  listener: (e: DshEvent) => void = () => {};
  getTargets() {
    return [{ sessionId: "session", cwd: tmpdir() }];
  }
  subscribe(f: (e: DshEvent) => void) {
    this.listener = f;
    return () => {};
  }
  async submit(i: DshSubmission) {
    this.inputs.push(i);
    const r = {
      sessionId: i.sessionId,
      messageId: i.messageId,
      state: "queued" as const,
    };
    this.states.set(i.messageId, r);
    return r;
  }
  async reconcile(s: string, m: string) {
    return (
      this.states.get(m) ?? {
        sessionId: s,
        messageId: m,
        state: "absent" as const,
      }
    );
  }
  async watch() {}
  async cancel() {}
  async answerApproval() {}
  async answerQuestions() {}
  async dispose() {}
  complete() {
    const i = this.inputs[0];
    const r = {
      sessionId: i.sessionId,
      messageId: i.messageId,
      state: "completed" as const,
      text: "result",
      seq: 9,
    };
    this.states.set(i.messageId, r);
    this.listener({ type: "submission", ...r });
  }
}
class Worker implements Transport {
  sent: any[] = [];
  failSend?: unknown;
  downloadError?: Error;
  async call<T>(method: string, p: unknown): Promise<T> {
    if (method === "send") {
      this.sent.push(p);
      if (this.failSend) throw this.failSend;
    }
    if (method === "download") {
      if (this.downloadError) throw this.downloadError;
      return Buffer.from("file") as T;
    }
    return true as T;
  }
  async stop() {}
}
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "wechat-service-"));
  const a = new Agent(),
    w = new Worker(),
    s = new WechatService(dir, a, w);
  s.store.set(
    "account",
    s.vault.seal({
      token: "secret",
      ownerId: "owner",
      botId: "bot",
      baseUrl: "https://ilinkai.weixin.qq.com",
    }),
  );
  s.store.bind("session", 0);
  s.store.set("context", s.vault.seal({ value: "ctx", epoch: 1 }));
  const driver = s as unknown as {
    running: boolean;
    deliverableQueue: Promise<unknown>;
    receive(): Promise<void>;
    deliver(): Promise<void>;
  };
  driver.running = true;
  return {
    s,
    a,
    w,
    driver,
    async close() {
      driver.running = false;
      await s.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
function ingest(
  f: Awaited<ReturnType<typeof setup>>,
  id: string,
  text: string,
  items: unknown[] = [],
) {
  const cursor = f.s.store.get("cursor", "");
  return f.s.store.ingestBatch(cursor, id, 1, [
    {
      providerId: id,
      text,
      payload: f.s.vault.seal({ message_id: id, item_list: items }),
    },
  ])[0];
}
test("text handoff is durable and result replay creates one outbound delivery", async () => {
  const f = await setup();
  try {
    const id = ingest(f, "1", "hi", [{ type: 1, text_item: { text: "hi" } }]);
    await f.driver.receive();
    assert.equal(f.a.inputs.length, 1);
    await f.driver.receive();
    assert.equal(f.a.inputs.length, 1);
    assert.equal(f.s.store.message(id)?.state, "accepted");
    f.a.complete();
    f.a.complete();
    await f.driver.deliverableQueue;
    assert.equal(f.s.store.outgoing().length, 1);
    await f.driver.deliver();
    assert.equal(f.w.sent.length, 1);
    assert.equal(f.s.store.list().items[0].state, "sent");
  } finally {
    await f.close();
  }
});
test("presented deliverables become deduplicated immutable WeChat attachments before result text", async () => {
  const f = await setup();
  try {
    const sourcePath = join(f.s.root, "shot.png");
    await writeFile(sourcePath, "first-image");
    ingest(f, "1", "make a screenshot");
    await f.driver.receive();
    const input = f.a.inputs[0];
    const event: DshEvent = {
      type: "deliverables/presented",
      sessionId: "session",
      messageId: input.messageId,
      turn: 1,
      callId: "present-call",
      cwd: tmpdir(),
      files: [{ path: sourcePath, description: "screen" }],
    };
    f.a.listener(event);
    f.a.listener(event);
    await f.driver.deliverableQueue;
    const attachmentRows = f.s.store.outgoing();
    assert.equal(attachmentRows.length, 1);
    assert.equal(attachmentRows[0].attachments.length, 1);
    assert.equal(attachmentRows[0].attachments[0].kind, "image");
    assert.equal(attachmentRows[0].attachments[0].mime, "image/png");
    await writeFile(sourcePath, "changed-image");
    assert.equal(
      (await f.s.files.read(attachmentRows[0].attachments[0])).toString(),
      "first-image",
    );
    f.a.complete();
    await f.driver.deliverableQueue;
    const queued = f.s.store.outgoing();
    assert.equal(
      queued.some((message) => message.text === "result"),
      true,
    );
    await f.driver.deliver();
    assert.equal(f.w.sent.length, 2);
    assert.deepEqual((f.w.sent[0] as { items: unknown[] }).items, [true]);
  } finally {
    await f.close();
  }
});

test("presented deliverables outside the matching WeChat submission are ignored", async () => {
  const f = await setup();
  try {
    const sourcePath = join(f.s.root, "desktop.png");
    await writeFile(sourcePath, "desktop");
    f.a.listener({
      type: "deliverables/presented",
      sessionId: "session",
      messageId: "desktop-message",
      turn: 2,
      callId: "desktop-present",
      cwd: tmpdir(),
      files: [{ path: sourcePath }],
    });
    await f.driver.deliverableQueue;
    assert.equal(f.s.store.outgoing().length, 0);
  } finally {
    await f.close();
  }
});

test("failed attachment blocks later text until explicitly cancelled", async () => {
  const f = await setup();
  try {
    const first = ingest(f, "1", "", [
      { type: 4, file_item: { file_name: "x" } },
    ]);
    ingest(f, "2", "explain");
    f.w.downloadError = new Error("ATTACHMENT_FAILED");
    await f.driver.receive();
    assert.equal(f.a.inputs.length, 0);
    assert.equal(f.s.store.message(first)?.state, "failed");
    await f.s.cancelMessage(first);
    await f.driver.receive();
    assert.equal(f.a.inputs.length, 1);
    assert.equal(f.a.inputs[0].text, "explain");
  } finally {
    await f.close();
  }
});
test("unknown acceptance never causes automatic task resubmission", async () => {
  const f = await setup();
  try {
    const id = ingest(f, "1", "hi");
    f.s.store.update(id, "uncertain", "SUBMISSION_UNCERTAIN");
    await f.driver.receive();
    assert.equal(f.a.inputs.length, 0);
  } finally {
    await f.close();
  }
});
test("waiting_context does not retry every tick with the same token", async () => {
  const f = await setup();
  try {
    const id = f.s.store.enqueue({ text: "hello", source: "wait" });
    f.w.failSend = Object.assign(new Error("rejected"), {
      kind: "rejected",
      remoteCode: -2,
    });
    await f.driver.deliver();
    assert.equal(f.s.store.message(id)?.state, "waiting_context");
    await f.driver.deliver();
    assert.equal(f.w.sent.length, 1);
  } finally {
    await f.close();
  }
});
test("ambiguous send remains inspectable rather than retried", async () => {
  const f = await setup();
  try {
    const id = f.s.store.enqueue({ text: "hello", source: "unknown" });
    f.w.failSend = Object.assign(new Error("timeout"), { kind: "uncertain" });
    await f.driver.deliver();
    await f.driver.deliver();
    assert.equal(f.s.store.message(id)?.state, "uncertain");
    assert.equal(f.w.sent.length, 1);
  } finally {
    await f.close();
  }
});
test("cancelling a message while its attachment downloads cannot submit it afterwards", async () => {
  const f = await setup();
  try {
    const id = ingest(f, "1", "", [
      { type: 4, file_item: { file_name: "a.txt" } },
    ]);
    let release!: (b: Uint8Array) => void;
    const normal = f.w.call.bind(f.w);
    f.w.call = async <T>(method: string, p: unknown) =>
      method === "download"
        ? ((await new Promise<Uint8Array>((r) => {
            release = r;
          })) as T)
        : normal<T>(method, p);
    const receiving = f.driver.receive();
    await new Promise((r) => setTimeout(r, 0));
    await f.s.cancelMessage(id);
    release(Buffer.from("hello"));
    await receiving;
    assert.equal(f.s.store.message(id)?.state, "cancelled");
    assert.equal(f.a.inputs.length, 0);
  } finally {
    await f.close();
  }
});
test("a failed DSH turn does not permanently block future ordinary input", async () => {
  const f = await setup();
  try {
    ingest(f, "1", "hi");
    await f.driver.receive();
    const first = f.a.inputs[0];
    f.a.listener({
      type: "submission",
      sessionId: "session",
      messageId: first.messageId,
      state: "failed",
      reason: "error",
    });
    await f.driver.deliverableQueue;
    ingest(f, "2", "next task");
    await f.driver.receive();
    assert.equal(f.a.inputs.length, 2);
  } finally {
    await f.close();
  }
});

test("Gateway acknowledgement is submitted until the authoritative resolution event arrives", async () => {
  const f = await setup();
  try {
    ingest(f, "1", "task");
    await f.driver.receive();
    const input = f.a.inputs[0];
    f.a.listener({
      type: "interaction",
      sessionId: "session",
      messageId: input.messageId,
      rpcId: "approval-1",
      kind: "approval",
      payload: { toolName: "write" },
    });
    const id = f.s.listInteractions().items[0].id;
    await f.s.resolveInteraction(id, "approve");
    assert.equal(f.s.listInteractions().items[0].state, "submitted");
    f.a.listener({
      type: "interaction-resolved",
      sessionId: "session",
      rpcId: "approval-1",
      payload: {},
    });
    assert.equal(f.s.listInteractions().items[0].state, "resolved");
  } finally {
    await f.close();
  }
});
test("failed recovery stops the channel rather than leaving a false connected state", async () => {
  const f = await setup();
  try {
    const id = ingest(f, "1", "task");
    f.s.store.update(id, "accepted");
    f.driver.running = false;
    f.a.watch = async () => {
      throw new Error("DSH_INTERACTION_STREAM_NOT_READY");
    };
    await assert.rejects(f.s.start(), /NOT_READY/);
    assert.equal(f.s.status().connection, "stopped");
  } finally {
    await f.close();
  }
});

test("uncertain older turn does not block a new turn, but blocks its own remaining parts", async () => {
  const f = await setup();
  try {
    const old = f.s.store.enqueue({
      text: "old first",
      source: "old:0",
      submissionId: "old-turn",
    });
    const sibling = f.s.store.enqueue({
      text: "old second",
      source: "old:1",
      submissionId: "old-turn",
    });
    const fresh = f.s.store.enqueue({
      text: "new reply",
      source: "new:0",
      submissionId: "new-turn",
    });
    f.s.store.update(old, "uncertain", "DELIVERY_UNCERTAIN");
    await f.driver.deliver();
    assert.equal(f.s.store.message(old)?.state, "uncertain");
    assert.equal(f.s.store.message(sibling)?.state, "queued");
    assert.equal(f.s.store.message(fresh)?.state, "sent");
    assert.equal(f.w.sent.length, 1);
  } finally {
    await f.close();
  }
});
