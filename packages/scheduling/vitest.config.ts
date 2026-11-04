// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
import { defineConfig } from "vitest/config";

// biome-ignore lint/style/noDefaultExport: build tool configuration entrypoint
export default defineConfig({
  test: { environment: "node", include: ["tests/**/*.test.ts"] },
});
