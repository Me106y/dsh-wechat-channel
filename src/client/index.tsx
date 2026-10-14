import React, { useCallback, useEffect, useRef, useState } from "react";
import { attachmentUrl, formatSize, request, statusLabel } from "./api.js";
import type { ChannelStatus, Interaction, Page, Target } from "./api.js";

export const inject = ["slots", "sessions"];
interface ClientContext {
  sessions: { open(sessionId: string): void };
  slots: {
    inject(name: string, factory: () => unknown): unknown;
    register(
      options: { name: string; id: string; order: number; label: () => string },
      component: React.ComponentType,
    ): unknown;
  };
}
export function apply(ctx: ClientContext): void {
  const Section = ({ close }: { close?: () => void }): React.ReactElement => (
    <WechatPanel
      openSession={(id) => {
        ctx.sessions.open(id);
        close?.();
      }}
    />
  );
  ctx.slots.inject("settings.section", () =>
    ctx.slots.register(
      {
        name: "settings.section",
        id: "wechat",
        order: 80,
        label: () => "微信",
      },
      Section,
    ),
  );
}

const style = `
.wc-panel{font:14px/1.6 system-ui,sans-serif;color:inherit;max-width:1000px;width:100%;min-width:0;padding:20px;box-sizing:border-box}
.wc-panel *{box-sizing:border-box}.wc-panel h2{font-size:22px;margin:0}.wc-panel h3{font-size:15px;margin:0 0 12px}.wc-panel p{margin:8px 0}.wc-muted{opacity:.65}.wc-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.wc-spread{justify-content:space-between}.wc-tabs{display:flex;border-bottom:1px solid #8884;gap:8px;margin:24px 0}.wc-panel button,.wc-panel select,.wc-panel input{font:inherit;color:inherit;background:transparent;border:1px solid #8886;border-radius:7px;padding:7px 12px}.wc-panel button{cursor:pointer}.wc-panel button:disabled{opacity:.45;cursor:default}.wc-panel button:focus-visible,.wc-panel select:focus-visible,.wc-panel input:focus-visible{outline:2px solid #1b9d73;outline-offset:2px}.wc-tabs button{border:0;border-radius:0;border-bottom:2px solid transparent;padding:10px 12px}.wc-tabs button[aria-selected=true]{border-bottom-color:#1b9d73;color:#1b9d73}.wc-panel .wc-primary{background:#167956;color:white;border-color:#167956}.wc-card{border:1px solid #8884;border-radius:10px;padding:18px;margin:14px 0}.wc-error{color:#c74539;border:1px solid #c7453966;border-radius:8px;padding:10px}.wc-badge{font-size:12px;padding:3px 8px;border-radius:20px;background:#8882}.wc-message{border-left:3px solid #1b9d7366}.wc-message[data-direction=out]{border-left-color:#768cc7}.wc-text{white-space:pre-wrap;overflow-wrap:anywhere}.wc-panel a{color:#218868}.wc-media{display:flex;flex-wrap:wrap;gap:12px;margin-top:12px}.wc-attachment{display:flex;flex-direction:column;gap:4px;max-width:220px;overflow-wrap:anywhere}.wc-attachment img{max-width:220px;max-height:160px;border-radius:6px;object-fit:contain;background:white}.wc-qr{width:220px;height:220px;background:white;padding:10px;border-radius:8px}.wc-empty{text-align:center;padding:35px 10px;opacity:.65}.wc-panel code{font-size:12px;overflow-wrap:anywhere}.wc-panel label{display:flex;gap:8px;align-items:center;min-width:0;max-width:100%;white-space:nowrap}.wc-panel select{min-width:0;max-width:100%;width:100%;text-overflow:ellipsis}.wc-danger{color:#c74539!important}.wc-confirm{background:#b5821512}.wc-answer{width:100%;margin:10px 0}@media(max-width:600px){.wc-panel{padding:10px}.wc-panel label{align-items:flex-start;flex-direction:column}.wc-tabs{gap:0}.wc-tabs button{padding:10px 8px}}
`;
const date = (n?: number): string =>
  n ? new Date(n).toLocaleString("zh-CN") : "—";

