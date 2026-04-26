import type { ProjectConfig, SandboxMode } from "../types.js";

export function threadIdFromParams(params: Record<string, unknown> | undefined) {
  if (!params) return undefined;
  if (typeof params.threadId === "string") return params.threadId;

  const thread = params.thread;
  if (thread && typeof thread === "object" && "id" in thread && typeof thread.id === "string") {
    return thread.id;
  }

  return undefined;
}

export function turnIdFromParams(params: Record<string, unknown> | undefined) {
  if (!params) return undefined;
  const turn = params.turn;
  if (turn && typeof turn === "object" && "id" in turn && typeof turn.id === "string") {
    return turn.id;
  }
  if (typeof params.turnId === "string") return params.turnId;
  return undefined;
}

export function toThreadStartParams(project: ProjectConfig, title?: string) {
  return {
    cwd: project.path,
    model: project.defaultModel ?? null,
    approvalPolicy: project.defaultApprovalPolicy,
    sandbox: project.defaultSandbox,
    personality: "friendly",
    serviceName: "codex_mobile_console",
    developerInstructions: mobileConsoleInstructions(title),
    experimentalRawEvents: false,
    persistExtendedHistory: true
  };
}

export function toTurnStartParams(project: ProjectConfig, threadId: string, text: string) {
  return {
    threadId,
    cwd: project.path,
    approvalPolicy: project.defaultApprovalPolicy,
    sandboxPolicy: sandboxPolicyFor(project.defaultSandbox, project.path),
    input: [{ type: "text", text, text_elements: [] }]
  };
}

export function sandboxPolicyFor(mode: SandboxMode, projectPath: string) {
  if (mode === "danger-full-access") {
    return { type: "dangerFullAccess" };
  }
  if (mode === "read-only") {
    return { type: "readOnly", networkAccess: false };
  }
  return {
    type: "workspaceWrite",
    networkAccess: false,
    writableRoots: [projectPath]
  };
}

function mobileConsoleInstructions(title?: string) {
  return [
    "You are being controlled from Codex Mobile Console, a small-screen remote UI.",
    "Keep progress updates concise and make approval prompts understandable on a phone.",
    "Do not perform destructive git or filesystem operations unless the user explicitly requested them.",
    title ? `The user-facing session title is: ${title}` : ""
  ]
    .filter(Boolean)
    .join("\n");
}
