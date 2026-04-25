import fs from "node:fs";
import { nanoid } from "nanoid";
import { dataDir, statePath } from "../paths.js";
import type {
  ApprovalDecision,
  ApprovalRecord,
  ConsoleMessage,
  ConsoleSession,
  GatewayState,
  SessionStatus
} from "../types.js";

const emptyState: GatewayState = {
  sessions: [],
  messages: [],
  approvals: []
};

function now() {
  return new Date().toISOString();
}

export class DataStore {
  private state: GatewayState;

  constructor() {
    fs.mkdirSync(dataDir, { recursive: true });
    this.state = this.readState();
  }

  snapshot() {
    return structuredClone(this.state);
  }

  listSessions(projectId?: string) {
    return this.state.sessions
      .filter((session) => !projectId || session.projectId === projectId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  getSession(sessionId: string) {
    return this.state.sessions.find((session) => session.id === sessionId);
  }

  findSessionByThreadId(threadId?: string) {
    if (!threadId) return undefined;
    return this.state.sessions.find((session) => session.codexThreadId === threadId);
  }

  createSession(input: Pick<ConsoleSession, "projectId" | "codexThreadId" | "title">) {
    const createdAt = now();
    const session: ConsoleSession = {
      id: nanoid(12),
      projectId: input.projectId,
      codexThreadId: input.codexThreadId,
      title: input.title,
      status: "idle",
      createdAt,
      updatedAt: createdAt
    };
    this.state.sessions.push(session);
    this.persist();
    return session;
  }

  updateSession(sessionId: string, patch: Partial<ConsoleSession>) {
    const session = this.getSession(sessionId);
    if (!session) return undefined;
    Object.assign(session, patch, { updatedAt: now() });
    this.persist();
    return session;
  }

  listMessages(sessionId: string) {
    return this.state.messages
      .filter((message) => message.sessionId === sessionId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  addMessage(input: Pick<ConsoleMessage, "sessionId" | "role" | "content"> & Partial<ConsoleMessage>) {
    const createdAt = now();
    const message: ConsoleMessage = {
      id: nanoid(12),
      sessionId: input.sessionId,
      role: input.role,
      content: input.content,
      status: input.status ?? "complete",
      itemId: input.itemId,
      turnId: input.turnId,
      createdAt,
      updatedAt: createdAt
    };
    this.state.messages.push(message);
    this.persist();
    return message;
  }

  appendAssistantDelta(sessionId: string, itemId: string, turnId: string, delta: string) {
    let message = this.state.messages.find(
      (candidate) => candidate.sessionId === sessionId && candidate.itemId === itemId && candidate.role === "assistant"
    );
    if (!message) {
      message = this.addMessage({
        sessionId,
        role: "assistant",
        content: "",
        status: "streaming",
        itemId,
        turnId
      });
    }
    message.content += delta;
    message.status = "streaming";
    message.updatedAt = now();
    this.persist();
    return message;
  }

  completeStreamingMessages(sessionId: string, turnId?: string) {
    const changed: ConsoleMessage[] = [];
    for (const message of this.state.messages) {
      if (
        message.sessionId === sessionId &&
        message.role === "assistant" &&
        message.status === "streaming" &&
        (!turnId || message.turnId === turnId)
      ) {
        message.status = "complete";
        message.updatedAt = now();
        changed.push(message);
      }
    }
    if (changed.length) this.persist();
    return changed;
  }

  createApproval(input: Pick<ApprovalRecord, "codexRequestId" | "method" | "params" | "sessionId">) {
    const createdAt = now();
    const approval: ApprovalRecord = {
      id: nanoid(12),
      codexRequestId: input.codexRequestId,
      method: input.method,
      params: input.params,
      sessionId: input.sessionId,
      status: "pending",
      createdAt,
      updatedAt: createdAt
    };
    this.state.approvals.push(approval);
    this.persist();
    return approval;
  }

  listPendingApprovals() {
    return this.state.approvals
      .filter((approval) => approval.status === "pending")
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  getApproval(approvalId: string) {
    return this.state.approvals.find((approval) => approval.id === approvalId);
  }

  updateApproval(approvalId: string, patch: Partial<ApprovalRecord> & { decision?: ApprovalDecision }) {
    const approval = this.getApproval(approvalId);
    if (!approval) return undefined;
    Object.assign(approval, patch, { updatedAt: now() });
    this.persist();
    return approval;
  }

  setSessionStatusByThreadId(threadId: string | undefined, status: SessionStatus, activeTurnId?: string) {
    const session = this.findSessionByThreadId(threadId);
    if (!session) return undefined;
    session.status = status;
    session.activeTurnId = activeTurnId;
    session.updatedAt = now();
    this.persist();
    return session;
  }

  private readState(): GatewayState {
    if (!fs.existsSync(statePath)) return structuredClone(emptyState);
    try {
      const parsed = JSON.parse(fs.readFileSync(statePath, "utf8")) as GatewayState;
      return {
        sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
        messages: Array.isArray(parsed.messages) ? parsed.messages : [],
        approvals: Array.isArray(parsed.approvals) ? parsed.approvals : []
      };
    } catch {
      return structuredClone(emptyState);
    }
  }

  private persist() {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(this.state, null, 2));
  }
}
