import {
  Activity,
  Check,
  ChevronRight,
  ClipboardCheck,
  FolderGit2,
  MessageSquarePlus,
  RefreshCcw,
  Send,
  Settings,
  ShieldCheck,
  Smartphone,
  Terminal,
  X
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { defaultGatewayUrl, GatewayApi } from "./api";
import type {
  ApprovalDecision,
  ApprovalRecord,
  ConsoleMessage,
  ConsoleSession,
  GatewayEvent,
  ProjectConfig,
  Snapshot
} from "./types";

type MobilePanel = "projects" | "chat" | "approvals";

const savedBase = localStorage.getItem("cmc.gatewayUrl") ?? defaultGatewayUrl();
const savedToken = localStorage.getItem("cmc.token") ?? "";

export function App() {
  const [gatewayUrl, setGatewayUrl] = useState(savedBase);
  const [token, setToken] = useState(savedToken);
  const [draftGatewayUrl, setDraftGatewayUrl] = useState(savedBase);
  const [draftToken, setDraftToken] = useState(savedToken);
  const [projects, setProjects] = useState<ProjectConfig[]>([]);
  const [sessions, setSessions] = useState<ConsoleSession[]>([]);
  const [messages, setMessages] = useState<ConsoleMessage[]>([]);
  const [approvals, setApprovals] = useState<ApprovalRecord[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string>();
  const [selectedSessionId, setSelectedSessionId] = useState<string>();
  const [prompt, setPrompt] = useState("");
  const [sessionTitle, setSessionTitle] = useState("");
  const [error, setError] = useState<string>();
  const [connected, setConnected] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(!savedToken);
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>("chat");
  const selectedSessionRef = useRef<string | undefined>(selectedSessionId);

  const api = useMemo(() => new GatewayApi(gatewayUrl.replace(/\/$/, ""), token.trim()), [gatewayUrl, token]);
  const authorized = token.trim().length > 0;
  const selectedProject = projects.find((project) => project.id === selectedProjectId);
  const projectSessions = sessions.filter((session) => session.projectId === selectedProjectId);
  const selectedSession = sessions.find((session) => session.id === selectedSessionId);
  const selectedApprovals = approvals.filter(
    (approval) => approval.status === "pending" && (!selectedSessionId || approval.sessionId === selectedSessionId)
  );

  useEffect(() => {
    selectedSessionRef.current = selectedSessionId;
  }, [selectedSessionId]);

  useEffect(() => {
    if (!authorized) return;
    void refreshSnapshot();
  }, [authorized, gatewayUrl, token]);

  useEffect(() => {
    if (!authorized) return;

    const ws = new WebSocket(api.websocketUrl());
    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onerror = () => setConnected(false);
    ws.onmessage = (event) => {
      const parsed = JSON.parse(event.data) as GatewayEvent;
      applyGatewayEvent(parsed);
    };

    return () => ws.close();
  }, [api, authorized]);

  useEffect(() => {
    if (!selectedSessionId || !authorized) {
      setMessages([]);
      return;
    }
    void loadSession(selectedSessionId);
  }, [selectedSessionId, authorized]);

  async function refreshSnapshot() {
    try {
      setError(undefined);
      const payload = (await api.projects()) as Snapshot;
      setProjects(payload.projects);
      setSessions(payload.sessions);
      setApprovals(payload.approvals);

      const projectId = selectedProjectId ?? payload.projects[0]?.id;
      if (projectId) setSelectedProjectId(projectId);

      const firstSession =
        selectedSessionId ??
        payload.sessions.find((session) => session.projectId === projectId)?.id ??
        payload.sessions[0]?.id;
      if (firstSession) setSelectedSessionId(firstSession);
    } catch (err) {
      setError(readableError(err));
    }
  }

  async function loadSession(sessionId: string) {
    try {
      const payload = (await api.session(sessionId)) as {
        session: ConsoleSession;
        messages: ConsoleMessage[];
        approvals: ApprovalRecord[];
      };
      mergeSession(payload.session);
      setMessages(payload.messages);
      setApprovals((current) => mergeApprovals(current, payload.approvals));
    } catch (err) {
      setError(readableError(err));
    }
  }

  async function createSession() {
    if (!selectedProject) return;
    try {
      setError(undefined);
      const payload = (await api.createSession(selectedProject.id, sessionTitle.trim() || undefined)) as {
        session: ConsoleSession;
      };
      mergeSession(payload.session);
      setSelectedSessionId(payload.session.id);
      setSessionTitle("");
      setMobilePanel("chat");
    } catch (err) {
      setError(readableError(err));
    }
  }

  async function sendPrompt() {
    if (!selectedSession || !prompt.trim()) return;
    const text = prompt.trim();
    setPrompt("");
    try {
      setError(undefined);
      await api.sendMessage(selectedSession.id, text);
    } catch (err) {
      setPrompt(text);
      setError(readableError(err));
    }
  }

  async function decide(approval: ApprovalRecord, decision: ApprovalDecision) {
    try {
      setError(undefined);
      await api.decide(approval.id, decision);
      setApprovals((current) =>
        current.map((item) => (item.id === approval.id ? { ...item, status: "resolved", decision } : item))
      );
    } catch (err) {
      setError(readableError(err));
    }
  }

  async function answerUserInput(approval: ApprovalRecord, answers: Record<string, { answers: string[] }>) {
    try {
      setError(undefined);
      await api.answerUserInput(approval.id, answers);
      setApprovals((current) =>
        current.map((item) =>
          item.id === approval.id
            ? {
                ...item,
                status: "resolved",
                answerSummary: Object.entries(answers)
                  .map(([key, value]) => `${key}: ${value.answers.join(", ")}`)
                  .join("; ")
              }
            : item
        )
      );
    } catch (err) {
      setError(readableError(err));
    }
  }

  function saveSettings() {
    const base = draftGatewayUrl.replace(/\/$/, "");
    const nextToken = draftToken.trim();
    localStorage.setItem("cmc.gatewayUrl", base);
    localStorage.setItem("cmc.token", nextToken);
    setGatewayUrl(base);
    setToken(nextToken);
    setSettingsOpen(false);
  }

  function applyGatewayEvent(event: GatewayEvent) {
    if (event.type === "snapshot") {
      const snapshot = event.data as Snapshot;
      setProjects(snapshot.projects);
      setSessions(snapshot.sessions);
      setApprovals(snapshot.approvals);
      if (!selectedProjectId && snapshot.projects[0]) setSelectedProjectId(snapshot.projects[0].id);
      return;
    }

    if (event.type === "session.updated") {
      mergeSession(event.data as ConsoleSession);
      return;
    }

    if (event.type === "message.created" || event.type === "message.updated") {
      const message = event.data as ConsoleMessage;
      if (message.sessionId === selectedSessionRef.current) mergeMessage(message);
      return;
    }

    if (event.type === "approval.created" || event.type === "approval.updated") {
      const approval = event.data as ApprovalRecord;
      setApprovals((current) => mergeApprovals(current, [approval]));
    }
  }

  function mergeSession(session: ConsoleSession) {
    setSessions((current) => {
      const exists = current.some((item) => item.id === session.id);
      return exists
        ? current.map((item) => (item.id === session.id ? session : item))
        : [session, ...current];
    });
  }

  function mergeMessage(message: ConsoleMessage) {
    setMessages((current) => {
      const exists = current.some((item) => item.id === message.id);
      return exists
        ? current.map((item) => (item.id === message.id ? message : item))
        : [...current, message];
    });
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <Smartphone size={20} />
          <div>
            <strong>Codex Console</strong>
            <span>{connected ? "已连接" : "未连接"}</span>
          </div>
        </div>
        <div className="topbar-actions">
          <button className="icon-button" title="刷新" onClick={() => void refreshSnapshot()}>
            <RefreshCcw size={18} />
          </button>
          <button className="icon-button" title="设置" onClick={() => setSettingsOpen(true)}>
            <Settings size={18} />
          </button>
        </div>
      </header>

      {error && (
        <div className="error-bar">
          <span>{error}</span>
          <button className="plain-icon" onClick={() => setError(undefined)} title="关闭">
            <X size={16} />
          </button>
        </div>
      )}

      <main className="workspace">
        <aside className={`panel project-panel ${mobilePanel === "projects" ? "mobile-visible" : ""}`}>
          <PanelTitle icon={<FolderGit2 size={17} />} title="Projects" />
          <div className="project-list">
            {projects.map((project) => (
              <button
                key={project.id}
                className={`project-row ${project.id === selectedProjectId ? "selected" : ""}`}
                onClick={() => {
                  setSelectedProjectId(project.id);
                  const nextSession = sessions.find((session) => session.projectId === project.id);
                  setSelectedSessionId(nextSession?.id);
                  setMobilePanel("chat");
                }}
              >
                <span>
                  <strong>{project.name}</strong>
                  <small>{project.path}</small>
                </span>
                <ChevronRight size={16} />
              </button>
            ))}
          </div>

          <div className="session-create">
            <input
              value={sessionTitle}
              onChange={(event) => setSessionTitle(event.target.value)}
              placeholder="新 session 标题"
            />
            <button className="primary-button" onClick={() => void createSession()} disabled={!selectedProject}>
              <MessageSquarePlus size={16} />
              新建
            </button>
          </div>

          <PanelTitle icon={<Activity size={17} />} title="Sessions" />
          <div className="session-list">
            {projectSessions.map((session) => (
              <button
                key={session.id}
                className={`session-row ${session.id === selectedSessionId ? "selected" : ""}`}
                onClick={() => {
                  setSelectedSessionId(session.id);
                  setMobilePanel("chat");
                }}
              >
                <span className={`status-dot ${session.status}`} />
                <span>
                  <strong>{session.title}</strong>
                  <small>{session.status}</small>
                </span>
              </button>
            ))}
          </div>
        </aside>

        <section className={`panel chat-panel ${mobilePanel === "chat" ? "mobile-visible" : ""}`}>
          <div className="chat-header">
            <div>
              <h1>{selectedSession?.title ?? "选择或新建一个 session"}</h1>
              <p>{selectedProject?.name ?? "No project selected"}</p>
            </div>
            <span className={`session-pill ${selectedSession?.status ?? "idle"}`}>{selectedSession?.status ?? "idle"}</span>
          </div>

          <div className="message-list">
            {!selectedSession && (
              <div className="empty-state">
                <Terminal size={28} />
                <strong>先选一个项目，然后新建 session</strong>
                <span>每个 session 会绑定一个 Codex thread，可以之后继续恢复。</span>
              </div>
            )}

            {messages.map((message) => (
              <article key={message.id} className={`message ${message.role}`}>
                <div className="message-meta">
                  <span>{message.role === "assistant" ? "Codex" : message.role === "user" ? "你" : "Event"}</span>
                  {message.status === "streaming" && <small>streaming</small>}
                </div>
                <p>{message.content}</p>
              </article>
            ))}
          </div>

          <div className="composer">
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="给 Codex 发任务..."
              rows={3}
              disabled={!selectedSession}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                  void sendPrompt();
                }
              }}
            />
            <button className="send-button" onClick={() => void sendPrompt()} disabled={!selectedSession || !prompt.trim()}>
              <Send size={18} />
            </button>
          </div>
        </section>

        <aside className={`panel approval-panel ${mobilePanel === "approvals" ? "mobile-visible" : ""}`}>
          <PanelTitle icon={<ClipboardCheck size={17} />} title="Approvals" />
          {selectedApprovals.length === 0 && (
            <div className="quiet-state">
              <ShieldCheck size={22} />
              <span>暂无待审批操作</span>
            </div>
          )}
          <div className="approval-list">
            {selectedApprovals.map((approval) => (
              <ApprovalCard
                key={approval.id}
                approval={approval}
                onDecide={decide}
                onAnswerUserInput={answerUserInput}
              />
            ))}
          </div>
        </aside>
      </main>

      <nav className="mobile-tabs">
        <button className={mobilePanel === "projects" ? "active" : ""} onClick={() => setMobilePanel("projects")}>
          <FolderGit2 size={18} />
          项目
        </button>
        <button className={mobilePanel === "chat" ? "active" : ""} onClick={() => setMobilePanel("chat")}>
          <Terminal size={18} />
          会话
        </button>
        <button className={mobilePanel === "approvals" ? "active" : ""} onClick={() => setMobilePanel("approvals")}>
          <ClipboardCheck size={18} />
          审批
        </button>
      </nav>

      {settingsOpen && (
        <div className="modal-backdrop">
          <div className="settings-modal">
            <h2>连接 Gateway</h2>
            <label>
              Gateway URL
              <input value={draftGatewayUrl} onChange={(event) => setDraftGatewayUrl(event.target.value)} />
            </label>
            <label>
              Device Token
              <input value={draftToken} onChange={(event) => setDraftToken(event.target.value)} type="password" />
            </label>
            <div className="modal-actions">
              {authorized && (
                <button className="secondary-button" onClick={() => setSettingsOpen(false)}>
                  取消
                </button>
              )}
              <button className="primary-button" onClick={saveSettings}>
                <Check size={16} />
                保存
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function PanelTitle({ icon, title }: { icon: React.ReactNode; title: string }) {
  return (
    <div className="panel-title">
      {icon}
      <span>{title}</span>
    </div>
  );
}

function ApprovalCard({
  approval,
  onDecide,
  onAnswerUserInput
}: {
  approval: ApprovalRecord;
  onDecide: (approval: ApprovalRecord, decision: ApprovalDecision) => Promise<void>;
  onAnswerUserInput: (approval: ApprovalRecord, answers: Record<string, { answers: string[] }>) => Promise<void>;
}) {
  const summary = summarizeApproval(approval);
  const questions = getUserInputQuestions(approval);
  const [answers, setAnswers] = useState<Record<string, string>>(() =>
    Object.fromEntries(questions.map((question) => [question.id, question.options?.[0]?.label ?? ""]))
  );

  if (questions.length > 0) {
    return (
      <article className="approval-card">
        <div className="approval-head">
          <strong>需要补充信息</strong>
          <span>{approval.method.replace("item/", "")}</span>
        </div>
        <div className="question-list">
          {questions.map((question) => (
            <label key={question.id} className="question-block">
              <span>{question.question}</span>
              {question.options?.length ? (
                <select
                  value={answers[question.id] ?? question.options[0]?.label ?? ""}
                  onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))}
                >
                  {question.options.map((option) => (
                    <option key={option.label} value={option.label}>
                      {option.label}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  value={answers[question.id] ?? ""}
                  type={question.isSecret ? "password" : "text"}
                  onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))}
                />
              )}
            </label>
          ))}
        </div>
        <div className="approval-actions single">
          <button
            onClick={() =>
              void onAnswerUserInput(
                approval,
                Object.fromEntries(
                  questions.map((question) => [question.id, { answers: [answers[question.id] ?? ""] }])
                )
              )
            }
            className="approve-button"
          >
            <Check size={15} />
            提交
          </button>
        </div>
      </article>
    );
  }

  return (
    <article className="approval-card">
      <div className="approval-head">
        <strong>{summary.title}</strong>
        <span>{approval.method.replace("item/", "")}</span>
      </div>
      <pre>{summary.detail}</pre>
      <div className="approval-actions">
        <button onClick={() => void onDecide(approval, "accept")} className="approve-button">
          <Check size={15} />
          一次
        </button>
        <button onClick={() => void onDecide(approval, "acceptForSession")} className="session-button">
          <ShieldCheck size={15} />
          本会话
        </button>
        <button onClick={() => void onDecide(approval, "decline")} className="decline-button">
          <X size={15} />
          拒绝
        </button>
      </div>
    </article>
  );
}

