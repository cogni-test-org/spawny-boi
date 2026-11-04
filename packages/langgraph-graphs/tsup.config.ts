// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/langgraph-graphs/tsup.config`
 * Purpose: Build configuration for langgraph-graphs package.
 * Scope: Build tooling only; does not contain runtime code.
 * Invariants: Output must be ESM with type declarations. Multi-entry for subpaths.
 * Side-effects: IO
 * Links: docs/spec/langgraph-patterns.md
 * @internal
 */

import { defineConfig } from "tsup";

export const tsupConfig = defineConfig({
  entry: [
    "src/index.ts",
    "src/runtime/index.ts",
    "src/graphs/index.ts",
    "src/inproc/index.ts",
  ],
  format: ["esm"],
  dts: {
    resolve: ["@cogni/ai-core"],
    compilerOptions: { composite: false, incremental: false },
  },
  outDir: "dist/bundled", // tsc owns dist/*.d.ts; preserve these normal bundled declarations.
  clean: false, // preserve .d.ts files from tsc -b (incremental builds)
  sourcemap: true,
  platform: "node", // LangChain requires Node.js
  external: ["@langchain/core", "@langchain/langgraph", "@cogni/ai-tools", "zod"],
  // RUNTIME_LEAF_ON_AI_CORE: the few ai-core runtime helpers this package calls (error codes,
  // tool-runner) are bundled in. A node's vendored @cogni/ai-core dist is tsc output with
  // extensionless imports, which plain Node ESM (vitest externals, scripts) cannot load from
  // inside node_modules. Its structural types are bundled into public declarations.
  noExternal: [/^@cogni\/ai-core/],
});

export default tsupConfig;
