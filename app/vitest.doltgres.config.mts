// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Isolated real-Doltgres acceptance lane; never shares the Postgres setup. */

import path from "node:path";
import { fileURLToPath } from "node:url";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
	root: __dirname,
	plugins: [tsconfigPaths({ projects: ["./tsconfig.test.json"] })],
	test: {
		include: ["tests/component/db/doltgres-*.int.test.ts"],
		environment: "node",
		setupFiles: ["./tests/setup.ts"],
		sequence: { concurrent: false },
		testTimeout: 120_000,
		hookTimeout: 180_000,
	},
	resolve: {
		alias: {
			"@tests": path.resolve(__dirname, "./tests"),
		},
	},
});
