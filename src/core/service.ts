import { randomUUID, createHash } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import QRCode from "qrcode";
import { Store } from "./store.js";
import { Vault } from "./vault.js";
import { Files } from "./files.js";
import { WorkerRpc } from "../worker/rpc.js";
import type {
  Attachment,
  Binding,
  Interaction,
  Message,
  MessageView,
  Status,
} from "./types.js";
import type {
  ILinkAccount,
  Updates,
  QrStatus,
  MessageItem,
  ILinkMessage,
} from "../ilink/index.js";
import type {
  DshEvent,
  DshReconciliation,
  DshSubmission,
} from "../dsh/types.js";
export interface AgentPort {
  getTargets():
    | Promise<{ sessionId: string; cwd?: string; status?: string }[]>
    | { sessionId: string; cwd?: string; status?: string }[];
  submit(input: DshSubmission): Promise<DshReconciliation>;
  reconcile(sessionId: string, messageId: string): Promise<DshReconciliation>;
  watch(sessionId: string, messageId: string): Promise<unknown> | void;
  cancel(sessionId: string, messageId: string): Promise<unknown>;
  subscribe(listener: (event: DshEvent) => void): () => void;
  answerApproval(
    rpcId: string,
    outcome: "allowed-once" | "rejected",
  ): Promise<unknown>;
  answerQuestions(rpcId: string, answer: unknown): Promise<unknown>;
  dispose(): Promise<void>;
}
export interface Transport {
  call<T>(method: string, payload: unknown, timeout?: number): Promise<T>;
  stop(): Promise<void>;
}
export class WechatService {
  readonly store: Store;
  readonly vault: Vault;
  readonly files: Files;
  readonly rpc: Transport;
  private transition: Promise<unknown> = Promise.resolve();
  private deliverableQueue: Promise<unknown> = Promise.resolve();
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.transition.then(fn, fn);
    this.transition = next.catch(() => {});
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
  private running = false;
  private closed = false;
  private generation = 0;
  private pumpTimer?: NodeJS.Timeout;
  private pumping = false;
  private pollTask?: Promise<void>;
  private connection = "stopped";
  private qr?: {
    id: string;
    dataUrl: string;
    status: string;
    candidate?: ILinkAccount;
  };
  private loginGeneration = 0;
  private unsubscribe: () => void;
  private interactions = new Map<
    string,
    Interaction & {
      rpcId: string;
      messageId: string;
      payload: Record<string, unknown>;
    }
  >();
  constructor(
    readonly root: string,
    readonly dsh: AgentPort,
    transport?: Transport,
  ) {
    this.store = new Store(join(root, "bridge.sqlite"));
    this.vault = new Vault(join(root, "credentials"));
    this.files = new Files(join(root, "blobs"));
    this.rpc = transport ?? new WorkerRpc(() => this.store.epoch);
    this.store.recoverSending();
    this.unsubscribe = dsh.subscribe((e) => this.event(e));
  }
  status(): Status {
    const a = this.account();
    return {
      connection: this.connection,
      lastPollAt: this.store.get<number | undefined>("lastPoll", undefined),
      ownerId: a?.ownerId,
      pairing: this.qr
        ? {
            qrDataUrl: this.qr.dataUrl,
            status: this.qr.status,
            ownerId: this.qr.candidate?.ownerId,
          }
        : undefined,
      binding:
        this.store.get<Binding | undefined>("binding", undefined) ?? undefined,
      counts: this.store.counts(),
      capabilities: {
        text: true,
        images: true,
        files: "native-attachment-reference",
        trace: "DSH native session",
        singleOwner: true,
      },
    };
  }
  account(): ILinkAccount | undefined {
    const cipher = this.store.get<string | null>("account", null);
    return cipher ? this.vault.open<ILinkAccount>(cipher) : undefined;
  }
  private async pairingStartImpl() {
    await this.stopImpl();
    this.loginGeneration++;
    const gen = this.loginGeneration;
    await this.rpc.call("configure", {});
    const qr = await this.rpc.call<{
      qrcode: string;
      qrcode_img_content: string;
    }>("qr", {});
    this.qr = {
      id: qr.qrcode,
      dataUrl: await QRCode.toDataURL(qr.qrcode_img_content),
      status: "wait",
    };
    void this.loginLoop(gen);
    return this.status();
  }
  private async loginLoop(gen: number) {
    const until = Date.now() + 5 * 60000;
    while (
      !this.closed &&
      Date.now() < until &&
      gen === this.loginGeneration &&
      this.qr &&
      !["confirmed", "expired", "failed"].includes(this.qr.status)
    ) {
      try {
        const r = await this.rpc.call<QrStatus>("qrStatus", {
          qrcode: this.qr.id,
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
            baseUrl: r.baseurl ?? "https://ilinkai.weixin.qq.com",
          };
          return;
        }
        if (
          [
            "need_verifycode",
            "verify_code_blocked",
            "scaned_but_redirect",
            "binded_redirect",
          ].includes(r.status)
        ) {
          this.qr.status = "failed";
          return;
        }
      } catch (e) {
        if (gen !== this.loginGeneration) return;
        if ((e as { kind?: string }).kind !== "network") {
          if (this.qr) this.qr.status = "failed";
          return;
        }
      }
      await pause(1500);
    }
    if (this.qr && gen === this.loginGeneration && Date.now() >= until)
      this.qr.status = "expired";
  }
  private async pairingConfirmImpl() {
    if (!this.qr?.candidate || this.qr.status !== "confirmed")
      throw new Error("OWNER_UNVERIFIED");
    const a = this.qr.candidate;
    this.store.resetAccount();
    this.store.set("account", this.vault.seal(a));
    this.qr = undefined;
    this.loginGeneration++;
    return this.status();
  }
  private async unbindImpl() {
    this.loginGeneration++;
    await this.stopImpl();
    this.qr = undefined;
    this.store.resetAccount();
    this.interactions.clear();
    return this.status();
  }
  async bind(sessionId: string, revision: number) {
    const targets = await this.dsh.getTargets();
    if (!targets.some((t) => t.sessionId === sessionId))
      throw new Error("SESSION_UNAVAILABLE");
    this.store.bind(sessionId, revision);
    return this.status();
  }
  private async startImpl() {
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
      // Register the complete recovery roster before opening the shared event stream.
      await Promise.all(
        this.store
          .incoming()
          .filter(
            (m) =>
              m.sessionId &&
              m.dshMessageId &&
              ["accepted", "running", "uncertain"].includes(m.state),
          )
          .map((m) => this.dsh.watch(m.sessionId!, m.dshMessageId!)),
      );
    } catch (error) {
      await this.stopImpl();
      throw error;
    }
    this.pollTask = this.pollLoop(gen);
    this.pumpTimer = setInterval(() => {
      void this.pump();
      this.expireInteractions();
    }, 1000);
    void this.pump();
    return this.status();
  }
  private async stopImpl() {
    this.running = false;
    this.generation++;
    this.connection = "stopped";
    if (this.pumpTimer) clearInterval(this.pumpTimer);
    await this.rpc.stop();
    await this.pollTask?.catch(() => {});
    while (this.pumping) await pause(20);
    return this.status();
  }
  private async pollLoop(gen: number) {
    let failures = 0;
    while (this.running && gen === this.generation) {
      try {
        const cursor = this.store.get("cursor", ""),
          epoch = this.store.epoch;
        const data = await this.rpc.call<Updates>("poll", { cursor });
        if (!this.running || gen !== this.generation) return;
        const owner = this.account()?.ownerId;
        const bot = this.account()?.botId;
        const valid = data.msgs.filter(
          (m) =>
            m.from_user_id === owner &&
            (!m.to_user_id || m.to_user_id === bot) &&
            !m.group_id &&
            m.message_type === 1 &&
            m.message_state === 2,
        );
        const entries = valid.map((m) => ({
          providerId:
            m.message_id ??
            `unidentified:${createHash("sha256").update(JSON.stringify(m)).digest("hex")}`,
          text: (m.item_list ?? [])
            .filter((x) => x.type === 1)
            .map((x) => x.text_item?.text ?? "")
            .join("\n"),
          payload: this.vault.seal(m),
        }));
        const newestContext = valid
          .filter((m) => m.context_token)
          .at(-1)?.context_token;
        this.store.ingestBatch(
          cursor,
          data.get_updates_buf,
          epoch,
          entries,
          newestContext
            ? this.vault.seal({ value: newestContext, epoch })
            : undefined,
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
        if ((error as { remoteCode?: number }).remoteCode === -14) {
          this.connection = "auth_required";
          this.running = false;
          return;
        }
        await this.delay(Math.min(60000, 1000 * 2 ** Math.min(failures, 6)));
        if (!this.running || gen !== this.generation) return;
      }
    }
  }
  private async pump() {
    if (this.pumping || !this.running) return;
    this.pumping = true;
    try {
      await this.receive();
      await this.deliver();
    } catch {
      /* persisted entity states own user-visible failures */
    } finally {
      this.pumping = false;
    }
  }
  private async receive() {
    const blocked = new Set<string>();
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
          const raw = this.vault.open<ILinkMessage>(m.payload as string);
          const attachments: Attachment[] = [];
          for (const item of raw.item_list ?? []) {
            if (item.type === 1) continue;
            if (item.type !== 2 && item.type !== 4)
              throw new Error("UNSUPPORTED_MESSAGE");
            const kind = item.type === 2 ? "image" : "file";
            const bytes = await this.rpc.call<Uint8Array>("download", {
              item,
              maxBytes: kind === "image" ? 20 * 1024 ** 2 : 100 * 1024 ** 2,
            });
            if (!this.running) {
              if (this.store.message(m.id)?.state === "preparing")
                this.store.update(m.id, "received");
              return;
            }
            if (
              this.store.message(m.id)?.state !== "preparing" ||
              m.epoch !== this.store.epoch
            )
              break;
            const b = Buffer.from(bytes);
            const mime =
              kind === "image" ? imageMime(b) : "application/octet-stream";
            attachments.push(
              await this.files.save(
                b,
                kind === "file"
                  ? (item.file_item?.file_name ?? "文件")
                  : "图片",
                mime,
                kind,
              ),
            );
          }
          if (
            this.store.message(m.id)?.state !== "preparing" ||
            m.epoch !== this.store.epoch
          )
            continue;
          if (!m.text.trim() && !attachments.length)
            throw new Error("EMPTY_MESSAGE");
          this.store.attachments(m.id, attachments);
          this.store.update(m.id, "ready");
        }
        const fresh = this.store.message(m.id)!;
        if (fresh.state !== "ready" || fresh.epoch !== this.store.epoch)
          continue;
        this.store.update(m.id, "uncertain", "SUBMISSION_UNCERTAIN");
        const observation = await this.dsh.submit({
          sessionId: fresh.sessionId!,
          messageId: fresh.dshMessageId!,
          text: fresh.text,
          attachments: fresh.attachments.map((a) => ({
            kind: a.kind,
            path: a.path,
            name: a.name,
            mediaType: a.mime,
          })),
        });
        this.applyObservation(fresh, observation);
      } catch (e) {
        const current = this.store.message(m.id)!;
        if (!this.running && current.state === "preparing")
          this.store.update(m.id, "received");
        else if (!["uncertain", "cancelled"].includes(current.state))
          this.store.update(m.id, "failed", safeCode(e));
        blocked.add(key);
      }
    }
  }
  private applyObservation(m: Message, o: DshReconciliation) {
    if (this.closed || m.epoch !== this.store.epoch) return;
    const state = {
      absent: "uncertain",
      queued: "accepted",
      running: "running",
      completed: "completed",
      cancelled: "cancelled",
      failed: "failed",
      unknown: "uncertain",
    } as const;
    this.store.transaction(() => {
      const priorSeq = this.store.get(`dsh-seq:${m.id}`, -1);
      if (typeof o.seq === "number" && o.seq < priorSeq) return;
      if (
        this.store.get(`terminal:${m.id}`, false) &&
        !["completed", "failed", "cancelled"].includes(o.state)
      )
        return;
      if (typeof o.seq === "number") this.store.set(`dsh-seq:${m.id}`, o.seq);
      if (typeof o.turn === "number")
        this.store.set(`dsh-turn:${m.id}`, o.turn);
      this.store.update(
        m.id,
        state[o.state],
        o.state === "unknown" || o.state === "absent"
          ? "SUBMISSION_UNCERTAIN"
          : o.state === "failed"
            ? (o.reason ?? "DSH_EXECUTION_FAILED")
            : null,
      );
      if (["completed", "failed", "cancelled"].includes(o.state)) {
        this.store.set(`terminal:${m.id}`, true);
        const text =
          o.text ||
          (
            {
              completed: "任务已完成。",
              failed: "任务执行失败，请在 DSH 查看详情。",
              cancelled: "任务已停止。",
            } as Record<string, string>
          )[o.state];
        this.enqueueText(text, m, `result:${m.epoch}:${m.id}`);
      }
    });
  }
  private enqueueText(text: string, m: Message, source: string) {
    const chars = Array.from(text);
    for (let i = 0; i < chars.length; i += 2000)
      this.store.enqueue({
        text: chars.slice(i, i + 2000).join(""),
        sessionId: m.sessionId ?? undefined,
        submissionId: m.id,
        source: `${source}:${i / 2000}`,
      });
  }
  private event(e: DshEvent) {
    if (this.closed) return;
    const ordered =
      e.type === "deliverables/presented" ||
      (e.type === "submission" &&
        ["completed", "failed", "cancelled"].includes(e.state));
    if (!ordered) {
      this.processEvent(e);
      return;
    }
    const operation = this.deliverableQueue.then(() => this.processEvent(e));
    this.deliverableQueue = operation.catch((error) => {
      const key =
        e.type === "deliverables/presented"
          ? `${e.sessionId}:${e.callId}`
          : `${e.sessionId}:${e.messageId}`;
      this.store.set(`deliverable-error:${key}`, safeCode(error));
    });
  }
  private async processEvent(e: DshEvent): Promise<void> {
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
      const id = randomUUID().slice(0, 8);
      const desc = interactionDescription(e.kind, e.payload);
      const item = {
        id,
        kind: e.kind,
        description: desc,
        expiresAt: Date.now() + 5 * 60000,
        state: "pending",
        sessionId: e.sessionId,
        rpcId: e.rpcId,
        messageId: e.messageId,
        payload: e.payload,
      };
      this.interactions.set(id, item);
      this.store.db
        .prepare("INSERT INTO interactions(id,payload,state) VALUES(?,?,?)")
        .run(id, JSON.stringify(item), "pending");
      this.store.enqueue({
        text: `${desc}\n${e.kind === "approval" ? `回复 /approve ${id} 同意，/deny ${id} 拒绝` : `回复 /answer ${id} 你的回答`}\n5 分钟内有效。`,
        submissionId: m.id,
        sessionId: e.sessionId,
        source: `interaction:${this.store.epoch}:${e.rpcId}:${id}`,
        payload: { control: true, interactionId: id },
      });
    } else if (e.type === "interaction-resolved") {
      for (const [id, item] of this.interactions)
        if (item.rpcId === e.rpcId) {
          item.state = "resolved";
          this.store.cancelInteractionDelivery(id);
          this.store.db
            .prepare("UPDATE interactions SET state='resolved' WHERE id=?")
            .run(id);
        }
    }
  }
  private async enqueuePresentedFiles(
    event: Extract<DshEvent, { type: "deliverables/presented" }>,
  ): Promise<void> {
    const submission = this.store.submission(event.sessionId, event.messageId);
    if (!submission || !this.running) return;
    for (const [index, file] of event.files.entries()) {
      if (!this.running) return;
      const source = `presented:${submission.epoch}:${event.callId}:${index}`;
      if (this.store.messageBySource(source)) continue;
      const path = isAbsolute(file.path)
        ? file.path
        : resolve(event.cwd, file.path);
      const attachment = await this.files.snapshot(path, [event.cwd]);
      this.store.enqueue({
        text: "",
        attachments: [attachment],
        sessionId: event.sessionId,
        submissionId: submission.id,
        source,
      });
    }
    void this.pump();
  }
  listInteractions() {
    return {
      items: [...this.interactions.values()].map(
        ({ rpcId, payload, messageId, ...safe }) => safe,
      ),
    };
  }
  async resolveInteraction(id: string, decision: string, text?: string) {
    const i = this.interactions.get(id);
    if (!i || i.state !== "pending" || i.expiresAt <= Date.now())
      throw new Error("INTERACTION_EXPIRED");
    i.state = "resolving";
    try {
      if (i.kind === "approval") {
        const ok = await this.dsh.answerApproval(
          i.rpcId,
          decision === "approve" ? "allowed-once" : "rejected",
        );
        if (ok === false) throw new Error("INTERACTION_EXPIRED");
      } else {
        if (!text?.trim()) throw new Error("ANSWER_REQUIRED");
        const questions = (i.payload.questions ?? []) as { id: string }[];
        if (questions.length !== 1) throw new Error("ANSWER_IN_DSH_REQUIRED");
        const ok = await this.dsh.answerQuestions(i.rpcId, {
          answers: [{ id: questions[0].id, selected: [], custom: text }],
        });
        if (ok === false) throw new Error("INTERACTION_EXPIRED");
      }
      // A Gateway ACK only confirms receipt. Its cancellation broadcast closes the request.
      if (i.state !== "resolved") i.state = "submitted";
      this.store.cancelInteractionDelivery(id);
      this.store.db
        .prepare("UPDATE interactions SET state=? WHERE id=?")
        .run(i.state, id);
    } catch (e) {
      i.state =
        safeCode(e) === "INTERACTION_EXPIRED"
          ? "expired"
          : safeCode(e) === "DSH_INTERACTION_RESPONSE_FAILED"
            ? "uncertain"
            : "pending";
      throw e;
    }
    return { ok: true };
  }
  private expireInteractions() {
    for (const [id, i] of this.interactions)
      if (i.state === "pending" && Date.now() >= i.expiresAt) {
        i.state = "expired";
        this.store.cancelInteractionDelivery(id);
        this.store.db
          .prepare("UPDATE interactions SET state='expired' WHERE id=?")
          .run(id);
        if (i.kind === "approval")
          void this.dsh.answerApproval(i.rpcId, "rejected").catch(() => {});
      }
  }
  private async command(m: Message) {
    try {
      const [command, id, ...rest] = m.text.trim().split(/\s+/);
      let text: string;
      if (command === "/stop") {
        await this.stopSession(m.sessionId ?? "");
        text = "已请求停止微信发起的任务。";
      } else if (command === "/approve" || command === "/deny") {
        await this.resolveInteraction(
          id,
          command === "/approve" ? "approve" : "deny",
        );
        text = "答复已提交，最终状态以 DSH 为准。";
      } else if (command === "/answer") {
        await this.resolveInteraction(id, "answer", rest.join(" "));
        text = "回答已提交。";
      } else if (command === "/status")
        text = `连接：${this.connection}\n会话：${m.sessionId ?? "未绑定"}`;
      else
        text =
          "支持 /status 查看状态，/stop 停止微信任务；其他文字直接交给 DSH。";
      this.store.update(m.id, "completed");
      this.enqueueText(text, m, `command:${m.id}`);
    } catch (e) {
      this.store.update(m.id, "failed", safeCode(e));
      this.enqueueText(
        "指令未完成，请在电脑端查看当前状态。",
        m,
        `command:${m.id}`,
      );
    }
  }
  async stopSession(sessionId: string) {
    for (const m of this.store.incoming())
      if (m.sessionId === sessionId) {
        if (["accepted", "running", "uncertain"].includes(m.state))
          await this.dsh.cancel(sessionId, m.dshMessageId!);
        else if (!m.text.startsWith("/")) this.store.update(m.id, "cancelled");
      }
    return { ok: true };
  }
  private async deliver() {
    const account = this.account();
    if (!account) return;
    const contextCipher = this.store.get<string | null>("context", null);
    const context = contextCipher
      ? this.vault.open<{ value: string; epoch: number }>(contextCipher)
      : undefined;
    const blocked = new Set<string>();
    const out = this.store
      .outgoing()
      .sort(
        (a, b) =>
          Number(Boolean((b.payload as any)?.control)) -
          Number(Boolean((a.payload as any)?.control)),
      );
    for (const m of out) {
      if (!this.running) return;
      // A delivery failure blocks only sibling parts, not later independent turns.
      const key = m.submissionId ?? m.id;
      const control = Boolean((m.payload as any)?.control);
      if (!control && blocked.has(key)) continue;
      if (
        !["queued", "retry_wait"].includes(m.state) ||
        m.nextAttempt > Date.now()
      ) {
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
        const items: MessageItem[] = [];
        if (m.text) items.push({ type: 1, text_item: { text: m.text } });
        for (const a of m.attachments) {
          const bytes = await this.files.read(a);
          items.push(
            await this.rpc.call<MessageItem>("upload", {
              bytes,
              toUserId: account.ownerId,
              kind: a.kind,
              fileName: a.name,
            }),
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
          items,
        });
        this.store.update(m.id, "sent");
      } catch (e) {
        const err = e as Error & { kind?: string; remoteCode?: number };
        const current = this.store.message(m.id)!;
        this.store.set(`delivery-diagnostic:${m.id}`, {
          phase: sendStarted ? "send" : "prepare",
          kind: err.kind ?? "unknown",
          code: err.remoteCode ?? null,
          reason: deliveryReason(err),
          at: Date.now(),
        });
        if (
          sendStarted &&
          current.state === "sending" &&
          (!err.kind || err.kind === "uncertain")
        )
          this.store.update(m.id, "uncertain", "DELIVERY_UNCERTAIN");
        else if (err.remoteCode === -2 || err.remoteCode === -14)
          this.store.update(
            m.id,
            "waiting_context",
            "DELIVERY_WAITING_CONTEXT",
          );
        else if (current.attempts >= 8 || err.kind === "protocol")
          this.store.update(m.id, "failed", safeCode(err));
        else
          this.store.defer(
            m.id,
            "retry_wait",
            safeCode(err),
            Math.min(60000, 1000 * 2 ** current.attempts),
          );
        blocked.add(key);
      }
    }
  }
  listMessages(options: Parameters<Store["list"]>[0]) {
    const result = this.store.list(options);
    return {
      items: result.items.map((m) => this.view(m)),
      nextCursor: result.nextCursor,
    };
  }
  private view(m: Message): MessageView {
    return {
      id: m.id,
      direction: m.direction,
      text: m.text,
      state: m.state,
      createdAt: m.createdAt,
      sessionId: m.sessionId ?? undefined,
      submissionId: m.submissionId ?? undefined,
      deliveryId: m.direction === "out" ? m.id : undefined,
      error: m.error ?? undefined,
      attachments: m.attachments.map((a) => ({
        id: a.id,
        name: a.name,
        mime: a.mime,
        size: a.size,
        url: `/dsh-wechat-channel/api/attachments/${a.id}`,
      })),
    };
  }
  async sendAttachment(
    sessionId: string,
    messageId: string,
    path: string,
    callId: string,
  ) {
    const m = this.store.submission(sessionId, messageId);
    if (!m) throw new Error("NO_WECHAT_SUBMISSION");
    const target = (await this.dsh.getTargets()).find(
      (t) => t.sessionId === sessionId,
    );
    if (!target?.cwd) throw new Error("WORKSPACE_UNAVAILABLE");
    const a = await this.files.snapshot(path, [target.cwd]);
    this.store.enqueue({
      text: "",
      attachments: [a],
      sessionId,
      submissionId: m.id,
      source: `attachment:${m.epoch}:${callId}:${a.sha256}`,
    });
    return { queued: true };
  }
  private async delay(ms: number) {
    const until = Date.now() + ms;
    while (this.running && Date.now() < until)
      await pause(Math.min(100, until - Date.now()));
  }
  async retryMessage(id: string) {
    const m = this.store.message(id);
    if (
      !m ||
      m.direction !== "in" ||
      m.epoch !== this.store.epoch ||
      m.state !== "failed"
    )
      throw new Error("INVALID_STATE");
    if (m.sessionId && m.dshMessageId) {
      const obs = await this.dsh.reconcile(m.sessionId, m.dshMessageId);
      if (obs.state !== "absent") throw new Error("ALREADY_SUBMITTED");
    }
    this.store.update(id, "received");
    return { ok: true };
  }
  async cancelMessage(id: string) {
    const m = this.store.message(id);
    if (!m || m.direction !== "in" || m.epoch !== this.store.epoch)
      throw new Error("NOT_FOUND");
    if (
      m.sessionId &&
      m.dshMessageId &&
      ["accepted", "running", "uncertain"].includes(m.state)
    )
      await this.dsh.cancel(m.sessionId, m.dshMessageId);
    this.store.update(id, "cancelled");
    return { ok: true };
  }
  async close() {
    await this.stop();
    this.closed = true;
    this.loginGeneration++;
    this.unsubscribe();
    await this.deliverableQueue.catch(() => {});
    await this.dsh.dispose();
    this.store.close();
  }
}
export function safeCode(e: unknown) {
  const message = e instanceof Error ? e.message : "";
  return /^[A-Z_]{3,80}$/.test(message) ? message : "OPERATION_FAILED";
}
function imageMime(b: Buffer) {
  if (b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return "image/png";
  if (b[0] === 255 && b[1] === 216) return "image/jpeg";
  if (b.subarray(0, 3).toString() === "GIF") return "image/gif";
  if (b.subarray(8, 12).toString() === "WEBP") return "image/webp";
  throw new Error("UNSUPPORTED_IMAGE");
}
function interactionDescription(kind: string, p: Record<string, unknown>) {
  if (kind === "approval")
    return `DSH 请求确认：${String(p.toolName ?? "工具操作")}\n${String(p.reason ?? "请在电脑端核对操作详情")}`;
  const qs = p.questions as
    | { question?: string; header?: string }[]
    | undefined;
  return (
    qs?.map((q) => q.question ?? q.header ?? "请回答").join("\n") ??
    "DSH 需要补充信息，请在电脑端查看详情。"
  );
}
const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function deliveryReason(error: Error): string {
  const value = error.message;
  if (
    /^iLink HTTP \d{3}$/.test(value) ||
    /^iLink rejected request \(-?\d+\)$/.test(value) ||
    /^WORKER_[A-Z_]+$/.test(value)
  )
    return value;
  if (
    [
      "Send acceptance not confirmed",
      "Invalid iLink response",
      "iLink request interrupted or network unavailable",
    ].includes(value)
  )
    return value;
  return "OPERATION_FAILED";
}
