import test from "node:test";
import assert from "node:assert/strict";
import { DshAdapter, reconcileEvents } from "../src/dsh/index.js";
import type {
  DshAgent,
  DshContext,
  DshEvent,
  DshMessage,
  DshSessionEvent,
} from "../src/dsh/types.js";
const e = (type: string, data: unknown, seq = 0): DshSessionEvent => ({
  type,
  data,
  seq,
});
const msg = (id: string): DshMessage => ({
  id,
  role: "user",
  source: { kind: "user" },
  content: [{ type: "text", text: id }],
});
function fixture(live = true) {
  const events: DshSessionEvent[] = [];
  const queue: DshMessage[] = [];
  let listener:
    | ((session: DshAgent["session"], event: DshSessionEvent) => void)
    | undefined;
  let disposed = 0;
  let cancelled = 0;
  let flushed = 0;
  let resumes = 0;
  const append = (type: string, data: unknown) => {
    const event = e(type, data, events.length);
    events.push(event);
    listener?.(agent.session, event);
  };
  const agent: DshAgent = {
    id: "s",
    status: "idle",
    session: {
      id: "s",
      header: { cwd: "/tmp" },
      snapshotEvents: () => [...events],
    },
    inbox: {
      nextTurn: queue,
      nextStep: [],
      remove(id) {
        const index = queue.findIndex((m) => m.id === id);
        if (index < 0) return false;
        append("agent/inbox/spliced", {
          target: "next-turn",
          start: index,
          removedCount: 1,
          inserted: [],
          outcome: "canceled",
        });
        queue.splice(index, 1);
        return true;
      },
    },
    followup(message) {
      queue.push(message);
      append("agent/inbox/spliced", {
        target: "next-turn",
        start: queue.length - 1,
        removedCount: 0,
        inserted: [message],
      });
    },
    cancel(_cause, options) {
      assert.equal(options.keepInbox, true);
      cancelled++;
    },
  };
  const context: DshContext = {
    agents: {
      get: () => (live ? agent : undefined),
      list: () => [agent],
    },
    sessionController: {
      resolveAgent: async () => {
        resumes++;
        live = true;
        return { agent };
      },
    },
    sessions: {
      flush: async () => {
        flushed++;
        return true;
      },
    },
    attachments: {
      saveImages: async () => [],
      saveFileStream: async ({ name }) => ({
        attachmentId: "file-id",
        name: name ?? "file",
        bytes: 3,
      }),
    },
    sessionQuery: { listSessions: async () => [] },
    typertGateway: {
      wireStream: {
        open: async (_endpoint, _payload, uplink, peer, signal) => {
          // 0.2 hands the Client-to-Host uplink and the peer before the signal.
          assert.equal(typeof uplink[Symbol.asyncIterator], "function");
          assert.equal(peer, undefined);
          return (async function* () {
            yield { type: "ready", clientId: "client" };
            if (!signal.aborted)
              await new Promise<void>((resolve) =>
                signal.addEventListener("abort", () => resolve(), {
                  once: true,
                }),
              );
          })();
        },
      },
    },
    connection: {
      createSharedFetchHandler: () => ({
        fetch: async () => Response.json({ result: { ok: true } }),
      }),
    },
    on: (_name, fn) => {
      listener = fn;
      return () => {
        listener = undefined;
      };
    },
  };
  return {
    agent,
    context,
    append,
    counts: () => ({ disposed, cancelled, flushed, resumes }),
  };
}
test("stable message identity deduplicates retries and flushes accepted input", async () => {
  const f = fixture();
  const adapter = new DshAdapter(f.context);
  const [a, b] = await Promise.all([
    adapter.submit({ sessionId: "s", messageId: "m", text: "one" }),
    adapter.submit({ sessionId: "s", messageId: "m", text: "one" }),
  ]);
  assert.equal(a.state, "queued");
  assert.equal(b.state, "queued");
  assert.equal(f.agent.inbox.nextTurn.length, 1);
  assert.ok(f.counts().flushed >= 1);
  await adapter.dispose();
  assert.equal(f.counts().disposed, 0);
});
test("concurrent cold acquire resolves once through Web controller and never disposes its Agent", async () => {
  const f = fixture(false);
  const adapter = new DshAdapter(f.context);
  await Promise.all([adapter.acquire("s"), adapter.acquire("s")]);
  await adapter.dispose();
  assert.equal(f.counts().resumes, 1);
  assert.equal(f.counts().disposed, 0);
});
test("replay maps Inbox claim without user/message to failed turn", () => {
  const history = [
    e("agent/inbox/spliced", {
      target: "next-turn",
      start: 0,
      removedCount: 0,
      inserted: [msg("m")],
    }),
    e("turn/start", { turn: 8 }),
    e("agent/inbox/spliced", {
      target: "next-turn",
      start: 0,
      removedCount: 1,
      inserted: [],
    }),
    e("turn/end", { turn: 8, reason: { kind: "blocked" } }),
  ];
  assert.deepEqual(
    { ...reconcileEvents("s", "m", history), seq: 0 },
    {
      sessionId: "s",
      messageId: "m",
      state: "failed",
      turn: 8,
      reason: "blocked",
      text: "",
      seq: 0,
    },
  );
});
test("completion text belongs only to matching turn and excludes reasoning", () => {
  const history = [
    e("agent/inbox/spliced", {
      target: "next-turn",
      start: 0,
      removedCount: 0,
      inserted: [msg("m")],
    }),
    e("turn/start", { turn: 1 }),
    e("agent/inbox/spliced", {
      target: "next-turn",
      start: 0,
      removedCount: 1,
      inserted: [],
    }),
    e("assistant/message", {
      turn: 1,
      message: {
        content: [
          { type: "reasoning", text: "secret" },
          { type: "text", text: "answer" },
        ],
      },
    }),
    e("turn/end", { turn: 1, reason: { kind: "completed" } }),
    e("turn/start", { turn: 2 }),
    e("assistant/message", {
      turn: 2,
      message: { content: [{ type: "text", text: "desktop" }] },
    }),
  ];
  const state = reconcileEvents("s", "m", history);
  assert.equal(state.state, "completed");
  assert.equal(state.text, "answer");
});
test("replay forwards presented files for exactly the matching WeChat turn before completion", async () => {
  const f = fixture();
  f.append("agent/inbox/spliced", {
    target: "next-turn",
    start: 0,
    removedCount: 0,
    inserted: [msg("m")],
  });
  f.append("turn/start", { turn: 3 });
  f.append("agent/inbox/spliced", {
    target: "next-turn",
    start: 0,
    removedCount: 1,
    inserted: [],
  });
  f.append("user/message", { id: "m" });
  f.append("deliverables/presented", {
    turn: 3,
    callId: "present-1",
    files: [{ path: "shot.png", description: "screen" }],
  });
  f.append("assistant/message", {
    turn: 3,
    message: { content: [{ type: "text", text: "done" }] },
  });
  f.append("turn/end", { turn: 3, reason: { kind: "completed" } });
  const adapter = new DshAdapter(f.context);
  const seen: DshEvent[] = [];
  adapter.subscribe((event) => seen.push(event));
  await adapter.watch("s", "m");
  assert.deepEqual(seen[0], {
    type: "deliverables/presented",
    sessionId: "s",
    messageId: "m",
    turn: 3,
    callId: "present-1",
    cwd: "/tmp",
    files: [{ path: "shot.png", description: "screen" }],
  });
  assert.equal(seen[1]?.type, "submission");
  assert.equal(
    seen.some(
      (event) =>
        event.type === "deliverables/presented" && event.messageId === "m",
    ),
    true,
  );
  await adapter.dispose();
});

