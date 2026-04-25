import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.zylen.codexconsole",
  appName: "Codex Console",
  webDir: "dist/mobile",
  server: {
    cleartext: true
  }
};

export default config;
