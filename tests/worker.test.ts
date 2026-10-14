import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { WorkerRpc } from "../src/worker/rpc.js";

// A real subprocess with a deterministic protocol: no external accounts or network.
const fixture = `
let config, configured = 0; const held = [];
process.on('disconnect', () => process.exit(0));
process.on('message', m => {
  const reply = (msg, result) => process.send({id:msg.id, epoch:msg.epoch, result});
  if (m.method === 'configure') { config=m.payload; configured++; reply(m,true); }
  else if (m.method === 'crash') process.exit(17);
  else if (m.method === 'hang') held.push(m);
  else if (m.method === 'release') { for (const old of held.splice(0)) reply(old,'late'); reply(m,true); }
  else reply(m,{config,configured,pid:process.pid});
});
`;
async function setup(
  t: { after(fn: () => Promise<void>): void },
  epoch = () => 1,
) {
  const root = await mkdtemp(join(tmpdir(), "dsh-wechat-worker-test-"));
  const script = join(root, "worker.cjs");
  await writeFile(script, fixture);
  const rpc = new WorkerRpc(epoch, pathToFileURL(script));
  t.after(async () => {
    await rpc.stop();
    await rm(root, { recursive: true, force: true });
  });
  return rpc;
}
type Probe = {
  config: Record<string, unknown>;
  configured: number;
  pid: number;
};

test("a crashed Worker restarts and receives saved configuration before ordinary requests", async (t) => {
  const rpc = await setup(t);
  await rpc.call("configure", { sentinel: "restored" });
  const first = await rpc.call<Probe>("probe", {});
  await assert.rejects(rpc.call("crash", {}), /WORKER_EXIT/);
  const second = await rpc.call<Probe>("probe", {});
  assert.notEqual(second.pid, first.pid);
  assert.deepEqual(second.config, { sentinel: "restored" });
  assert.equal(second.configured, 1);
});

test("RPC timeout kills the old process and retry uses a newly configured Worker", async (t) => {
  const rpc = await setup(t);
  await rpc.call("configure", { sentinel: "timeout-recovery" });
  const first = await rpc.call<Probe>("probe", {});
  await assert.rejects(
    rpc.call("hang", {}, 50),
    (e: unknown) =>
      e instanceof Error &&
      e.message === "WORKER_TIMEOUT" &&
      (e as any).kind === "uncertain",
  );
  const second = await rpc.call<Probe>("probe", {});
  assert.notEqual(second.pid, first.pid);
  assert.deepEqual(second.config, { sentinel: "timeout-recovery" });
  assert.throws(() => process.kill(first.pid, 0), /ESRCH/);
});

test("stop rejects old pending work without corrupting requests in the next generation", async (t) => {
  const rpc = await setup(t);
  await rpc.call("configure", { sentinel: "next-generation" });
  const pending = assert.rejects(rpc.call("hang", {}), /WORKER_STOPPED/);
  const first = await rpc.call<Probe>("probe", {});
  await rpc.stop();
  await pending;
  const second = await rpc.call<Probe>("probe", {});
  assert.notEqual(first.pid, second.pid);
  assert.equal(second.configured, 1);
  assert.equal(second.config.sentinel, "next-generation");
});

test("concurrent configure supersedes the earlier lifecycle request", async (t) => {
  const rpc = await setup(t);
  const first = rpc.call("configure", { winner: false });
  const second = rpc.call("configure", { winner: true });
  const results = await Promise.allSettled([first, second]);
  assert.equal(results[0].status, "rejected");
  assert.equal(results[1].status, "fulfilled");
  const state = await rpc.call<Probe>("probe", {});
  assert.equal(state.config.winner, true);
  assert.equal(state.configured, 1);
});

test("late replies from an old account epoch cannot resolve a request successfully", async (t) => {
  let epoch = 1;
  const rpc = await setup(t, () => epoch);
  await rpc.call("configure", {});
  const pending = assert.rejects(rpc.call("hang", {}), /STALE_EPOCH/);
  await rpc.call("probe", {});
  epoch = 2;
  await rpc.call("release", {});
  await pending;
});

test("missing Worker entry rejects cleanly instead of crashing the Host", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dsh-wechat-missing-worker-"));
  const rpc = new WorkerRpc(() => 1, pathToFileURL(join(root, "missing.cjs")));
  t.after(async () => {
    await rpc.stop();
    await rm(root, { recursive: true, force: true });
  });
  await assert.rejects(rpc.call("configure", {}), /WORKER_(EXIT|SPAWN_ERROR)/);
});
