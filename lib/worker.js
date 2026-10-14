// src/ilink/index.ts
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes
} from "node:crypto";
import JSONbig from "json-bigint";
var ILinkError = class extends Error {
  constructor(message, kind, code) {
    super(message);
    this.kind = kind;
    this.code = code;
    this.name = "ILinkError";
  }
};
var DEFAULT_API = "https://ilinkai.weixin.qq.com";
var DEFAULT_CDN = "https://novac2c.cdn.weixin.qq.com/c2c";
var IMAGE_LIMIT = 20 * 1024 * 1024;
var FILE_LIMIT = 100 * 1024 * 1024;
function validateHost(raw, kind = "api") {
  const url = new URL(raw);
  const allowed = kind === "api" ? url.hostname === "ilinkai.weixin.qq.com" : url.hostname === "novac2c.cdn.weixin.qq.com";
  if (!allowed || url.protocol !== "https:" || url.username || url.password || url.port && url.port !== "443" || url.hash) {
    throw new ILinkError("Untrusted iLink endpoint", "protocol");
  }
  return url;
}
var lossless = JSONbig({
  storeAsString: true,
  strict: true,
  protoAction: "error",
  constructorAction: "error"
});
function parseProtocolJson(raw) {
  const value = lossless.parse(raw);
  if (!value || Array.isArray(value) || typeof value !== "object")
    throw new ILinkError("Invalid iLink response object", "protocol");
  return value;
}
async function readBounded(response, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
    throw new ILinkError("Invalid byte limit", "protocol");
  if (Number(response.headers.get("content-length")) > maxBytes) {
    await response.body?.cancel();
    throw new ILinkError("Response exceeds configured byte limit", "protocol");
  }
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  let size = 0;
  const chunks = [];
  try {
    for (; ; ) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new ILinkError(
          "Response exceeds configured byte limit",
          "protocol"
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}
function decodeMediaKey(base64, hex) {
  if (hex !== void 0) {
    if (!/^[a-f\d]{32}$/i.test(hex))
      throw new ILinkError("Invalid media key", "protocol");
    return Buffer.from(hex, "hex");
  }
  if (!base64 || !/^[A-Za-z\d+/]+={0,2}$/.test(base64))
    throw new ILinkError("Missing or invalid media key", "protocol");
  const key = Buffer.from(base64, "base64");
  if (key.length === 16) return key;
  if (key.length === 32 && /^[a-f\d]{32}$/i.test(key.toString("ascii")))
    return Buffer.from(key.toString("ascii"), "hex");
  throw new ILinkError("Invalid media key", "protocol");
}
function crypt(bytes, key, decrypt) {
  const cipher = decrypt ? createDecipheriv("aes-128-ecb", key, null) : createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(bytes), cipher.final()]);
}
var ILinkClient = class {
  constructor(options = {}) {
    this.options = options;
    this.baseUrl = validateHost(options.baseUrl ?? DEFAULT_API).toString();
    this.cdnBaseUrl = validateHost(options.cdnBaseUrl ?? DEFAULT_CDN, "cdn").toString().replace(/\/$/, "");
    this.fetcher = options.fetch ?? fetch;
  }
  baseUrl;
  cdnBaseUrl;
  fetcher;
  signal(external, timeout = this.options.timeoutMs ?? 15e3) {
    const timer = AbortSignal.timeout(timeout);
    return external ? AbortSignal.any([external, timer]) : timer;
  }
  async request(endpoint, body, signal, sending = false, timeout) {
    const headers = {
      "iLink-App-Id": "bot",
      "iLink-App-ClientVersion": "256"
    };
    if (body !== void 0) {
      Object.assign(headers, {
        "Content-Type": "application/json",
        AuthorizationType: "ilink_bot_token",
        "X-WECHAT-UIN": Buffer.from(
          String(randomBytes(4).readUInt32BE())
        ).toString("base64")
      });
      if (this.options.token)
        headers.Authorization = `Bearer ${this.options.token}`;
    }
    try {
      const response = await this.fetcher(new URL(endpoint, this.baseUrl), {
        method: body === void 0 ? "GET" : "POST",
        headers,
        redirect: "error",
        ...body === void 0 ? {} : { body: JSON.stringify(body) },
        signal: this.signal(signal, timeout)
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new ILinkError(
          `iLink HTTP ${response.status}`,
          sending && (response.status >= 500 || response.status === 408) ? "uncertain" : "rejected",
          response.status
        );
      }
      let payload;
      try {
        payload = parseProtocolJson(
          (await readBounded(response, 8 * 1024 * 1024)).toString("utf8")
        );
      } catch {
        throw new ILinkError(
          "Invalid iLink response",
          sending ? "uncertain" : "protocol"
        );
      }
      for (const key of ["ret", "errcode"]) {
        if (payload[key] !== void 0 && payload[key] !== 0) {
          throw new ILinkError(
            `iLink rejected request (${String(payload[key])})`,
            "rejected",
            Number(payload[key])
          );
        }
      }
      return payload;
    } catch (error) {
      if (error instanceof ILinkError) throw error;
      throw new ILinkError(
        "iLink request interrupted or network unavailable",
        sending ? "uncertain" : "network"
      );
    }
  }
  metadata(body) {
    return {
      ...body,
      base_info: { channel_version: "0.1.0", bot_agent: "DSHWechat/0.1.0" }
    };
  }
  async getQrCode(signal) {
    const value = await this.request(
      "ilink/bot/get_bot_qrcode?bot_type=3",
      { local_token_list: [] },
      signal
    );
    if (typeof value.qrcode !== "string" || typeof value.qrcode_img_content !== "string")
      throw new ILinkError("Invalid QR response", "protocol");
    return {
      qrcode: value.qrcode,
      qrcode_img_content: value.qrcode_img_content
    };
  }
  async getQrStatus(qrcode, signal, verifyCode) {
    const query = new URLSearchParams({ qrcode });
    if (verifyCode) query.set("verify_code", verifyCode);
    const value = await this.request(
      `ilink/bot/get_qrcode_status?${query}`,
      void 0,
      signal,
      false,
      35e3
    );
    if (![
      "wait",
      "scaned",
      "confirmed",
      "expired",
      "scaned_but_redirect",
      "need_verifycode",
      "verify_code_blocked",
      "binded_redirect"
    ].includes(value.status))
      throw new ILinkError("Unknown login status", "protocol");
    if (value.baseurl) validateHost(value.baseurl);
    if (value.redirect_host) validateHost(`https://${value.redirect_host}`);
    if (value.status === "confirmed" && ![value.bot_token, value.ilink_bot_id, value.ilink_user_id].every(
      (x) => typeof x === "string" && x.length > 0
    ))
      throw new ILinkError(
        "Login missing confirmed owner identity",
        "protocol"
      );
    return value;
  }
  async getUpdates(cursor, signal) {
    const value = await this.request(
      "ilink/bot/getupdates",
      this.metadata({ get_updates_buf: cursor }),
      signal,
      false,
      35e3
    );
    if (value.msgs !== void 0 && !Array.isArray(value.msgs))
      throw new ILinkError("Invalid update messages", "protocol");
    const msgs = (value.msgs ?? []).map((message) => {
      if (!message || typeof message !== "object")
        throw new ILinkError("Invalid message", "protocol");
      for (const key of ["message_id", "seq"])
        if (message[key] !== void 0) {
          const id = String(message[key]);
          if (!/^\d+$/.test(id))
            throw new ILinkError("Invalid message identifier", "protocol");
          message[key] = id;
        }
      return message;
    });
    if (value.get_updates_buf !== void 0 && typeof value.get_updates_buf !== "string")
      throw new ILinkError("Invalid update cursor", "protocol");
    return {
      msgs,
      get_updates_buf: value.get_updates_buf ?? cursor,
      ...typeof value.longpolling_timeout_ms === "number" ? { longpolling_timeout_ms: value.longpolling_timeout_ms } : {}
    };
  }
  /** Resolves on API acceptance, never claims delivery or read. Caller owns durable clientId. */
  async send(input, signal) {
    if (!input.toUserId || !input.contextToken || !input.clientId || input.items.length !== 1)
      throw new ILinkError(
        "Send requires recipient, context, client ID and exactly one item",
        "protocol"
      );
    await this.request(
      "ilink/bot/sendmessage",
      this.metadata({
        msg: {
          from_user_id: "",
          to_user_id: input.toUserId,
          context_token: input.contextToken,
          client_id: input.clientId,
          message_type: 2,
          message_state: 2,
          item_list: input.items
        }
      }),
      signal,
      true
    );
  }
  async uploadMedia(bytes, input, signal) {
    const max = input.kind === "image" ? IMAGE_LIMIT : FILE_LIMIT;
    if (bytes.length > max)
      throw new ILinkError("Attachment exceeds configured limit", "protocol");
    const key = randomBytes(16), filekey = randomBytes(16).toString("hex");
    const encrypted = crypt(bytes, key, false);
    const slot = await this.request(
      "ilink/bot/getuploadurl",
      this.metadata({
        filekey,
        to_user_id: input.toUserId,
        media_type: input.kind === "image" ? 1 : 3,
        rawsize: bytes.length,
        rawfilemd5: createHash("md5").update(bytes).digest("hex"),
        filesize: encrypted.length,
        no_need_thumb: true,
        aeskey: key.toString("hex")
      }),
      signal
    );
    let target;
    if (typeof slot.upload_full_url === "string" && slot.upload_full_url)
      target = validateHost(slot.upload_full_url, "cdn");
    else if (typeof slot.upload_param === "string" && slot.upload_param) {
      target = new URL(`${this.cdnBaseUrl}/upload`);
      target.searchParams.set("encrypted_query_param", slot.upload_param);
      target.searchParams.set("filekey", filekey);
    } else throw new ILinkError("Upload response has no location", "protocol");
    let response;
    try {
      response = await this.fetcher(target, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Uint8Array(encrypted),
        redirect: "error",
        signal: this.signal(signal, 12e4)
      });
    } catch {
      throw new ILinkError("CDN upload failed", "network");
    }
    const param = response.headers.get("x-encrypted-param");
    await response.body?.cancel();
    if (!response.ok || !param)
      throw new ILinkError(
        `CDN upload not accepted (${response.status})`,
        "rejected",
        response.status
      );
    const media = {
      encrypt_query_param: param,
      aes_key: Buffer.from(key.toString("hex")).toString("base64"),
      encrypt_type: 1
    };
    return input.kind === "image" ? { type: 2, image_item: { media, mid_size: encrypted.length } } : {
      type: 4,
      file_item: {
        media,
        file_name: input.fileName,
        len: String(bytes.length)
      }
    };
  }
  async downloadMedia(item, limits = {}, signal) {
    const image = item.type === 2 ? item.image_item : void 0;
    const file = item.type === 4 ? item.file_item : void 0;
    if (!image && !file)
      throw new ILinkError("Unsupported media item", "protocol");
    const media = image?.media ?? file?.media;
    const max = Math.min(
      limits.maxBytes ?? (image ? IMAGE_LIMIT : FILE_LIMIT),
      image ? IMAGE_LIMIT : FILE_LIMIT
    );
    let target;
    if (media?.full_url) target = validateHost(media.full_url, "cdn");
    else if (media?.encrypt_query_param) {
      target = new URL(`${this.cdnBaseUrl}/download`);
      target.searchParams.set(
        "encrypted_query_param",
        media.encrypt_query_param
      );
    } else if (image?.url) target = validateHost(image.url, "cdn");
    else
      throw new ILinkError("Attachment has no download location", "protocol");
    const encrypted = !!(image?.aeskey || media?.aes_key);
    const key = encrypted ? decodeMediaKey(media?.aes_key, image?.aeskey) : void 0;
    let response;
    try {
      response = await this.fetcher(target, {
        redirect: "error",
        signal: this.signal(signal, 12e4)
      });
    } catch {
      throw new ILinkError("CDN download failed", "network");
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new ILinkError(
        `CDN download HTTP ${response.status}`,
        "rejected",
        response.status
      );
    }
    const data = await readBounded(response, encrypted ? max + 16 : max);
    let plain;
    try {
      plain = key ? crypt(data, key, true) : data;
    } catch {
      throw new ILinkError("Attachment decryption failed", "protocol");
    }
    if (plain.length > max)
      throw new ILinkError("Attachment exceeds configured limit", "protocol");
    if (file?.len && (!/^\d+$/.test(file.len) || BigInt(file.len) !== BigInt(plain.length)))
      throw new ILinkError("Attachment length mismatch", "protocol");
    if (file?.md5 && createHash("md5").update(plain).digest("hex") !== file.md5.toLowerCase())
      throw new ILinkError("Attachment checksum mismatch", "protocol");
    return plain;
  }
};

