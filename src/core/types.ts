export type MessageState =
  | "received"
  | "preparing"
  | "ready"
  | "accepted"
  | "running"
  | "completed"
  | "failed"
  | "uncertain"
  | "cancelled"
  | "queued"
  | "sending"
  | "sent"
  | "retry_wait"
  | "waiting_context";
export interface Attachment {
  id: string;
  name: string;
  mime: string;
  size: number;
  path: string;
  sha256: string;
  kind: "image" | "file";
}
export interface Message {
  id: string;
  epoch: number;
  direction: "in" | "out";
  providerId: string | null;
  sessionId: string | null;
  text: string;
  state: MessageState;
  error: string | null;
  createdAt: number;
  attachments: Attachment[];
  source: string | null;
  submissionId: string | null;
  dshMessageId: string | null;
  payload: unknown;
  attempts: number;
  nextAttempt: number;
  clientId: string;
}
export interface Binding {
  sessionId: string;
  revision: number;
}
export interface Interaction {
  id: string;
  kind: "approval" | "question";
  description: string;
  expiresAt: number;
  state: string;
  sessionId?: string;
}
export interface Status {
  lastPollAt?: number;
  connection: string;
  ownerId?: string;
  pairing?: { qrDataUrl?: string; status: string; ownerId?: string };
  binding?: Binding;
  counts: Record<string, number>;
  capabilities?: unknown;
}
export interface MessageView {
  id: string;
  direction: "in" | "out";
  text: string;
  state: string;
  createdAt: number;
  sessionId?: string;
  submissionId?: string;
  deliveryId?: string;
  error?: string;
  attachments: {
    id: string;
    name: string;
    mime: string;
    size: number;
    url: string;
  }[];
}
