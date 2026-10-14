/** Narrow structural seam matching the official DSH 0.1.5-rc.2 services. */
export interface DshMessage {
  id: string;
  role: "user";
  source: { kind: "user" };
  content: DshBlock[];
}
export type DshBlock =
  | { type: "text"; text: string }
  | { type: "image"; attachment: ImageRef }
  | { type: "file"; attachment: FileRef };
export interface FileRef {
  attachmentId: string;
  name: string;
  bytes: number;
}
export interface ImageRef {
  attachmentId: string;
  mediaType: string;
  bytes: number;
  width: number;
  height: number;
  name?: string;
}
export interface DshSessionEvent {
  type: string;
  seq: number;
  data: unknown;
}
export interface DshSession {
  id: string;
  snapshotEvents(): readonly DshSessionEvent[];
  header?: { cwd?: string };
}
export interface DshAgent {
  id: string;
  session: DshSession;
  status: "idle" | "running";
  inbox: {
    nextTurn: readonly DshMessage[];
    nextStep: readonly DshMessage[];
    remove(id: string): boolean;
  };
  followup(message: DshMessage): void;
  cancel(cause: { kind: "user" }, options: { keepInbox: true }): void;
}
export interface DshFrame {
  rpcId: string;
  payload: { type: string; sessionId?: string; [key: string]: unknown };
}
export interface DshContext {
  agents: {
    get(id: string): DshAgent | undefined;
    list(): DshAgent[];
  };
  sessionController: {
    resolveAgent(
      sessionId: string,
    ): Promise<{ agent: DshAgent } | { error: unknown }>;
  };
  sessions: { flush(session: DshSession): Promise<boolean> };
  attachments: {
    saveFileStream(input: {
      data: AsyncIterable<Uint8Array>;
      name?: string;
      signal?: AbortSignal;
    }): Promise<FileRef>;
    saveImages(
      images: readonly { data: Uint8Array; mediaType: string; name?: string }[],
    ): Promise<readonly ImageRef[]>;
  };
  on(
    name: "session/event",
    listener: (session: DshSession, event: DshSessionEvent) => void,
  ): () => void;
  sessionQuery: {
    listSessions(signal?: AbortSignal): Promise<
      {
        header: { id: string; cwd?: string; origin?: string };
        live: boolean;
        persisted: boolean;
      }[]
    >;
  };
  typertGateway: {
    wireStream: {
      open(
        endpoint: string,
        payload: unknown,
        uplink: AsyncIterable<unknown>,
        peer: unknown,
        signal: AbortSignal,
      ): Promise<AsyncIterable<unknown>>;
    };
  };
  connection: {
    createSharedFetchHandler(channel: "/api"): {
      fetch(request: Request): Promise<Response>;
    };
  };
}
export interface DshInputAttachment {
  kind: "image" | "file";
  path: string;
  name: string;
  mediaType: string;
}
export interface DshSubmission {
  sessionId: string;
  messageId: string;
  text?: string;
  attachments?: DshInputAttachment[];
}
export interface DshReconciliation {
  state:
    | "absent"
    | "queued"
    | "running"
    | "completed"
    | "cancelled"
    | "failed"
    | "unknown";
  messageId: string;
  sessionId: string;
  turn?: number;
  text?: string;
  reason?: string;
  seq?: number;
}
export interface DshPresentedFile {
  path: string;
  description?: string;
}
export type DshEvent =
  | (DshReconciliation & { type: "submission" })
  | {
      type: "deliverables/presented";
      sessionId: string;
      messageId: string;
      turn: number;
      callId: string;
      cwd: string;
      files: DshPresentedFile[];
    }
  | {
      type: "interaction";
      sessionId: string;
      messageId: string;
      rpcId: string;
      kind: "approval" | "question";
      payload: Record<string, unknown>;
    }
  | {
      type: "interaction-resolved";
      sessionId: string;
      rpcId: string;
      payload: Record<string, unknown>;
    }
  | { type: "error"; error: string };
