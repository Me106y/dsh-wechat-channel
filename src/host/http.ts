import type { IncomingMessage, ServerResponse } from "node:http";
import type { WechatService } from "../core/service.js";
import { safeCode } from "../core/service.js";
/** The official DSH Connection service owns browser token exchange and cookies. */
export interface BrowserConnection {
  requestRejection(request: {
    readonly headers: Readonly<
      Record<string, string | readonly string[] | undefined>
    >;
  }): 401 | 403 | undefined;
}
export function allowedRequest(req: IncomingMessage): boolean {
  const remote = req.socket.remoteAddress;
  if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote ?? ""))
    return false;
  let url: URL;
  try {
    url = new URL(`http://${req.headers.host}`);
  } catch {
    return false;
  }
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return false;
  if (req.headers.origin && req.headers.origin !== url.origin) return false;
  if (
    req.method !== "GET" &&
    (req.headers["x-dsh-wechat-channel"] !== "1" ||
      !req.headers["content-type"]?.startsWith("application/json"))
  )
    return false;
  return true;
}
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let n = 0;
  const chunks: Buffer[] = [];
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
const strings = (x: unknown) => (typeof x === "string" ? x : "");
export function handler(service: WechatService, connection: BrowserConnection) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    const json = (status: number, value: unknown) => {
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
      });
      res.end(JSON.stringify(value));
    };
    if (!allowedRequest(req)) {
      json(403, {
        error: { code: "FORBIDDEN", message: "仅允许本机 DSH 页面操作" },
      });
      return;
    }
    const rejection = connection.requestRejection(req);
    if (rejection !== undefined) {
      json(rejection, {
        error: {
          code: rejection === 401 ? "UNAUTHORIZED" : "FORBIDDEN",
          message:
            rejection === 401
              ? "请使用 DSH 启动链接登录后重试"
              : "仅允许本机 DSH 页面操作",
        },
      });
      return;
    }
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      const path = url.pathname.replace(/^\/dsh-wechat-channel\/api/, "");
      let result: unknown;
      if (req.method === "GET") {
        if (path === "/status") result = service.status();
        else if (path === "/sessions")
          result = { items: await service.dsh.getTargets() };
        else if (path === "/interactions") result = service.listInteractions();
        else if (path === "/messages") {
          const n = Number(url.searchParams.get("before"));
          result = service.listMessages({
            before: Number.isFinite(n) && n > 0 ? n : undefined,
            state: url.searchParams.get("state") ?? undefined,
            direction: url.searchParams.get("direction") ?? undefined,
          });
        } else if (path.startsWith("/attachments/")) {
          const a = service.store.attachment(
            decodeURIComponent(path.slice("/attachments/".length)),
          );
          if (!a) throw new Error("NOT_FOUND");
          const bytes = await service.files.read(a);
          const image = [
            "image/png",
            "image/jpeg",
            "image/gif",
            "image/webp",
          ].includes(a.mime);
          res.writeHead(200, {
            "Content-Type": image ? a.mime : "application/octet-stream",
            "Content-Length": bytes.length,
            "Content-Disposition": `${image ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(a.name)}`,
            "Content-Security-Policy": "default-src 'none'; sandbox",
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
            Number(data.expectedRevision ?? 0),
          );
        else if (/^\/deliveries\/[^/]+\/retry$/.test(path)) {
          service.store.retry(
            decodeURIComponent(path.split("/")[2]),
            data.allowDuplicate === true,
          );
          result = { ok: true };
        } else if (/^\/messages\/[^/]+\/retry$/.test(path))
          result = await service.retryMessage(
            decodeURIComponent(path.split("/")[2]),
          );
        else if (/^\/messages\/[^/]+\/cancel$/.test(path))
          result = await service.cancelMessage(
            decodeURIComponent(path.split("/")[2]),
          );
        else if (/^\/sessions\/[^/]+\/stop$/.test(path))
          result = await service.stopSession(
            decodeURIComponent(path.split("/")[2]),
          );
        else if (/^\/interactions\/[^/]+\/resolve$/.test(path)) {
          const decision = strings(data.decision);
          if (!["approve", "deny", "answer"].includes(decision))
            throw new Error("INVALID_DECISION");
          result = await service.resolveInteraction(
            decodeURIComponent(path.split("/")[2]),
            decision,
            strings(data.text),
          );
        } else throw new Error("NOT_FOUND");
      } else {
        json(405, {
          error: { code: "METHOD_NOT_ALLOWED", message: "不支持该操作" },
        });
        return;
      }
      json(200, result);
    } catch (e) {
      const code = safeCode(e);
      json(code === "NOT_FOUND" ? 404 : 409, {
        error: { code, message: errorCopy[code] ?? `操作未完成（${code}）` },
      });
    }
  };
}
const errorCopy: Record<string, string> = {
  OWNER_UNVERIFIED: "请先扫码，并在电脑端确认本人身份",
  SESSION_UNAVAILABLE: "请先选择一个可用的 DSH 会话",
  REVISION_CONFLICT: "配置已变更，请刷新页面",
  INTERACTION_EXPIRED: "确认请求已失效",
  ANSWER_IN_DSH_REQUIRED: "此问题包含多个字段，请在 DSH 中回答",
  ALREADY_SUBMITTED: "该消息已交给 DSH，请查看执行结果，不能重复提交",
  DUPLICATE_CONFIRMATION_REQUIRED: "发送结果未知，请确认微信是否收到后再重发",
  ATTACHMENT_CORRUPT: "附件已损坏，无法读取",
};
