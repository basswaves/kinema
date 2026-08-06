import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  // guessit-js reads process.env.DEBUG_* debug flags, which do not exist in a
  // webview — the bare reference throws "process is not defined" on the first
  // parse. It is only ever read for those flags (no other process usage in the
  // bundle), so an empty object is a complete substitute.
  //
  // Must be `{}` and not `({})`: esbuild requires a define value to be a JS
  // literal or an entity name and rejects the parenthesised form outright with
  // "Invalid define value". `vite dev` never validates it, so the parenthesised
  // version worked in development while `vite build` — and therefore
  // `tauri build` — could not produce a bundle at all.
  define: {
    'process.env': '{}',
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
