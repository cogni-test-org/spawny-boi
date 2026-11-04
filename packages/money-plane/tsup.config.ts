// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni-dao/money-plane/tsup.config`
 * Purpose: Build configuration for the money-plane package: the pure entry and the React subpath.
 * Scope: Build tooling only; does not contain runtime code.
 * Invariants: ESM, platform-neutral. React stays external (peer). The react entry keeps its "use client" directive
 *   as a banner so Next.js treats the built file as a client module. tsc -b emits the declarations (dts: false here).
 * Side-effects: IO
 * Links: .github/workflows/publish-packages.yml
 * @internal
 */

import { defineConfig } from "tsup";

export const tsupConfig = defineConfig([
  {
    entry: { index: "src/index.ts" },
    format: ["esm"],
    dts: false,
    clean: false,
    sourcemap: true,
    platform: "neutral",
  },
  {
    entry: { "react/index": "src/react/index.ts" },
    format: ["esm"],
    dts: false,
    clean: false,
    sourcemap: true,
    platform: "neutral",
    external: ["react", "react/jsx-runtime"],
    banner: { js: '"use client";' },
  },
]);

// biome-ignore lint/style/noDefaultExport: required by tsup
export default tsupConfig;
