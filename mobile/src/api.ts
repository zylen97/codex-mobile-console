import type { ApprovalDecision } from "./types";

export function defaultGatewayUrl() {
  if (location.port === "8787") return location.origin;
  return `${location.protocol}//${location.hostname}:8787`;
}

export class GatewayApi {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string
  ) {}

  websocketUrl() {
    const url = new URL(this.baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/ws";
    url.searchParams.set("token", this.token);
    return url.toString();
  }

  async status() {
    return this.request("/api/status");
  }

  async projects() {
    return this.request("/api/projects");
  }

  async createSession(projectId: string, title?: string) {
    return this.request(`/api/projects/${encodeURIComponent(projectId)}/sessions`, {
      method: "POST",
      body: JSON.stringify({ title })
    });
  }

  async session(sessionId: string) {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}`);
  }

  async sendMessage(sessionId: string, text: string) {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
      method: "POST",
      body: JSON.stringify({ text })
    });
  }

  async decide(approvalId: string, decision: ApprovalDecision) {
    return this.request(`/api/approvals/${encodeURIComponent(approvalId)}`, {
      method: "POST",
      body: JSON.stringify({ decision })
    });
  }

  async answerUserInput(approvalId: string, answers: Record<string, { answers: string[] }>) {
    return this.request(`/api/approvals/${encodeURIComponent(approvalId)}`, {
      method: "POST",
      body: JSON.stringify({ answers })
    });
  }

  private async request(path: string, init: RequestInit = {}) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.token}`,
        ...(init.headers ?? {})
      }
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error ?? `Request failed: ${response.status}`);
    }
    return payload;
  }
}