test("presented files from an unmatched desktop turn are ignored", async () => {
  const f = fixture();
  const adapter = new DshAdapter(f.context);
  await adapter.submit({ sessionId: "s", messageId: "m", text: "wechat" });
  const seen: DshEvent[] = [];
  adapter.subscribe((event) => seen.push(event));
  f.append("turn/start", { turn: 9 });
  f.append("deliverables/presented", {
    turn: 9,
    callId: "desktop-present",
    files: [{ path: "desktop.png" }],
  });
  await adapter.watch("s", "m");
  assert.equal(
    seen.some((event) => event.type === "deliverables/presented"),
    false,
  );
  await adapter.dispose();
});

test("cancel only known submitted message preserves unrelated desktop input", async () => {
  const f = fixture();
  const adapter = new DshAdapter(f.context);
  await adapter.submit({ sessionId: "s", messageId: "m", text: "test" });
  f.agent.followup(msg("desktop"));
  assert.equal(await adapter.cancel("s", "desktop"), false);
  assert.equal(await adapter.cancel("s", "m"), true);
  assert.deepEqual(
    f.agent.inbox.nextTurn.map((m) => m.id),
    ["desktop"],
  );
  assert.equal(f.counts().cancelled, 0);
  await adapter.dispose();
});
test("durability failure leaves recoverable queued identity rather than a second submission", async () => {
  const f = fixture();
  f.context.sessions.flush = async () => false;
  const adapter = new DshAdapter(f.context);
  await assert.rejects(
    adapter.submit({ sessionId: "s", messageId: "m", text: "test" }),
    /DURABILITY_UNCONFIRMED/,
  );
  await assert.rejects(adapter.reconcile("s", "m"), /DURABILITY_UNCONFIRMED/);
  f.context.sessions.flush = async () => true;
  assert.equal((await adapter.reconcile("s", "m")).state, "queued");
  assert.equal(f.agent.inbox.nextTurn.length, 1);
  await adapter.dispose();
});
test("omitted removedCount means zero when prepending pending input", () => {
  const history = [
    e("agent/inbox/spliced", {
      target: "next-turn",
      start: 0,
      inserted: [msg("m")],
    }),
    e("agent/inbox/spliced", {
      target: "next-turn",
      start: 0,
      inserted: [msg("desktop")],
    }),
    e("turn/start", { turn: 1 }),
    e("agent/inbox/spliced", {
      target: "next-turn",
      start: 0,
      removedCount: 1,
      inserted: [],
    }),
    e("turn/end", { turn: 1, reason: { kind: "completed" } }),
  ];
  assert.equal(reconcileEvents("s", "m", history).state, "queued");
});
test("Gateway waterfall keeps desktop and WeChat on the same arbiter and consumes answers once", async () => {
  const f = fixture();
  const sent: unknown[] = [];
  let publish!: (value: unknown) => void;
  f.context.typertGateway.wireStream.open = async (
    _endpoint,
    _payload,
    _uplink,
    _peer,
    signal,
  ) =>
    (async function* () {
      yield { type: "ready", clientId: "client" };
      while (!signal.aborted) {
        const value = await new Promise<unknown>((resolve) => {
          publish = resolve;
          signal.addEventListener("abort", () => resolve(undefined), {
            once: true,
          });
        });
        if (value) yield value;
      }
    })();
  f.context.connection.createSharedFetchHandler = () => ({
    fetch: async (request) => {
      sent.push(await request.json());
      return Response.json({ result: { ok: true } });
    },
  });
  const adapter = new DshAdapter(f.context);
  await adapter.submit({ sessionId: "s", messageId: "m", text: "go" });
  f.append("turn/start", { turn: 1 });
  f.append("agent/inbox/spliced", {
    target: "next-turn",
    start: 0,
    removedCount: 1,
    inserted: [],
  });
  const interactions: unknown[] = [];
  const resolved: string[] = [];
  adapter.subscribe((event) => {
    if (event.type === "interaction") interactions.push(event);
    if (event.type === "interaction-resolved") resolved.push(event.rpcId);
  });
  publish({
    type: "waterfall",
    event: "approval/request",
    eventId: "rpc",
    agentId: "s",
    request: { toolName: "bash" },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(interactions.length, 1);
  assert.deepEqual(
    await Promise.all([
      adapter.answerApproval("rpc", "allowed-once"),
      adapter.answerApproval("rpc", "allowed-once"),
    ]),
    [true, false],
  );
  assert.deepEqual((sent[0] as { payload: unknown }).payload, {
    args: {
      clientId: "client",
      eventId: "rpc",
      outcome: { kind: "result", value: "allowed-once" },
    },
  });
  publish({ type: "cancel", eventId: "rpc" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(resolved, ["rpc"]);
  publish({
    type: "waterfall",
    event: "user-questions/request",
    eventId: "question",
    agentId: "s",
    request: { questions: [{ id: "q", question: "Choose" }] },
  });
  await new Promise((resolve) => setImmediate(resolve));
  publish({ type: "cancel", eventId: "question" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    await adapter.answerQuestions("question", { answers: [] }),
    false,
  );
  publish({
    type: "waterfall",
    event: "approval/request",
    eventId: "desktop",
    agentId: "other",
    request: { toolName: "bash" },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual((sent[1] as { payload: unknown }).payload, {
    args: { clientId: "client", eventId: "desktop", outcome: { kind: "next" } },
  });
  await adapter.dispose();
});
test("terminal event is not published before its durability checkpoint succeeds", async () => {
  const f = fixture();
  const adapter = new DshAdapter(f.context);
  await adapter.submit({ sessionId: "s", messageId: "m", text: "hello" });
  await new Promise((resolve) => setImmediate(resolve));
  const seen: string[] = [];
  adapter.subscribe((event) => {
    if (event.type === "submission") seen.push(event.state);
  });
  let release: ((value: boolean) => void) | undefined;
  f.context.sessions.flush = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  f.append("turn/start", { turn: 1 });
  f.append("agent/inbox/spliced", {
    target: "next-turn",
    start: 0,
    removedCount: 1,
    inserted: [],
  });
  await new Promise((resolve) => setImmediate(resolve));
  release?.(true);
  await new Promise((resolve) => setImmediate(resolve));
  f.append("turn/end", { turn: 1, reason: { kind: "completed" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(!seen.includes("completed"));
  release?.(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(seen.includes("completed"));
  await adapter.dispose();
});
test("cold session listing merges live state through the official API", async () => {
  const f = fixture();
  f.context.sessionQuery.listSessions = async () => [
    { header: { id: "cold", cwd: "/project" }, live: false, persisted: true },
    {
      header: { id: "child", origin: "subagent" },
      live: false,
      persisted: true,
    },
  ];
  const adapter = new DshAdapter(f.context);
  assert.deepEqual(
    (await adapter.getTargets()).map((x) => x.sessionId),
    ["cold", "s"],
  );
  await adapter.dispose();
});
test("attachment tool rejects desktop turns and binds allowed execution to exact live agent", async () => {
  const { registerAttachmentTool } = await import(
    "../src/dsh/attachment-tool.js"
  );
  const f = fixture();
  const adapter = new DshAdapter(f.context);
  let tool:
    | import("../src/dsh/attachment-tool.js").AttachmentToolDefinition
    | undefined;
  const calls: unknown[] = [];
  registerAttachmentTool(
    {
      tools: {
        register(definition) {
          tool = definition;
          return () => {};
        },
      },
    },
    adapter,
    async (...args) => {
      calls.push(args);
      return { queued: true };
    },
  );
  await assert.rejects(
    tool!.execute(
      { path: "/project/a.txt" },
      { agent: f.agent, callId: "call", signal: new AbortController().signal },
    ),
    /CURRENT_WECHAT_TASK/,
  );
  await adapter.submit({ sessionId: "s", messageId: "m", text: "send" });
  f.append("turn/start", { turn: 1 });
  f.append("agent/inbox/spliced", {
    target: "next-turn",
    start: 0,
    removedCount: 1,
    inserted: [],
  });
  await tool!.execute(
    { path: "/project/a.txt" },
    { agent: f.agent, callId: "call", signal: new AbortController().signal },
  );
  assert.deepEqual(calls, [["s", "m", "/project/a.txt", "call"]]);
  await assert.rejects(
    tool!.execute(
      { path: "/project/a.txt" },
      {
        agent: { ...f.agent },
        callId: "spoofed",
        signal: new AbortController().signal,
      },
    ),
    /CURRENT_WECHAT_TASK/,
  );
  await adapter.dispose();
});
test("poll reconciliation also waits for durable terminal state", async () => {
  const f = fixture();
  f.agent.followup(msg("m"));
  f.append("turn/start", { turn: 1 });
  f.append("agent/inbox/spliced", {
    target: "next-turn",
    start: 0,
    removedCount: 1,
    inserted: [],
  });
  f.append("turn/end", { turn: 1, reason: { kind: "completed" } });
  const adapter = new DshAdapter(f.context);
  let release: ((v: boolean) => void) | undefined;
  let settled = false;
  f.context.sessions.flush = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const pending = adapter.reconcile("s", "m").then((value) => {
    settled = true;
    return value;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  release?.(true);
  assert.equal((await pending).state, "completed");
  await adapter.dispose();
});

test("native file storage finishes before identified followup and trace preserves exact terminal seq", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "dsh-wechat-file-"));
  try {
    const path = join(dir, "notes.txt");
    await writeFile(path, "abc");
    const f = fixture();
    let stored = false;
    f.context.attachments.saveFileStream = async (input) => {
      const chunks: Buffer[] = [];
      for await (const chunk of input.data) chunks.push(Buffer.from(chunk));
      assert.equal(Buffer.concat(chunks).toString(), "abc");
      assert.equal(f.agent.inbox.nextTurn.length, 0);
      stored = true;
      return { attachmentId: "native-file", name: "notes.txt", bytes: 3 };
    };
    const adapter = new DshAdapter(f.context);
    await adapter.submit({
      sessionId: "s",
      messageId: "file-message",
      attachments: [
        { kind: "file", path, name: "notes.txt", mediaType: "text/plain" },
      ],
    });
    assert.equal(stored, true);
    assert.deepEqual(f.agent.inbox.nextTurn[0]?.content, [
      {
        type: "file",
        attachment: {
          attachmentId: "native-file",
          name: "notes.txt",
          bytes: 3,
        },
      },
    ]);
    f.append("turn/start", { turn: 4 });
    f.append("agent/inbox/spliced", {
      target: "next-turn",
      start: 0,
      removedCount: 1,
      inserted: [],
    });
    f.append("user/message", msg("file-message"));
    f.append("assistant/message", {
      turn: 4,
      step: 1,
      message: {
        id: "assistant",
        role: "assistant",
        source: { kind: "model" },
        content: [{ type: "text", text: "done" }],
      },
      stream: [],
    });
    f.append("turn/end", { turn: 4, reason: { kind: "completed" } });
    const state = await adapter.reconcile("s", "file-message");
    assert.equal(state.seq, 5);
    assert.equal(state.turn, 4);
    assert.equal(state.sessionId, "s");
    assert.equal(state.text, "done");
    await adapter.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Gateway source late registration retries before submission and failure remains bounded", async () => {
  const f = fixture();
  const original = f.context.typertGateway.wireStream.open;
  let attempts = 0;
  f.context.typertGateway.wireStream.open = async (...args) => {
    if (attempts++ === 0)
      return (async function* () {
        throw Object.assign(new Error("source unavailable"), {
          code: "gateway/service-unavailable",
        });
      })();
    return original(...args);
  };
  const adapter = new DshAdapter(f.context);
  assert.equal(
    (await adapter.submit({ sessionId: "s", messageId: "m", text: "hello" }))
      .state,
    "queued",
  );
  assert.equal(attempts, 2);
  await adapter.dispose();
});

test("first watch registers recovered ownership before Gateway replays existing approvals", async () => {
  const f = fixture();
  f.agent.followup(msg("recover"));
  f.append("turn/start", { turn: 1 });
  f.append("agent/inbox/spliced", {
    target: "next-turn",
    start: 0,
    removedCount: 1,
    inserted: [],
  });
  let opened = false;
  f.context.typertGateway.wireStream.open = async (
    _endpoint,
    _payload,
    _uplink,
    _peer,
    signal,
  ) =>
    (async function* () {
      opened = true;
      yield { type: "ready", clientId: "client" };
      yield {
        type: "waterfall",
        event: "approval/request",
        eventId: "recovered-approval",
        agentId: "s",
        request: { toolName: "bash" },
      };
      if (!signal.aborted)
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
    })();
  const adapter = new DshAdapter(f.context);
  assert.equal(opened, false);
  const requests: string[] = [];
  adapter.subscribe((event) => {
    if (event.type === "interaction") requests.push(event.rpcId);
  });
  await adapter.watch("s", "recover");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(requests, ["recovered-approval"]);
  await adapter.dispose();
});

test("controller errors cannot be bypassed through the raw live registry", async () => {
  const f = fixture();
  const failure = new Error("preset or model selection unavailable");
  f.context.sessionController.resolveAgent = async () => ({ error: failure });
  const adapter = new DshAdapter(f.context);
  await assert.rejects(adapter.acquire("s"), (error) => error === failure);
  await adapter.dispose();
});
