import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 5173,
    watch: {
      // More stable on Windows when editors/antivirus lock files briefly.
      usePolling: true,
      interval: 150,
      awaitWriteFinish: {
        stabilityThreshold: 250,
        pollInterval: 100,
      },
    },
  },
});