// src/worker/main.ts
var client;
var epoch;
var configuring = false;
var mediaBusy = false;
var pollBusy = false;
process.on("disconnect", () => process.exit(0));
function reply(m, payload) {
  if (process.connected)
    process.send?.({ id: m.id, epoch: m.epoch, ...payload }, () => {
    });
}
process.on("message", async (m) => {
  if (!m || typeof m.id !== "string" || !Number.isSafeInteger(m.epoch) || typeof m.method !== "string")
    return;
  let media = false, poll = false;
  try {
    const p = m.payload ?? {};
    let result;
    if (m.method === "configure") {
      if (configuring || client) throw new Error("WORKER_ALREADY_CONFIGURED");
      configuring = true;
      client = new ILinkClient(p);
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
        result = await client.getQrStatus(p.qrcode, void 0, p.verifyCode);
        break;
      case "poll":
        result = await client.getUpdates(p.cursor);
        break;
      case "download":
        result = await client.downloadMedia(p.item, {
          maxBytes: p.maxBytes
        });
        break;
      case "send":
        result = await client.send(p);
        break;
      case "upload":
        result = await client.uploadMedia(Buffer.from(p.bytes), {
          toUserId: p.toUserId,
          kind: p.kind,
          fileName: p.fileName
        });
        break;
      default:
        throw new Error("UNKNOWN_WORKER_METHOD");
    }
    reply(m, { result });
  } catch (e) {
    const err = e;
    reply(m, {
      error: { code: err.message, kind: err.kind, remoteCode: err.code }
    });
  } finally {
    if (media) mediaBusy = false;
    if (poll) pollBusy = false;
  }
});
