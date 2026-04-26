import crypto from "node:crypto";
import path from "node:path";
import type { ConsoleMessage, ConsoleSession, ProjectConfig, SessionStatus } from "../types.js";

type ThreadStatus =
  | { type: "notLoaded" }
  | { type: "idle" }
  | { type: "systemError" }
  | { type: "active"; activeFlags?: string[] };

export interface CodexThread {
  id: string;
  preview?: string;
  modelProvider?: string;
  createdAt?: number;
  updatedAt?: number;
  status?: ThreadStatus;
  cwd?: string;
  source?: string;
  gitInfo?: {
    sha?: string | null;
    branch?: string | null;
    originUrl?: string | null;
    origin_url?: string | null;
  } | null;
  name?: string | null;
  turns?: CodexTurn[];
}

interface CodexTurn {
  id: string;
  items?: CodexThreadItem[];
  status?: string;
  startedAt?: number | null;
  completedAt?: number | null;
}

type CodexThreadItem = Record<string, unknown> & { type?: string; id?: string };

const fallbackSandbox = "workspace-write";
const fallbackApprovalPolicy = "on-request";

export function buildSyncedSnapshot(threads: CodexThread[], configuredProjects: ProjectConfig[]) {
  const projectsById = new Map<string, ProjectConfig>();
  for (const project of configuredProjects) {
    projectsById.set(project.id, project);
  }

  const sessions = threads.map((thread) => {
    const project = projectForThread(thread, configuredProjects);
    projectsById.set(project.id, project);
    return sessionFromThread(thread, project);
  });

  const projects = Array.from(projectsById.values()).sort((a, b) => {
    const aLatest = latestSessionTimeForProject(sessions, a.id);
    const bLatest = latestSessionTimeForProject(sessions, b.id);
    if (aLatest !== bLatest) return bLatest.localeCompare(aLatest);
    return a.name.localeCompare(b.name);
  });

  return { projects, sessions };
}

export function projectForThread(thread: CodexThread, configuredProjects: ProjectConfig[]) {
  const cwd = thread.cwd ?? "";
  const exactProject = configuredProjects.find((project) => normalizePath(project.path) === normalizePath(cwd));
  if (exactProject) return exactProject;

  const defaults = defaultsForCwd(cwd, configuredProjects);
  return {
    id: projectIdForCwd(cwd),
    name: projectNameForThread(thread),
    path: cwd,
    description: thread.gitInfo?.branch ? `Git branch: ${thread.gitInfo.branch}` : "Discovered from Codex sessions.",
    defaultModel: defaults.defaultModel,
    defaultSandbox: defaults.defaultSandbox,
    defaultApprovalPolicy: defaults.defaultApprovalPolicy
  } satisfies ProjectConfig;
}

export function projectByIdFromSnapshot(projects: ProjectConfig[], projectId: string) {
  return projects.find((project) => project.id === projectId);
}

export function defaultsForCwd(cwd: string, configuredProjects: ProjectConfig[]) {
  const normalizedCwd = normalizePath(cwd);
  const closest = configuredProjects
    .filter((project) => isSameOrChildPath(normalizedCwd, normalizePath(project.path)))
    .sort((a, b) => normalizePath(b.path).length - normalizePath(a.path).length)[0];

  return {
    defaultModel: closest?.defaultModel,
    defaultSandbox: closest?.defaultSandbox ?? fallbackSandbox,
    defaultApprovalPolicy: closest?.defaultApprovalPolicy ?? fallbackApprovalPolicy
  } satisfies Pick<ProjectConfig, "defaultModel" | "defaultSandbox" | "defaultApprovalPolicy">;
}

export function sessionFromThread(thread: CodexThread, project: ProjectConfig): ConsoleSession {
  const createdAt = dateFromUnixSeconds(thread.createdAt) ?? new Date().toISOString();
  const updatedAt = dateFromUnixSeconds(thread.updatedAt ?? thread.createdAt) ?? createdAt;
  return {
    id: thread.id,
    projectId: project.id,
    codexThreadId: thread.id,
    title: titleForThread(thread),
    status: statusFromThread(thread.status),
    createdAt,
    updatedAt,
    preview: singleLine(thread.preview),
    cwd: thread.cwd,
    source: thread.source,
    modelProvider: thread.modelProvider,
    gitBranch: thread.gitInfo?.branch ?? undefined,
    gitOrigin: thread.gitInfo?.originUrl ?? thread.gitInfo?.origin_url ?? undefined
  };
}

