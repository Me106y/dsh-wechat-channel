#!/usr/bin/env node
// Actual DSH loop with a deterministic in-process provider; no model or iLink calls.
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { spawn, execFileSync } from "node:child_process";
import { build } from "esbuild";
import QRCode from "qrcode";
import { resolveRuntime } from "./dsh-runtime.mjs";
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtime = await resolveRuntime(),
  require = createRequire(runtime.cli);
const home = await mkdtemp(join(tmpdir(), "dsh-wechat-loop-"));
const profile = join(home, "profiles/web");
await mkdir(profile, { recursive: true });
const workspace = join(home, "workspace");
await mkdir(workspace);
await writeFile(
  join(workspace, "image.png"),
  await QRCode.toBuffer("local-loop-fixture"),
);
await writeFile(join(workspace, "file.txt"), "native file fixture");
await build({
  entryPoints: [join(repo, "src/dsh/index.ts")],
  outfile: join(home, "adapter.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
});
/** A Windows absolute path is not a valid ESM specifier; hand the probe a file URL instead. */
const llmPath = pathToFileURL(require.resolve("@deepseek-ai/dsh-llm")).href;
await writeFile(
  join(home, "probe.mjs"),
  `
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {LlmAdapter} from ${JSON.stringify(llmPath)};
import {DshAdapter} from './adapter.mjs';
export const inject=['llm','agents','sessions','attachments','sessionQuery','typertGateway','connection','sessionController','agentPresets'];
export async function apply(ctx){
 const report={ok:false,calls:[],results:[],checks:[]};let handle;let adapter;let agent;
 try{
  class LocalProvider extends LlmAdapter {
   async resolveModel(provider,model){return {provider,id:model,name:'Local deterministic fixture',inputModalities:['text','image'],context:{contextWindow:128000}};}
   async *stream(options){
    assert.equal(options.provider,'wechat-fixture');
    options.signal?.throwIfAborted();
    const input=options.messages.filter(message=>message.source.kind==='user').at(-1);
    if(input && ["text","image","file"].includes(input.id))report.calls.push({id:input?.id,types:input?.content.map(block=>block.type)});
    const text='local result '+report.calls.length;
    yield {type:'block-start',index:0,blockType:'text'};
    yield {type:'text-delta',index:0,text};
    yield {type:'block-end',index:0,block:{type:'text',text}};
    yield {type:'finish',reason:{kind:'stop'}};
   }
  }
  ctx.llm.registerAdapter(['wechat-fixture'],new LocalProvider());
  const preset=await ctx.agentPresets.resolve();
  handle=await ctx.agents.create({sessionId:'wechat-local-loop',meta:{agentPreset:preset.id,cwd:${JSON.stringify(workspace)}},agentOptions:{provider:'wechat-fixture',model:'local'}});
  agent=handle.agent;
  adapter=new DshAdapter(ctx);
  const cases=[{messageId:'text',text:'hello'},{messageId:'image',text:'inspect image',attachments:[{kind:'image',path:${JSON.stringify(join(workspace, "image.png"))},name:'image.png',mediaType:'image/png'}]},{messageId:'file',text:'inspect file',attachments:[{kind:'file',path:${JSON.stringify(join(workspace, "file.txt"))},name:'file.txt',mediaType:'text/plain'}]}];
  for(const input of cases){
   await adapter.submit({sessionId:agent.id,...input});
   await agent.whenIdle();
   const state=await adapter.reconcile(agent.id,input.messageId);
   report.results.push(state);
   const original=agent.session.snapshotEvents().find(event=>event.type==='user/message'&&event.data.id===input.messageId);
   assert.deepEqual(original.data.content.map(block=>block.type),input.messageId==='text'?['text']:['text',input.messageId]);
   assert.equal(state.state,'completed');assert.equal(state.text,'local result '+report.results.length);
   assert.equal(typeof state.seq,'number');assert.equal(state.turn,report.results.length);
   const event=agent.session.eventAt(state.seq);assert.equal(event.type,'turn/end');
   await adapter.submit({sessionId:agent.id,...input});
   if(input.messageId==='text'){
    await ctx.sessions.flush(agent.session);
    const id=agent.id;await handle.dispose();handle=undefined;
    assert.equal(ctx.agents.get(id),undefined);
    const [first,second]=await Promise.all([adapter.acquire(id),adapter.acquire(id)]);
    assert.equal(first,second);agent=first;
    assert.equal(agent.session.header.agentPreset,preset.id);
    report.coldResume={preset:preset.id,provider:agent.session.requestHeader().config.provider,model:agent.session.requestHeader().config.model};
   }
  }
  assert.equal(report.calls.length,3);
  assert.deepEqual(report.calls.map(c=>c.types),[['text'],['text','image'],['text','text']]);
  report.checks=['real-Agent-loop-text-image-file','native-attachments-in-session-and-official-file-handle-projection','assembled-replies-and-terminal-trace','retry-identity-no-second-model-call','controller-cold-resume-restores-model-and-preset'];report.ok=true;
 }catch(error){report.error=String(error.stack??error);}
 finally{await adapter?.dispose();await handle?.dispose();await writeFile(${JSON.stringify(join(home, "loop-report.json"))},JSON.stringify(report,null,2));}
}
`,
);
await writeFile(
  join(profile, "package.json"),
  JSON.stringify({
    name: "wechat-loop-smoke",
    private: true,
    dsh: {
      profile: {
        bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"],
      },
    },
  }),
);
await writeFile(
  join(profile, "cordis.patch.yml"),
  `- insert:\n    - id: wechat-loop-probe\n      name: ${JSON.stringify(join(home, "probe.mjs"))}\n`,
);
const env = {
  ...process.env,
  DSH_HOME: home,
  DSH_TELEMETRY: "0",
  npm_config_registry: "https://registry.npmjs.org",
};
for (const key of Object.keys(env))
  if (/API_KEY|ACCESS_TOKEN|AUTH_TOKEN|BEARER_TOKEN/.test(key)) delete env[key];
execFileSync(
  process.execPath,
  [runtime.cli, "plugin", "--profile", "web", "add", repo],
  { cwd: workspace, env, timeout: 120000, stdio: "pipe" },
);
const child = spawn(
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
  { cwd: workspace, env, stdio: ["ignore", "pipe", "pipe"] },
);
let logs = "";
for (const stream of [child.stdout, child.stderr])
  stream.on("data", (v) => {
    logs += v.toString();
  });
const redact = (value) =>
  value.replace(/([?&]token=)[^\s"'<>]+/g, "$1[REDACTED]");
let report;
try {
  for (let attempt = 0; attempt < 600; attempt++) {
    try {
      report = JSON.parse(
        await readFile(join(home, "loop-report.json"), "utf8"),
      );
      break;
    } catch {}
    if (child.exitCode !== null)
      throw new Error("Host exited: " + redact(logs.slice(-6000)));
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!report)
    throw new Error("Loop smoke timed out: " + redact(logs.slice(-6000)));
  if (!report.ok) process.exitCode = 1;
  console.log(
    JSON.stringify({ home, versions: runtime.versions, ...report }, null, 2),
  );
} catch (error) {
  console.error(redact(error.message));
  process.exitCode = 1;
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    await new Promise((r) => {
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        r();
      }, 5000);
      child.once("exit", () => {
        clearTimeout(timeout);
        r();
      });
    });
  }
  await writeFile(join(home, "host.log"), redact(logs));
}
