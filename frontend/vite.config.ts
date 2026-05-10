/// <reference types="vitest" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: "./src/test-setup.ts",
    include: ["src/**/*.test.tsx", "src/**/*.test.ts", "src/**/*.spec.tsx", "src/**/*.spec.ts"],
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:8000",
      "/health": "http://localhost:8000",
      "/resumes": "http://localhost:8000",
      "/jobs": "http://localhost:8000",
      "/settings": "http://localhost:8000",
    },
  },
});
