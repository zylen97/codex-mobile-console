import fs from "node:fs";
import Fastify, { type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import staticPlugin from "@fastify/static";
import websocketPlugin from "@fastify/websocket";
import { z } from "zod";
import { CodexAppServerClient, type JsonObject, type JsonRpcMessage, type JsonValue } from "./codex/CodexAppServerClient.js";
import { threadIdFromParams, toThreadStartParams, toTurnStartParams, turnIdFromParams } from "./codex/helpers.js";
import { loadGatewayConfig } from "./config.js";
import { mobileDistPath } from "./paths.js";
import { getOrCreateDeviceToken, timingSafeEqualText } from "./security.js";
import { DataStore } from "./state/store.js";
import type { ApprovalDecision, GatewayEvent, ProjectConfig } from "./types.js";

const host = process.env.CMC_HOST ?? "127.0.0.1";
const port = Number(process.env.CMC_PORT ?? 8787);
const deviceToken = getOrCreateDeviceToken();

const config = loadGatewayConfig();
const store = new DataStore();
const codex = new CodexAppServerClient();
const loadedThreads = new Set<string>();
const clients = new Set<{ send: (message: string) => void }>();
const itemCache = new Map<string, unknown>();

const app = Fastify({ logger: true });

await app.register(cors, { origin: true });
await app.register(websocketPlugin);

if (fs.existsSync(mobileDistPath)) {
  await app.register(staticPlugin, {
    root: mobileDistPath,
    prefix: "/"
  });
}

app.addHook("preHandler", async (request, reply) => {
  if (!request.url.startsWith("/api/")) return;
  if (request.url === "/api/health") return;
  if (isAuthorized(request)) return;
  reply.code(401).send({ error: "Unauthorized" });
});

app.get("/api/health", async () => ({
  ok: true,
  service: "codex-mobile-console",
  auth: "token"
}));

app.get("/api/status", async () => ({
  ok: true,
  host,
  port,
  projects: config.projects.length,
  codexCli: "codex app-server via stdio"
}));

app.get("/api/projects", async () => ({
  projects: config.projects,
  sessions: store.listSessions()
}));

app.get("/api/projects/:projectId/sessions", async (request, reply) => {
  const { projectId } = z.object({ projectId: z.string() }).parse(request.params);
  const project = getProject(projectId);
  if (!project) return reply.code(404).send({ error: "Unknown project" });
  return { sessions: store.listSessions(projectId) };
});

app.post("/api/projects/:projectId/sessions", async (request, reply) => {
  const params = z.object({ projectId: z.string() }).parse(request.params);
  const body = z
    .object({
      title: z.string().min(1).max(120).optional()
    })
    .parse(request.body ?? {});
  const project = getProject(params.projectId);
  if (!project) return reply.code(404).send({ error: "Unknown project" });

  try {
    await codex.ensureReady();
    const result = (await codex.request("thread/start", toThreadStartParams(project, body.title) as never)) as {
      thread?: { id?: string };
    };
    const threadId = result.thread?.id;
    if (!threadId) throw new Error("Codex did not return a thread id");

    loadedThreads.add(threadId);
    const session = store.createSession({
      projectId: project.id,
      codexThreadId: threadId,
      title: body.title ?? `Mobile session ${new Date().toLocaleString()}`
    });
    broadcast({ type: "session.updated", data: session });
    return { session };
  } catch (error) {
    return reply.code(500).send({ error: readableError(error) });
  }
});

app.get("/api/sessions/:sessionId", async (request, reply) => {
  const { sessionId } = z.object({ sessionId: z.string() }).parse(request.params);
  const session = store.getSession(sessionId);
  if (!session) return reply.code(404).send({ error: "Unknown session" });
  return {
    session,
    messages: store.listMessages(sessionId),
    approvals: store.listPendingApprovals().filter((approval) => approval.sessionId === sessionId)
  };
});

app.post("/api/sessions/:sessionId/messages", async (request, reply) => {
  const { sessionId } = z.object({ sessionId: z.string() }).parse(request.params);
  const body = z.object({ text: z.string().min(1).max(20_000) }).parse(request.body ?? {});
  const session = store.getSession(sessionId);
  if (!session) return reply.code(404).send({ error: "Unknown session" });
  const project = getProject(session.projectId);
  if (!project) return reply.code(404).send({ error: "Unknown project" });

  const userMessage = store.addMessage({
    sessionId,
    role: "user",
    content: body.text
  });
  broadcast({ type: "message.created", data: userMessage });

  try {
    await ensureThreadLoaded(session.codexThreadId, project);

    if (session.status === "running" && session.activeTurnId) {
      await codex.request("turn/steer", {
        threadId: session.codexThreadId,
        expectedTurnId: session.activeTurnId,
        input: [{ type: "text", text: body.text }]
      } as never);
    } else {
      const response = (await codex.request(
        "turn/start",
        toTurnStartParams(project, session.codexThreadId, body.text) as never
      )) as { turn?: { id?: string } };
      const activeTurnId = response.turn?.id;
      const updated = store.updateSession(sessionId, {
        status: "running",
        activeTurnId,
        lastError: undefined
      });
      if (updated) broadcast({ type: "session.updated", data: updated });
    }

    return { ok: true };
  } catch (error) {
    const updated = store.updateSession(sessionId, {
      status: "error",
      lastError: readableError(error)
    });
    if (updated) broadcast({ type: "session.updated", data: updated });
    return reply.code(500).send({ error: readableError(error) });
  }
});

app.post("/api/approvals/:approvalId", async (request, reply) => {
  const { approvalId } = z.object({ approvalId: z.string() }).parse(request.params);
  const body = z
    .object({
      decision: z.enum(["accept", "acceptForSession", "decline", "cancel"]).optional(),
      answers: z.record(z.object({ answers: z.array(z.string()) })).optional()
    })
    .parse(request.body ?? {});

  const approval = store.getApproval(approvalId);
  if (!approval) return reply.code(404).send({ error: "Unknown approval" });
  if (approval.status !== "pending") return reply.code(409).send({ error: "Approval already resolved" });

  try {
    const response = responseForApproval(approval.method, approval.params, body);
    codex.respond(approval.codexRequestId, response);
    const updated = store.updateApproval(approvalId, {
      status: "resolved",
      decision: body.decision as ApprovalDecision | undefined,
      answerSummary: summarizeAnswers(body.answers)
    });
    if (updated) broadcast({ type: "approval.updated", data: updated });

    if (approval.sessionId) {
      const session = store.getSession(approval.sessionId);
      if (session?.status === "waiting-approval") {
        const updatedSession = store.updateSession(session.id, { status: "running" });
        if (updatedSession) broadcast({ type: "session.updated", data: updatedSession });
      }
    }

    return { ok: true };
  } catch (error) {
    const updated = store.updateApproval(approvalId, { status: "failed" });
    if (updated) broadcast({ type: "approval.updated", data: updated });
    return reply.code(500).send({ error: readableError(error) });
  }
});

app.get("/ws", { websocket: true }, (socket, request) => {
  if (!isAuthorized(request)) {
    socket.close(1008, "Unauthorized");
    return;
  }

  clients.add(socket);
  socket.send(JSON.stringify(snapshotEvent()));

  socket.on("close", () => {
    clients.delete(socket);
  });
});

codex.on("notification", (message: JsonRpcMessage) => {
  handleCodexNotification(message);
});

codex.on("serverRequest", (message: JsonRpcMessage) => {
  handleCodexServerRequest(message);
});

codex.on("diagnostic", (diagnostic) => {
  broadcast({ type: "codex.event", data: { method: "diagnostic", params: diagnostic } });
});

await app.listen({ host, port });

app.log.info(`Codex Mobile Console Gateway`);
app.log.info(`Local: http://127.0.0.1:${port}`);
app.log.info(`Token: ${deviceToken}`);
app.log.info(`For Tailscale/LAN access: CMC_HOST=0.0.0.0 npm run dev:gateway`);

function getProject(projectId: string) {
  return config.projects.find((project) => project.id === projectId);
}

async function ensureThreadLoaded(threadId: string, project: ProjectConfig) {
  await codex.ensureReady();
  if (loadedThreads.has(threadId)) return;
  await codex.request("thread/resume", {
    threadId,
    cwd: project.path,
    approvalPolicy: project.defaultApprovalPolicy,
    sandbox: project.defaultSandbox,
    personality: "friendly"
  } as never);
  loadedThreads.add(threadId);
}

function handleCodexNotification(message: JsonRpcMessage) {
  const params = message.params ?? {};
  const threadId = threadIdFromParams(params);
  const session = store.findSessionByThreadId(threadId);

  const item = params.item;
  if (item && typeof item === "object" && "id" in item && typeof item.id === "string") {
    itemCache.set(item.id, item);
    if (itemCache.size > 400) {
      const oldestKey = itemCache.keys().next().value;
      if (oldestKey) itemCache.delete(oldestKey);
    }
  }

  if (message.method === "turn/started" && session) {
    const updated = store.updateSession(session.id, {
      status: "running",
      activeTurnId: turnIdFromParams(params),
      lastError: undefined
    });
    if (updated) broadcast({ type: "session.updated", data: updated });
  }

  if (message.method === "item/agentMessage/delta" && session) {
    const itemId = typeof params.itemId === "string" ? params.itemId : "assistant";
    const turnId = typeof params.turnId === "string" ? params.turnId : "";
    const delta = typeof params.delta === "string" ? params.delta : "";
    if (delta) {
      const updatedMessage = store.appendAssistantDelta(session.id, itemId, turnId, delta);
      broadcast({ type: "message.updated", data: updatedMessage });
    }
  }

  if (message.method === "turn/completed" && session) {
    const turnId = turnIdFromParams(params);
    for (const updatedMessage of store.completeStreamingMessages(session.id, turnId)) {
      broadcast({ type: "message.updated", data: updatedMessage });
    }
    const turn = params.turn;
    const error =
      turn && typeof turn === "object" && "error" in turn && turn.error
        ? JSON.stringify(turn.error)
        : undefined;
    const updated = store.updateSession(session.id, {
      status: error ? "error" : "idle",
      activeTurnId: undefined,
      lastError: error
    });
    if (updated) broadcast({ type: "session.updated", data: updated });
  }

  if (message.method === "item/started" && session) {
    const eventMessage = summarizeItemEvent("started", params);
    if (eventMessage) {
      const created = store.addMessage({
        sessionId: session.id,
        role: "event",
        content: eventMessage
      });
      broadcast({ type: "message.created", data: created });
    }
  }

  if (message.method === "item/completed" && session) {
    const eventMessage = summarizeItemEvent("completed", params);
    if (eventMessage) {
      const created = store.addMessage({
        sessionId: session.id,
        role: "event",
        content: eventMessage
      });
      broadcast({ type: "message.created", data: created });
    }
  }

  broadcast({
    type: "codex.event",
    data: {
      sessionId: session?.id,
      method: message.method,
      params
    }
  });
}

function handleCodexServerRequest(message: JsonRpcMessage) {
  const params = message.params ?? {};
  const threadId = threadIdFromParams(params);
  const session = store.findSessionByThreadId(threadId);

  if (message.id === undefined || !message.method) return;

  const approvalMethods = new Set([
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
    "item/permissions/requestApproval",
    "item/tool/requestUserInput"
  ]);

  if (!approvalMethods.has(message.method)) {
    codex.respondError(message.id, `Unsupported server request: ${message.method}`);
    return;
  }

  const itemId = typeof params.itemId === "string" ? params.itemId : undefined;
  const cachedItem = itemId ? itemCache.get(itemId) : undefined;
  const approvalParams = cachedItem ? { ...params, item: cachedItem } : params;

  const approval = store.createApproval({
    codexRequestId: message.id,
    method: message.method,
    params: approvalParams,
    sessionId: session?.id
  });

  if (session) {
    const updated = store.updateSession(session.id, { status: "waiting-approval" });
    if (updated) broadcast({ type: "session.updated", data: updated });
  }

  broadcast({ type: "approval.created", data: approval });
}

function summarizeItemEvent(kind: "started" | "completed", params: Record<string, unknown>) {
  const item = params.item;
  if (!item || typeof item !== "object") return undefined;
  const type = "type" in item && typeof item.type === "string" ? item.type : undefined;

  if (type === "commandExecution") {
    const command = "command" in item ? item.command : undefined;
    const status = "status" in item ? String(item.status) : kind;
    const commandText = Array.isArray(command) ? command.join(" ") : typeof command === "string" ? command : "";
    return commandText ? `Command ${status}: ${commandText}` : undefined;
  }

  if (type === "fileChange") {
    const status = "status" in item ? String(item.status) : kind;
    return `File change ${status}`;
  }

  return undefined;
}

function responseForApproval(
  method: string,
  params: Record<string, unknown>,
  body: {
    decision?: ApprovalDecision;
    answers?: Record<string, { answers: string[] }>;
  }
): JsonObject {
  if (method === "item/tool/requestUserInput") {
    if (!body.answers) throw new Error("answers is required for requestUserInput");
    return { answers: body.answers as unknown as JsonValue };
  }

  if (method === "item/permissions/requestApproval") {
    if (!body.decision) throw new Error("decision is required for permission approvals");
    if (body.decision === "accept" || body.decision === "acceptForSession") {
      return {
        permissions: (params.permissions ?? {}) as JsonValue,
        scope: body.decision === "acceptForSession" ? "session" : "turn"
      };
    }
    return {
      permissions: {
        fileSystem: null,
        network: null
      },
      scope: "turn"
    };
  }

  if (!body.decision) throw new Error("decision is required for this approval");
  return { decision: body.decision };
}

function summarizeAnswers(answers?: Record<string, { answers: string[] }>) {
  if (!answers) return undefined;
  return Object.entries(answers)
    .map(([key, value]) => `${key}: ${value.answers.join(", ")}`)
    .join("; ");
}

function snapshotEvent(): GatewayEvent {
  return {
    type: "snapshot",
    data: {
      projects: config.projects,
      sessions: store.listSessions(),
      approvals: store.listPendingApprovals()
    }
  };
}

function broadcast(event: GatewayEvent) {
  const payload = JSON.stringify(event);
  for (const client of clients) {
    client.send(payload);
  }
}

function isAuthorized(request: FastifyRequest) {
  const header = request.headers.authorization;
  const bearer = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
  const explicitHeader = request.headers["x-cmc-token"];
  const queryToken =
    request.query && typeof request.query === "object" && "token" in request.query
      ? String(request.query.token)
      : undefined;
  const token = bearer ?? (Array.isArray(explicitHeader) ? explicitHeader[0] : explicitHeader) ?? queryToken;
  return typeof token === "string" && timingSafeEqualText(token, deviceToken);
}

function readableError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
