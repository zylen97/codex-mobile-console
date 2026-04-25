import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { projectRoot, projectsConfigPath } from "./paths.js";
import type { GatewayConfig } from "./types.js";

const projectSchema = z.object({
  id: z.string().min(2).regex(/^[a-zA-Z0-9._-]+$/),
  name: z.string().min(1),
  path: z.string().min(1),
  description: z.string().optional(),
  defaultModel: z.string().optional(),
  defaultSandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]).default("workspace-write"),
  defaultApprovalPolicy: z.enum(["untrusted", "on-request", "never"]).default("on-request")
});

const configSchema = z.object({
  projects: z.array(projectSchema).default([])
});

export function loadGatewayConfig(): GatewayConfig {
  const raw = fs.existsSync(projectsConfigPath)
    ? JSON.parse(fs.readFileSync(projectsConfigPath, "utf8"))
    : {
        projects: [
          {
            id: "codex-mobile-console",
            name: "Codex Mobile Console",
            path: projectRoot,
            description: "Default local project. Create config/projects.json to add your own projects.",
            defaultModel: "gpt-5.4",
            defaultSandbox: "workspace-write",
            defaultApprovalPolicy: "on-request"
          }
        ]
      };
  const parsed = configSchema.parse(raw);

  const seen = new Set<string>();
  const projects = parsed.projects.map((project) => {
    if (seen.has(project.id)) {
      throw new Error(`Duplicate project id in config/projects.json: ${project.id}`);
    }
    seen.add(project.id);

    const absolutePath = path.resolve(project.path);
    if (!fs.existsSync(absolutePath)) {
      throw new Error(`Project path does not exist: ${absolutePath}`);
    }

    return {
      ...project,
      path: absolutePath
    };
  });

  return { projects };
}
