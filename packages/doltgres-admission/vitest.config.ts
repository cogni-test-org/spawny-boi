// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { defineProject } from "vitest/config";
export default defineProject({
  test: {
    name: "doltgres-admission",
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
