import { join, resolve } from "node:path";
import { homedir } from "node:os";
import {
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import type { Context } from "@deepseek-ai/cordis";
import type { IncomingMessage, ServerResponse } from "node:http";
import { DshAdapter, type DshContext } from "../dsh/index.js";
import { WechatService } from "../core/service.js";
import { handler, type BrowserConnection } from "./http.js";
import {
  registerAttachmentTool,
  type AttachmentToolContext,
} from "../dsh/attachment-tool.js";
export const name = "dsh-wechat-channel";
export const inject = [
  "agents",
  "sessions",
  "sessionQuery",
  "sessionController",
  "typertGateway",
  "attachments",
  "webServer",
  "connection",
  "tools",
];
export interface Config {
  dataDir?: string;
  autoStart?: boolean;
}
interface WebHost {
  connection: BrowserConnection;
  webServer: {
    host: string;
    register(route: {
      kind: "prefix";
      path: string;
      handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
    }): () => void;
  };
}
/** The Host owns channel state. No second DSH runtime is constructed. */
export function apply(ctx: Context, config: Config = {}) {
  const host = ctx as unknown as DshContext & WebHost;
  if (host.webServer.host !== "127.0.0.1")
    throw new Error("DSH_WECHAT_REQUIRES_LOOPBACK_HOST");
  const root = resolve(
    config.dataDir ??
      join(
        process.env.DSH_HOME?.trim() || join(homedir(), ".dsh"),
        "plugins",
        "wechat-channel",
      ),
  );
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const lock = join(root, "host.lock");
  try {
    const fd = openSync(lock, "wx", 0o600);
    writeFileSync(fd, String(process.pid));
    closeSync(fd);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    const pid = Number(readFileSync(lock, "utf8"));
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ESRCH") alive = false;
    }
    if (alive || !Number.isSafeInteger(pid) || pid <= 0)
      throw new Error("WECHAT_HOST_ALREADY_RUNNING");
    unlinkSync(lock);
    const fd = openSync(lock, "wx", 0o600);
    writeFileSync(fd, String(process.pid));
    closeSync(fd);
  }
  let service: WechatService;
  let adapter: DshAdapter;
  try {
    adapter = new DshAdapter(host);
    service = new WechatService(root, adapter);
  } catch (e) {
    unlinkSync(lock);
    throw e;
  }
  let unregister = () => {};
  let unregisterTool = () => {};
  ctx.effect(() => async () => {
    unregisterTool();
    unregister();
    await service.close();
    try {
      unlinkSync(lock);
    } catch {}
  });
  unregister = host.webServer.register({
    kind: "prefix",
    path: "/dsh-wechat-channel/api",
    handler: handler(service, host.connection),
  });
  unregisterTool = registerAttachmentTool(
    ctx as unknown as AttachmentToolContext,
    adapter,
    service.sendAttachment.bind(service),
  );
  if (config.autoStart && service.account() && service.status().binding)
    void service.start().catch(() => {});
}
