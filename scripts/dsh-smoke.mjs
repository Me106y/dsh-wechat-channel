#!/usr/bin/env node
// Public installer + actual official Host + native attachments. No model or iLink calls.
import { mkdtemp, mkdir, writeFile, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { resolveRuntime } from "./dsh-runtime.mjs";
import QRCode from "qrcode";
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtime = await resolveRuntime(),
  cli = runtime.cli;
await access(join(repo, "lib/index.js"));
const home = await mkdtemp(join(tmpdir(), "dsh-wechat-latest-"));
const profile = join(home, "profiles/web");
await mkdir(profile, { recursive: true });
const sessionId = "wechat-smoke-" + randomUUID();
const pngFixture = (await QRCode.toBuffer("DSH native image fixture")).toString(
  "base64",
);
await writeFile(
  join(profile, "package.json"),
  JSON.stringify({
    name: "wechat-isolated-smoke",
    private: true,
    dsh: {
      profile: {
        bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"],
      },
    },
  }),
);
await writeFile(
  join(home, "probe.mjs"),
  `
import {writeFileSync,existsSync} from 'node:fs';
import {createReadStream} from 'node:fs';
export const inject=['agents','sessions','attachments','tools'];
export async function apply(ctx){
 const home=process.env.DSH_HOME;const id=${JSON.stringify(sessionId)};
 const result={toolRegistered:!!ctx.tools.get('wechat_send_attachment')};
 let owned;
 if(!existsSync(home+'/created.json')){
  try{
   for(let attempt=0;;attempt++){
    try{owned=await ctx.agents.create({sessionId:id,meta:{cwd:${JSON.stringify(repo)}}});break;}
    catch(error){
     if(attempt>=60||!/no agent factory registered/.test(String(error)))throw error;
     await new Promise(r=>setTimeout(r,100));
    }
   }
   const [image]=await ctx.attachments.saveImages([{data:Buffer.from(${JSON.stringify(pngFixture)},'base64'),mediaType:'image/png',name:'probe.png'}]);
   writeFileSync(home+'/input.txt','native file smoke');
   const file=await ctx.attachments.saveFileStream({data:createReadStream(home+'/input.txt'),name:'input.txt'});
   result.nativeImage=!!image?.attachmentId;result.nativeFile=!!file.attachmentId;
   await ctx.sessions.flush(owned.agent.session);
   writeFileSync(home+'/created.json',JSON.stringify({sessionId:id}));
  }catch(error){result.error=String((error&&error.stack)||error);}
 }
 for(let i=0;i<100&&!ctx.tools.get('wechat_send_attachment');i++)await new Promise(r=>setTimeout(r,50));
 result.toolRegistered=!!ctx.tools.get('wechat_send_attachment');
 writeFileSync(home+'/probe.json',JSON.stringify(result));
 if(owned)ctx.effect(()=>()=>owned.dispose());
}
`,
);
await writeFile(
  join(profile, "cordis.patch.yml"),
  `- insert:\n    - id: wechat-probe\n      name: ${JSON.stringify(join(home, "probe.mjs"))}\n`,
);
const output = execFileSync(
  process.execPath,
  [cli, "plugin", "--profile", "web", "add", repo],
  {
    cwd: repo,
    env: {
      ...process.env,
      DSH_HOME: home,
      npm_config_registry: "https://registry.npmjs.org",
    },
    encoding: "utf8",
    timeout: 120000,
  },
);
assert.ok(!output.includes("plain dependency"));
const installed = JSON.parse(
  await readFile(join(profile, "package.json"), "utf8"),
);
assert.equal(
  installed.dsh.profile.bundles.filter((v) => v === "dsh-wechat-channel").length,
  1,
);
let current;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const redact = (s) => s.replace(/([?&]token=)[^\s"'<>]+/g, "$1[REDACTED]");
async function start() {
  const child = spawn(
    process.execPath,
    [
      cli,
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
  current = child;
  let logs = "";
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk) => {
      logs += chunk.toString();
    });
  let error;
  child.on("error", (e) => {
    error = e;
  });
  for (let i = 0; i < 300; i++) {
    if (error) throw error;
    if (child.exitCode !== null) throw new Error(redact(logs.slice(-5000)));
    const match = logs.match(
      /dsh web:\s+(http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/,
    );
    if (match) {
      const bootstrap = match[1],
        origin = new URL(bootstrap).origin;
      const response = await fetch(bootstrap, {
        redirect: "manual",
        signal: AbortSignal.timeout(10000),
      });
      assert.equal(response.status, 303);
      const cookie = response.headers.get("set-cookie")?.split(";")[0];
      assert.ok(cookie);
      await writeFile(join(home, "browser-url"), bootstrap, { mode: 0o600 });
      return { child, origin, cookie };
    }
    await pause(100);
  }
  throw new Error(redact("Host startup timed out: " + logs.slice(-3000)));
}
async function stop() {
  if (!current || current.exitCode !== null || current.signalCode !== null)
    return;
  const child = current;
  child.kill("SIGTERM");
  await new Promise((r) => {
    const t = setTimeout(() => {
      child.kill("SIGKILL");
      r();
    }, 5000);
    child.once("exit", () => {
      clearTimeout(t);
      r();
    });
  });
}
async function request(host, path, body) {
  const response = await fetch(host.origin + path, {
    headers: {
      Cookie: host.cookie,
      ...(body
        ? {
            "content-type": "application/json",
            "x-dsh-wechat-channel": "1",
            Origin: host.origin,
          }
        : {}),
    },
    ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(response.status, 200, `${path}: ${response.status}`);
  return response.json();
}
const report = {
  home,
  versions: runtime.versions,
  checks: ["public-plugin-add-activates-bundle"],
  ok: false,
};
try {
  const first = await start();
  // Boot may print its address before every asynchronous plugin has activated.
  let status;
  for (let i = 0; i < 100; i++) {
    try {
      status = await request(first, "/dsh-wechat-channel/api/status");
      break;
    } catch {
      await pause(100);
    }
  }
  assert.equal(status?.connection, "stopped");
  report.checks.push("authenticated-plugin-status");
  const unauthorized = await fetch(first.origin + "/dsh-wechat-channel/api/status");
  assert.equal(unauthorized.status, 401);
  report.checks.push("unauthenticated-access-denied");
  const html = await (
    await fetch(first.origin + "/", { headers: { Cookie: first.cookie } })
  ).text();
  const bootJson = html.match(
    /globalThis\["__DSH_BOOT__"\]\s*=\s*([^<]+)<\/script>/,
  )?.[1];
  assert.ok(bootJson);
  const entry = JSON.parse(bootJson).entries.find((e) => e.id === "dsh-wechat-channel");
  assert.ok(entry);
  const bundle = await fetch(new URL(entry.url, first.origin), {
    headers: { Cookie: first.cookie },
  });
  assert.equal(bundle.status, 200);
  assert.match(await bundle.text(), /__ModuleLoader__\.load/);
  report.checks.push("real-client-manifest-and-bundle");
  let probe;
  for (let i = 0; i < 100; i++) {
    try {
      probe = JSON.parse(await readFile(join(home, "probe.json"), "utf8"));
      break;
    } catch {
      await pause(100);
    }
  }
  assert.ok(probe?.nativeImage);
  assert.ok(probe?.nativeFile);
  assert.ok(probe?.toolRegistered);
  report.checks.push("native-image-file-and-tool");
  const sessions = await request(first, "/dsh-wechat-channel/api/sessions");
  assert.ok(sessions.items.some((s) => s.sessionId === sessionId));
  report.checks.push("native-live-session-list");
  await stop();
  const second = await start();
  let cold;
  for (let i = 0; i < 100; i++) {
    try {
      cold = await request(second, "/dsh-wechat-channel/api/sessions");
      break;
    } catch {
      await pause(100);
    }
  }
  assert.ok(cold.items.some((s) => s.sessionId === sessionId));
  report.checks.push("restart-cold-session-list");
  report.ok = true;
  if (process.env.DSH_SMOKE_KEEP === "1") {
    await writeFile(
      join(home, "ready.json"),
      JSON.stringify({
        pid: second.child.pid,
        origin: second.origin,
        browserUrlFile: join(home, "browser-url"),
      }),
    );
    console.log(JSON.stringify({ ready: home }));
    await new Promise((r) => {
      process.once("SIGINT", r);
      process.once("SIGTERM", r);
    });
  }
} catch (error) {
  report.error = redact(error.message);
  process.exitCode = 1;
} finally {
  await stop();
  await writeFile(
    join(home, "smoke-report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
}
