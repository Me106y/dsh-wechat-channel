import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/store.js";
import { Vault } from "../src/core/vault.js";
function fixture() {
  const p = mkdtempSync(join(tmpdir(), "wechat-store-"));
  const s = new Store(join(p, "db"));
  return {
    s,
    p,
    close() {
      s.close();
      rmSync(p, { recursive: true, force: true });
    },
  };
}
test("batch cursor and messages commit together, duplicate replay deduplicates", () => {
  const f = fixture();
  try {
    f.s.bind("session", 0);
    const ids = f.s.ingestBatch("", "c1", 1, [
      { providerId: "1", text: "hi", payload: null },
    ]);
    assert.equal(ids.length, 1);
    assert.deepEqual(
      f.s.ingestBatch("", "c1", 1, [
        { providerId: "1", text: "hi", payload: null },
      ]),
      [],
    );
    assert.equal(f.s.incoming().length, 1);
    assert.equal(f.s.get("cursor", ""), "c1");
    assert.throws(() => f.s.ingestBatch("wrong", "c2", 1, []), /STALE_CURSOR/);
    assert.equal(f.s.get("cursor", ""), "c1");
  } finally {
    f.close();
  }
});
test("route is frozen and stale epochs rejected", () => {
  const f = fixture();
  try {
    f.s.bind("A", 0);
    const [id] = f.s.ingestBatch("", "1", 1, [
      { providerId: "1", text: "hi", payload: null },
    ]);
    f.s.bind("B", 1);
    assert.equal(f.s.message(id)?.sessionId, "A");
    f.s.resetAccount();
    assert.throws(() => f.s.ingestBatch("", "2", 1, []), /STALE_EPOCH/);
    assert.equal(f.s.message(id)?.state, "cancelled");
  } finally {
    f.close();
  }
});
test("transaction rolls back on mid-batch failure", () => {
  const f = fixture();
  try {
    const cyclic: any = {};
    cyclic.x = cyclic;
    assert.throws(() =>
      f.s.ingestBatch("", "1", 1, [
        { providerId: "1", text: "ok", payload: null },
        { providerId: "2", text: "bad", payload: cyclic },
      ]),
    );
    assert.equal(f.s.incoming().length, 0);
    assert.equal(f.s.get("cursor", ""), "");
  } finally {
    f.close();
  }
});
test("outbox source dedup and uncertain cannot silently resend", () => {
  const f = fixture();
  try {
    const id = f.s.enqueue({ text: "hi", source: "1" });
    assert.equal(f.s.enqueue({ text: "hi", source: "1" }), id);
    f.s.attempt(id);
    f.s.recoverSending();
    assert.equal(f.s.message(id)?.state, "uncertain");
    assert.throws(() => f.s.retry(id), /DUPLICATE_CONFIRMATION/);
    f.s.retry(id, true);
    assert.equal(f.s.message(id)?.state, "queued");
  } finally {
    f.close();
  }
});
test("vault survives restart and detects tampering", () => {
  const f = fixture();
  try {
    const v = new Vault(f.p);
    const enc = v.seal({ token: "secret" });
    assert.equal(enc.includes("secret"), false);
    assert.deepEqual(new Vault(f.p).open(enc), { token: "secret" });
    const b = Buffer.from(enc, "base64");
    b[20] ^= 1;
    assert.throws(() => v.open(b.toString("base64")));
  } finally {
    f.close();
  }
});
test("reply context commits with cursor and preparing is recoverable after restart", () => {
  const f = fixture();
  try {
    const [id] = f.s.ingestBatch(
      "",
      "c1",
      1,
      [{ providerId: "1", text: "hi", payload: null }],
      "sealed-context",
    );
    assert.equal(f.s.get("context", ""), "sealed-context");
    f.s.update(id, "preparing");
    f.s.recoverSending();
    assert.equal(f.s.message(id)?.state, "received");
  } finally {
    f.close();
  }
});
test("restart retires stale approval notifications while preserving ordinary queued results", () => {
  const f = fixture();
  try {
    const old = f.s.enqueue({
      text: "approve",
      source: "interaction:1:rpc:old",
      payload: { control: true, interactionId: "old" },
    });
    const result = f.s.enqueue({ text: "result", source: "result:1" });
    f.s.recoverSending();
    assert.equal(f.s.message(old)?.state, "cancelled");
    assert.equal(f.s.message(result)?.state, "queued");
  } finally {
    f.close();
  }
});
test("recover only protocol-misclassified acceptance, never transport uncertainty", () => {
  const f = fixture();
  try {
    const accepted = f.s.enqueue({ text: "a", source: "a" }),
      unknown = f.s.enqueue({ text: "b", source: "b" });
    f.s.update(accepted, "uncertain");
    f.s.update(unknown, "uncertain");
    f.s.set(`delivery-diagnostic:${accepted}`, {
      phase: "send",
      reason: "Send acceptance not confirmed",
    });
    f.s.set(`delivery-diagnostic:${unknown}`, {
      phase: "send",
      reason: "WORKER_TIMEOUT",
    });
    f.s.recoverSending();
    assert.equal(f.s.message(accepted)?.state, "sent");
    assert.equal(f.s.message(unknown)?.state, "uncertain");
  } finally {
    f.close();
  }
});
