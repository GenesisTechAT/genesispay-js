import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["packages/*/src/**/*.test.ts"],
  },
  resolve: {
    alias: {
      // Resolve workspace packages from source so tests do not depend on a
      // prior `npm run build` dist output.
      "@genesis-tech/peerpay-protocol": path.resolve(
        __dirname,
        "packages/protocol/src/index.ts",
      ),
      "@genesis-tech/peerpay-agent": path.resolve(
        __dirname,
        "packages/agent-sdk/src/index.ts",
      ),
      "@genesis-tech/peerpay-seller": path.resolve(
        __dirname,
        "packages/seller-sdk/src/index.ts",
      ),
    },
  },
});
