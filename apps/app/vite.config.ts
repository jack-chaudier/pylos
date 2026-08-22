import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const port = Number(process.env.PYLOS_UI_PORT ?? 1420);

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  // Hosted, the app is served under /app/ beside the landing page. The Tauri
  // shell serves the same dist at the root of tauri://localhost, so the desktop
  // build overrides this with `vite build --base=/` (see `build:desktop`).
  base: "/app/",
  server: {
    port,
    strictPort: true,
    host: "127.0.0.1",
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    target: "es2022",
    sourcemap: true,
    chunkSizeWarningLimit: 900,
  },
});
