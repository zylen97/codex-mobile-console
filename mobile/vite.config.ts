import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "mobile",
  plugins: [react()],
  build: {
    outDir: "../dist/mobile",
    emptyOutDir: true
  },
  server: {
    port: 5178,
    strictPort: true
  }
});
