// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/ai-tools/tsup.config`
 * Purpose: Build configuration for ai-tools package.
 * Scope: Build tooling only; does not contain runtime code.
 * Invariants: Output must be ESM with type declarations.
 * Side-effects: IO
 * Links: docs/spec/langgraph-patterns.md
 * @internal
 */

import { defineConfig } from "tsup";

export const tsupConfig = defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: {
    resolve: ["@cogni/ai-core"],
    compilerOptions: { composite: false, incremental: false },
  },
  outDir: "dist/bundled", // tsc owns dist/*.d.ts; preserve these normal bundled declarations.
  clean: false, // preserve .d.ts files from tsc -b (incremental builds)
  sourcemap: true,
  platform: "neutral",
});

export default tsupConfig;
