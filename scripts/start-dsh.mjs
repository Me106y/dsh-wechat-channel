#!/usr/bin/env node
import { spawn } from "node:child_process";
import {
  resolveRuntime,
  assertProfileRuntimeIsShared,
} from "./dsh-runtime.mjs";
try {
  const runtime = await resolveRuntime();
  await assertProfileRuntimeIsShared(runtime);
  const { cli } = runtime;
  const child = spawn(
    process.execPath,
    [cli, "web", ...process.argv.slice(2)],
    { stdio: "inherit", env: process.env },
  );
  child.on("error", (error) => {
    process.stderr.write(`Unable to start DSH: ${error.message}\n`);
    process.exitCode = 1;
  });
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => child.kill(signal));
  child.on("exit", (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0);
  });
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
