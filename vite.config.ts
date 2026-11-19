import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  worker: {
    format: "es",
  },
  optimizeDeps: {
    exclude: ["pyodide"],
  },
  server: {
    port: 5178,
    open: false,
  },
  build: {
    target: "es2022",
  },
});
