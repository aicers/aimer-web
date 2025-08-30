// vitest.config.ts
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  esbuild: {
    jsx: "automatic",
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    include: ["__tests__/**/*.test.tsx"],
    // Force single-threaded runs to avoid worker kill issues (EPERM)
    pool: "threads",
    poolOptions: {
      threads: {
        singleThread: true,
      },
    },
  },
});
