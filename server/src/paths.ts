import path from "node:path";

export const projectRoot = process.cwd();
export const dataDir = path.join(projectRoot, ".data");
export const statePath = path.join(dataDir, "state.json");
export const tokenPath = path.join(dataDir, "device-token.txt");
export const projectsConfigPath = path.join(projectRoot, "config", "projects.json");
export const mobileDistPath = path.join(projectRoot, "dist", "mobile");
