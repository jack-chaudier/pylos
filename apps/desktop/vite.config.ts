import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const port = Number(process.env.PYLOS_UI_PORT ?? 1420);

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
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
