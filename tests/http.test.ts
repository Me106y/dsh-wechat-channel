import test from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { allowedRequest } from "../src/host/http.js";
function req(
  host: string,
  origin?: string,
  method = "GET",
  remoteAddress = "127.0.0.1",
) {
  return {
    method,
    socket: { remoteAddress },
    headers: {
      host,
      origin,
      "content-type": "application/json",
      "x-dsh-wechat-channel": "1",
    },
  } as unknown as IncomingMessage;
}
test("HTTP rejects remote clients, rebinding hosts and cross-origin writes", () => {
  assert.equal(
    allowedRequest(req("127.0.0.1:4096", "http://127.0.0.1:4096", "POST")),
    true,
  );
  assert.equal(allowedRequest(req("evil.example")), false);
  assert.equal(
    allowedRequest(req("127.0.0.1:4096", "https://evil.example", "POST")),
    false,
  );
  assert.equal(
    allowedRequest(req("127.0.0.1:4096", undefined, "GET", "8.8.8.8")),
    false,
  );
});
test("write requests require custom header and JSON", () => {
  const r = req("localhost:4096", undefined, "POST");
  delete r.headers["x-dsh-wechat-channel"];
  assert.equal(allowedRequest(r), false);
});

test("all plugin reads and writes require the official DSH browser authentication", async () => {
  const { createServer } = await import("node:http");
  const { handler } = await import("../src/host/http.js");
  let statusReads = 0;
  let connectionStarts = 0;
  let authChecks = 0;
  const service = {
    status: () => {
      statusReads++;
      return { connected: false };
    },
    start: async () => {
      connectionStarts++;
      return { ok: true };
    },
  } as unknown as import("../src/core/service.js").WechatService;
  const server = createServer(
    handler(service, {
      requestRejection(request) {
        authChecks++;
        // The official service owns cookie validation; the adapter must delegate
        // each request, including media reads, before accessing private state.
        return request.headers.cookie === "test-session=valid"
          ? undefined
          : 401;
      },
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as import("node:net").AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;
  try {
    for (const path of [
      "/status",
      "/messages",
      "/attachments/private",
      "/status?token=invalid",
    ]) {
      const response = await fetch(base + "/dsh-wechat-channel/api" + path);
      assert.equal(response.status, 401);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal((await response.json()).error.code, "UNAUTHORIZED");
    }
    assert.equal(statusReads, 0);
    const write = {
      method: "POST",
      headers: { "content-type": "application/json", "x-dsh-wechat-channel": "1" },
      body: "{}",
    };
    assert.equal(
      (await fetch(base + "/dsh-wechat-channel/api/connection/start", write)).status,
      401,
    );
    assert.equal(connectionStarts, 0);
    assert.equal(
      (
        await fetch(base + "/dsh-wechat-channel/api/status", {
          headers: { cookie: "test-session=valid" },
        })
      ).status,
      200,
    );
    assert.equal(statusReads, 1);
    assert.equal(
      (
        await fetch(base + "/dsh-wechat-channel/api/connection/start", {
          ...write,
          headers: {
            ...write.headers,
            cookie: "test-session=valid",
            origin: "https://evil.example",
          },
        })
      ).status,
      403,
    );
    assert.equal(connectionStarts, 0);
    assert.equal(
      (
        await fetch(base + "/dsh-wechat-channel/api/connection/start", {
          ...write,
          headers: {
            ...write.headers,
            cookie: "test-session=valid",
            origin: base,
          },
        })
      ).status,
      200,
    );
    assert.equal(connectionStarts, 1);
    assert.equal(authChecks, 7);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
