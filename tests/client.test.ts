import assert from "node:assert/strict";
import test from "node:test";
import type React from "react";
import { attachmentUrl, request } from "../src/client/api.js";
import { apply, inject } from "../src/client/index.js";

test("client registers the real DSH settings section lazily", () => {
  let registered = false;
  assert.deepEqual(inject, ["slots", "sessions"]);
  apply({
    sessions: { open() {} },
    slots: {
      inject(name, factory) {
        assert.equal(name, "settings.section");
        factory();
      },
      register(options, component) {
        registered = true;
        assert.equal(options.id, "wechat");
        assert.equal(options.label(), "微信");
        assert.equal(options.name, "settings.section");
        assert.equal(typeof component, "function");
      },
    },
  });
  assert.equal(registered, true);
});

test("client uses authenticated same-origin JSON commands and propagates host errors", async () => {
  const original = globalThis.fetch;
  const calls: { path: string; init?: RequestInit }[] = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ path: String(input), init });
    return new Response(
      JSON.stringify({
        error: {
          code: "REVISION_CONFLICT",
          message: "绑定已变更，请刷新后重试",
        },
      }),
      { status: 409, headers: { "Content-Type": "application/json" } },
    );
  };
  try {
    await assert.rejects(
      request("/binding", { sessionId: "s1", expectedRevision: 2 }),
      /绑定已变更/,
    );
    assert.equal(calls[0].path, "/dsh-wechat-channel/api/binding");
    assert.equal(calls[0].init?.credentials, "same-origin");
    assert.equal(calls[0].init?.method, "POST");
    assert.equal(new Headers(calls[0].init?.headers).get("x-dsh-wechat-channel"), "1");
    assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {
      sessionId: "s1",
      expectedRevision: 2,
    });
  } finally {
    globalThis.fetch = original;
  }
});

test("attachment URLs address only an encoded identifier in the controlled route", () => {
  assert.equal(
    attachmentUrl("../secret?download=1"),
    "/dsh-wechat-channel/api/attachments/..%2Fsecret%3Fdownload%3D1",
  );
});

test("expired DSH browser authentication gives a recovery action without exposing host response", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response("Unauthorized", { status: 401 });
  try {
    await assert.rejects(
      request("/status"),
      /使用本次启动时提供的链接重新打开 DSH/,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("browser transport failures identify DSH connectivity and never retry commands", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async () => {
      calls++;
      throw new TypeError("Failed to fetch");
    };
    await assert.rejects(request("/status"), /无法连接 DSH/);
    globalThis.fetch = async () => {
      calls++;
      throw new DOMException("signal timed out", "TimeoutError");
    };
    await assert.rejects(request("/status"), /读取 DSH 通道记录超时/);
    await assert.rejects(request("/pairing/start", {}), /操作可能仍在处理中/);
    assert.equal(calls, 3);
  } finally {
    globalThis.fetch = original;
  }
});

test("response body timeouts and malformed JSON are not swallowed as successful null", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(
              new DOMException("signal timed out", "TimeoutError"),
            );
          },
        }),
        { status: 200 },
      );
    await assert.rejects(request("/status"), /读取 DSH 通道记录超时/);
    globalThis.fetch = async () => new Response("not JSON", { status: 200 });
    await assert.rejects(request("/status"), /无法读取的响应/);
  } finally {
    globalThis.fetch = original;
  }
});

test("native session action uses DSH sessions.open and closes the settings panel", () => {
  const opened: string[] = [];
  let closed = false;
  apply({
    sessions: {
      open(id) {
        opened.push(id);
      },
    },
    slots: {
      inject(_name, factory) {
        factory();
      },
      register(_options, component) {
        const section = component as (props: {
          close(): void;
        }) => React.ReactElement<{ openSession(id: string): void }>;
        const panel = section({
          close() {
            closed = true;
          },
        });
        panel.props.openSession("verified-session");
      },
    },
  });
  assert.deepEqual(opened, ["verified-session"]);
  assert.equal(closed, true);
});
