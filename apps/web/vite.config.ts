import { defineConfig } from "vite";

export default defineConfig({
  appType: "mpa",
  build: {
    target: "es2022",
    cssTarget: "safari16",
    assetsInlineLimit: 2048,
    modulePreload: { polyfill: false },
    reportCompressedSize: true,
    rollupOptions: {
      output: {
        // one page, one script: an extra request buys nothing here
        manualChunks: undefined,
      },
    },
  },
});