export function WechatPanel({
  openSession,
}: { openSession?: (id: string) => void } = {}): React.ReactElement {
  const [tab, setTab] = useState("connection");
  const [status, setStatus] = useState<ChannelStatus>();
  const [targets, setTargets] = useState<Target[]>([]);
  const [page, setPage] = useState<Page>({ items: [] });
  const [interactions, setInteractions] = useState<Interaction[]>([]);
  const [selected, setSelected] = useState("");
  const [filter, setFilter] = useState("");
  const [direction, setDirection] = useState("");
  const [error, setError] = useState("");
  const [refreshError, setRefreshError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [confirm, setConfirm] = useState<{
    kind: "unbind" | "retry";
    id?: string;
  }>();
  const alive = useRef(true);
  const generation = useRef(0);
  const expanded = useRef(false);
  const messagePath = useCallback(
    (cursor?: string) => {
      const query = new URLSearchParams();
      if (filter) query.set("state", filter);
      if (direction) query.set("direction", direction);
      if (cursor) query.set("before", cursor);
      return `/messages?${query}`;
    },
    [filter, direction],
  );
  const refresh = useCallback(async () => {
    const current = generation.current;
    try {
      const [s, t, p, i] = await Promise.allSettled([
        request<ChannelStatus>("/status"),
        request<{ items: Target[] }>("/sessions"),
        request<Page>(messagePath()),
        request<{ items: Interaction[] }>("/interactions"),
      ]);
      if (!alive.current || current !== generation.current) return;
      if (s.status === "fulfilled") {
        setStatus(s.value);
        setLoaded(true);
      }
      if (t.status === "fulfilled") setTargets(t.value.items);
      if (i.status === "fulfilled") setInteractions(i.value.items);
      if (p.status === "fulfilled" && !expanded.current) setPage(p.value);
      const failures = [s, t, p, i].filter(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );
      setRefreshError(
        [
          ...new Set(
            failures.map((result) =>
              result.reason instanceof Error
                ? result.reason.message
                : String(result.reason),
            ),
          ),
        ].join("；"),
      );
    } catch (e) {
      if (alive.current && current === generation.current)
        setRefreshError(e instanceof Error ? e.message : String(e));
    }
  }, [messagePath]);
  useEffect(() => {
    alive.current = true;
    generation.current++;
    expanded.current = false;
    setPage({ items: [] });
    // Schedule after each completion so a slow host never accumulates requests.
    let timer: ReturnType<typeof setTimeout>;
    let disposed = false;
    const poll = async (): Promise<void> => {
      if (disposed) return;
      await refresh();
      if (!disposed) timer = setTimeout(poll, 2500);
    };
    void poll();
    return () => {
      disposed = true;
      alive.current = false;
      clearTimeout(timer);
    };
  }, [refresh]);
  const act = async (path: string, body: unknown = {}): Promise<void> => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await request(path, body);
      setNotice("操作已提交");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const more = async (): Promise<void> => {
    setBusy(true);
    const current = generation.current;
    try {
      const next = await request<Page>(messagePath(page.nextCursor));
      if (alive.current && current === generation.current) {
        expanded.current = true;
        setPage((p) => ({
          items: [
            ...p.items,
            ...next.items.filter(
              (m) => !p.items.some((old) => old.id === m.id),
            ),
          ],
          nextCursor: next.nextCursor,
        }));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const candidate = status?.pairing?.ownerId;
  return (
    <section className="wc-panel" aria-label="微信通道管理">
      <style>{style}</style>
      <div className="wc-row wc-spread">
        <div>
          <h2>微信</h2>
          <p className="wc-muted">通过微信连接这台电脑上的 DSH。</p>
        </div>
        <span className="wc-badge">
          {status ? statusLabel(status.connection) : "读取状态中"}
        </span>
      </div>
      {(error || refreshError) && (
        <p className="wc-error" role="alert">
          {error || refreshError}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <div className="wc-tabs" role="tablist" aria-label="微信设置页面">
        {[
          ["connection", "连接与会话"],
          ["messages", "消息与附件"],
          ["execution", "执行与确认"],
        ].map(([id, title]) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
          >
            {title}
          </button>
        ))}
      </div>
      {!loaded && !error && !refreshError && (
        <p className="wc-empty">正在读取本地通道记录…</p>
      )}
      {tab === "connection" && (
        <>
          <div className="wc-card">
            <h3>个人微信绑定</h3>
            <p>
              绑定身份：<code>{status?.ownerId ?? "尚未绑定"}</code>
            </p>
            <div className="wc-row">
              <button
                className="wc-primary"
                disabled={busy || !!status?.ownerId}
                onClick={() => void act("/pairing/start")}
              >
                扫码连接微信
              </button>
              {status?.ownerId && (
                <button
                  disabled={busy}
                  className="wc-danger"
                  onClick={() => setConfirm({ kind: "unbind" })}
                >
                  解绑
                </button>
              )}
            </div>
            {status?.pairing?.qrDataUrl &&
              /^data:image\/(png|svg\+xml|jpeg);base64,/.test(
                status.pairing.qrDataUrl,
              ) && (
                <p>
                  <img
                    className="wc-qr"
                    src={status.pairing.qrDataUrl}
                    alt="微信绑定二维码，请使用本人的微信扫描"
                  />
                </p>
              )}
            {status?.pairing?.status && (
              <p className="wc-muted">
                配对状态：{statusLabel(status.pairing.status)}
              </p>
            )}
            {candidate && !status?.ownerId && (
              <div className="wc-card wc-confirm">
                <p>
                  确认将此身份作为唯一微信使用者：<code>{candidate}</code>
                </p>
                <button
                  disabled={busy}
                  className="wc-primary"
                  onClick={() => void act("/pairing/confirm")}
                >
                  确认是本人
                </button>
              </div>
            )}
          </div>
          <div className="wc-card">
            <h3>通道连接</h3>
            <div className="wc-row">
              {[
                ["start", "启动"],
                ["stop", "停止接收"],
                ["reconnect", "重新连接"],
              ].map(([action, label]) => (
                <button
                  key={action}
                  disabled={busy || (!status?.ownerId && action !== "stop")}
                  onClick={() => void act(`/connection/${action}`)}
                >
                  {label}
                </button>
              ))}
            </div>
            {status?.counts && (
              <p className="wc-muted">
                {Object.entries(status.counts)
                  .map(([key, value]) => `${statusLabel(key)} ${value}`)
                  .join(" · ")}
              </p>
            )}
            {status?.lastPollAt && (
              <p className="wc-muted">最近收取：{date(status.lastPollAt)}</p>
            )}
            {status?.error && <p className="wc-error">{status.error}</p>}
          </div>
          <div className="wc-card">
            <h3>目标会话</h3>
            <p className="wc-muted">
              微信消息发送到固定会话；切换桌面窗口不会改变此绑定。
            </p>
            <p>
              当前会话：<code>{status?.binding?.sessionId ?? "尚未选择"}</code>
            </p>
            <div className="wc-row">
              <label>
                会话
                <select
                  aria-label="目标 DSH 会话"
                  value={selected}
                  onChange={(e) => setSelected(e.target.value)}
                >
                  <option value="">选择会话</option>
                  {targets.map((t) => (
                    <option key={t.sessionId} value={t.sessionId}>
                      {t.title || t.sessionId}
                      {t.cwd ? ` · ${t.cwd}` : ""}
                    </option>
                  ))}
                </select>
              </label>
              <button
                disabled={busy || !selected}
                onClick={() =>
                  void act("/binding", {
                    sessionId: selected,
                    expectedRevision: status?.binding?.revision ?? 0,
                  })
                }
              >
                保存绑定
              </button>
            </div>
            {loaded && !targets.length && (
              <p className="wc-muted">
                尚无可选会话，请先在 DSH 中创建项目会话。
              </p>
            )}
          </div>
        </>
      )}
      {tab === "messages" && (
        <>
          <div className="wc-row">
            <label>
              状态
              <select
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              >
                {[
                  ["", "全部"],
                  ["received", "已接收"],
                  ["preparing", "处理附件中"],
                  ["ready", "准备提交"],
                  ["accepted", "已接受"],
                  ["queued", "已排队"],
                  ["running", "执行中"],
                  ["completed", "执行完成"],
                  ["sent", "微信接口已接受"],
                  ["sending", "发送中"],
                  ["retry_wait", "等待重试"],
                  ["waiting_context", "等待微信消息"],
                  ["cancelled", "已取消"],
                  ["failed", "失败"],
                  ["uncertain", "待核对"],
                ].map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
            <label>
              方向
              <select
                value={direction}
                onChange={(e) => setDirection(e.target.value)}
              >
                <option value="">全部</option>
                <option value="in">微信发来</option>
                <option value="out">发往微信</option>
              </select>
            </label>
            <button
              disabled={busy}
              onClick={() => {
                expanded.current = false;
                setError("");
                void refresh();
              }}
            >
              刷新最新记录
            </button>
          </div>
          {expanded.current && (
            <p className="wc-muted">
              正在查看历史记录，点击刷新可返回最新消息。
            </p>
          )}
          {loaded && !page.items.length && (
            <p className="wc-empty">
              暂无符合条件的消息。连接后发送一条微信消息开始。
            </p>
          )}
          {page.items.map((m) => (
            <article
              className="wc-card wc-message"
              data-direction={m.direction}
              key={m.id}
            >
              <div className="wc-row wc-spread">
                <strong>
                  {m.direction === "in" ? "微信 → DSH" : "DSH → 微信"}
                </strong>
                <span className="wc-badge">{statusLabel(m.state)}</span>
              </div>
              <small className="wc-muted">{date(m.createdAt)}</small>
              <p className="wc-text">{m.text}</p>
              <div className="wc-media">
                {m.attachments?.map((a) => (
                  <a
                    className="wc-attachment"
                    key={a.id}
                    href={attachmentUrl(a.id)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {a.mime?.startsWith("image/") &&
                      a.mime !== "image/svg+xml" && (
                        <img
                          src={attachmentUrl(a.id)}
                          alt={a.name}
                          loading="lazy"
                        />
                      )}
                    <span>{a.name} ↗</span>
                    <small className="wc-muted">{formatSize(a.size)}</small>
                  </a>
                ))}
              </div>
              {m.error && <p className="wc-error">{m.error}</p>}
              {(m.sessionId || m.submissionId) && (
                <p className="wc-muted">
                  <small>
                    会话 <code>{m.sessionId ?? "—"}</code>
                    {m.submissionId && (
                      <>
                        {" "}
                        · 提交 <code>{m.submissionId}</code>
                      </>
                    )}
                  </small>
                </p>
              )}
              {m.sessionId && openSession && (
                <button onClick={() => openSession(m.sessionId!)}>
                  打开 DSH 会话
                </button>
              )}
              {m.direction === "in" && m.state === "failed" && (
                <div className="wc-row">
                  <button
                    disabled={busy}
                    onClick={() =>
                      void act(`/messages/${encodeURIComponent(m.id)}/retry`)
                    }
                  >
                    重试此任务
                  </button>
                  <button
                    disabled={busy}
                    onClick={() =>
                      void act(`/messages/${encodeURIComponent(m.id)}/cancel`)
                    }
                  >
                    取消此任务
                  </button>
                </div>
              )}
              {m.direction === "out" &&
                ["failed", "uncertain"].includes(m.state) && (
                  <button
                    disabled={busy}
                    onClick={() =>
                      m.state === "uncertain"
                        ? setConfirm({
                            kind: "retry",
                            id: m.deliveryId ?? m.id,
                          })
                        : void act(
                            `/deliveries/${encodeURIComponent(m.deliveryId ?? m.id)}/retry`,
                          )
                    }
                  >
                    重新发送
                  </button>
                )}
            </article>
          ))}
          {page.nextCursor && (
            <button disabled={busy} onClick={() => void more()}>
              加载更早记录
            </button>
          )}
        </>
      )}
      {tab === "execution" && (
        <>
          <div className="wc-card">
            <h3>执行记录</h3>
            <p>打开 DSH 会话后，使用原生 Trajectory 查看执行过程和工具调用。</p>
            <p>
              已绑定会话：
              <code>{status?.binding?.sessionId ?? "尚未绑定"}</code>
            </p>
            {status?.binding?.sessionId && openSession && (
              <button
                className="wc-primary"
                onClick={() => openSession(status.binding!.sessionId)}
              >
                打开 DSH 会话
              </button>
            )}
            {status?.binding?.sessionId && (
              <button
                onClick={() => {
                  void navigator.clipboard
                    .writeText(status.binding!.sessionId)
                    .then(() => setNotice("已复制会话 ID"))
                    .catch(() => setError("复制失败，请手动选择会话 ID"));
                }}
              >
                复制会话 ID
              </button>
            )}
            {status?.binding?.sessionId && (
              <button
                className="wc-danger"
                disabled={busy}
                onClick={() =>
                  void act(
                    `/sessions/${encodeURIComponent(status.binding!.sessionId)}/stop`,
                  )
                }
              >
                停止当前微信任务
              </button>
            )}
            <p className="wc-muted">
              停止仅针对微信发起的任务；桌面发起的任务由 DSH 管理。
            </p>
          </div>
          <h3>待确认请求</h3>
          {!interactions.length && loaded && (
            <p className="wc-empty">暂无待确认请求。</p>
          )}
          {interactions.map((i) => (
            <InteractionCard
              key={i.id}
              interaction={i}
              disabled={busy}
              resolve={(decision, text) =>
                act(`/interactions/${encodeURIComponent(i.id)}/resolve`, {
                  decision,
                  ...(text ? { text } : {}),
                })
              }
            />
          ))}
        </>
      )}
      {confirm && (
        <div
          className="wc-card wc-confirm"
          role="alertdialog"
          aria-label="确认操作"
        >
          <p>
            {confirm.kind === "unbind"
              ? "解绑后此微信将无法继续控制 DSH，重新使用需要扫码绑定。确认解绑？"
              : "微信接口可能已接受这条消息。再次发送可能让微信收到重复消息，是否仍然发送？"}
          </p>
          <div className="wc-row">
            <button
              disabled={busy}
              onClick={() => {
                const c = confirm;
                setConfirm(undefined);
                void act(
                  c.kind === "unbind"
                    ? "/unbind"
                    : `/deliveries/${encodeURIComponent(c.id!)}/retry`,
                  c.kind === "retry" ? { allowDuplicate: true } : {},
                );
              }}
            >
              确认{confirm.kind === "unbind" ? "解绑" : "再次发送"}
            </button>
            <button onClick={() => setConfirm(undefined)}>取消</button>
          </div>
        </div>
      )}
    </section>
  );
}

function InteractionCard({
  interaction: i,
  disabled,
  resolve,
}: {
  interaction: Interaction;
  disabled: boolean;
  resolve: (decision: string, text?: string) => Promise<void>;
}): React.ReactElement {
  const [answer, setAnswer] = useState("");
  const isQuestion = i.kind === "question";
  const expired = !!i.expiresAt && i.expiresAt < Date.now();
  return (
    <div className="wc-card">
      <div className="wc-row wc-spread">
        <strong>{isQuestion ? "DSH 提问" : "操作审批"}</strong>
        <span className="wc-badge">
          {expired ? "已过期" : statusLabel(i.state)}
        </span>
      </div>
      <p className="wc-text">{i.description}</p>
      {i.expiresAt && (
        <small className="wc-muted">有效期至 {date(i.expiresAt)}</small>
      )}
      {isQuestion && (
        <input
          className="wc-answer"
          aria-label="给 DSH 的答复"
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          placeholder="输入答复"
        />
      )}
      <div className="wc-row">
        <button
          className="wc-primary"
          disabled={
            disabled ||
            expired ||
            i.state !== "pending" ||
            (isQuestion && !answer.trim())
          }
          onClick={() =>
            void resolve("approve", isQuestion ? answer : undefined)
          }
        >
          {isQuestion ? "提交答复" : "允许"}
        </button>
        <button
          disabled={disabled || expired || i.state !== "pending"}
          onClick={() => void resolve("deny")}
        >
          拒绝
        </button>
      </div>
    </div>
  );
}
