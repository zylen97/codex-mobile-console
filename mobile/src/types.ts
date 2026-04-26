export type ApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";
export type SessionStatus = "idle" | "running" | "waiting-approval" | "error";

export interface ProjectConfig {
  id: string;
  name: string;
  path: string;
  description?: string;
  defaultModel?: string;
  defaultSandbox: "read-only" | "workspace-write" | "danger-full-access";
  defaultApprovalPolicy: "untrusted" | "on-request" | "never";
}

export interface ConsoleSession {
  id: string;
  projectId: string;
  codexThreadId: string;
  title: string;
  status: SessionStatus;
  activeTurnId?: string;
  lastError?: string;
  preview?: string;
  cwd?: string;
  source?: string;
  modelProvider?: string;
  gitBranch?: string;
  gitOrigin?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConsoleMessage {
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "event";
  content: string;
  status?: "streaming" | "complete" | "error";
  itemId?: string;
  turnId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ApprovalRecord {
  id: string;
  sessionId?: string;
  codexRequestId: string | number;
  method: string;
  params: Record<string, unknown>;
  status: "pending" | "resolved" | "failed";
  decision?: ApprovalDecision;
  answerSummary?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Snapshot {
  projects: ProjectConfig[];
  sessions: ConsoleSession[];
  approvals: ApprovalRecord[];
}

export interface GatewayEvent {
  type:
    | "snapshot"
    | "session.updated"
    | "message.created"
    | "message.updated"
    | "approval.created"
    | "approval.updated"
    | "codex.event"
    | "gateway.error";
  data: unknown;
}
