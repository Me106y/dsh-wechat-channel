// Isolated, explicitly labelled browser fixture. Never registers in the DSH plugin.
import { build } from "esbuild";
import http from "node:http";
const port = Number(process.env.UI_PREVIEW_PORT || 4398);
const { outputFiles } = await build({
  stdin: {
    contents: `import React from 'react'; import { createRoot } from 'react-dom/client'; import {WechatPanel} from './src/client/index.tsx'; createRoot(document.getElementById('root')).render(React.createElement(WechatPanel));`,
    resolveDir: process.cwd(),
    loader: "tsx",
  },
  bundle: true,
  write: false,
  format: "iife",
  platform: "browser",
  jsx: "automatic",
});
const now = Date.now();
const demoImage = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
  "base64",
);
const messages = [
  {
    id: "demo-1",
    direction: "in",
    text: "请看一下这张图片和需求文件，帮我整理实现方案。",
    state: "completed",
    createdAt: now,
    sessionId: "demo-session",
    attachments: [
      { id: "demo-image", name: "界面截图.png", mime: "image/png", size: 4120 },
      { id: "demo-file", name: "需求说明.txt", mime: "text/plain", size: 2080 },
    ],
  },
  {
    id: "demo-2",
    direction: "out",
    text: "已完成分析，设计方案已保存。\n我建议先打通文本链路，再验证附件传输与断线恢复。",
    state: "sent",
    createdAt: now - 3000,
    sessionId: "demo-session",
    attachments: [],
  },
  {
    id: "demo-3",
    direction: "out",
    text: "这是投递状态不确定的测试消息。",
    state: "uncertain",
    error: "发送响应未返回，尚不能确认微信是否已收到。",
    createdAt: now - 6000,
    attachments: [],
  },
  {
    id: "demo-4",
    direction: "in",
    text: "这是附件准备失败的测试消息。",
    state: "failed",
    error: "附件下载失败，可重试或取消此任务。",
    createdAt: now - 9000,
    attachments: [],
  },
];
let bound = true;
let connection = "connected";
const interactions = [
  {
    id: "approval-1",
    kind: "approval",
    description: "测试审批：允许更新项目内的 README.md？",
    state: "pending",
    expiresAt: now + 3600000,
  },
  {
    id: "question-1",
    kind: "question",
    description: "测试提问：这份报告使用中文还是英文？",
    state: "pending",
    expiresAt: now + 3600000,
  },
];
http
  .createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    res.setHeader("Cache-Control", "no-store");
    const json = (value) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(value));
    };
    if (url.pathname === "/") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.end(
        '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>微信插件 · 隔离测试数据</title><body style="margin:0;background:#f7f9f8;color:#18261f"><aside style="background:#f6df9d;padding:10px 20px;font:14px system-ui">仅用于界面测试 · 以下均为虚构样例 · 未连接微信或 DSH</aside><main id="root" style="max-width:1000px;margin:24px auto;background:white;border-radius:16px"></main><script src="/client.js"></script></body></html>',
      );
    }
    if (url.pathname === "/client.js") {
      res.setHeader("Content-Type", "text/javascript");
      return res.end(outputFiles[0].text);
    }
    const path = url.pathname.replace("/dsh-wechat-channel/api", "");
    if (req.method === "POST") {
      let raw = "";
      for await (const part of req) raw += part;
      const body = raw ? JSON.parse(raw) : {};
      if (path === "/unbind") bound = false;
      if (path === "/pairing/confirm") bound = true;
      if (path.startsWith("/connection/"))
        connection = path.endsWith("/stop") ? "stopped" : "connected";
      if (path.startsWith("/interactions/")) {
        const item = interactions.find((i) => path.includes(i.id));
        if (item) item.state = "resolved";
      }
      if (path.startsWith("/deliveries/")) {
        const item = messages.find((i) => path.includes(i.id));
        if (item) {
          item.state = "sent";
          delete item.error;
        }
      }
      if (path.startsWith("/messages/")) {
        const item = messages.find((i) => path.includes(i.id));
        if (item) {
          item.state = path.endsWith("/cancel") ? "cancelled" : "queued";
          delete item.error;
        }
      }
      console.log("Fixture command", path, body);
      return json({ ok: true });
    }
    if (path === "/status")
      return json({
        connection,
        ownerId: bound ? "demo-owner" : undefined,
        pairing: bound
          ? undefined
          : {
              status: "scanned",
              ownerId: "demo-owner",
              qrDataUrl: `data:image/png;base64,${demoImage.toString("base64")}`,
            },
        binding: { sessionId: "demo-session", revision: 1 },
        counts: { completed: 1, sent: 1, failed: 1, uncertain: 1 },
      });
    if (path === "/sessions")
      return json({
        items: [
          {
            sessionId: "demo-session",
            title: "微信插件测试项目",
            cwd: "/demo/project",
          },
        ],
      });
    if (path === "/messages")
      return json({
        items: messages.filter(
          (m) =>
            (!url.searchParams.get("state") ||
              m.state === url.searchParams.get("state")) &&
            (!url.searchParams.get("direction") ||
              m.direction === url.searchParams.get("direction")),
        ),
      });
    if (path === "/interactions")
      return json({ items: interactions.filter((i) => i.state === "pending") });
    if (path === "/attachments/demo-image") {
      res.setHeader("Content-Type", "image/png");
      return res.end(demoImage);
    }
    if (path === "/attachments/demo-file") {
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      return res.end("这是用于界面测试的附件，不包含真实项目数据。");
    }
    res.statusCode = 404;
    json({ error: { code: "NOT_FOUND", message: "未知测试接口" } });
  })
  .listen(port, "127.0.0.1", () =>
    console.log(`Isolated fixture: http://127.0.0.1:${port}`),
  );
