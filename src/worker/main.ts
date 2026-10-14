import {
  ILinkClient,
  type ILinkOptions,
  type MessageItem,
} from "../ilink/index.js";
import type { Wire } from "./rpc.js";
let client: ILinkClient | undefined;
let epoch: number | undefined;
let configuring = false;
let mediaBusy = false;
let pollBusy = false;
process.on("disconnect", () => process.exit(0));
function reply(m: Wire, payload: Partial<Wire>) {
  if (process.connected)
    process.send?.({ id: m.id, epoch: m.epoch, ...payload }, () => {});
}
process.on("message", async (m: Wire) => {
  if (
    !m ||
    typeof m.id !== "string" ||
    !Number.isSafeInteger(m.epoch) ||
    typeof m.method !== "string"
  )
    return;
  let media = false,
    poll = false;
  try {
    const p = (m.payload ?? {}) as Record<string, any>;
    let result: unknown;
    if (m.method === "configure") {
      if (configuring || client) throw new Error("WORKER_ALREADY_CONFIGURED");
      configuring = true;
      client = new ILinkClient(p as ILinkOptions);
      epoch = m.epoch;
      configuring = false;
      reply(m, { result: true });
      return;
    }
    if (!client || epoch !== m.epoch) throw new Error("STALE_EPOCH");
    if (m.method === "upload" || m.method === "download") {
      if (mediaBusy) throw new Error("MEDIA_BUSY");
      mediaBusy = true;
      media = true;
    }
    if (m.method === "poll") {
      if (pollBusy) throw new Error("POLL_BUSY");
      pollBusy = true;
      poll = true;
    }
    switch (m.method) {
      case "qr":
        result = await client.getQrCode();
        break;
      case "qrStatus":
        result = await client.getQrStatus(p.qrcode, undefined, p.verifyCode);
        break;
      case "poll":
        result = await client.getUpdates(p.cursor);
        break;
      case "download":
        result = await client.downloadMedia(p.item as MessageItem, {
          maxBytes: p.maxBytes,
        });
        break;
      case "send":
        result = await client.send(p as Parameters<ILinkClient["send"]>[0]);
        break;
      case "upload":
        result = await client.uploadMedia(Buffer.from(p.bytes), {
          toUserId: p.toUserId,
          kind: p.kind,
          fileName: p.fileName,
        });
        break;
      default:
        throw new Error("UNKNOWN_WORKER_METHOD");
    }
    reply(m, { result });
  } catch (e) {
    const err = e as Error & { kind?: string; code?: number };
    reply(m, {
      error: { code: err.message, kind: err.kind, remoteCode: err.code },
    });
  } finally {
    if (media) mediaBusy = false;
    if (poll) pollBusy = false;
  }
});
