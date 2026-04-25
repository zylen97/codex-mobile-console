import crypto from "node:crypto";
import fs from "node:fs";
import { dataDir, tokenPath } from "./paths.js";

export function getOrCreateDeviceToken(): string {
  if (process.env.CMC_TOKEN?.trim()) {
    return process.env.CMC_TOKEN.trim();
  }

  fs.mkdirSync(dataDir, { recursive: true });
  if (fs.existsSync(tokenPath)) {
    return fs.readFileSync(tokenPath, "utf8").trim();
  }

  const token = crypto.randomBytes(24).toString("base64url");
  fs.writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
  return token;
}

export function timingSafeEqualText(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}
