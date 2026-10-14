import { isAbsolute } from "node:path";
import type { DshAdapter } from "./index.js";
import type { DshAgent } from "./types.js";
export interface AttachmentToolDefinition {
  name: string;
  description: string;
  parameters: object;
  output: {
    schema: object;
    render(args: unknown, value: unknown): { type: "text"; text: string }[];
  };
  execute(
    args: unknown,
    exec: { agent?: DshAgent; callId: string; signal: AbortSignal },
  ): Promise<{ queued: boolean }>;
}
export interface AttachmentToolContext {
  tools: { register(definition: AttachmentToolDefinition): () => void };
}
/** Uses the official ToolDefinition/ToolRuntime.register contract without bypassing DSH's tool policy pipeline. */
export function registerAttachmentTool(
  context: AttachmentToolContext,
  adapter: DshAdapter,
  enqueue: (
    sessionId: string,
    messageId: string,
    path: string,
    callId: string,
  ) => Promise<{ queued: boolean }>,
): () => void {
  return context.tools.register({
    name: "wechat_send_attachment",
    description:
      "Send an existing local image or file to the owner of the current WeChat task. Use only when this task was received from WeChat. The path must be absolute and inside the current project. This queues delivery; it does not confirm receipt.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute path of the existing image or file to send",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: "object",
        properties: { queued: { type: "boolean" } },
        required: ["queued"],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      const path =
        args !== null && typeof args === "object"
          ? (args as { path?: unknown }).path
          : undefined;
      if (typeof path !== "string" || !isAbsolute(path))
        throw new Error("WECHAT_ATTACHMENT_ABSOLUTE_PATH_REQUIRED");
      const messageId = exec.agent && adapter.currentSubmission(exec.agent);
      if (!exec.agent || !messageId)
        throw new Error("WECHAT_ATTACHMENT_REQUIRES_CURRENT_WECHAT_TASK");
      return enqueue(exec.agent.id, messageId, path, exec.callId);
    },
  });
}
