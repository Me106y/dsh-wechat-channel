window.__ModuleLoader__.load({id:"dsh-wechat-channel",factory:function(require){var module={exports:{}};var exports=module.exports;
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client/index.tsx
var index_exports = {};
__export(index_exports, {
  WechatPanel: () => WechatPanel,
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(index_exports);
var import_react = require("react");

// src/client/api.ts
var API_BASE = "/dsh-wechat-channel/api";
async function request(path, body) {
  const signal = AbortSignal.timeout(
    path === "/pairing/start" && body !== void 0 ? 65e3 : 15e3
  );
  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      signal,
      method: body === void 0 ? "GET" : "POST",
      credentials: "same-origin",
      headers: body === void 0 ? { Accept: "application/json" } : {
        Accept: "application/json",
        "Content-Type": "application/json",
        "x-dsh-wechat-channel": "1"
      },
      ...body === void 0 ? {} : { body: JSON.stringify(body) }
    });
    if (response.status === 401)
      throw new Error(
        "DSH \u767B\u5F55\u5DF2\u5931\u6548\uFF0C\u8BF7\u4F7F\u7528\u672C\u6B21\u542F\u52A8\u65F6\u63D0\u4F9B\u7684\u94FE\u63A5\u91CD\u65B0\u6253\u5F00 DSH\u3002"
      );
    const result = await response.json();
    if (!response.ok)
      throw new Error(
        result?.error?.message ?? result?.error ?? `\u8BF7\u6C42\u5931\u8D25 (${response.status})`
      );
    return result;
  } catch (error) {
    if (signal.aborted || error instanceof Error && error.name === "TimeoutError")
      throw new Error(
        body === void 0 ? "\u8BFB\u53D6 DSH \u901A\u9053\u8BB0\u5F55\u8D85\u65F6\uFF0C\u8BF7\u68C0\u67E5 DSH \u662F\u5426\u4ECD\u5728\u8FD0\u884C\u3002" : "\u7B49\u5F85 DSH \u64CD\u4F5C\u7ED3\u679C\u8D85\u65F6\uFF0C\u64CD\u4F5C\u53EF\u80FD\u4ECD\u5728\u5904\u7406\u4E2D\uFF0C\u8BF7\u5148\u5237\u65B0\u72B6\u6001\u518D\u51B3\u5B9A\u662F\u5426\u91CD\u8BD5\u3002"
      );
    if (error instanceof TypeError)
      throw new Error(
        "\u65E0\u6CD5\u8FDE\u63A5 DSH\uFF0C\u8BF7\u68C0\u67E5 DSH \u662F\u5426\u4ECD\u5728\u8FD0\u884C\uFF0C\u4EE5\u53CA\u6D4F\u89C8\u5668\u662F\u5426\u62E6\u622A\u4E86\u672C\u673A\u8BF7\u6C42\u3002"
      );
    if (error instanceof SyntaxError)
      throw new Error("DSH \u8FD4\u56DE\u4E86\u65E0\u6CD5\u8BFB\u53D6\u7684\u54CD\u5E94\uFF0C\u8BF7\u5237\u65B0\u72B6\u6001\u540E\u91CD\u8BD5\u3002");
    throw error;
  }
}
var attachmentUrl = (id) => `${API_BASE}/attachments/${encodeURIComponent(id)}`;
function formatSize(bytes) {
  if (bytes === void 0) return "";
  return bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
}
var labels = {
  reconnecting: "\u6B63\u5728\u91CD\u65B0\u8FDE\u63A5",
  auth_required: "\u767B\u5F55\u5DF2\u5931\u6548\uFF0C\u8BF7\u91CD\u65B0\u626B\u7801",
  unbound: "\u5C1A\u672A\u7ED1\u5B9A",
  wait: "\u7B49\u5F85\u626B\u7801",
  scaned: "\u5DF2\u626B\u7801\uFF0C\u7B49\u5F85\u624B\u673A\u786E\u8BA4",
  confirmed: "\u5FAE\u4FE1\u767B\u5F55\u5DF2\u786E\u8BA4\uFF0C\u5F85\u786E\u8BA4\u672C\u4EBA\u7ED1\u5B9A",
  need_verifycode: "\u9700\u8981\u5FAE\u4FE1\u9A8C\u8BC1",
  verify_code_blocked: "\u5FAE\u4FE1\u9A8C\u8BC1\u6682\u4E0D\u53EF\u7528",
  connected: "\u5DF2\u8FDE\u63A5",
  online: "\u5728\u7EBF",
  idle: "\u672A\u542F\u52A8",
  stopped: "\u5DF2\u505C\u6B62",
  connecting: "\u8FDE\u63A5\u4E2D",
  disconnected: "\u5DF2\u65AD\u5F00",
  pairing: "\u7B49\u5F85\u626B\u7801",
  expired: "\u5DF2\u8FC7\u671F",
  pending: "\u5F85\u5904\u7406",
  preparing: "\u5904\u7406\u9644\u4EF6\u4E2D",
  ready: "\u51C6\u5907\u63D0\u4EA4",
  accepted: "\u5DF2\u63A5\u53D7",
  cancelled: "\u5DF2\u53D6\u6D88",
  sending: "\u53D1\u9001\u4E2D",
  retry_wait: "\u7B49\u5F85\u91CD\u8BD5",
  waiting_context: "\u7B49\u5F85\u65B0\u7684\u5FAE\u4FE1\u6D88\u606F",
  received: "\u5DF2\u63A5\u6536",
  queued: "\u5DF2\u6392\u961F",
  submitted: "\u5DF2\u63D0\u4EA4",
  running: "\u6267\u884C\u4E2D",
  completed: "\u6267\u884C\u5B8C\u6210",
  sent: "\u5FAE\u4FE1\u63A5\u53E3\u5DF2\u63A5\u53D7",
  failed: "\u5931\u8D25",
  uncertain: "\u5F85\u6838\u5BF9",
  awaiting_context: "\u7B49\u5F85\u65B0\u7684\u5FAE\u4FE1\u6D88\u606F",
  rejected: "\u5DF2\u62D2\u7EDD",
  resolved: "\u5DF2\u5904\u7406"
};
var statusLabel = (value) => labels[value] ?? value;

// src/client/index.tsx
var import_jsx_runtime = require("react/jsx-runtime");
var inject = ["slots", "sessions"];
function apply(ctx) {
  const Section = ({ close }) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
    WechatPanel,
    {
      openSession: (id) => {
        ctx.sessions.open(id);
        close?.();
      }
    }
  );
  ctx.slots.inject(
    "settings.section",
    () => ctx.slots.register(
      {
        name: "settings.section",
        id: "wechat",
        order: 80,
        label: () => "\u5FAE\u4FE1"
      },
      Section
    )
  );
}
var style = `
.wc-panel{font:14px/1.6 system-ui,sans-serif;color:inherit;max-width:1000px;width:100%;min-width:0;padding:20px;box-sizing:border-box}
.wc-panel *{box-sizing:border-box}.wc-panel h2{font-size:22px;margin:0}.wc-panel h3{font-size:15px;margin:0 0 12px}.wc-panel p{margin:8px 0}.wc-muted{opacity:.65}.wc-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.wc-spread{justify-content:space-between}.wc-tabs{display:flex;border-bottom:1px solid #8884;gap:8px;margin:24px 0}.wc-panel button,.wc-panel select,.wc-panel input{font:inherit;color:inherit;background:transparent;border:1px solid #8886;border-radius:7px;padding:7px 12px}.wc-panel button{cursor:pointer}.wc-panel button:disabled{opacity:.45;cursor:default}.wc-panel button:focus-visible,.wc-panel select:focus-visible,.wc-panel input:focus-visible{outline:2px solid #1b9d73;outline-offset:2px}.wc-tabs button{border:0;border-radius:0;border-bottom:2px solid transparent;padding:10px 12px}.wc-tabs button[aria-selected=true]{border-bottom-color:#1b9d73;color:#1b9d73}.wc-panel .wc-primary{background:#167956;color:white;border-color:#167956}.wc-card{border:1px solid #8884;border-radius:10px;padding:18px;margin:14px 0}.wc-error{color:#c74539;border:1px solid #c7453966;border-radius:8px;padding:10px}.wc-badge{font-size:12px;padding:3px 8px;border-radius:20px;background:#8882}.wc-message{border-left:3px solid #1b9d7366}.wc-message[data-direction=out]{border-left-color:#768cc7}.wc-text{white-space:pre-wrap;overflow-wrap:anywhere}.wc-panel a{color:#218868}.wc-media{display:flex;flex-wrap:wrap;gap:12px;margin-top:12px}.wc-attachment{display:flex;flex-direction:column;gap:4px;max-width:220px;overflow-wrap:anywhere}.wc-attachment img{max-width:220px;max-height:160px;border-radius:6px;object-fit:contain;background:white}.wc-qr{width:220px;height:220px;background:white;padding:10px;border-radius:8px}.wc-empty{text-align:center;padding:35px 10px;opacity:.65}.wc-panel code{font-size:12px;overflow-wrap:anywhere}.wc-panel label{display:flex;gap:8px;align-items:center;min-width:0;max-width:100%;white-space:nowrap}.wc-panel select{min-width:0;max-width:100%;width:100%;text-overflow:ellipsis}.wc-danger{color:#c74539!important}.wc-confirm{background:#b5821512}.wc-answer{width:100%;margin:10px 0}@media(max-width:600px){.wc-panel{padding:10px}.wc-panel label{align-items:flex-start;flex-direction:column}.wc-tabs{gap:0}.wc-tabs button{padding:10px 8px}}
`;
var date = (n) => n ? new Date(n).toLocaleString("zh-CN") : "\u2014";
function WechatPanel({
  openSession
} = {}) {
  const [tab, setTab] = (0, import_react.useState)("connection");
  const [status, setStatus] = (0, import_react.useState)();
  const [targets, setTargets] = (0, import_react.useState)([]);
  const [page, setPage] = (0, import_react.useState)({ items: [] });
  const [interactions, setInteractions] = (0, import_react.useState)([]);
  const [selected, setSelected] = (0, import_react.useState)("");
  const [filter, setFilter] = (0, import_react.useState)("");
  const [direction, setDirection] = (0, import_react.useState)("");
  const [error, setError] = (0, import_react.useState)("");
  const [refreshError, setRefreshError] = (0, import_react.useState)("");
  const [notice, setNotice] = (0, import_react.useState)("");
  const [busy, setBusy] = (0, import_react.useState)(false);
  const [loaded, setLoaded] = (0, import_react.useState)(false);
  const [confirm, setConfirm] = (0, import_react.useState)();
  const alive = (0, import_react.useRef)(true);
  const generation = (0, import_react.useRef)(0);
  const expanded = (0, import_react.useRef)(false);
  const messagePath = (0, import_react.useCallback)(
    (cursor) => {
      const query = new URLSearchParams();
      if (filter) query.set("state", filter);
      if (direction) query.set("direction", direction);
      if (cursor) query.set("before", cursor);
      return `/messages?${query}`;
    },
    [filter, direction]
  );
  const refresh = (0, import_react.useCallback)(async () => {
    const current = generation.current;
    try {
      const [s, t, p, i] = await Promise.allSettled([
        request("/status"),
        request("/sessions"),
        request(messagePath()),
        request("/interactions")
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
        (result) => result.status === "rejected"
      );
      setRefreshError(
        [
          ...new Set(
            failures.map(
              (result) => result.reason instanceof Error ? result.reason.message : String(result.reason)
            )
          )
        ].join("\uFF1B")
      );
    } catch (e) {
      if (alive.current && current === generation.current)
        setRefreshError(e instanceof Error ? e.message : String(e));
    }
  }, [messagePath]);
  (0, import_react.useEffect)(() => {
    alive.current = true;
    generation.current++;
    expanded.current = false;
    setPage({ items: [] });
    let timer;
    let disposed = false;
    const poll = async () => {
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
  const act = async (path, body = {}) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await request(path, body);
      setNotice("\u64CD\u4F5C\u5DF2\u63D0\u4EA4");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const more = async () => {
    setBusy(true);
    const current = generation.current;
    try {
      const next = await request(messagePath(page.nextCursor));
      if (alive.current && current === generation.current) {
        expanded.current = true;
        setPage((p) => ({
          items: [
            ...p.items,
            ...next.items.filter(
              (m) => !p.items.some((old) => old.id === m.id)
            )
          ],
          nextCursor: next.nextCursor
        }));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const candidate = status?.pairing?.ownerId;
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { className: "wc-panel", "aria-label": "\u5FAE\u4FE1\u901A\u9053\u7BA1\u7406", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("style", { children: style }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "wc-row wc-spread", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", { children: "\u5FAE\u4FE1" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "wc-muted", children: "\u901A\u8FC7\u5FAE\u4FE1\u8FDE\u63A5\u8FD9\u53F0\u7535\u8111\u4E0A\u7684 DSH\u3002" })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "wc-badge", children: status ? statusLabel(status.connection) : "\u8BFB\u53D6\u72B6\u6001\u4E2D" })
    ] }),
    (error || refreshError) && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "wc-error", role: "alert", children: error || refreshError }),
    notice && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { role: "status", children: notice }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "wc-tabs", role: "tablist", "aria-label": "\u5FAE\u4FE1\u8BBE\u7F6E\u9875\u9762", children: [
      ["connection", "\u8FDE\u63A5\u4E0E\u4F1A\u8BDD"],
      ["messages", "\u6D88\u606F\u4E0E\u9644\u4EF6"],
      ["execution", "\u6267\u884C\u4E0E\u786E\u8BA4"]
    ].map(([id, title]) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      "button",
      {
        role: "tab",
        "aria-selected": tab === id,
        onClick: () => setTab(id),
        children: title
      },
      id
    )) }),
    !loaded && !error && !refreshError && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "wc-empty", children: "\u6B63\u5728\u8BFB\u53D6\u672C\u5730\u901A\u9053\u8BB0\u5F55\u2026" }),
    tab === "connection" && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "wc-card", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { children: "\u4E2A\u4EBA\u5FAE\u4FE1\u7ED1\u5B9A" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { children: [
          "\u7ED1\u5B9A\u8EAB\u4EFD\uFF1A",
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("code", { children: status?.ownerId ?? "\u5C1A\u672A\u7ED1\u5B9A" })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "wc-row", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            "button",
            {
              className: "wc-primary",
              disabled: busy || !!status?.ownerId,
              onClick: () => void act("/pairing/start"),
              children: "\u626B\u7801\u8FDE\u63A5\u5FAE\u4FE1"
            }
          ),
          status?.ownerId && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            "button",
            {
              disabled: busy,
              className: "wc-danger",
              onClick: () => setConfirm({ kind: "unbind" }),
              children: "\u89E3\u7ED1"
            }
          )
        ] }),
        status?.pairing?.qrDataUrl && /^data:image\/(png|svg\+xml|jpeg);base64,/.test(
          status.pairing.qrDataUrl
        ) && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "img",
          {
            className: "wc-qr",
            src: status.pairing.qrDataUrl,
            alt: "\u5FAE\u4FE1\u7ED1\u5B9A\u4E8C\u7EF4\u7801\uFF0C\u8BF7\u4F7F\u7528\u672C\u4EBA\u7684\u5FAE\u4FE1\u626B\u63CF"
          }
        ) }),
        status?.pairing?.status && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { className: "wc-muted", children: [
          "\u914D\u5BF9\u72B6\u6001\uFF1A",
          statusLabel(status.pairing.status)
        ] }),
        candidate && !status?.ownerId && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "wc-card wc-confirm", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { children: [
            "\u786E\u8BA4\u5C06\u6B64\u8EAB\u4EFD\u4F5C\u4E3A\u552F\u4E00\u5FAE\u4FE1\u4F7F\u7528\u8005\uFF1A",
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("code", { children: candidate })
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            "button",
            {
              disabled: busy,
              className: "wc-primary",
              onClick: () => void act("/pairing/confirm"),
              children: "\u786E\u8BA4\u662F\u672C\u4EBA"
            }
          )
        ] })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "wc-card", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { children: "\u901A\u9053\u8FDE\u63A5" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "wc-row", children: [
          ["start", "\u542F\u52A8"],
          ["stop", "\u505C\u6B62\u63A5\u6536"],
          ["reconnect", "\u91CD\u65B0\u8FDE\u63A5"]
        ].map(([action, label]) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "button",
          {
            disabled: busy || !status?.ownerId && action !== "stop",
            onClick: () => void act(`/connection/${action}`),
            children: label
          },
          action
        )) }),
        status?.counts && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "wc-muted", children: Object.entries(status.counts).map(([key, value]) => `${statusLabel(key)} ${value}`).join(" \xB7 ") }),
        status?.lastPollAt && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { className: "wc-muted", children: [
          "\u6700\u8FD1\u6536\u53D6\uFF1A",
          date(status.lastPollAt)
        ] }),
        status?.error && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "wc-error", children: status.error })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "wc-card", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { children: "\u76EE\u6807\u4F1A\u8BDD" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "wc-muted", children: "\u5FAE\u4FE1\u6D88\u606F\u53D1\u9001\u5230\u56FA\u5B9A\u4F1A\u8BDD\uFF1B\u5207\u6362\u684C\u9762\u7A97\u53E3\u4E0D\u4F1A\u6539\u53D8\u6B64\u7ED1\u5B9A\u3002" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { children: [
          "\u5F53\u524D\u4F1A\u8BDD\uFF1A",
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("code", { children: status?.binding?.sessionId ?? "\u5C1A\u672A\u9009\u62E9" })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "wc-row", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { children: [
            "\u4F1A\u8BDD",
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
              "select",
              {
                "aria-label": "\u76EE\u6807 DSH \u4F1A\u8BDD",
                value: selected,
                onChange: (e) => setSelected(e.target.value),
                children: [
                  /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "", children: "\u9009\u62E9\u4F1A\u8BDD" }),
                  targets.map((t) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("option", { value: t.sessionId, children: [
                    t.title || t.sessionId,
                    t.cwd ? ` \xB7 ${t.cwd}` : ""
                  ] }, t.sessionId))
                ]
              }
            )
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            "button",
            {
              disabled: busy || !selected,
              onClick: () => void act("/binding", {
                sessionId: selected,
                expectedRevision: status?.binding?.revision ?? 0
              }),
              children: "\u4FDD\u5B58\u7ED1\u5B9A"
            }
          )
        ] }),
        loaded && !targets.length && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "wc-muted", children: "\u5C1A\u65E0\u53EF\u9009\u4F1A\u8BDD\uFF0C\u8BF7\u5148\u5728 DSH \u4E2D\u521B\u5EFA\u9879\u76EE\u4F1A\u8BDD\u3002" })
      ] })
    ] }),
    tab === "messages" && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "wc-row", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { children: [
          "\u72B6\u6001",
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            "select",
            {
              value: filter,
              onChange: (e) => setFilter(e.target.value),
              children: [
                ["", "\u5168\u90E8"],
                ["received", "\u5DF2\u63A5\u6536"],
                ["preparing", "\u5904\u7406\u9644\u4EF6\u4E2D"],
                ["ready", "\u51C6\u5907\u63D0\u4EA4"],
                ["accepted", "\u5DF2\u63A5\u53D7"],
                ["queued", "\u5DF2\u6392\u961F"],
                ["running", "\u6267\u884C\u4E2D"],
                ["completed", "\u6267\u884C\u5B8C\u6210"],
                ["sent", "\u5FAE\u4FE1\u63A5\u53E3\u5DF2\u63A5\u53D7"],
                ["sending", "\u53D1\u9001\u4E2D"],
                ["retry_wait", "\u7B49\u5F85\u91CD\u8BD5"],
                ["waiting_context", "\u7B49\u5F85\u5FAE\u4FE1\u6D88\u606F"],
                ["cancelled", "\u5DF2\u53D6\u6D88"],
                ["failed", "\u5931\u8D25"],
                ["uncertain", "\u5F85\u6838\u5BF9"]
              ].map(([v, l]) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: v, children: l }, v))
            }
          )
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { children: [
          "\u65B9\u5411",
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
            "select",
            {
              value: direction,
              onChange: (e) => setDirection(e.target.value),
              children: [
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "", children: "\u5168\u90E8" }),
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "in", children: "\u5FAE\u4FE1\u53D1\u6765" }),
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "out", children: "\u53D1\u5F80\u5FAE\u4FE1" })
              ]
            }
          )
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "button",
          {
            disabled: busy,
            onClick: () => {
              expanded.current = false;
              setError("");
              void refresh();
            },
            children: "\u5237\u65B0\u6700\u65B0\u8BB0\u5F55"
          }
        )
      ] }),
      expanded.current && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "wc-muted", children: "\u6B63\u5728\u67E5\u770B\u5386\u53F2\u8BB0\u5F55\uFF0C\u70B9\u51FB\u5237\u65B0\u53EF\u8FD4\u56DE\u6700\u65B0\u6D88\u606F\u3002" }),
      loaded && !page.items.length && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "wc-empty", children: "\u6682\u65E0\u7B26\u5408\u6761\u4EF6\u7684\u6D88\u606F\u3002\u8FDE\u63A5\u540E\u53D1\u9001\u4E00\u6761\u5FAE\u4FE1\u6D88\u606F\u5F00\u59CB\u3002" }),
      page.items.map((m) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
        "article",
        {
          className: "wc-card wc-message",
          "data-direction": m.direction,
          children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "wc-row wc-spread", children: [
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { children: m.direction === "in" ? "\u5FAE\u4FE1 \u2192 DSH" : "DSH \u2192 \u5FAE\u4FE1" }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "wc-badge", children: statusLabel(m.state) })
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("small", { className: "wc-muted", children: date(m.createdAt) }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "wc-text", children: m.text }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "wc-media", children: m.attachments?.map((a) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
              "a",
              {
                className: "wc-attachment",
                href: attachmentUrl(a.id),
                target: "_blank",
                rel: "noreferrer",
                children: [
                  a.mime?.startsWith("image/") && a.mime !== "image/svg+xml" && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
                    "img",
                    {
                      src: attachmentUrl(a.id),
                      alt: a.name,
                      loading: "lazy"
                    }
                  ),
                  /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { children: [
                    a.name,
                    " \u2197"
                  ] }),
                  /* @__PURE__ */ (0, import_jsx_runtime.jsx)("small", { className: "wc-muted", children: formatSize(a.size) })
                ]
              },
              a.id
            )) }),
            m.error && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "wc-error", children: m.error }),
            (m.sessionId || m.submissionId) && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "wc-muted", children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("small", { children: [
              "\u4F1A\u8BDD ",
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("code", { children: m.sessionId ?? "\u2014" }),
              m.submissionId && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
                " ",
                "\xB7 \u63D0\u4EA4 ",
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)("code", { children: m.submissionId })
              ] })
            ] }) }),
            m.sessionId && openSession && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { onClick: () => openSession(m.sessionId), children: "\u6253\u5F00 DSH \u4F1A\u8BDD" }),
            m.direction === "in" && m.state === "failed" && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "wc-row", children: [
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
                "button",
                {
                  disabled: busy,
                  onClick: () => void act(`/messages/${encodeURIComponent(m.id)}/retry`),
                  children: "\u91CD\u8BD5\u6B64\u4EFB\u52A1"
                }
              ),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
                "button",
                {
                  disabled: busy,
                  onClick: () => void act(`/messages/${encodeURIComponent(m.id)}/cancel`),
                  children: "\u53D6\u6D88\u6B64\u4EFB\u52A1"
                }
              )
            ] }),
            m.direction === "out" && ["failed", "uncertain"].includes(m.state) && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
              "button",
              {
                disabled: busy,
                onClick: () => m.state === "uncertain" ? setConfirm({
                  kind: "retry",
                  id: m.deliveryId ?? m.id
                }) : void act(
                  `/deliveries/${encodeURIComponent(m.deliveryId ?? m.id)}/retry`
                ),
                children: "\u91CD\u65B0\u53D1\u9001"
              }
            )
          ]
        },
        m.id
      )),
      page.nextCursor && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { disabled: busy, onClick: () => void more(), children: "\u52A0\u8F7D\u66F4\u65E9\u8BB0\u5F55" })
    ] }),
    tab === "execution" && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "wc-card", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { children: "\u6267\u884C\u8BB0\u5F55" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { children: "\u6253\u5F00 DSH \u4F1A\u8BDD\u540E\uFF0C\u4F7F\u7528\u539F\u751F Trajectory \u67E5\u770B\u6267\u884C\u8FC7\u7A0B\u548C\u5DE5\u5177\u8C03\u7528\u3002" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { children: [
          "\u5DF2\u7ED1\u5B9A\u4F1A\u8BDD\uFF1A",
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("code", { children: status?.binding?.sessionId ?? "\u5C1A\u672A\u7ED1\u5B9A" })
        ] }),
        status?.binding?.sessionId && openSession && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "button",
          {
            className: "wc-primary",
            onClick: () => openSession(status.binding.sessionId),
            children: "\u6253\u5F00 DSH \u4F1A\u8BDD"
          }
        ),
        status?.binding?.sessionId && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "button",
          {
            onClick: () => {
              void navigator.clipboard.writeText(status.binding.sessionId).then(() => setNotice("\u5DF2\u590D\u5236\u4F1A\u8BDD ID")).catch(() => setError("\u590D\u5236\u5931\u8D25\uFF0C\u8BF7\u624B\u52A8\u9009\u62E9\u4F1A\u8BDD ID"));
            },
            children: "\u590D\u5236\u4F1A\u8BDD ID"
          }
        ),
        status?.binding?.sessionId && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "button",
          {
            className: "wc-danger",
            disabled: busy,
            onClick: () => void act(
              `/sessions/${encodeURIComponent(status.binding.sessionId)}/stop`
            ),
            children: "\u505C\u6B62\u5F53\u524D\u5FAE\u4FE1\u4EFB\u52A1"
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "wc-muted", children: "\u505C\u6B62\u4EC5\u9488\u5BF9\u5FAE\u4FE1\u53D1\u8D77\u7684\u4EFB\u52A1\uFF1B\u684C\u9762\u53D1\u8D77\u7684\u4EFB\u52A1\u7531 DSH \u7BA1\u7406\u3002" })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { children: "\u5F85\u786E\u8BA4\u8BF7\u6C42" }),
      !interactions.length && loaded && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "wc-empty", children: "\u6682\u65E0\u5F85\u786E\u8BA4\u8BF7\u6C42\u3002" }),
      interactions.map((i) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        InteractionCard,
        {
          interaction: i,
          disabled: busy,
          resolve: (decision, text) => act(`/interactions/${encodeURIComponent(i.id)}/resolve`, {
            decision,
            ...text ? { text } : {}
          })
        },
        i.id
      ))
    ] }),
    confirm && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
      "div",
      {
        className: "wc-card wc-confirm",
        role: "alertdialog",
        "aria-label": "\u786E\u8BA4\u64CD\u4F5C",
        children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { children: confirm.kind === "unbind" ? "\u89E3\u7ED1\u540E\u6B64\u5FAE\u4FE1\u5C06\u65E0\u6CD5\u7EE7\u7EED\u63A7\u5236 DSH\uFF0C\u91CD\u65B0\u4F7F\u7528\u9700\u8981\u626B\u7801\u7ED1\u5B9A\u3002\u786E\u8BA4\u89E3\u7ED1\uFF1F" : "\u5FAE\u4FE1\u63A5\u53E3\u53EF\u80FD\u5DF2\u63A5\u53D7\u8FD9\u6761\u6D88\u606F\u3002\u518D\u6B21\u53D1\u9001\u53EF\u80FD\u8BA9\u5FAE\u4FE1\u6536\u5230\u91CD\u590D\u6D88\u606F\uFF0C\u662F\u5426\u4ECD\u7136\u53D1\u9001\uFF1F" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "wc-row", children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
              "button",
              {
                disabled: busy,
                onClick: () => {
                  const c = confirm;
                  setConfirm(void 0);
                  void act(
                    c.kind === "unbind" ? "/unbind" : `/deliveries/${encodeURIComponent(c.id)}/retry`,
                    c.kind === "retry" ? { allowDuplicate: true } : {}
                  );
                },
                children: [
                  "\u786E\u8BA4",
                  confirm.kind === "unbind" ? "\u89E3\u7ED1" : "\u518D\u6B21\u53D1\u9001"
                ]
              }
            ),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { onClick: () => setConfirm(void 0), children: "\u53D6\u6D88" })
          ] })
        ]
      }
    )
  ] });
}
function InteractionCard({
  interaction: i,
  disabled,
  resolve
}) {
  const [answer, setAnswer] = (0, import_react.useState)("");
  const isQuestion = i.kind === "question";
  const expired = !!i.expiresAt && i.expiresAt < Date.now();
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "wc-card", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "wc-row wc-spread", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { children: isQuestion ? "DSH \u63D0\u95EE" : "\u64CD\u4F5C\u5BA1\u6279" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "wc-badge", children: expired ? "\u5DF2\u8FC7\u671F" : statusLabel(i.state) })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "wc-text", children: i.description }),
    i.expiresAt && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("small", { className: "wc-muted", children: [
      "\u6709\u6548\u671F\u81F3 ",
      date(i.expiresAt)
    ] }),
    isQuestion && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      "input",
      {
        className: "wc-answer",
        "aria-label": "\u7ED9 DSH \u7684\u7B54\u590D",
        value: answer,
        onChange: (e) => setAnswer(e.target.value),
        placeholder: "\u8F93\u5165\u7B54\u590D"
      }
    ),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "wc-row", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        "button",
        {
          className: "wc-primary",
          disabled: disabled || expired || i.state !== "pending" || isQuestion && !answer.trim(),
          onClick: () => void resolve("approve", isQuestion ? answer : void 0),
          children: isQuestion ? "\u63D0\u4EA4\u7B54\u590D" : "\u5141\u8BB8"
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        "button",
        {
          disabled: disabled || expired || i.state !== "pending",
          onClick: () => void resolve("deny"),
          children: "\u62D2\u7EDD"
        }
      )
    ] })
  ] });
}

return module.exports;}});
