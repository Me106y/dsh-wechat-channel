/** Browser contract contains public channel state only; never credentials or local paths. */
export interface ChannelStatus {
  revision?: number;
  connection: string;
  ownerId?: string;
  candidateOwnerId?: string;
  binding?: { sessionId: string; revision: number };
  counts?: Record<string, number>;
  lastPollAt?: number;
  error?: string;
  pairing?: { qrDataUrl?: string; status?: string; ownerId?: string };
  capabilities?: Record<string, unknown>;
}
export interface Target {
  sessionId: string;
  title?: string;
  cwd?: string;
}
export interface Attachment {
  id: string;
  name: string;
  kind?: "image" | "file";
  size?: number;
  mime?: string;
  url?: string;
}
export interface ChannelMessage {
  id: string;
  direction: "in" | "out";
  text: string;
  state: string;
  createdAt: number;
  sessionId?: string;
  turnId?: string;
  error?: string;
  deliveryId?: string;
  submissionId?: string;
  attachments?: Attachment[];
}
export interface Interaction {
  id: string;
  kind: string;
  description: string;
  expiresAt?: number;
  state: string;
  sessionId?: string;
  choices?: string[];
}
export interface Page {
  items: ChannelMessage[];
  nextCursor?: string;
}
export const API_BASE = "/dsh-wechat-channel/api";
export async function request<T>(path: string, body?: unknown): Promise<T> {
  // DSH 0.1.5 exchanges its launch token for an HttpOnly browser cookie.
  // Let the browser carry that cookie; never read or copy the launch token.
  // Pairing waits for a Worker RPC with a 60-second deadline.
  const signal = AbortSignal.timeout(
    path === "/pairing/start" && body !== undefined ? 65_000 : 15_000,
  );
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      signal,
      method: body === undefined ? "GET" : "POST",
      credentials: "same-origin",
      headers:
        body === undefined
          ? { Accept: "application/json" }
          : {
              Accept: "application/json",
              "Content-Type": "application/json",
              "x-dsh-wechat-channel": "1",
            },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status === 401)
      throw new Error(
        "DSH 登录已失效，请使用本次启动时提供的链接重新打开 DSH。",
      );
    const result = await response.json();
    if (!response.ok)
      throw new Error(
        result?.error?.message ??
          result?.error ??
          `请求失败 (${response.status})`,
      );
    return result as T;
  } catch (error) {
    if (
      signal.aborted ||
      (error instanceof Error && error.name === "TimeoutError")
    )
      throw new Error(
        body === undefined
          ? "读取 DSH 通道记录超时，请检查 DSH 是否仍在运行。"
          : "等待 DSH 操作结果超时，操作可能仍在处理中，请先刷新状态再决定是否重试。",
      );
    if (error instanceof TypeError)
      throw new Error(
        "无法连接 DSH，请检查 DSH 是否仍在运行，以及浏览器是否拦截了本机请求。",
      );
    if (error instanceof SyntaxError)
      throw new Error("DSH 返回了无法读取的响应，请刷新状态后重试。");
    throw error;
  }
}
export const attachmentUrl = (id: string): string =>
  `${API_BASE}/attachments/${encodeURIComponent(id)}`;
export function formatSize(bytes?: number): string {
  if (bytes === undefined) return "";
  return bytes < 1024
    ? `${bytes} B`
    : bytes < 1048576
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / 1048576).toFixed(1)} MB`;
}
const labels: Record<string, string> = {
  reconnecting: "正在重新连接",
  auth_required: "登录已失效，请重新扫码",
  unbound: "尚未绑定",
  wait: "等待扫码",
  scaned: "已扫码，等待手机确认",
  confirmed: "微信登录已确认，待确认本人绑定",
  need_verifycode: "需要微信验证",
  verify_code_blocked: "微信验证暂不可用",
  connected: "已连接",
  online: "在线",
  idle: "未启动",
  stopped: "已停止",
  connecting: "连接中",
  disconnected: "已断开",
  pairing: "等待扫码",
  expired: "已过期",
  pending: "待处理",
  preparing: "处理附件中",
  ready: "准备提交",
  accepted: "已接受",
  cancelled: "已取消",
  sending: "发送中",
  retry_wait: "等待重试",
  waiting_context: "等待新的微信消息",
  received: "已接收",
  queued: "已排队",
  submitted: "已提交",
  running: "执行中",
  completed: "执行完成",
  sent: "微信接口已接受",
  failed: "失败",
  uncertain: "待核对",
  awaiting_context: "等待新的微信消息",
  rejected: "已拒绝",
  resolved: "已处理",
};
export const statusLabel = (value: string): string => labels[value] ?? value;