export function messagesFromThread(thread: CodexThread): ConsoleMessage[] {
  const messages: ConsoleMessage[] = [];
  for (const turn of thread.turns ?? []) {
    const timestamp =
      dateFromUnixSeconds(turn.startedAt ?? turn.completedAt ?? thread.updatedAt ?? thread.createdAt) ??
      new Date().toISOString();
    for (const [index, item] of (turn.items ?? []).entries()) {
      const message = messageFromItem(thread.id, turn, item, index, timestamp);
      if (message) messages.push(message);
    }
  }
  return messages.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function mergeThreadMessages(history: ConsoleMessage[], overlay: ConsoleMessage[]) {
  const historicalKeys = new Set(history.map(messageKey));
  const byId = new Map(history.map((message) => [message.id, message]));

  for (const message of overlay) {
    if (message.status !== "streaming" && historicalKeys.has(messageKey(message))) continue;
    byId.set(message.id, message);
  }

  return Array.from(byId.values()).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function messageFromItem(
  threadId: string,
  turn: CodexTurn,
  item: CodexThreadItem,
  index: number,
  fallbackTimestamp: string
): ConsoleMessage | undefined {
  const itemId = typeof item.id === "string" ? item.id : `${turn.id}-${index}`;
  const base = {
    id: `${threadId}:${turn.id}:${itemId}`,
    sessionId: threadId,
    itemId,
    turnId: turn.id,
    createdAt: fallbackTimestamp,
    updatedAt: dateFromUnixSeconds(turn.completedAt ?? turn.startedAt) ?? fallbackTimestamp
  };

  if (item.type === "userMessage") {
    const content = userInputText(item.content);
    if (!content) return undefined;
    return { ...base, role: "user", content, status: "complete" };
  }

  if (item.type === "agentMessage") {
    const text = typeof item.text === "string" ? item.text : "";
    if (!text.trim()) return undefined;
    return { ...base, role: "assistant", content: text, status: "complete" };
  }

  if (item.type === "plan") {
    const text = typeof item.text === "string" ? item.text : "";
    if (!text.trim()) return undefined;
    return { ...base, role: "event", content: `Plan\n${text}`, status: "complete" };
  }

  if (item.type === "commandExecution") {
    const command = typeof item.command === "string" ? item.command : "";
    const status = typeof item.status === "string" ? item.status : turn.status ?? "completed";
    const output = typeof item.aggregatedOutput === "string" ? item.aggregatedOutput.trim() : "";
    const content = [`Command ${status}: ${command}`, output ? truncate(output, 1000) : ""].filter(Boolean).join("\n\n");
    return command ? { ...base, role: "event", content, status: "complete" } : undefined;
  }

  if (item.type === "fileChange") {
    const status = typeof item.status === "string" ? item.status : "completed";
    const count = Array.isArray(item.changes) ? item.changes.length : 0;
    return { ...base, role: "event", content: `File change ${status}${count ? ` (${count})` : ""}`, status: "complete" };
  }

  if (item.type === "mcpToolCall") {
    const server = typeof item.server === "string" ? item.server : "app";
    const tool = typeof item.tool === "string" ? item.tool : "tool";
    const status = typeof item.status === "string" ? item.status : "completed";
    return { ...base, role: "event", content: `App tool ${status}: ${server}/${tool}`, status: "complete" };
  }

  if (item.type === "webSearch") {
    const query = typeof item.query === "string" ? item.query : "";
    return query ? { ...base, role: "event", content: `Web search: ${query}`, status: "complete" } : undefined;
  }

  return undefined;
}

function userInputText(content: unknown) {
  if (!Array.isArray(content)) return "";
  return content
    .map((entry) => {
      if (!entry || typeof entry !== "object") return "";
      if ("text" in entry && typeof entry.text === "string") return entry.text;
      if ("path" in entry && typeof entry.path === "string") return `[${String(entry.type ?? "item")}: ${entry.path}]`;
      if ("url" in entry && typeof entry.url === "string") return `[image: ${entry.url}]`;
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function statusFromThread(status?: ThreadStatus): SessionStatus {
  if (!status) return "idle";
  if (status.type === "systemError") return "error";
  if (status.type === "active") {
    return status.activeFlags?.some((flag) => flag === "waitingOnApproval" || flag === "waitingOnUserInput")
      ? "waiting-approval"
      : "running";
  }
  return "idle";
}

function titleForThread(thread: CodexThread) {
  return singleLine(thread.name) || truncate(singleLine(thread.preview), 80) || "Untitled session";
}

function projectNameForThread(thread: CodexThread) {
  const cwd = thread.cwd ?? "";
  if (thread.gitInfo?.originUrl || thread.gitInfo?.origin_url) {
    const origin = thread.gitInfo.originUrl ?? thread.gitInfo.origin_url ?? "";
    const repo = origin.split("/").pop()?.replace(/\.git$/, "");
    if (repo) return repo;
  }
  return path.basename(cwd) || cwd || "Unknown project";
}

function projectIdForCwd(cwd: string) {
  const digest = crypto.createHash("sha1").update(cwd || "unknown").digest("hex").slice(0, 12);
  return `cwd-${digest}`;
}

function latestSessionTimeForProject(sessions: ConsoleSession[], projectId: string) {
  return sessions
    .filter((session) => session.projectId === projectId)
    .map((session) => session.updatedAt)
    .sort()
    .at(-1) ?? "";
}

function messageKey(message: ConsoleMessage) {
  if (message.role === "user") return `${message.sessionId}:${message.turnId ?? ""}:user`;
  return `${message.sessionId}:${message.turnId ?? ""}:${message.itemId ?? ""}:${message.role}`;
}

function dateFromUnixSeconds(value?: number | null) {
  if (typeof value !== "number") return undefined;
  return new Date(value * 1000).toISOString();
}

function normalizePath(value: string) {
  return path.resolve(value || ".");
}

function isSameOrChildPath(candidate: string, parent: string) {
  return candidate === parent || candidate.startsWith(`${parent}${path.sep}`);
}

function singleLine(value?: string | null) {
  return value?.replace(/\s+/g, " ").trim() ?? "";
}

function truncate(value: string, maxLength: number) {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}
