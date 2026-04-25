# Architecture

```text
Android PWA / iPad browser
        |
        | HTTPS/WebSocket over Tailscale
        v
Codex Mobile Console Gateway
        |
        | JSONL stdio
        v
codex app-server
        |
        v
Local Codex runtime
```

## Gateway Responsibilities

- owns the device token
- loads project allowlist
- creates and resumes Codex threads
- persists local mobile session metadata in `.data/state.json`
- broadcasts Codex notifications to connected mobile clients
- converts app-server server requests into mobile approval records

## Why stdio

`codex app-server` supports WebSocket transport, but the official docs mark it as experimental and unsupported for remote exposure. This project keeps app-server on stdio and only exposes the smaller Gateway API.

## Data Model

```text
Project
  id
  name
  path
  defaultModel
  defaultSandbox
  defaultApprovalPolicy

Session
  id
  projectId
  codexThreadId
  title
  status
  activeTurnId

Message
  id
  sessionId
  role
  content
  itemId
  turnId

Approval
  id
  sessionId
  codexRequestId
  method
  params
  status
  decision
```

## Security Boundary

The Gateway is not a general shell server. It only starts/resumes Codex threads inside allowlisted project paths, then relies on Codex app-server approval flow for command execution and file changes.