function summarizeApproval(approval: ApprovalRecord) {
  const params = approval.params as Record<string, unknown>;
  if (approval.method.includes("permissions")) {
    return {
      title: "权限扩展",
      detail: JSON.stringify(
        {
          reason: params.reason,
          permissions: params.permissions
        },
        null,
        2
      )
    };
  }

  if (approval.method.includes("commandExecution")) {
    const command = params.command;
    const detail = Array.isArray(command)
      ? command.join(" ")
      : typeof command === "string"
        ? command
        : JSON.stringify(params, null, 2);
    return { title: "命令执行", detail };
  }

  if (approval.method.includes("fileChange")) {
    const item = params.item as { changes?: Array<{ path?: string; kind?: string; diff?: string }> } | undefined;
    const changes = item?.changes?.map((change) => ({
      path: change.path,
      kind: change.kind,
      diffPreview: change.diff?.slice(0, 1200)
    }));
    return {
      title: "文件修改",
      detail: JSON.stringify(
        {
          reason: params.reason,
          grantRoot: params.grantRoot,
          itemId: params.itemId,
          changes
        },
        null,
        2
      )
    };
  }

  return { title: "权限请求", detail: JSON.stringify(params, null, 2) };
}

function getUserInputQuestions(approval: ApprovalRecord) {
  if (!approval.method.includes("tool/requestUserInput")) return [];
  const params = approval.params as {
    questions?: Array<{
      id: string;
      question: string;
      header?: string;
      isSecret?: boolean;
      options?: Array<{ label: string; description: string }> | null;
    }>;
  };
  return Array.isArray(params.questions) ? params.questions : [];
}

function mergeApprovals(current: ApprovalRecord[], incoming: ApprovalRecord[]) {
  const byId = new Map(current.map((approval) => [approval.id, approval]));
  for (const approval of incoming) byId.set(approval.id, approval);
  return Array.from(byId.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function readableError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
