// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni-dao/money-plane/vitest.config`
 * Purpose: Vitest configuration for money-plane package tests.
 * Scope: Package-local tests only; does not import from app src/.
 * Invariants: Tests import only from ../src; no network (every read uses an injected fake fetch).
 * Side-effects: none
 * Links: tests/
 * @internal
 */

import { defineProject } from "vitest/config";

// biome-ignore lint/style/noDefaultExport: required by vitest
export default defineProject({
  test: {
    name: "money-plane",
    globals: true,
    environment: "node",
    include: ["tests/**/*.{test,spec}.ts"],
    exclude: ["node_modules", "dist"],
  },
});
