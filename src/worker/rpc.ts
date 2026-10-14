import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
export interface Wire {
  id: string;
  epoch: number;
  method?: string;
  payload?: unknown;
  result?: unknown;
  error?: { code: string; kind?: string; remoteCode?: number };
}
type Pending = {
  child: ChildProcess;
  epoch: number;
  resolve: (x: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
};
const failure = (code: string) =>
  Object.assign(new Error(code), { kind: "uncertain" });
/** One configured process generation. A timeout terminates that process before retry is possible. */
export class WorkerRpc {
  private child?: ChildProcess;
  private pending = new Map<string, Pending>();
  private configuration: unknown = {};
  private ready?: Promise<ChildProcess>;
  private generation = 0;
  private stopped?: Promise<void>;
  private reconfiguring?: Promise<unknown>;
  constructor(
    private readonly epoch: () => number,
    private readonly workerUrl: URL = new URL("./worker.js", import.meta.url),
  ) {}
  private rejectChild(child: ChildProcess, error: Error) {
    for (const [id, p] of this.pending)
      if (p.child === child) {
        clearTimeout(p.timer);
        this.pending.delete(id);
        p.reject(error);
      }
  }
  private retire(child: ChildProcess, error: Error) {
    if (this.child === child) {
      this.child = undefined;
      this.ready = undefined;
      this.generation++;
    }
    this.rejectChild(child, error);
    const closing = new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.once("error", () => resolve());
      child.kill("SIGKILL");
      // A failed spawn may emit error without exit; no live child exists in that case.
      if (!child.pid) resolve();
    });
    this.stopped = closing;
    void closing.finally(() => {
      if (this.stopped === closing) this.stopped = undefined;
    });
  }
  private spawn(): ChildProcess {
    const child = fork(fileURLToPath(this.workerUrl), [], {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      serialization: "advanced",
      execArgv: [],
    });
    this.child = child;
    child.on("message", (m: Wire) => {
      if (!m || typeof m.id !== "string") return;
      const p = this.pending.get(m.id);
      if (!p || p.child !== child) return;
      clearTimeout(p.timer);
      this.pending.delete(m.id);
      if (m.epoch !== p.epoch || p.epoch !== this.epoch())
        p.reject(failure("STALE_EPOCH"));
      else if (m.error)
        p.reject(
          Object.assign(new Error(m.error.code), {
            kind: m.error.kind,
            remoteCode: m.error.remoteCode,
          }),
        );
      else p.resolve(m.result);
    });
    child.on("error", () => this.retire(child, failure("WORKER_SPAWN_ERROR")));
    child.on("exit", () => {
      if (this.child === child) {
        this.child = undefined;
        this.ready = undefined;
        this.generation++;
      }
      this.rejectChild(child, failure("WORKER_EXIT"));
    });
    return child;
  }
  private request<T>(
    child: ChildProcess,
    method: string,
    payload: unknown,
    timeout: number,
  ): Promise<T> {
    const id = randomUUID(),
      epoch = this.epoch();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => this.retire(child, failure("WORKER_TIMEOUT")),
        timeout,
      );
      this.pending.set(id, {
        child,
        epoch,
        resolve: resolve as (x: unknown) => void,
        reject,
        timer,
      });
      try {
        child.send({ id, epoch, method, payload }, (error) => {
          if (error) this.retire(child, failure("WORKER_SEND_FAILED"));
        });
      } catch {
        this.retire(child, failure("WORKER_SEND_FAILED"));
      }
    });
  }
  private async ensureReady(): Promise<ChildProcess> {
    const generation = this.generation;
    if (this.stopped) await this.stopped;
    if (generation !== this.generation) throw failure("WORKER_STOPPED");
    if (!this.ready) {
      const child = this.spawn();
      const ready = this.request(
        child,
        "configure",
        this.configuration,
        15_000,
      ).then(() => {
        if (this.child !== child || generation !== this.generation)
          throw failure("WORKER_STOPPED");
        return child;
      });
      this.ready = ready;
      // Keep cleanup attached even if the initiating caller is cancelled by lifecycle changes.
      void ready.catch(() => {
        if (this.child === child)
          this.retire(child, failure("WORKER_CONFIGURE_FAILED"));
      });
    }
    return this.ready;
  }
  async call<T>(
    method: string,
    payload: unknown,
    timeout?: number,
  ): Promise<T> {
    if (method === "configure") {
      const stopping = this.stop(),
        generation = this.generation;
      const task = (async () => {
        await stopping;
        if (generation !== this.generation) throw failure("WORKER_STOPPED");
        this.configuration = payload;
        await this.ensureReady();
        return true as T;
      })();
      this.reconfiguring = task;
      try {
        return await task;
      } finally {
        if (this.reconfiguring === task) this.reconfiguring = undefined;
      }
    }
    const epoch = this.epoch();
    if (this.reconfiguring) await this.reconfiguring;
    const child = await this.ensureReady();
    if (child !== this.child || epoch !== this.epoch())
      throw failure("STALE_EPOCH");
    return this.request<T>(
      child,
      method,
      payload,
      timeout ?? (["download", "upload"].includes(method) ? 150_000 : 60_000),
    );
  }
  async stop(): Promise<void> {
    this.generation++;
    const child = this.child;
    this.child = undefined;
    this.ready = undefined;
    if (!child) {
      await this.stopped;
      return;
    }
    this.rejectChild(child, failure("WORKER_STOPPED"));
    const closing = new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 3000);
      child.once("exit", finish);
      child.once("error", finish);
      child.kill("SIGTERM");
    });
    this.stopped = closing;
    await closing;
    if (this.stopped === closing) this.stopped = undefined;
  }
}
