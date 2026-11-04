// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/graph-execution-host/tsup.config`
 * Purpose: Build configuration for graph-execution-host package.
 * Scope: Build tooling only. Does not contain runtime code.
 * Invariants: Output must be ESM with sourcemaps.
 * Side-effects: IO
 * Links: docs/spec/packages-architecture.md
 * @internal
 */

import { defineConfig } from "tsup";

export const tsupConfig = defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: false,
  clean: false,
  sourcemap: true,
  // This package transitively reaches node:crypto (the trace-scrubbing helpers
  // hash content), so it builds for node. Under "neutral" esbuild cannot
  // resolve the builtin once the workspace closure is bundled:
  // `Could not resolve "crypto"`. `platform: "node"` also keeps builtins
  // external in the tarball, which is what a consumer wants.
  platform: "node",
  // Bundle the workspace closure so the published tarball is a dependency
  // leaf: a consumer installs one artifact, not a graph of unpublished
  // @cogni/* packages. Everything reached is pure — ai-core and
  // graph-execution-core are types and constants, and the only node-shared
  // imports are its two pure subpaths.
  noExternal: [/^@cogni\//],
});

export default tsupConfig;
