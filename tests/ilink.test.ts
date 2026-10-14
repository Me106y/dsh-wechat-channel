import test from "node:test";
import assert from "node:assert/strict";
import { createCipheriv } from "node:crypto";
import {
  ILinkClient,
  ILinkError,
  validateHost,
  readBounded,
  decodeMediaKey,
} from "../src/ilink/index.js";
const mock = (
  fn: (url: URL, init: RequestInit) => Promise<Response> | Response,
) =>
  (async (url: any, init: any) =>
    fn(new URL(String(url)), init)) as typeof fetch;
test("getUpdates preserves uint64 message identity and opaque cursor", async () => {
  const client = new ILinkClient({
    token: "secret",
    fetch: mock((url, init) => {
      assert.equal(url.pathname, "/ilink/bot/getupdates");
      assert.equal(JSON.parse(String(init.body)).get_updates_buf, "previous");
      assert.equal((init.headers as any).Authorization, "Bearer secret");
      return new Response(
        '{"ret":0,"msgs":[{"message_id":18446744073709551615,"seq":42}],"get_updates_buf":"next"}',
      );
    }),
  });
  assert.deepEqual(
    JSON.parse(JSON.stringify(await client.getUpdates("previous"))),
    {
      msgs: [{ message_id: "18446744073709551615", seq: "42" }],
      get_updates_buf: "next",
    },
  );
});
test("send acceptance rejects ambiguous outcomes without retrying", async () => {
  for (const response of [
    new Response("broken"),
    new Response("", { status: 503 }),
    new Response("", { status: 408 }),
  ]) {
    let attempts = 0;
    const client = new ILinkClient({
      fetch: mock(() => {
        attempts++;
        return response;
      }),
    });
    await assert.rejects(
      client.send({
        toUserId: "owner",
        contextToken: "ctx",
        clientId: "durable-id",
        items: [{ type: 1, text_item: { text: "hello" } }],
      }),
      (e: unknown) => e instanceof ILinkError && e.kind === "uncertain",
    );
    assert.equal(attempts, 1);
  }
});
test("send API rejection is distinguished from transport uncertainty", async () => {
  const client = new ILinkClient({
    fetch: mock(() => new Response('{"ret":-14,"errmsg":"secret token"}')),
  });
  await assert.rejects(
    client.send({
      toUserId: "u",
      contextToken: "c",
      clientId: "i",
      items: [{ type: 1 }],
    }),
    (e: unknown) =>
      e instanceof ILinkError &&
      e.kind === "rejected" &&
      e.code === -14 &&
      !e.message.includes("secret"),
  );
});
test("QR requires scanned owner identity and rejects untrusted API redirect", async () => {
  for (const value of [
    { status: "confirmed", bot_token: "t", ilink_bot_id: "b" },
    { status: "scaned_but_redirect", redirect_host: "localhost" },
  ]) {
    const client = new ILinkClient({
      fetch: mock(() => new Response(JSON.stringify(value))),
    });
    await assert.rejects(client.getQrStatus("q"), ILinkError);
  }
});
test("bounded reader stops chunked bodies before unbounded accumulation", async () => {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(8));
      controller.enqueue(new Uint8Array(8));
      controller.close();
    },
  });
  await assert.rejects(readBounded(new Response(body), 10), /byte limit/);
});
test("media downloads decrypt both key encodings and validate file length", async () => {
  const key = Buffer.alloc(16, 8),
    plaintext = Buffer.from("attachment bytes");
  const cipher = createCipheriv("aes-128-ecb", key, null);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  for (const encoded of [
    key.toString("base64"),
    Buffer.from(key.toString("hex")).toString("base64"),
  ]) {
    assert.deepEqual(decodeMediaKey(encoded), key);
    const client = new ILinkClient({
      fetch: mock((url, init) => {
        assert.equal(init.redirect, "error");
        assert.equal(url.searchParams.get("encrypted_query_param"), "opaque");
        return new Response(ciphertext);
      }),
    });
    const item = {
      type: 4,
      file_item: {
        media: { encrypt_query_param: "opaque", aes_key: encoded },
        len: String(plaintext.length),
      },
    };
    assert.deepEqual(await client.downloadMedia(item), plaintext);
    await assert.rejects(client.downloadMedia(item, { maxBytes: 2 }), /limit/);
  }
});
test("upload encrypts bytes and emits correct file protocol item", async () => {
  let key: Buffer | undefined, cipherSize: number | undefined;
  const client = new ILinkClient({
    fetch: mock((url, init) => {
      if (url.pathname.endsWith("getuploadurl")) {
        const body = JSON.parse(String(init.body));
        key = Buffer.from(body.aeskey, "hex");
        cipherSize = body.filesize;
        assert.equal(body.media_type, 3);
        assert.equal(body.rawsize, 5);
        return new Response('{"upload_param":"opaque"}');
      }
      assert.equal(url.hostname, "novac2c.cdn.weixin.qq.com");
      assert.equal((init.body as Uint8Array).length, cipherSize);
      assert.notDeepEqual(
        Buffer.from(init.body as Uint8Array),
        Buffer.from("hello"),
      );
      return new Response("", { headers: { "x-encrypted-param": "download" } });
    }),
  });
  const item = await client.uploadMedia(Buffer.from("hello"), {
    toUserId: "u",
    kind: "file",
    fileName: "a.txt",
  });
  assert.equal(item.file_item?.len, "5");
  assert.deepEqual(decodeMediaKey(item.file_item?.media?.aes_key), key);
});
test("endpoint validation disallows credentials, local endpoints and redirects", () => {
  for (const url of [
    "http://ilinkai.weixin.qq.com",
    "https://ilinkai.weixin.qq.com.evil.test",
    "https://user:pass@ilinkai.weixin.qq.com",
    "https://localhost",
    "https://127.0.0.1",
    "https://ilinkai.weixin.qq.com:9999",
  ])
    assert.throws(() => validateHost(url));
});

test("multi-item messages must be split into durable outbox entries before transport", async () => {
  let requests = 0;
  const client = new ILinkClient({
    fetch: mock(() => {
      requests++;
      return new Response('{"ret":0}');
    }),
  });
  await assert.rejects(
    client.send({
      toUserId: "u",
      contextToken: "ctx",
      clientId: "id",
      items: [{ type: 1, text_item: { text: "caption" } }, { type: 4 }],
    }),
    /exactly one item/,
  );
  assert.equal(requests, 0);
});

test("iLink default-zero send response accepts omitted ret without retrying", async () => {
  for (const body of ["{}", '{"ret":0}']) {
    const client = new ILinkClient({ fetch: mock(() => new Response(body)) });
    await assert.doesNotReject(
      client.send({
        toUserId: "owner",
        contextToken: "ctx",
        clientId: "id",
        items: [{ type: 1, text_item: { text: "hello" } }],
      }),
    );
  }
});
