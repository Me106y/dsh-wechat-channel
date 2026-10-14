#!/usr/bin/env node
// Isolated A/B/B/A transport check. Never opens a model turn or configures iLink.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { resolveRuntime } from "./dsh-runtime.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtime = await resolveRuntime();
const require = createRequire(runtime.cli);
const gatewayRequire = createRequire(
  require.resolve("@deepseek-ai/dsh-api-gateway"),
);
const { WebSocket } = gatewayRequire("ws");
await access(join(repo, "lib/index.js"));
const home = await mkdtemp(join(tmpdir(), "dsh-network-ab-"));
const profile = join(home, "profiles/web");
await mkdir(profile, { recursive: true });
const manifestPath = join(profile, "package.json");
await writeFile(
  manifestPath,
  JSON.stringify({
    name: "wechat-network-isolated",
    private: true,
    dsh: {
      profile: {
        bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"],
      },
    },
  }),
);
// Install once into the temporary profile. Both variants retain identical dependencies.
execFileSync(
  process.execPath,
  [runtime.cli, "plugin", "--profile", "web", "add", repo],
  {
    cwd: repo,
    env: {
      ...process.env,
      DSH_HOME: home,
      npm_config_registry: "https://registry.npmjs.org",
    },
    stdio: "pipe",
    timeout: 120000,
  },
);
const installed = JSON.parse(await readFile(manifestPath, "utf8"));
assert(installed.dsh.profile.bundles.includes("dsh-wechat-channel"));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const safe = (message) =>
  String(message).replace(/([?&]token=)[^\s"'<>]+/g, "$1[REDACTED]");
const round = (value) => Math.round(value * 100) / 100;
function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    samples: values.length,
    medianMs: round(sorted[Math.floor(sorted.length / 2)]),
    p95Ms: round(sorted[Math.ceil(sorted.length * 0.95) - 1]),
    maxMs: round(sorted.at(-1)),
  };
}
let child;
async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closing = child;
  const exit = once(closing, "exit");
  closing.kill("SIGTERM");
  const timer = setTimeout(() => closing.kill("SIGKILL"), 5000);
  await exit;
  clearTimeout(timer);
}
async function start(plugin) {
  const config = structuredClone(installed);
  if (!plugin)
    config.dsh.profile.bundles = config.dsh.profile.bundles.filter(
      (name) => name !== "dsh-wechat-channel",
    );
  await writeFile(manifestPath, JSON.stringify(config));
  child = spawn(
    process.execPath,
    [
      runtime.cli,
      "--profile",
      "web",
      "--no-open",
      "--host",
      "127.0.0.1",
      "--port",
      "0",
    ],
    {
      cwd: repo,
      env: { ...process.env, DSH_HOME: home, DSH_TELEMETRY: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let logs = "",
    spawnError;
  child.on("error", (error) => {
    spawnError = error;
  });
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (bytes) => {
      logs += bytes.toString();
    });
  for (let attempt = 0; attempt < 300; attempt++) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null) throw new Error(safe(logs.slice(-3000)));
    const bootstrap = logs.match(
      /dsh web:\s+(http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/,
    )?.[1];
    if (bootstrap) {
      const response = await fetch(bootstrap, {
        redirect: "manual",
        signal: AbortSignal.timeout(10000),
      });
      assert.equal(response.status, 303);
      const cookie = response.headers.get("set-cookie")?.split(";")[0];
      assert(cookie);
      // The token and cookie only live in this process, never in the report or files.
      await pause(1200);
      assert.equal(child.exitCode, null, safe(logs.slice(-3000)));
      return { origin: new URL(bootstrap).origin, cookie };
    }
    await pause(100);
  }
  throw new Error("Isolated DSH startup timed out");
}
async function measureHttp(host, path, iterations = 20) {
  const latencies = [],
    statuses = {};
  for (let i = 0; i < iterations + 1; i++) {
    const begin = performance.now();
    const response = await fetch(host.origin + path, {
      headers: { Cookie: host.cookie },
      signal: AbortSignal.timeout(10000),
    });
    await response.arrayBuffer();
    if (i > 0) {
      latencies.push(performance.now() - begin);
      statuses[response.status] = (statuses[response.status] ?? 0) + 1;
    }
  }
  return { path, ...stats(latencies), statuses };
}
async function measureWebSocket(host) {
  const start = performance.now();
  const socket = new WebSocket(
    host.origin.replace("http:", "ws:") + "/api/remote.mux",
    {
      headers: { Cookie: host.cookie, Origin: host.origin },
      handshakeTimeout: 10000,
    },
  );
  let pings = 0;
  socket.on("ping", () => {
    pings++;
  });
  try {
    await once(socket, "open", { signal: AbortSignal.timeout(10000) });
    const handshakeMs = round(performance.now() - start);
    const firstFrame = once(socket, "message", {
      signal: AbortSignal.timeout(10000),
    });
    socket.send(
      JSON.stringify({
        type: "open",
        streamId: "network-probe",
        endpoint: "$events",
        payload: { args: {} },
      }),
    );
    const [bytes] = await firstFrame;
    const frame = JSON.parse(bytes.toString());
    assert.equal(frame.type, "item");
    assert.equal(frame.value.type, "ready");
    const pingLatency = [];
    for (let i = 0; i < 20; i++) {
      const begin = performance.now();
      const pong = once(socket, "pong", { signal: AbortSignal.timeout(10000) });
      socket.ping("probe");
      await pong;
      pingLatency.push(performance.now() - begin);
    }
    await pause(2500);
    assert.equal(socket.readyState, WebSocket.OPEN);
    assert(pings > 0, "DSH native server heartbeat should arrive");
    socket.send(JSON.stringify({ type: "cancel", streamId: "network-probe" }));
    return {
      handshakeMs,
      nativeEventStreamReady: true,
      serverHeartbeats: pings,
      pingPong: stats(pingLatency),
    };
  } finally {
    socket.terminate();
  }
}
const report = {
  createdAt: new Date().toISOString(),
  versions: runtime.versions,
  method:
    "Same temporary profile and installed dependencies; only dsh-wechat-channel bundle membership changes. A/B/B/A order, one warmup plus 20 HTTP samples, native event-stream ready frame and 20 WebSocket ping/pong samples.",
  limits: [
    "No browser rendering, user profile, user token, external model or iLink traffic tested.",
    "Plugin is unpaired and stopped; cannot exclude effects under large histories, media transfers or active message load.",
    "Loopback transport health does not establish external provider connectivity or rule out browser proxy/VPN/extension/cookie issues.",
    "Small local sample is diagnostic, not a performance benchmark; ports and process IDs differ per start.",
  ],
  runs: [],
  ok: false,
};
try {
  for (const plugin of [false, true, true, false]) {
    const host = await start(plugin);
    const page = await fetch(host.origin + "/", {
      headers: { Cookie: host.cookie },
    });
    const html = await page.text();
    const bootJson = html.match(
      /globalThis\["__DSH_BOOT__"\]\s*=\s*([^<]+)<\/script>/,
    )?.[1];
    assert(bootJson, "Official frontend boot manifest should be present");
    const pluginInManifest = JSON.parse(bootJson).entries.some(
      (entry) => entry.id === "dsh-wechat-channel",
    );
    assert.equal(
      pluginInManifest,
      plugin,
      "A/B must actually change plugin activation",
    );
    const nativeHttp = await measureHttp(
      host,
      "/api/__wechat_network_probe_undefined__",
    );
    assert.deepEqual(Object.keys(nativeHttp.statuses), ["404"]);
    const root = await measureHttp(host, "/");
    assert.deepEqual(Object.keys(root.statuses), ["200"]);
    const websocket = await measureWebSocket(host);
    const pluginStatus = plugin
      ? await measureHttp(host, "/dsh-wechat-channel/api/status")
      : undefined;
    if (pluginStatus)
      assert.deepEqual(Object.keys(pluginStatus.statuses), ["200"]);
    report.runs.push({
      plugin,
      pluginInManifest,
      nativeHttp,
      root,
      websocket,
      pluginStatus,
    });
    console.log(
      `Isolated ${plugin ? "B (plugin loaded)" : "A (base only)"}: HTTP and WebSocket passed`,
    );
    await stop();
  }
  report.ok = true;
} catch (error) {
  report.error = safe(error.stack ?? error);
} finally {
  await stop();
  await writeFile(
    join(home, "network-report.json"),
    JSON.stringify(report, null, 2),
    { mode: 0o600 },
  );
}
console.log(
  JSON.stringify(
    {
      ok: report.ok,
      report: join(home, "network-report.json"),
      runs: report.runs,
    },
    null,
    2,
  ),
);
if (!report.ok) {
  console.error(report.error);
  process.exitCode = 1;
}
