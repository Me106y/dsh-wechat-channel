import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import type {
  DshAgent,
  DshContext,
  DshEvent,
  DshReconciliation,
  DshSession,
  DshSessionEvent,
  DshSubmission,
  DshFrame,
  DshBlock,
} from "./types.js";
export type * from "./types.js";
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
const messages = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.map(record) : [];

/** Replay the durable Inbox rather than mistaking an Agent-wide idle edge for a message result. */
export function reconcileEvents(
  sessionId: string,
  messageId: string,
  events: readonly DshSessionEvent[],
): DshReconciliation {
  const result: DshReconciliation = { sessionId, messageId, state: "absent" };
  const queues: Record<string, Record<string, unknown>[]> = {
    "next-turn": [],
    "next-step": [],
  };
  let openTurn: number | undefined;
  const replies: string[] = [];
  for (const event of events) {
    const data = record(event.data);
    if (event.type === "turn/start") openTurn = data.turn as number;
    if (event.type === "agent/inbox/spliced") {
      const queue = queues[String(data.target)];
      if (!queue || typeof data.start !== "number") continue;
      const inserted = messages(data.inserted);
      const removed = queue.splice(
        data.start,
        typeof data.removedCount === "number" ? data.removedCount : 0,
        ...inserted,
      );
      if (inserted.some((m) => m.id === messageId)) {
        result.state = "queued";
        result.seq = event.seq;
      }
      if (removed.some((m) => m.id === messageId)) {
        result.seq = event.seq;
        if (data.outcome === "canceled") result.state = "cancelled";
        else if (openTurn !== undefined) {
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
    if (
      event.type === "assistant/message" &&
      result.turn !== undefined &&
      data.turn === result.turn
    ) {
      for (const block of messages(record(data.message).content))
        if (block.type === "text" && typeof block.text === "string")
          replies.push(block.text);
    }
    if (event.type === "turn/end") {
      if (result.turn === data.turn) {
        const reason = record(data.reason);
        result.state =
          reason.kind === "completed"
            ? "completed"
            : reason.kind === "aborted"
              ? "cancelled"
              : "failed";
        result.reason = String(reason.kind ?? "unknown");
        result.text = replies.join("\n\n");
        result.seq = event.seq;
      }
      openTurn = undefined;
    }
  }
  return result;
}

/**
 * 0.2 Gateway streams carry a Client-to-Host uplink beside the downlink. A
 * Gateway-owned endpoint such as `$events` hands the uplink back as soon as the
 * stream opens and drops its items, so an immediately half-closed iterator is
 * the correct companion for a Host-side consumer.
 */
async function* emptyUplink(): AsyncIterable<never> {}
export class DshAdapter {
  private readonly acquiring = new Map<string, Promise<DshAgent>>();
  private readonly watched = new Map<string, Set<string>>();
  private readonly listeners = new Set<(event: DshEvent) => void>();
  private readonly last = new Map<string, string>();
  private readonly pending = new Map<string, DshFrame["payload"]>();
  private readonly notifiedInteractions = new Set<string>();
  private readonly answered = new Set<string>();
  private readonly controller = new AbortController();
  private readonly unlisten: () => void;
  private closed = false;
  private clientId?: string;
  private interactionsStarted = false;
  private readonly ready: Promise<void>;
  private readyResolve!: () => void;
  private readyReject!: (error: unknown) => void;
  private readonly durableQueues = new Map<string, Promise<void>>();
  constructor(private readonly context: DshContext) {
    if (
      !context.agents?.get ||
      !context.sessionController?.resolveAgent ||
      !context.sessions?.flush ||
      !context.attachments?.saveImages ||
      !context.attachments?.saveFileStream ||
      !context.sessionQuery?.listSessions ||
      !context.typertGateway?.wireStream ||
      !context.connection?.createSharedFetchHandler
    )
      throw new Error(
        "DSH_INCOMPATIBLE: requires DSH 0.2.0-rc.2 agents, sessions, attachments, sessionQuery, sessionController, typertGateway and connection",
      );
    this.unlisten = context.on("session/event", (session, event) => {
      const ids = this.watched.get(session.id);
      if (
        !ids ||
        ![
          "agent/inbox/spliced",
          "user/message",
          "assistant/message",
          "deliverables/presented",
          "turn/end",
        ].includes(event.type)
      )
        return;
      const history = session.snapshotEvents().some((e) => e.seq === event.seq)
        ? session.snapshotEvents()
        : [...session.snapshotEvents(), event];
      const values = [...ids].map((id) =>
        reconcileEvents(session.id, id, history),
      );
      const prior = this.durableQueues.get(session.id) ?? Promise.resolve();
      const next = prior
        .then(async () => {
          if (!(await this.context.sessions.flush(session)))
            throw new Error("DSH_DURABILITY_UNCONFIRMED");
          if (event.type === "deliverables/presented")
            this.publishPresented(session, event, history);
          for (const value of values) this.publish(value);
        })
        .catch((error) => {
          this.emit({
            type: "error",
            error: `DSH event durability failed: ${String(error)}`,
          });
        });
      this.durableQueues.set(session.id, next);
    });
    this.ready = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    void this.ready.catch(() => {});
  }
  subscribe(listener: (event: DshEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private emit(event: DshEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(event);
      } catch {
        /* A UI observer cannot veto committed DSH input. */
      }
    }
  }
  private publish(value: DshReconciliation): void {
    const key = `${value.sessionId}/${value.messageId}`;
    const serialized = JSON.stringify(value);
    if (this.last.get(key) === serialized) return;
    this.last.set(key, serialized);
    this.emit({ type: "submission", ...value });
  }
  private publishPresented(
    session: DshSession,
    event: DshSessionEvent,
    history: readonly DshSessionEvent[],
  ): void {
    const data = record(event.data);
    if (
      event.type !== "deliverables/presented" ||
      typeof data.turn !== "number" ||
      !Number.isSafeInteger(data.turn) ||
      typeof data.callId !== "string" ||
      !session.header?.cwd
    )
      return;
    const files = messages(data.files).flatMap((file) => {
      if (typeof file.path !== "string" || !file.path.trim()) return [];
      return [
        {
          path: file.path,
          ...(typeof file.description === "string"
            ? { description: file.description }
            : {}),
        },
      ];
    });
    if (!files.length) return;
    const matches = [...(this.watched.get(session.id) ?? [])].filter(
      (id) => reconcileEvents(session.id, id, history).turn === data.turn,
    );
    if (matches.length !== 1) return;
    const messageId = matches[0]!;
    this.emit({
      type: "deliverables/presented",
      sessionId: session.id,
      messageId,
      turn: data.turn,
      callId: data.callId,
      cwd: session.header.cwd,
      files,
    });
  }
  async acquire(sessionId: string): Promise<DshAgent> {
    if (this.closed) throw new Error("DSH_ADAPTER_CLOSED");
    if (!sessionId) throw new Error("DSH_SESSION_REQUIRED");
    const existing = this.acquiring.get(sessionId);
    if (existing) return existing;
    // Match Web's model selection and Agent preset composition, including cold sessions.
    // The controller owns these Agents; disposing a channel must not dispose a desktop task.
    const loading = this.context.sessionController
      .resolveAgent(sessionId)
      .then((result) => {
        if (this.closed) throw new Error("DSH_ADAPTER_CLOSED");
        if ("error" in result) throw result.error;
        return result.agent;
      })
      .finally(() => this.acquiring.delete(sessionId));
    this.acquiring.set(sessionId, loading);
    return loading;
  }
  async getTargets(): Promise<
    { sessionId: string; cwd?: string; status: string }[]
  > {
    const live = this.context.agents.list().map((agent) => ({
      sessionId: agent.id,
      cwd: agent.session.header?.cwd,
      status: agent.status,
    }));
    const records = await this.context.sessionQuery.listSessions(
      this.controller.signal,
    );
    const all = new Map(
      records
        .filter((item) => item.header.origin !== "subagent")
        .map((item) => [
          item.header.id,
          { sessionId: item.header.id, cwd: item.header.cwd, status: "idle" },
        ]),
    );
    for (const item of live) all.set(item.sessionId, item);
    return [...all.values()];
  }
  currentSubmission(agent: DshAgent): string | undefined {
    if (this.context.agents.get(agent.id) !== agent) return undefined;
    return [...(this.watched.get(agent.id) ?? [])].find(
      (id) =>
        reconcileEvents(agent.id, id, agent.session.snapshotEvents()).state ===
        "running",
    );
  }
  async watch(
    sessionId: string,
    messageId: string,
  ): Promise<DshReconciliation> {
    const ids = this.watched.get(sessionId) ?? new Set<string>();
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
    if (
      state.state !== "absent" &&
      !(await this.context.sessions.flush(agent.session))
    )
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
  async reconcile(
    sessionId: string,
    messageId: string,
  ): Promise<DshReconciliation> {
    const agent = await this.acquire(sessionId);
    const result = reconcileEvents(
      sessionId,
      messageId,
      agent.session.snapshotEvents(),
    );
    if (
      result.state !== "absent" &&
      !(await this.context.sessions.flush(agent.session))
    )
      throw new Error("DSH_DURABILITY_UNCONFIRMED");
    return result;
  }
  async submit(input: DshSubmission): Promise<DshReconciliation> {
    if (!input.messageId || !input.sessionId)
      throw new Error("DSH_INPUT_ID_REQUIRED");
    const agent = await this.acquire(input.sessionId);
    const existing = await this.watch(input.sessionId, input.messageId);
    if (existing.state !== "absent") return existing;
    const content: DshBlock[] = [];
    if (input.text?.trim()) content.push({ type: "text", text: input.text });
    for (const attachment of input.attachments ?? []) {
      if (!isAbsolute(attachment.path))
        throw new Error("DSH_ATTACHMENT_PATH_MUST_BE_ABSOLUTE");
      if (attachment.kind === "image") {
        const [ref] = await this.context.attachments.saveImages([
          {
            data: await readFile(attachment.path),
            mediaType: attachment.mediaType,
            name: attachment.name,
          },
        ]);
        if (!ref) throw new Error("DSH_ATTACHMENT_SAVE_FAILED");
        content.push({ type: "image", attachment: ref });
      } else {
        const ref = await this.context.attachments.saveFileStream({
          data: createReadStream(attachment.path),
          name: attachment.name,
          signal: this.controller.signal,
        });
        content.push({ type: "file", attachment: ref });
      }
    }
    if (!content.length) throw new Error("DSH_EMPTY_MESSAGE");
    // Recheck after attachment I/O so concurrent retries cannot enqueue this identity twice.
    const again = reconcileEvents(
      input.sessionId,
      input.messageId,
      agent.session.snapshotEvents(),
    );
    if (again.state !== "absent") return again;
    agent.followup({
      id: input.messageId,
      role: "user",
      source: { kind: "user" },
      content,
    });
    return this.reconcile(input.sessionId, input.messageId);
  }
  async cancel(sessionId: string, messageId: string): Promise<boolean> {
    if (!this.watched.get(sessionId)?.has(messageId)) return false;
    const agent = await this.acquire(sessionId);
    if (agent.inbox.remove(messageId)) {
      if (!(await this.context.sessions.flush(agent.session)))
        throw new Error("DSH_DURABILITY_UNCONFIRMED");
      return true;
    }
    const state = reconcileEvents(
      sessionId,
      messageId,
      agent.session.snapshotEvents(),
    );
    if (state.state !== "running") return false;
    agent.cancel({ kind: "user" }, { keepInbox: true });
    return true;
  }
  private async openInteractions(): Promise<AsyncIterable<unknown>> {
    // api-remotes registers the source after the Gateway service exists. Bound the boot race.
    for (let attempt = 0; ; attempt++) {
      let iterator: AsyncIterator<unknown> | undefined;
      try {
        const stream = await this.context.typertGateway.wireStream.open(
          "$events",
          { args: {} },
          emptyUplink(),
          undefined,
          this.controller.signal,
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
        if (
          attempt >= 49 ||
          this.controller.signal.aborted ||
          record(error).code !== "gateway/service-unavailable"
        )
          throw error;
        await delay(100, undefined, { signal: this.controller.signal });
      }
    }
  }
  private async consumeInteractions(): Promise<void> {
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
          const payload = this.pending.get(rpcId);
          this.pending.delete(rpcId);
          this.notifiedInteractions.delete(rpcId);
          this.answered.delete(rpcId);
          if (payload?.sessionId)
            this.emit({
              type: "interaction-resolved",
              sessionId: payload.sessionId,
              rpcId,
              payload,
            });
          continue;
        }
        if (frame.type !== "waterfall") continue;
        const sessionId = String(frame.agentId ?? "");
        const supported =
          frame.event === "approval/request" ||
          frame.event === "user-questions/request";
        if (!supported || !this.watched.has(sessionId)) {
          await this.sendOutcome(rpcId, { kind: "next" });
          continue;
        }
        const payload: DshFrame["payload"] = {
          ...record(frame.request),
          sessionId,
          type:
            frame.event === "approval/request"
              ? "approval/requested"
              : "question/requested",
        };
        this.pending.set(rpcId, payload);
        const agent = this.context.agents.get(sessionId);
        if (agent && !(await this.context.sessions.flush(agent.session)))
          throw new Error("DSH_DURABILITY_UNCONFIRMED");
        this.publishInteraction(rpcId, payload);
        // Do not hold a desktop-originated interaction simply because its session is bound.
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
          error: `DSH interaction stream stopped: ${String(error)}`,
        });
    }
  }
  private async sendOutcome(rpcId: string, outcome: unknown): Promise<void> {
    if (!this.clientId) throw new Error("DSH_INTERACTION_STREAM_NOT_READY");
    // Official in-process carrier: same Gateway arbiter as desktop clients, no HTTP/token loopback.
    const response = await this.context.connection
      .createSharedFetchHandler("/api")
      .fetch(
        new Request("http://localhost/api/$events/result", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            type: "client-request",
            rpcId: randomUUID(),
            method: "$events/result",
            payload: {
              args: { clientId: this.clientId, eventId: rpcId, outcome },
            },
          }),
        }),
      );
    const body = record(await response.json());
    if (!response.ok || record(body.result).ok !== true)
      throw new Error("DSH_INTERACTION_RESPONSE_FAILED");
  }
  private publishInteraction(
    rpcId: string,
    payload: DshFrame["payload"],
  ): void {
    const sessionId = payload.sessionId;
    if (!sessionId || this.notifiedInteractions.has(rpcId)) return;
    const agent = this.context.agents.get(sessionId);
    if (!agent) return;
    const messageId = [...(this.watched.get(sessionId) ?? [])].find(
      (id) =>
        reconcileEvents(sessionId, id, agent.session.snapshotEvents()).state ===
        "running",
    );
    if (!messageId) return;
    this.notifiedInteractions.add(rpcId);
    this.emit({
      type: "interaction",
      sessionId,
      messageId,
      rpcId,
      kind: payload.type === "approval/requested" ? "approval" : "question",
      payload,
    });
  }
  async answerApproval(
    rpcId: string,
    outcome: "allowed-once" | "rejected",
  ): Promise<boolean> {
    if (outcome !== "allowed-once" && outcome !== "rejected")
      throw new Error("INVALID_APPROVAL_OUTCOME");
    const pending = this.pending.get(rpcId);
    if (
      !this.notifiedInteractions.has(rpcId) ||
      !pending ||
      pending.type !== "approval/requested"
    )
      return false;
    return this.answer(rpcId, outcome);
  }
  async answerQuestions(rpcId: string, answer: unknown): Promise<boolean> {
    const pending = this.pending.get(rpcId);
    if (
      !this.notifiedInteractions.has(rpcId) ||
      !pending ||
      pending.type !== "question/requested"
    )
      return false;
    return this.answer(rpcId, answer);
  }
  private async answer(rpcId: string, value: unknown): Promise<boolean> {
    // Reserve before yielding, but retain pending until the shared arbiter's cancel frame.
    // An uncertain transport failure is never automatically retried.
    if (!this.pending.has(rpcId) || this.answered.has(rpcId)) return false;
    this.answered.add(rpcId);
    await this.sendOutcome(rpcId, { kind: "result", value });
    return true;
  }

  async dispose(): Promise<void> {
    this.closed = true;
    this.controller.abort();
    this.unlisten();
    await Promise.allSettled([...this.durableQueues.values()]);
    await Promise.allSettled([...this.acquiring.values()]);
    this.listeners.clear();
    this.pending.clear();
  }
}
