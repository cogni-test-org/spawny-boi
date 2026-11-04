// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Real Doltgres 0.57.3 acceptance for the deployed work-item mutation flow.
 *
 * node-template owns `@cogni/work-items`' Doltgres adapter, so the real-engine
 * proof belongs here rather than only in a fork (task.5199). Fake-SQL unit
 * tests cannot see Dolt branch semantics; bug.5358 shipped green against them.
 */

import { execFileSync, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
	toWorkItemId,
	rankScore,
	compareWorkItems,
	normalizeWorkItemOrder,
	WORK_ITEM_SORT_FIELDS,
	WORK_ITEM_SORT_DIRECTIONS,
	type WorkItem,
} from "@cogni/work-items";
import { rankScoreSql } from "../../../../packages/work-items/src/rank-policy";
import { acquireDoltWriterLocks } from "@cogni-dao/doltgres-admission";
import postgres, { type Sql } from "postgres";
import {
	DoltBranchSessionRunner,
	DoltgresKnowledgeStoreAdapter,
	DoltgresKnowledgeContributionAdapter,
} from "@cogni/knowledge-store/adapters/doltgres";
import {
	GenericContainer,
	type StartedTestContainer,
	Wait,
} from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	DoltgresWorkItemAdapter,
	WorkItemWriteOutcomeUnknownError,
	WorkItemAuthorizationError,
	WorkItemRevisionConflictError,
	WorkItemsBusyError,
} from "@cogni/work-items/adapters/doltgres";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const MIGRATE_SCRIPT = path.resolve(
	REPO_ROOT,
	"scripts/db/migrate-doltgres.mjs",
);
const MIGRATIONS_DIR = path.resolve(
	REPO_ROOT,
	"app/src/adapters/server/db/doltgres-migrations",
);
const DOLTGRES_IMAGE = "dolthub/doltgresql:0.57.3";
const DB_NAME = "knowledge_node_template_work_items";
const PASSWORD = "doltgres";

describe("Doltgres 0.57.3 work-item acceptance", () => {
	let container: StartedTestContainer;
	let sql: Sql;
	let dbUrl: string;
	const stageLogger = {
		info: (fields: unknown, message?: string) =>
			console.info(message, JSON.stringify(fields)),
		warn: (fields: unknown, message?: string) =>
			console.warn(message, JSON.stringify(fields)),
		error: (fields: unknown, message?: string) =>
			console.error(message, JSON.stringify(fields)),
	};

	beforeAll(async () => {
		container = await new GenericContainer(DOLTGRES_IMAGE)
			.withEnvironment({ DOLTGRES_PASSWORD: PASSWORD })
			.withExposedPorts(5432)
			.withWaitStrategy(
				Wait.forLogMessage(/server (started|listening)/i, 1).withStartupTimeout(
					60_000,
				),
			)
			.start();

		const host = container.getHost();
		const port = container.getMappedPort(5432);
		const baseUrl = `postgresql://postgres:${PASSWORD}@${host}:${port}/postgres`;
		dbUrl = `postgresql://postgres:${PASSWORD}@${host}:${port}/${DB_NAME}`;
		const bootstrap = postgres(baseUrl, { max: 1, fetch_types: false });
		try {
			await bootstrap.unsafe(`CREATE DATABASE ${DB_NAME}`);
		} finally {
			await bootstrap.end({ timeout: 5 });
		}

		execFileSync(process.execPath, [MIGRATE_SCRIPT, MIGRATIONS_DIR], {
			env: {
				...process.env,
				DATABASE_URL: dbUrl,
				NODE_NAME: "node-template-work-items",
			},
			encoding: "utf8",
			stdio: "pipe",
		});
		sql = postgres(dbUrl, { max: 1, fetch_types: false });
	}, 180_000);

	afterAll(async () => {
		if (sql) await sql.end({ timeout: 5 });
		if (container) await container.stop();
	});

	it("walks NOW-backed timestamp pages once in both directions", async () => {
		// NOW() stores nanoseconds on this engine, while its text I/O exposes
		// microseconds. Literal six-digit fixtures cannot catch that mismatch.
		const expected = [
			"task.290005",
			"task.290006",
			"task.290003",
			"task.290004",
			"task.290001",
			"task.290002",
		];
		const reader = postgres(dbUrl, { max: 1, fetch_types: false });
		const adapter = new DoltgresWorkItemAdapter(sql, {
			readClient: reader,
			readConnectionBudget: 2,
			queryTimeoutMs: 5000,
			logger: stageLogger,
		});
		try {
			for (let i = 0; i < expected.length; i += 2) {
				// Each statement has one NOW value. IDs deliberately oppose time;
				// each timestamp tie must still use id ASC in either direction.
				await sql.unsafe(
					`INSERT INTO work_items (id,type,title,status,node,created_at,updated_at) VALUES ('${expected[i]}','task','${i === 4 ? "needle" : "absent"}','needs_design','timestamp-native',NOW(),NOW()),('${expected[i + 1]}','task','${i === 4 ? "needle" : "absent"}','needs_design','timestamp-native',NOW(),NOW())`
				);
			}
			const precision = await sql.unsafe(
				"SELECT id, created_at > CAST(CAST(created_at AS TEXT) AS TIMESTAMP WITH TIME ZONE) AS hidden_created_nanoseconds, updated_at > CAST(CAST(updated_at AS TEXT) AS TIMESTAMP WITH TIME ZONE) AS hidden_updated_nanoseconds FROM work_items WHERE node='timestamp-native'"
			);
			expect(
				precision.some((row) => row.hidden_created_nanoseconds === true)
			).toBe(true);
			expect(
				precision.some((row) => row.hidden_updated_nanoseconds === true)
			).toBe(true);
			for (const sortBy of ["createdAt", "updatedAt"] as const) {
				for (const sortDirection of WORK_ITEM_SORT_DIRECTIONS) {
					const ordered =
						sortDirection === "asc"
							? expected
							: [
									...expected.slice(4, 6),
									...expected.slice(2, 4),
									...expected.slice(0, 2),
								];
					const seen: string[] = [];
					let cursor: string | undefined;
					do {
						const page = await adapter.list({
							node: "timestamp-native",
							sortBy,
							sortDirection,
							limit: 1,
							...(cursor ? { cursor } : {}),
						});
						for (const item of page.items) {
							expect(
								seen,
								`${sortBy} ${sortDirection}: repeated boundary`
							).not.toContain(item.id);
							seen.push(item.id);
						}
						expect(seen.length).toBeLessThanOrEqual(expected.length);
						cursor = page.nextCursor;
					} while (cursor);
					expect(seen, `${sortBy} ${sortDirection}`).toEqual(ordered);
					const textFirst = await adapter.list({
						node: "timestamp-native",
						sortBy,
						sortDirection,
						text: "needle",
						limit: 1,
					});
					expect(textFirst.items.map((item) => item.id)).toEqual([
						"task.290001",
					]);
					expect(textFirst.pageInfo.hasMore).toBe(true);
					if (!textFirst.nextCursor) throw new Error("missing text cursor");
					const textLast = await adapter.list({
						node: "timestamp-native",
						sortBy,
						sortDirection,
						text: "needle",
						limit: 1,
						cursor: textFirst.nextCursor,
					});
					expect(textLast.items.map((item) => item.id)).toEqual([
						"task.290002",
					]);
					expect(textLast.pageInfo.hasMore).toBe(false);
				}
			}
		} finally {
			await reader.end({ timeout: 5 });
			await sql.unsafe("DELETE FROM work_items WHERE node='timestamp-native'");
		}
	});

	it("globally ranks native JSON before limiting, roundtrips every order, and measures plans at 15625 rows", async () => {
		const fixtures: {
			id: string;
			scores: Record<string, { v: number; ev?: string }> | null;
		}[] = [];
		for (let goal = 1; goal <= 5; goal++)
			for (let time = 1; time <= 5; time++)
				for (let unblocks = 1; unblocks <= 5; unblocks++)
					for (let ease = 1; ease <= 5; ease++)
						for (let confidence = 1; confidence <= 5; confidence++)
							for (let agent = 1; agent <= 5; agent++) {
								fixtures.push({
									id: `task.${100000 + fixtures.length}`,
									scores: Object.fromEntries(
										Object.entries({
											goal,
											time,
											unblocks,
											ease,
											confidence,
											agent,
										}).map(([axis, v]) => [
											axis,
											{ v, ev: "https://example.org/native-fixture" },
										]),
									),
								});
							}
		try {
		// Bounded seed batches, not 15625 version-control branch mutations.
		for (let offset = 0; offset < fixtures.length; offset += 250) {
			const batch = fixtures.slice(offset, offset + 250);
			await sql.unsafe(
				`INSERT INTO work_items (id,type,title,status,node,priority,rank,scores,created_at,updated_at) VALUES ${batch.map((f, i) => `('${f.id}','task','native rank ${f.id}','needs_implement','rank-native',${offset + i < 500 ? 0 : 4},${offset + i},'${JSON.stringify(f.scores)}'::JSONB,'2026-10-26 00:00:00.123456+00','2026-10-26 00:00:00.123456+00')`).join(",")}`,
			);
		}
		// Test the ACTUAL private policy emitter against native JSON, including every valid 5^6 combination.
		const values = await sql.unsafe(
			`SELECT id, ${rankScoreSql()} AS native_rank FROM work_items WHERE node='rank-native'`,
		);
		const expected = new Map(fixtures.map((f) => [f.id, rankScore(f.scores)]));
		for (const row of values)
			expect(Number(row.native_rank), String(row.id)).toBe(
				expected.get(String(row.id)),
			);
		expect(values).toHaveLength(15625);
		const invalids = [
			"null",
			"[]",
			"true",
			"{}",
			'{"goal":{"v":"5"}}',
			'{"goal":{"v":1e100},"agent":{"v":5}}',
		];
		const valid = fixtures[fixtures.length - 1]?.scores;
		if (!valid) throw new Error("valid fixture missing");
		for (const invalid of [0, 6, 1.5, "5", true, null, {}, []])
			invalids.push(JSON.stringify({ ...valid, goal: { v: invalid } }));
		for (const [i, json] of invalids.entries()) {
			const rows = await sql.unsafe(
				`SELECT ${rankScoreSql()} AS native_rank FROM (SELECT '${json}'::JSONB AS scores) AS historical`,
			);
			expect(rows[0]?.native_rank, `invalid fixture ${i}`).toBeNull();
		}
		// 1e1000 cannot exist in this engine's JSONB storage. Check that input
		// boundary separately rather than attributing its rejection to rank SQL.
		await expect(sql.unsafe(`SELECT '{"goal":{"v":1e1000},"agent":{"v":5}}'::JSONB`)).rejects.toThrow(/invalid input syntax for type json/);
		console.info("rank_query_native_parity", JSON.stringify({image:DOLTGRES_IMAGE,validCombinations:values.length,invalidFixtures:invalids.length,unrepresentableJsonRejected:true}));
		const queries: string[] = [];
		const readSql = postgres(dbUrl, { max: 1, fetch_types: false });
		const tracedRead = new Proxy(readSql, {
			get(target, key) {
				if (key === "unsafe")
					return (query: string) => {
						queries.push(query);
						return target.unsafe(query);
					};
				return Reflect.get(target, key);
			},
		});
		const adapter = new DoltgresWorkItemAdapter(sql, {
			readClient: tracedRead,
			readConnectionBudget: 2,
			queryTimeoutMs: 5000,
			logger: stageLogger,
		});
		try {
			const measured = async (mode: string, limit: number) => {
				const start = performance.now();
				const page = await adapter.list({ node: "rank-native", limit });
				const elapsedMs = performance.now() - start;
				console.info(
					"rank_query_native_measurement",
					JSON.stringify({
						image: DOLTGRES_IMAGE,
						datasetN: fixtures.length,
						mode,
						limit,
						elapsedMs,
						queryCount: queries.length,
					}),
				);
				expect(elapsedMs).toBeLessThan(5000);
				return page;
			};
			const firstAdapterRead = await measured("first-adapter-read-after-parity", 5);
			expect(firstAdapterRead.items.map((item) => rankScore(item.scores))).toEqual([
				15, 15, 15, 15, 15,
			]);
			const legacy = await sql.unsafe(
				"SELECT id FROM work_items WHERE node='rank-native' ORDER BY priority ASC,rank ASC LIMIT 500",
			);
			expect(legacy.map((row) => row.id)).not.toContain(firstAdapterRead.items[0]?.id);
			await measured("repeat-adapter-read", 5);
			const query = queries[0];
			if (!query) throw new Error("query missing");
			const plan = await sql.unsafe(`EXPLAIN ${query}`);
			console.info(
				"rank_query_native_explain",
				JSON.stringify({ image: DOLTGRES_IMAGE, rows: fixtures.length, plan }),
			);
			expect(plan.length).toBeGreaterThan(0);
			const all: WorkItem[] = [];
			let cursor: string | undefined;
			do {
				const page = await adapter.list({
					node: "rank-native",
					limit: 500,
					...(cursor ? { cursor } : {}),
				});
				all.push(...page.items);
				cursor = page.nextCursor;
			} while (cursor);
			expect(all).toHaveLength(15625);
			expect(new Set(all.map((item) => item.id)).size).toBe(15625);
			expect(all.map((item) => item.id)).toEqual(
				[...all]
					.sort((a, b) => compareWorkItems(a, b, normalizeWorkItemOrder()))
					.map((item) => item.id),
			);
			// Small tied/unknown shelf exercises every override and both directions without 10 full large scans.
			const ids = all
				.slice(0, 3)
				.concat(all.slice(-3))
				.map((item) => item.id);
			await sql.unsafe(
				`UPDATE work_items SET scores=NULL,priority=NULL,rank=NULL WHERE id='${ids[0]}'`,
			);
			const shelf = (await adapter.list({ ids, limit: 50 })).items;
			for (const sortBy of WORK_ITEM_SORT_FIELDS)
				for (const sortDirection of WORK_ITEM_SORT_DIRECTIONS) {
					const order = { sortBy, sortDirection };
					const seen: WorkItem[] = [];
					let next: string | undefined;
					do {
						const page = await adapter.list({
							ids,
							limit: 2,
							...order,
							...(next ? { cursor: next } : {}),
						});
						seen.push(...page.items);
						next = page.nextCursor;
					} while (next);
					expect(
						seen.map((item) => item.id),
						JSON.stringify(order),
					).toEqual(
						[...shelf]
							.sort((a, b) => compareWorkItems(a, b, order))
							.map((item) => item.id),
					);
				}
			const first = await adapter.list({ ids, limit: 1 });
			await expect(
				adapter.list({
					ids,
					limit: 1,
					sortBy: "priority",
					cursor: first.nextCursor,
				}),
			).rejects.toMatchObject({ name: "InvalidCursorError" });
			// Sparse text matches straddle multiple bounded batches, including out-of-line TEXT.
			for (let i = 0; i < 503; i++)
				await sql.unsafe(
					`INSERT INTO work_items (id,type,title,status,node,summary) VALUES ('task.${200000 + i}','task','text ${i}','needs_design','text-native','${"x".repeat(8000)} ${i === 8 || i === 502 ? "needle" : "absent"}')`,
				);
			const textStart = performance.now();
			const before = queries.length;
			const textPage = await adapter.list({
				node: "text-native",
				text: "NEEDLE",
				limit: 1,
			});
			expect(textPage.items.map((item) => item.id)).toEqual(["task.200008"]);
			expect(textPage.pageInfo.hasMore).toBe(true);
			const textNext = await adapter.list({
				node: "text-native",
				text: "needle",
				limit: 1,
				cursor: textPage.nextCursor,
			});
			expect(textNext.items.map((item) => item.id)).toEqual(["task.200502"]);
			expect(textNext.pageInfo.hasMore).toBe(false);
			expect(queries.slice(before).length).toBeGreaterThanOrEqual(3);
			console.info(
				"rank_query_sparse_text",
				JSON.stringify({
					image: DOLTGRES_IMAGE,
					datasetN: 503,
					limit: 1,
					elapsedMs: performance.now() - textStart,
					batches: queries.length - before,
				}),
			);
			for (const issued of queries)
				expect(issued).toMatch(/ LIMIT (2|3|6|51|501)$/);
		} finally {
			await readSql.end({ timeout: 5 });
		}
		} finally {
			// Cleanup also runs when seed/JSON qualification fails before reader setup.
			await sql.unsafe("DELETE FROM work_items WHERE node IN ('rank-native','text-native')");
		}
	});


	it("filters bounded native pages against a 5000-row backlog", async () => {
		const readSql = postgres(dbUrl, { max: 1, fetch_types: false });
		const issued: string[] = [];
		let lateStart: number | undefined;
		const unsafe = readSql.unsafe.bind(readSql);
		readSql.unsafe = ((query: string) => {
			issued.push(query);
			if (lateStart !== undefined)
				console.info("rank_query_late_text_batch", JSON.stringify({ batch: issued.length, elapsedMs: performance.now() - lateStart }));
			return unsafe(query);
		}) as typeof readSql.unsafe;
		try {
			// Add a known filtered shelf to the 5,000-row native backlog. Rank 15
			// and rank 10 sit exactly on the two bounds; decoys isolate each filter.
			const scoresFor = (time: number, unblocks: number) =>
				JSON.stringify(
					Object.fromEntries(
						Object.entries({
							goal: 5,
							time,
							unblocks,
							ease: 5,
							confidence: 5,
							agent: 5,
						}).map(([axis, v]) => [axis, { v }]),
					),
				);
			const high = scoresFor(5, 5); // 15
			const low = scoresFor(4, 1); // 10
			const below = scoresFor(3, 1); // 9
			const matchingIds = Array.from(
				{ length: 21 },
				(_, i) => `task.${300000 + i}`,
			);
			const rows = matchingIds.map(
				(id, i) =>
					`('${id}','task','scale needle','needs_implement','scale-native','proj.${i % 2 ? "beta" : "alpha"}','${i < 10 ? high : low}'::JSONB)`,
			);
			rows.push(
				`('task.300021','task','scale needle','needs_implement','scale-native','proj.alpha','${below}'::JSONB)`,
				`('task.300022','task','scale needle','needs_implement','scale-native','proj.alpha',NULL)`,
				`('task.300023','task','scale needle','needs_implement','scale-native','proj.other','${high}'::JSONB)`,
				`('task.300024','bug','scale needle','needs_implement','scale-native','proj.alpha','${high}'::JSONB)`,
				`('task.300025','task','scale needle','needs_design','scale-native','proj.alpha','${high}'::JSONB)`,
				`('task.300026','task','scale absent','needs_implement','scale-native','proj.alpha','${high}'::JSONB)`,
			);
			for (let i = 27; i < 5000; i++)
				rows.push(
					`('task.${300000 + i}','task','${i === 4999 ? "last-only-needle" : "filler"}','needs_implement','scale-native','proj.other','${high}'::JSONB)`,
				);
			for (let offset = 0; offset < rows.length; offset += 250)
				await sql.unsafe(
					`INSERT INTO work_items (id,type,title,status,node,project_id,scores) VALUES ${rows.slice(offset, offset + 250).join(",")}`,
				);
			const filteredAdapter = new DoltgresWorkItemAdapter(sql, {
				readClient: readSql,
				readConnectionBudget: 2,
				queryTimeoutMs: 5000,
				logger: stageLogger,
			});
			const broad = { node: "scale-native", statuses: ["needs_implement"] as const, rankMin: 4, limit: 10 };
			lateStart = performance.now();
			let late: Awaited<ReturnType<typeof filteredAdapter.list>>;
			let lateElapsed: number;
			try {
				late = await filteredAdapter.list({ ...broad, text: "LAST-ONLY-NEEDLE" });
			} finally {
				lateElapsed = performance.now() - lateStart;
				console.info("rank_query_late_text_phase", JSON.stringify({ elapsedMs: lateElapsed, datasetN: 5000, queriesStarted: issued.length, order: normalizeWorkItemOrder(broad) }));
				lateStart = undefined;
			}
			expect(late.items.map((item) => item.id)).toEqual(["task.304999"]);
			expect(late.pageInfo.hasMore).toBe(false);
			expect(late.nextCursor).toBeUndefined();
			expect(lateElapsed).toBeLessThan(5000);
			expect(issued.length).toBeGreaterThan(1);
			for (const query of issued) {
				const nativeLimit = Number(query.match(/ LIMIT (\d+)$/)?.[1]);
				expect(nativeLimit).toBeGreaterThan(0);
				expect(nativeLimit).toBeLessThanOrEqual(501);
			}
			console.info("rank_query_late_text", JSON.stringify({ elapsedMs: lateElapsed, datasetN: 5000, queries: issued.length, resultCount: late.items.length }));
			const broadFirst = await filteredAdapter.list(broad);
			expect(broadFirst.items.map((item) => item.id)).toEqual(matchingIds.slice(0, 10));
			if (!broadFirst.nextCursor) throw new Error("missing broad cursor");
			const broadNext = await filteredAdapter.list({ ...broad, cursor: broadFirst.nextCursor });
			expect(broadNext.items).toHaveLength(10);
			expect(broadNext.items.every((item) => !broadFirst.items.some((first) => first.id === item.id))).toBe(true);
			await sql.unsafe(`UPDATE work_items SET labels='["area:web", "goal:work", "part,one"]'::JSONB WHERE id='task.300000'`);
			const labelFilter = { node: "scale-native", projectIds: [toWorkItemId("proj.alpha")], limit: 10 };
			expect((await filteredAdapter.list({ ...labelFilter, text: "part,one" })).items.map((item) => item.id)).toEqual(["task.300000"]);
			expect((await filteredAdapter.list({ ...labelFilter, text: "web,goal" })).items).toHaveLength(0);
			expect((await filteredAdapter.list({ ...labelFilter, text: "task.300000" })).items.map((item) => item.id)).toEqual(["task.300000"]);
			const filter = {
				node: "scale-native",
				types: ["task"] as const,
				statuses: ["needs_implement"] as const,
				projectIds: [toWorkItemId("proj.alpha"), toWorkItemId("proj.beta")],
				text: "scale needle",
				rankMin: 10,
				rankMax: 15,
				limit: 10,
			};
			const page1 = await filteredAdapter.list(filter);
			if (!page1.nextCursor) throw new Error("missing first scale cursor");
			const page2 = await filteredAdapter.list({
				...filter,
				cursor: page1.nextCursor,
			});
			if (!page2.nextCursor) throw new Error("missing second scale cursor");
			const page3 = await filteredAdapter.list({
				...filter,
				cursor: page2.nextCursor,
			});
			expect(page1.items.map((item) => item.id)).toEqual(
				matchingIds.slice(0, 10),
			);
			expect(page2.items.map((item) => item.id)).toEqual(
				matchingIds.slice(10, 20),
			);
			expect(page3.items.map((item) => item.id)).toEqual(matchingIds.slice(20));
			expect([
				page1.pageInfo.hasMore,
				page2.pageInfo.hasMore,
				page3.pageInfo.hasMore,
			]).toEqual([true, true, false]);
			const back = await filteredAdapter.list({
				...filter,
				cursor: page1.nextCursor,
			});
			expect(back.items.map((item) => item.id)).toEqual(
				matchingIds.slice(10, 20),
			);
			const exactHigh = await filteredAdapter.list({
				...filter,
				rankMin: 15,
				rankMax: 15,
				limit: 50,
			});
			const exactLow = await filteredAdapter.list({
				...filter,
				rankMin: 10,
				rankMax: 10,
				limit: 50,
			});
			expect(exactHigh.items.map((item) => item.id)).toEqual(
				matchingIds.slice(0, 10),
			);
			expect(exactLow.items.map((item) => item.id)).toEqual(
				matchingIds.slice(10),
			);
			const unbounded = await filteredAdapter.list({
				...filter,
				rankMin: undefined,
				rankMax: undefined,
				limit: 50,
			});
			expect(unbounded.items.map((item) => item.id)).toEqual([
				...matchingIds,
				"task.300021",
				"task.300022",
			]);
			for (const changed of [
				{ rankMin: 11 },
				{ rankMax: 14 },
				{ projectIds: [toWorkItemId("proj.alpha")] },
				{ statuses: ["needs_design"] as const },
				{ text: "scale absent" },
			])
				await expect(
					filteredAdapter.list({
						...filter,
						...changed,
						cursor: page1.nextCursor,
					}),
				).rejects.toMatchObject({ name: "InvalidCursorError" });
		} finally {
			try {
				await readSql.end({ timeout: 5 });
			} finally {
				await sql.unsafe("DELETE FROM work_items WHERE node='scale-native'");
			}
		}
	});

	it.each([
		"native",
		"admission",
	] as const)("expires a sparse text list across batches including %s waiting without partial success", async (mode) => {
		const writer = postgres(dbUrl, { max: 1, fetch_types: false });
		const reader = postgres(dbUrl, { max: 1, fetch_types: false });
		const unsafe = reader.unsafe.bind(reader);
		const end = reader.end.bind(reader);
		const native: Promise<unknown>[] = [];
		let batches = 0,
			ended = 0,
			settled = 0;
		let signalFirst!: () => void;
		const firstStarted = new Promise<void>((resolve) => {
			signalFirst = resolve;
		});
		reader.unsafe = ((query: string) => {
			const isList = query.includes("node IN ('deadline-native')");
			if (isList) {
				batches++;
				signalFirst();
			}
			const delay = isList ? (batches === 1 ? 0.15 : 0.7) : 0.7;
			// Execute the actual adapter query; real native pg_sleep delays its settlement.
			// The result includes a match on batch 1, so a timeout must discard it.
			const pending = (async () => {
				const rows = await unsafe(query);
				await unsafe(`SELECT pg_sleep(${delay}) /* rank_text_deadline_probe */`);
				return rows;
			})().finally(() => {
				settled++;
			});
			native.push(pending);
			return pending;
		}) as typeof reader.unsafe;
		reader.end = (async (options) => {
			ended++;
			await end(options);
		}) as typeof reader.end;
		try {
			await sql.unsafe(
				`INSERT INTO work_items (id,type,title,status,node) VALUES ${Array.from({ length: 503 }, (_, i) => `('task.${300000 + i}','task','${i === 0 || i === 502 ? "needle" : "absent"}','needs_design','deadline-native')`).join(",")}`,
			);
			const adapter = new DoltgresWorkItemAdapter(writer, {
				readClient: reader,
				readConnectionBudget: 2,
				queryTimeoutMs: 500,
			});
			const list = adapter.list({
				node: "deadline-native",
				text: "needle",
				limit: 1,
			});
			const rejected = expect(list).rejects.toBeInstanceOf(WorkItemsBusyError);
			await firstStarted;
			const queued =
				mode === "admission"
					? adapter.get(toWorkItemId("task.300000")).catch((error) => error)
					: undefined;
			await rejected;
			expect(batches).toBe(mode === "native" ? 2 : 1);
			expect(ended).toBe(0); // A pending native operation retains its generation.
			const captured = batches;
			await Promise.allSettled(native);
			await queued;
			expect(settled).toBe(native.length);
			expect(batches).toBe(captured); // No later text batch dispatch after expiry.
			await expect.poll(() => ended).toBe(1);
			console.info(
				"rank_query_text_deadline",
				JSON.stringify({
					image: DOLTGRES_IMAGE,
					mode,
					batches,
					settled,
					ended,
					queryTimeoutMs: 500,
				}),
			);
		} finally {
			await Promise.allSettled(native);
			await Promise.allSettled([writer.end({ timeout: 5 }), end({ timeout: 5 })]);
			await sql.unsafe("DELETE FROM work_items WHERE node='deadline-native'");
		}
	});

	it("creates, lists, patches, and retains versioned content through Dolt branches", async () => {
		const createWorkItemClient = () =>
			postgres(dbUrl, { max: 1, fetch_types: false });
		// An EXPLICIT read pool, so `recreateClient` below stays a pure
		// write-pool factory and `sql` keeps tracking the write pool — which the
		// pool-death scenario further down depends on. The 0.1.7 derivation path
		// (no readClient, pool built from recreateClient) is covered in the unit
		// lane; mixing it in here would mean `sql` sometimes pointed at the read
		// pool and the pool-death assertions would kill the wrong connection.
		const readSql = createWorkItemClient();
		const createAdapter = () =>
			new DoltgresWorkItemAdapter(sql, {
				logger: stageLogger,
				lockWaitMs: 250,
				lockRetryMs: 25,
				queryTimeoutMs: 5_000,
				readClient: readSql,
				recreateReadClient: createWorkItemClient,
				recreateClient: () => {
					sql = createWorkItemClient();
					return sql;
				},
			});
		let adapter = createAdapter();
		const id = toWorkItemId("task.9501");
		const principalId = "doltgres-acceptance-agent";
		const searchId = toWorkItemId("task.9500");

		await adapter.create(
			{
				id: searchId,
				type: "task",
				title: "Out-of-line text search",
				summary: `prefix ${"x".repeat(8_000)} panic-proof-needle`,
			},
			principalId,
		);
		await expect(
			adapter.list({ text: "PANIC-PROOF-NEEDLE" }),
		).resolves.toMatchObject({
			items: [expect.objectContaining({ id: searchId })],
		});

		const created = await adapter.create(
			{ id, type: "task", title: "Doltgres acceptance" },
			principalId,
		);
		expect(created.id).toBe(id);
		expect((await adapter.list({ ids: [id] })).items).toHaveLength(1);

		const patched = await adapter.patch(
			{ id, set: { title: "Doltgres accepted" } },
			principalId,
		);
		expect(patched.title).toBe("Doltgres accepted");

		// bug.5358's core guarantee, against a REAL held lock: a write holding
		// the global work-items lock must not take reads down with it. Before
		// 0.1.7 this same lock made `get` reject with WorkItemsBusyError, because
		// reads shared the write lane. The write lane still fails closed — the
		// `patch` below proves that on the same held lock.
		const blocker = createWorkItemClient();
		try {
			await blocker.unsafe("SELECT pg_advisory_lock(5001001)");
			await expect(adapter.get(id)).resolves.toMatchObject({ id });
			await expect(
				adapter.patch({ id, set: { title: "blocked" } }, principalId),
			).rejects.toBeInstanceOf(WorkItemsBusyError);
		} finally {
			await blocker
				.unsafe("SELECT pg_advisory_unlock(5001001)")
				.catch(() => undefined);
			await blocker.end({ timeout: 0 });
		}

		// The common scope used by knowledge and work items must cover the
		// whole write, even while a different client holds a database-only guard.
		const scopedBlocker = createWorkItemClient();
		await scopedBlocker.unsafe("SELECT 1");
		const scopedSession = await scopedBlocker.reserve();
		const writerGuard = await acquireDoltWriterLocks(scopedSession, {
			protocol: "database",
		});
		try {
			await expect(adapter.get(id)).resolves.toMatchObject({ id });
			await expect(
				adapter.patch({ id, set: { title: "scoped blocked" } }, principalId),
			).rejects.toBeInstanceOf(WorkItemsBusyError);
		} finally {
			await writerGuard.release();
			scopedSession.release();
			await scopedBlocker.end({ timeout: 0 });
		}

		const maintenance = createWorkItemClient();
		try {
			await maintenance.unsafe(
				"SELECT dolt_checkout('-b', 'work-item-op/acceptance-orphan', 'main')",
			);
			await maintenance.unsafe("SELECT dolt_checkout('main')");
		} finally {
			await maintenance.end({ timeout: 0 });
		}

		const oldPool = sql;
		const oldPid = Number(
			(await oldPool.unsafe("SELECT pg_backend_pid() AS pid"))[0]?.pid,
		);
		const lockHolder = createWorkItemClient();
		try {
			await lockHolder.unsafe("SELECT pg_advisory_lock(9501002)");
			const blockedQuery = oldPool.unsafe("SELECT pg_advisory_lock(9501002)");
			const blockedResult = blockedQuery.then(
				() => undefined,
				(error) => error,
			);
			await new Promise((resolve) => setTimeout(resolve, 50));
			// Only a write can observe this write-pool transport loss. It must
			// quarantine its native capacity while the independent reader serves.
			const recoveryAttempt = adapter.patch(
				{ id, set: { title: "pool death" } },
				principalId,
			);
			const destroyTimer = setTimeout(() => {
				void oldPool.end({ timeout: 0 });
			}, 100);
			await expect(blockedResult).resolves.toBeInstanceOf(Error);
			await expect(recoveryAttempt).rejects.toBeInstanceOf(WorkItemsBusyError);
			clearTimeout(destroyTimer);
		} finally {
			await oldPool.end({ timeout: 0 });
			await lockHolder
				.unsafe("SELECT pg_advisory_unlock(9501002)")
				.catch(() => undefined);
			await lockHolder.end({ timeout: 0 });
		}
		// Transport failure does not prove that Dolt finished the old statement.
		// Keep that adapter quarantined, including after the lock-holder exits.
		await expect(
			adapter.patch({ id, set: { title: "no replacement" } }, principalId),
		).rejects.toMatchObject({ code: "work_items_native_capacity_held" });
		// This owned test can explicitly observe the old native session depart
		// before constructing a replacement; production needs its own authority.
		await expect
			.poll(
				async () =>
					(
						await readSql.unsafe(
							`SELECT pid FROM pg_catalog.pg_stat_activity WHERE pid = ${oldPid}`,
						)
					).length,
				{ timeout: 3_000 },
			)
			.toBe(0);
		sql = createWorkItemClient();
		adapter = createAdapter();

		// Reads kept serving throughout — including while the write pool was
		// dead, which is the bug.5358 guarantee.
		await expect(adapter.get(id)).resolves.toMatchObject({ id });
		// ...and an explicit replacement after native absence sweeps the
		// orphan branch. Sweeping is a branch mutation, so it belongs to the
		// write plane (COMMAND_QUERY_SEPARATION); a read used to do it here only
		// because a read used to take the write lock.
		await expect(
			adapter.patch({ id, set: { title: "Doltgres accepted" } }, principalId),
		).resolves.toMatchObject({ id, title: "Doltgres accepted" });
		const verifier = createWorkItemClient();
		try {
			await expect(
				verifier.unsafe(
					"SELECT name FROM dolt.branches WHERE name = 'work-item-op/acceptance-orphan'",
				),
			).resolves.toHaveLength(0);
		} finally {
			await verifier.end({ timeout: 0 });
		}

		await expect(adapter.delete(id, principalId)).rejects.toMatchObject({
			name: "WorkItemDeletionRetiredError",
		});
		await adapter.patch({ id, set: { status: "cancelled" } }, principalId);
		await adapter.patch(
			{ id: searchId, set: { status: "cancelled" } },
			principalId,
		);
		await expect(adapter.get(id)).resolves.toMatchObject({
			id,
			status: "cancelled",
		});
		await readSql.end({ timeout: 0 });
	}, 60_000);

	// task.5284 (story.5096): `patch` honors `expectedRevision` as a real
	// compare-and-set, and a non-creator may patch ONLY the triage fields
	// (priority, rank, labels). Any other field keeps the whole patch
	// creator-bound. Refusals must leave `main` and the op namespace untouched.
	it("compare-and-sets patch on expectedRevision and admits collaborator triage fields only", async () => {
		const casSql = postgres(dbUrl, { max: 1, fetch_types: false });
		const casReadSql = postgres(dbUrl, { max: 1, fetch_types: false });
		const adapter = new DoltgresWorkItemAdapter(casSql, {
			readClient: casReadSql,
			logger: stageLogger,
			lockWaitMs: 250,
			lockRetryMs: 25,
			queryTimeoutMs: 5_000,
		});
		const id = toWorkItemId("task.9503");
		const creator = "doltgres-cas-creator";
		const collaborator = "doltgres-cas-collaborator";
		const mainHash = async () =>
			String(
				(await casSql.unsafe("SELECT dolt_hashof('main') AS hash"))[0]?.hash ?? "",
			);
		try {
			const created = await adapter.create(
				{ id, type: "task", title: "CAS me", priority: 3, rank: 9 },
				creator,
			);
			// Matching expectedRevision lands and bumps the revision by one.
			const casPatched = await adapter.patch(
				{ id, expectedRevision: created.revision, set: { title: "CAS landed" } },
				creator,
			);
			expect(casPatched).toMatchObject({
				id,
				title: "CAS landed",
				revision: created.revision + 1,
			});

			// Stale expectedRevision: conflict, nothing written.
			const beforeStale = await mainHash();
			await expect(
				adapter.patch(
					{ id, expectedRevision: created.revision, set: { title: "stale" } },
					creator,
				),
			).rejects.toBeInstanceOf(WorkItemRevisionConflictError);
			expect(await mainHash()).toBe(beforeStale);
			await expect(adapter.get(id)).resolves.toMatchObject({
				title: "CAS landed",
				revision: casPatched.revision,
			});

			// A non-creator may set the triage fields, attributed to itself.
			const triaged = await adapter.patch(
				{
					id,
					expectedRevision: casPatched.revision,
					set: { priority: 0, rank: 1, labels: ["triaged"] },
				},
				collaborator,
			);
			expect(triaged).toMatchObject({
				priority: 0,
				rank: 1,
				labels: ["triaged"],
				revision: casPatched.revision + 1,
			});
			await expect(
				casSql.unsafe(
					`SELECT commit_hash FROM dolt.commits WHERE message = 'work-items: patch ${id} by actor:${collaborator}'`,
				),
			).resolves.toHaveLength(1);

			// ...but naming any other field keeps the whole patch creator-bound.
			const beforeMixed = await mainHash();
			await expect(
				adapter.patch(
					{ id, set: { priority: 5, title: "not yours" } },
					collaborator,
				),
			).rejects.toBeInstanceOf(WorkItemAuthorizationError);
			expect(await mainHash()).toBe(beforeMixed);
			await expect(adapter.get(id)).resolves.toMatchObject({
				priority: 0,
				title: "CAS landed",
				revision: triaged.revision,
			});

			// The creator's unconditioned patch is unchanged.
			await expect(
				adapter.patch({ id, set: { title: "creator unconditioned" } }, creator),
			).resolves.toMatchObject({
				title: "creator unconditioned",
				revision: triaged.revision + 1,
			});
			await expect(
				casSql.unsafe(
					"SELECT name FROM dolt.branches WHERE name LIKE 'work-item-op/%'",
				),
			).resolves.toHaveLength(0);
		} finally {
			await casReadSql.end({ timeout: 0 });
			await casSql.end({ timeout: 0 });
		}
	}, 60_000);

	it("serves reads past an unprovable operation branch and quarantines it so writes recover", async () => {
		const branch = "work-item-op/component-unreachable";
		const maintenance = postgres(dbUrl, { max: 1, fetch_types: false });
		try {
			await maintenance.unsafe(
				`SELECT dolt_checkout('-b', '${branch}', 'main')`,
			);
			await maintenance.unsafe(
				"INSERT INTO work_items (id, type, title, status, node, created_by_principal_id) VALUES ('task.9599', 'task', 'Unreachable evidence', 'needs_implement', 'shared', 'component-agent')",
			);
			await maintenance.unsafe(
				"SELECT dolt_commit('-Am', 'component unreachable evidence')",
			);
			await maintenance.unsafe("SELECT dolt_checkout('main')");

			const adapter = new DoltgresWorkItemAdapter(sql, {
				recreateReadClient: () =>
					postgres(dbUrl, { max: 2, fetch_types: false }),
				logger: stageLogger,
				lockWaitMs: 250,
				lockRetryMs: 25,
			});
			// bug.5358: an unprovable branch must not take reads down. The read is
			// served from committed `main` — which does not carry task.9599, so null
			// is the correct answer — while the evidence branch stays untouched.
			// Reads still fail closed on lock contention and on a destroyed
			// connection; both are asserted above. Only branch-proof residue is
			// tolerated.
			await expect(adapter.get(toWorkItemId("task.9599"))).resolves.toBeNull();
			await expect(
				maintenance.unsafe(
					`SELECT name FROM dolt.branches WHERE name = '${branch}'`,
				),
			).resolves.toHaveLength(1);

			// CONTRACT CHANGE, deliberate (bug.5358). This case previously asserted
			// that the write stays 503 forever. That is what made operator
			// production unwritable: nothing deletes this ref, the sweep re-walks
			// `dolt.branches` on every request, and no restart clears it — 88
			// consecutive write 503s over two hours while reads stayed 200.
			//
			// The safety property is unchanged: the write still does not build on
			// unproven evidence. Instead the ref is RENAMED out of the swept
			// namespace, so its commits survive byte-for-byte for a human to
			// merge, and the write then proceeds. Here it proceeds to a genuine
			// "not found", because committed `main` does not carry task.9599 —
			// which is exactly the point: the branch no longer decides the
			// outcome.
			await expect(
				adapter.patch(
					{
						id: toWorkItemId("task.9599"),
						set: { title: "must not land" },
					},
					"component-agent",
				),
			).rejects.toThrow(/Work item not found/);
			// Parked, never deleted: gone from the op namespace, present under
			// quarantine with its row intact.
			await expect(
				maintenance.unsafe(
					`SELECT name FROM dolt.branches WHERE name = '${branch}'`,
				),
			).resolves.toHaveLength(0);
			const quarantined = `work-item-quarantine/${branch.slice(
				"work-item-op/".length,
			)}`;
			await expect(
				maintenance.unsafe(
					`SELECT name FROM dolt.branches WHERE name = '${quarantined}'`,
				),
			).resolves.toHaveLength(1);
			// Proving the ROW survived is the point of quarantine. Doltgres is
			// Postgres dialect, so MySQL backtick branch-qualification does not
			// parse; check the branch out on the maintenance session instead.
			await maintenance.unsafe(`SELECT dolt_checkout('${quarantined}')`);
			await expect(
				maintenance.unsafe("SELECT id FROM work_items WHERE id = 'task.9599'"),
			).resolves.toHaveLength(1);
			await maintenance.unsafe("SELECT dolt_checkout('main')");

			// `branch` no longer exists — quarantine renamed it — so drop the
			// quarantined ref to prove a clean store still reads null.
			await maintenance.unsafe(`SELECT dolt_branch('-D', '${quarantined}')`);
			await expect(adapter.get(toWorkItemId("task.9599"))).resolves.toBeNull();
		} finally {
			await maintenance
				.unsafe("SELECT dolt_checkout('main')")
				.catch(() => undefined);
			await maintenance
				.unsafe(`SELECT dolt_branch('-D', '${branch}')`)
				.catch(() => undefined);
			await maintenance
				.unsafe(
					`SELECT dolt_branch('-D', 'work-item-quarantine/${branch.slice("work-item-op/".length)}')`,
				)
				.catch(() => undefined);
			await maintenance.end({ timeout: 0 });
		}
	}, 60_000);

	it("commits only work_items while preserving and deterministically cleaning dirty knowledge", async () => {
		const adapter = new DoltgresWorkItemAdapter(sql, {
			recreateReadClient: () => postgres(dbUrl, { max: 2, fetch_types: false }),
			logger: stageLogger,
			lockWaitMs: 250,
			lockRetryMs: 25,
			queryTimeoutMs: 5_000,
		});
		const id = toWorkItemId("task.9502");
		const knowledgeId = "component-dirty-knowledge";
		const knowledgeBranch = "knowledge-component-dirty";
		const principalId = "doltgres-scoped-staging-agent";
		const knowledgeSql = postgres(dbUrl, { max: 1, fetch_types: false });
		let knowledgeSession:
			| Awaited<ReturnType<typeof knowledgeSql.reserve>>
			| undefined;
		let workItemCreated = false;
		let before = "";
		let beforeBranches: ReadonlyArray<Record<string, unknown>> = [];
		let beforeStatus: ReadonlyArray<Record<string, unknown>> = [];

		try {
			const beforeRows = await sql.unsafe("SELECT dolt_hashof('main') AS hash");
			before = String(beforeRows[0]?.hash ?? "");
			expect(before).not.toBe("");
			beforeBranches = await sql.unsafe(
				"SELECT name, hash FROM dolt.branches ORDER BY name",
			);
			beforeStatus = await sql.unsafe(
				"SELECT table_name, staged FROM dolt.status ORDER BY table_name",
			);
			// Pin checkout, dirty write, assertions, and cleanup to one Dolt session.
			// A max:1 pool limits concurrency but does not itself reserve a session.
			await knowledgeSql.unsafe("SELECT 1 AS knowledge_ready");
			knowledgeSession = await knowledgeSql.reserve();
			await knowledgeSession.unsafe(
				`SELECT dolt_checkout('-b', '${knowledgeBranch}', 'main')`,
			);
			await knowledgeSession.unsafe(
				`INSERT INTO knowledge (id, domain, title, content, source_type) VALUES ('${knowledgeId}', 'shared', 'Dirty fixture', 'Must remain outside work-item commit', 'agent')`,
			);

			await adapter.create(
				{ id, type: "task", title: "Scoped staging acceptance" },
				principalId,
			);
			workItemCreated = true;

			const afterRows = await sql.unsafe("SELECT dolt_hashof('main') AS hash");
			const after = String(afterRows[0]?.hash ?? "");
			expect(after).not.toBe(before);
			await expect(
				sql.unsafe(
					`SELECT * FROM dolt_diff('${before}', '${after}', 'knowledge')`,
				),
			).resolves.toHaveLength(0);
			await expect(
				knowledgeSession.unsafe(
					`SELECT table_name FROM dolt.status WHERE table_name = 'public.knowledge'`,
				),
			).resolves.toHaveLength(1);
			await expect(
				knowledgeSession.unsafe(
					`SELECT id FROM knowledge WHERE id = '${knowledgeId}'`,
				),
			).resolves.toHaveLength(1);
		} finally {
			if (workItemCreated) {
				await adapter
					.patch({ id, set: { status: "cancelled" } }, principalId)
					.catch(() => undefined);
			}
			if (knowledgeSession) {
				await knowledgeSession
					.unsafe("SELECT dolt_reset('--hard', 'HEAD')")
					.catch(() => undefined);
				await knowledgeSession
					.unsafe("SELECT dolt_checkout('main')")
					.catch(() => undefined);
				await knowledgeSession
					.unsafe(`SELECT dolt_branch('-D', '${knowledgeBranch}')`)
					.catch(() => undefined);
				knowledgeSession.release();
			}
			await knowledgeSql.end({ timeout: 0 });
			await sql.unsafe("SELECT dolt_checkout('main')").catch(() => undefined);
			if (before) {
				await sql.unsafe(`SELECT dolt_reset('--hard', '${before}')`);
			}
			await expect(
				sql.unsafe("SELECT dolt_hashof('main') AS hash"),
			).resolves.toEqual([{ hash: before }]);
			await expect(
				sql.unsafe("SELECT name, hash FROM dolt.branches ORDER BY name"),
			).resolves.toEqual(beforeBranches);
			await expect(
				sql.unsafe(
					"SELECT table_name, staged FROM dolt.status ORDER BY table_name",
				),
			).resolves.toEqual(beforeStatus);
		}
	}, 60_000);
	it("a timed-out GET preserves healthy old and new readers while draining its own generation", async () => {
		const clients: Sql[] = [];
		const nativeReads: PromiseLike<unknown>[] = [];
		const createReader = () => {
			const client = postgres(dbUrl, { max: 2, fetch_types: false });
			const unsafe = client.unsafe.bind(client);
			client.unsafe = ((query: string) => {
				const pending = query.includes("task.9001")
					? unsafe("SELECT pg_sleep(3)").then(() => [])
					: query.includes("task.9002")
						? unsafe("SELECT pg_sleep(0.5)").then(() => [])
						: unsafe(query);
				nativeReads.push(pending);
				return pending;
			}) as typeof client.unsafe;
			clients.push(client);
			return client;
		};
		const writer = postgres(dbUrl, { max: 1, fetch_types: false });
		const reader = createReader();
		try {
			await reader.unsafe("SELECT 1");
			const adapter = new DoltgresWorkItemAdapter(writer, {
				readClient: reader,
				recreateReadClient: createReader,
				queryTimeoutMs: 1_000,
				readConnectionBudget: 4,
			});
			const first = adapter
				.get(toWorkItemId("task.9001"))
				.catch((error) => error);
			await new Promise((resolve) => setTimeout(resolve, 600));
			const healthyOld = adapter.get(toWorkItemId("task.9002"));
			expect(await first).toBeInstanceOf(WorkItemsBusyError);
			await expect(adapter.get(toWorkItemId("task.9003"))).resolves.toBeNull();
			await expect(healthyOld).resolves.toBeNull();
			expect(clients).toHaveLength(2);
			// The expired read does not destroy siblings or poison the replacement.
			await new Promise((resolve) => setTimeout(resolve, 1_100));
			await expect(adapter.get(toWorkItemId("task.9003"))).resolves.toBeNull();
		} finally {
			await Promise.allSettled(nativeReads);
			await Promise.all([
				writer.end({ timeout: 0 }),
				...clients.map((client) => client.end({ timeout: 0 })),
			]);
		}
	}, 5_000);
	it("keeps reader generation slots until native settlement and bounds repeated timeouts", async () => {
		const clients: Sql[] = [];
		const native: Promise<unknown>[] = [];
		let ended = 0;
		const observer = postgres(dbUrl, { max: 1, fetch_types: false });
		const writer = postgres(dbUrl, { max: 1, fetch_types: false });
		const reader = () => {
			const client = postgres(dbUrl, { max: 1, fetch_types: false });
			const unsafe = client.unsafe.bind(client);
			const end = client.end.bind(client);
			client.unsafe = ((query: string) => {
				if (!query.includes("task.9613")) return unsafe(query);
				const pending = unsafe(
					"SELECT pg_sleep(3) /* reader_generation_probe */",
				).then(() => []);
				native.push(pending);
				return pending;
			}) as typeof client.unsafe;
			client.end = (async (options) => {
				await end(options);
				ended++;
			}) as typeof client.end;
			clients.push(client);
			return client;
		};
		try {
			const observerPid = Number(
				(await observer.unsafe("SELECT pg_backend_pid() AS pid"))[0]?.pid,
			);
			const adapter = new DoltgresWorkItemAdapter(writer, {
				readClient: reader(),
				recreateReadClient: reader,
				readConnectionBudget: 2,
				queryTimeoutMs: 500,
			});
			for (let attempt = 0; attempt < 2; attempt++)
				await expect(
					adapter.get(toWorkItemId("task.9613")),
				).rejects.toBeInstanceOf(WorkItemsBusyError);
			await expect(
				adapter.get(toWorkItemId("task.9613")),
			).rejects.toBeInstanceOf(WorkItemsBusyError);
			expect(clients).toHaveLength(2);
			expect(ended).toBe(0);
			const rows = await observer.unsafe(
				`SELECT DISTINCT pid FROM pg_catalog.pg_stat_activity WHERE pid <> ${observerPid} AND state = 'active' AND query LIKE '%reader_generation_probe%'`,
			);
			expect(rows).toHaveLength(2);
			await Promise.all(native);
			await expect.poll(() => ended).toBe(2);
			await expect(
				Promise.all(
					Array.from({ length: 8 }, () =>
						adapter.get(toWorkItemId("task.9614")),
					),
				),
			).resolves.toEqual(Array.from({ length: 8 }, () => null));
			expect(clients).toHaveLength(3);
		} finally {
			await Promise.allSettled(native);
			await Promise.allSettled(
				[...clients, writer, observer].map((client) =>
					client.end({ timeout: 0 }),
				),
			);
		}
	}, 6_000);
	it("the legacy end(0) strategy is a sensitive native orphan control", async () => {
		const observer = postgres(dbUrl, { max: 1, fetch_types: false });
		const clients: Sql[] = [];
		const pids: number[] = [];
		const started = Date.now();
		let lastConfirmedSleepAt = started;
		try {
			for (let attempt = 0; attempt < 2; attempt++) {
				const client = postgres(dbUrl, { max: 1, fetch_types: false });
				clients.push(client);
				const pid = Number(
					(await client.unsafe("SELECT pg_backend_pid() AS pid"))[0]?.pid,
				);
				pids.push(pid);
				const pending = client
					.unsafe("SELECT pg_sleep(6)")
					.catch(() => undefined);
				await expect
					.poll(
						async () =>
							(
								await observer.unsafe(
									`SELECT pid FROM pg_catalog.pg_stat_activity WHERE pid = ${pid} AND state = 'active' AND query LIKE '%pg_sleep%'`,
								)
							).length,
						{ timeout: 1_000 },
					)
					.toBe(1);
				lastConfirmedSleepAt = Date.now();
				await client.end({ timeout: 0 });
				await pending;
			}
			const rows = await observer.unsafe(
				`SELECT DISTINCT pid FROM pg_catalog.pg_stat_activity WHERE pid IN (${pids.join(",")})`,
			);
			expect(Date.now() - started).toBeLessThan(5_000);
			expect(rows).toHaveLength(2);
		} finally {
			await new Promise((resolve) =>
				setTimeout(
					resolve,
					Math.max(0, lastConfirmedSleepAt + 6_250 - Date.now()),
				),
			);
			await Promise.allSettled(
				[...clients, observer].map((client) => client.end({ timeout: 0 })),
			);
		}
	}, 12_000);
	it("retains one native writer through caller retries and recovers after actual settlement", async () => {
		const writer = postgres(dbUrl, { max: 1, fetch_types: false });
		const reader = postgres(dbUrl, { max: 1, fetch_types: false });
		const observer = postgres(dbUrl, { max: 1, fetch_types: false });
		const otherDb = postgres(dbUrl.replace(`/${DB_NAME}`, "/postgres"), {
			max: 1,
			fetch_types: false,
		});
		const unsafe = writer.unsafe.bind(writer);
		const reserve = writer.reserve.bind(writer);
		let native: Promise<unknown> | undefined;
		let primed = false;
		let reservations = 0;
		let replacements = 0;
		let mutations = 0;
		writer.unsafe = ((query: string) => {
			if (query === "SELECT 1 AS work_items_ready" && !primed) {
				primed = true;
				native = unsafe("SELECT pg_sleep(2)").then(() => []);
				return native;
			}
			if (/INSERT|UPDATE|DELETE/.test(query)) mutations++;
			return unsafe(query);
		}) as typeof writer.unsafe;
		writer.reserve = (() => {
			reservations++;
			return reserve();
		}) as typeof writer.reserve;
		const adapter = new DoltgresWorkItemAdapter(writer, {
			writerLockProtocol: "database",
			readClient: reader,
			queryTimeoutMs: 250,
			recreateClient: () => {
				replacements++;
				throw new Error("No replacement while native SQL is pending");
			},
		});
		try {
			const pid = Number(
				(await unsafe("SELECT pg_backend_pid() AS pid"))[0]?.pid,
			);
			const abandoned = adapter
				.create(
					{
						id: toWorkItemId("task.9612"),
						type: "task",
						title: "Never resume",
					},
					"native-capacity-probe",
				)
				.catch((error: unknown) => error);
			await expect
				.poll(
					async () =>
						(
							await observer.unsafe(
								`SELECT pid FROM pg_catalog.pg_stat_activity WHERE pid = ${pid} AND state = 'active' AND query LIKE '%pg_sleep%'`,
							)
						).length,
					{ timeout: 1_000 },
				)
				.toBe(1);
			expect(await abandoned).toMatchObject({
				code: "work_items_native_capacity_held",
			});
			for (let retry = 0; retry < 4; retry++)
				await expect(
					adapter.create(
						{ type: "task", title: "Retry cannot allocate" },
						"native-capacity-probe",
					),
				).rejects.toMatchObject({ code: "work_items_native_capacity_held" });
			expect(reservations).toBe(0);
			expect(replacements).toBe(0);
			expect(mutations).toBe(0);
			await expect(adapter.get(toWorkItemId("task.9612"))).resolves.toBeNull();
			await expect(
				otherDb.unsafe("SELECT 1 AS independent_database"),
			).resolves.toEqual([{ independent_database: 1 }]);
			await native;
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(reservations).toBe(0);
			expect(mutations).toBe(0);
			await expect(
				adapter.patch(
					{ id: toWorkItemId("task.9612"), set: { title: "Fresh request" } },
					"native-capacity-probe",
				),
			).rejects.toThrow(/not found/);
			expect(reservations).toBe(1);
			expect(replacements).toBe(0);
			await expect(
				observer.unsafe("SELECT id FROM work_items WHERE id = 'task.9612'"),
			).resolves.toHaveLength(0);
		} finally {
			await native?.catch(() => undefined);
			await Promise.allSettled(
				[writer, reader, observer, otherDb].map((client) =>
					client.end({ timeout: 0 }),
				),
			);
		}
	}, 6_000);
	it("reconciles finite post-DML abandonment before releasing its database guard", async () => {
		const writer = postgres(dbUrl, { max: 1, fetch_types: false });
		const reader = postgres(dbUrl, { max: 1, fetch_types: false });
		const observer = postgres(dbUrl, { max: 1, fetch_types: false });
		const competitor = postgres(dbUrl, { max: 1, fetch_types: false });
		const reserve = writer.reserve.bind(writer);
		let stalled: Promise<unknown> | undefined;
		let inserts = 0;
		let commits = 0;
		let resets = 0;
		writer.reserve = (async () => {
			const session = await reserve();
			const unsafe = session.unsafe.bind(session);
			session.unsafe = ((query: string) => {
				if (query.startsWith("INSERT INTO work_items")) inserts++;
				if (query.startsWith("SELECT dolt_commit")) commits++;
				if (query === "SELECT dolt_reset('--hard', 'HEAD')") resets++;
				if (query === "SELECT dolt_add('work_items')" && !stalled) {
					stalled = unsafe("SELECT pg_sleep(2)").then(() => []);
					return stalled;
				}
				return unsafe(query);
			}) as typeof session.unsafe;
			return session;
		}) as typeof writer.reserve;
		const adapter = new DoltgresWorkItemAdapter(writer, {
			writerLockProtocol: "database",
			readClient: reader,
			queryTimeoutMs: 500,
		});
		let rival: Awaited<ReturnType<Sql["reserve"]>> | undefined;
		try {
			const error = await adapter
				.create(
					{
						id: toWorkItemId("task.9615"),
						type: "task",
						title: "Must remain uncommitted",
					},
					"native-cleanup-probe",
				)
				.catch((failure: unknown) => failure);
			expect(error).toBeInstanceOf(WorkItemWriteOutcomeUnknownError);
			if (!(error instanceof WorkItemWriteOutcomeUnknownError)) throw error;
			expect(inserts).toBe(1);
			expect(commits).toBe(0);
			expect(resets).toBe(0);
			await competitor.unsafe("SELECT 1");
			rival = await competitor.reserve();
			const rivalSession = rival;
			await expect
				.poll(
					async () => {
						try {
							const guard = await acquireDoltWriterLocks(rivalSession, {
								protocol: "database",
								lockWaitMs: 0,
							});
							await guard.release();
							return true;
						} catch {
							return false;
						}
					},
					{ timeout: 5_000 },
				)
				.toBe(true);
			expect(resets).toBe(1);
			expect(inserts).toBe(1);
			expect(commits).toBe(0);
			await expect(
				writer.unsafe("SELECT active_branch() AS branch_name"),
			).resolves.toEqual([{ branch_name: "main" }]);
			await expect(
				writer.unsafe("SELECT * FROM dolt.status"),
			).resolves.toHaveLength(0);
			await expect(
				observer.unsafe("SELECT id FROM work_items WHERE id = 'task.9615'"),
			).resolves.toHaveLength(0);
			await expect(
				observer.unsafe(
					`SELECT name FROM dolt.branches WHERE name = '${error.branch}'`,
				),
			).resolves.toHaveLength(1);
			expect(error).toMatchObject({
				retryable: false,
				branch: expect.stringMatching(/^work-item-op\//),
			});
		} finally {
			await stalled?.catch(() => undefined);
			rival?.release();
			await Promise.allSettled(
				[writer, reader, observer, competitor].map((client) =>
					client.end({ timeout: 0 }),
				),
			);
		}
	}, 10_000);
	it.each(["checkout", "edit"] as const)(
		"restores a persisted clean contribution after finite %s settles",
		async (stage) => {
			const writer = postgres(dbUrl, { max: 1, fetch_types: false });
			const reader = postgres(dbUrl, { max: 1, fetch_types: false });
			const competitor = postgres(dbUrl, { max: 1, fetch_types: false });
			const runner = new DoltBranchSessionRunner(writer, {
				writerProtocol: "database",
				queryTimeoutMs: 500,
			});
			const contributions = new DoltgresKnowledgeContributionAdapter({
				sql: reader,
				writerSession: runner,
			});
			const store = new DoltgresKnowledgeStoreAdapter({
				sql: reader,
				writerSession: runner,
			});
			const principal = {
				id: `native-persisted-clean-${stage}`,
				kind: "agent" as const,
			};
			const rowId = `native-persisted-clean-entry-${stage}`;
			const domainId = `persisted-clean-native-${stage}`;
			let contribution:
				| Awaited<ReturnType<typeof contributions.create>>
				| undefined;
			let pending: Promise<unknown> | undefined;
			let nativeSettled = false;
			let earlyAdmission = false;
			let armed = false;
			let edits = 0;
			let resets = 0;
			let commits = 0;
			const reserve = writer.reserve.bind(writer);
			const wrapped = new WeakSet<object>();
			writer.reserve = (async () => {
				const session = await reserve();
				if (wrapped.has(session)) return session;
				wrapped.add(session);
				const unsafe = session.unsafe.bind(session);
				session.unsafe = (async (query: string) => {
					if (armed && query.startsWith("SELECT dolt_commit")) commits++;
					if (query === "SELECT dolt_reset('--hard', 'HEAD')") resets++;
					if (
						armed &&
						stage === "checkout" &&
						query.startsWith("SELECT dolt_checkout('contrib/") &&
						!pending
					) {
						const rows = await unsafe(query);
						pending = unsafe("SELECT pg_sleep(2)").then(() => {
							nativeSettled = true;
							return rows;
						});
						return pending;
					}
					if (armed && query.startsWith("UPDATE knowledge SET")) {
						edits++;
						const rows = await unsafe(query);
						if (!pending) {
							pending = unsafe("SELECT pg_sleep(2)").then(() => {
								nativeSettled = true;
								return rows;
							});
							return pending;
						}
						return rows;
					}
					return unsafe(query);
				}) as typeof session.unsafe;
				return session;
			}) as typeof writer.reserve;
			let rival: Awaited<ReturnType<Sql["reserve"]>> | undefined;
			try {
				await store.registerDomain({
					id: domainId,
					name: "Persisted clean native proof",
				});
				contribution = await contributions.create({
					principal,
					message: "Historical committed entry",
					edits: [
						{
							op: "insert",
							entry: {
								id: rowId,
								domain: domainId,
								title: "Keep history",
								content: "Historical content",
							},
						},
					],
				});
				const seedHead = contribution.headCommit;
				expect(seedHead).toMatch(/^[a-z0-9]{32}$/);
				armed = true;
				const error = await contributions
					.appendCommit({
						contributionId: contribution.contributionId,
						principal,
						message: "Finite abandoned edit",
						edits: [
							{
								op: "patch",
								targetRowId: rowId,
								entry: { useWhen: "must be rolled back" },
							},
						],
					})
					.catch((failure: unknown) => failure);
				expect(error).toMatchObject({
					name: "KnowledgeWriteOutcomeUnknownError",
					retryable: false,
				});
				expect(edits).toBe(stage === "edit" ? 1 : 0);
				expect(resets).toBe(0);
				expect(nativeSettled).toBe(false);
				expect(commits).toBe(0);
				await competitor.unsafe("SELECT 1");
				rival = await competitor.reserve();
				const rivalSession = rival;
				await expect
					.poll(
						async () => {
							try {
								const guard = await acquireDoltWriterLocks(rivalSession, {
									protocol: "database",
									lockWaitMs: 0,
								});
								earlyAdmission ||= !nativeSettled;
								await guard.release();
								return true;
							} catch {
								return false;
							}
						},
						{ timeout: 5_000 },
					)
					.toBe(true);
				expect(earlyAdmission).toBe(false);
				expect(nativeSettled).toBe(true);
				expect(resets).toBe(stage === "edit" ? 1 : 0);
				expect(edits).toBe(stage === "edit" ? 1 : 0);
				expect(commits).toBe(0);
				await expect(
					writer.unsafe("SELECT active_branch() AS branch_name"),
				).resolves.toEqual([{ branch_name: "main" }]);
				await expect(
					writer.unsafe("SELECT * FROM dolt.status"),
				).resolves.toHaveLength(0);
				await rival.unsafe(`SELECT dolt_checkout('${contribution.branch}')`);
				await expect(
					rival.unsafe("SELECT dolt_hashof('HEAD') AS hash"),
				).resolves.toEqual([{ hash: seedHead }]);
				await expect(
					rival.unsafe(
						`SELECT title, content, use_when FROM knowledge WHERE id = '${rowId}'`,
					),
				).resolves.toEqual([
					{
						title: "Keep history",
						content: "Historical content",
						use_when: null,
					},
				]);
				await rival.unsafe("SELECT dolt_checkout('main')");
				rival.release();
				rival = undefined;
				const fresh = await contributions.appendCommit({
					contributionId: contribution.contributionId,
					principal,
					message: "Legitimate new intent",
					edits: [
						{
							op: "patch",
							targetRowId: rowId,
							entry: { useWhen: "new committed intent" },
						},
					],
				});
				expect(fresh.commitHash).not.toBe(seedHead);
				expect(edits).toBe(stage === "edit" ? 2 : 1);
				expect(resets).toBe(stage === "edit" ? 1 : 0);
				expect(commits).toBe(2);
				await expect(
					reader.unsafe(
						`SELECT commit_count FROM knowledge_contributions WHERE id = '${contribution.contributionId}'`,
					),
				).resolves.toEqual([{ commit_count: 2 }]);
			} finally {
				await pending?.catch(() => undefined);
				rival?.release();
				if (contribution)
					await contributions
						.close({
							contributionId: contribution.contributionId,
							principal,
							reason: "owned native proof complete",
						})
						.catch(() => undefined);
				await Promise.allSettled(
					[writer, reader, competitor].map((client) =>
						client.end({ timeout: 0 }),
					),
				);
			}
		},
		15_000,
	);
	it.each(["checkout", "content"] as const)(
		"recovers finite initial contribution %s on its proven new branch",
		async (stage) => {
			const writer = postgres(dbUrl, { max: 1, fetch_types: false }),
				reader = postgres(dbUrl, { max: 1, fetch_types: false }),
				competitor = postgres(dbUrl, { max: 1, fetch_types: false });
			const runner = new DoltBranchSessionRunner(writer, {
				writerProtocol: "database",
				queryTimeoutMs: 500,
			});
			const contributions = new DoltgresKnowledgeContributionAdapter({
				sql: reader,
				writerSession: runner,
			});
			const store = new DoltgresKnowledgeStoreAdapter({
				sql: reader,
				writerSession: runner,
			});
			const principal = { id: `native-fresh-${stage}`, kind: "agent" as const },
				domain = `fresh-native-${stage}`,
				rowId = `fresh-native-entry-${stage}`;
			let armed = false,
				nativeSettled = false,
				earlyAdmission = false,
				branch = "",
				edits = 0,
				resets = 0,
				commits = 0;
			let pending: Promise<unknown> | undefined;
			let rival: Awaited<ReturnType<Sql["reserve"]>> | undefined;
			let fresh: Awaited<ReturnType<typeof contributions.create>> | undefined;
			const reserve = writer.reserve.bind(writer),
				wrapped = new WeakSet<object>();
			writer.reserve = (async () => {
				const session = await reserve();
				if (wrapped.has(session)) return session;
				wrapped.add(session);
				const unsafe = session.unsafe.bind(session);
				session.unsafe = (async (query: string) => {
					if (armed && query.startsWith("SELECT dolt_commit(")) commits++;
					if (query === "SELECT dolt_reset('--hard', 'HEAD')") resets++;
					const creating = query.startsWith(
						"SELECT dolt_checkout('-b', 'contrib/",
					);
					if (armed && creating) branch = query.split("'")[3]!;
					if (armed && query.startsWith("INSERT INTO knowledge ")) edits++;
					if (
						armed &&
						!pending &&
						(stage === "checkout"
							? creating
							: query.startsWith("INSERT INTO knowledge "))
					) {
						const rows = await unsafe(query);
						pending = unsafe("SELECT pg_sleep(2)").then(() => {
							nativeSettled = true;
							return rows;
						});
						return pending;
					}
					return unsafe(query);
				}) as typeof session.unsafe;
				return session;
			}) as typeof writer.reserve;
			try {
				await store.registerDomain({
					id: domain,
					name: "Native fresh branch proof",
				});
				const base = String(
					(await reader.unsafe("SELECT dolt_hashof('main') AS hash"))[0]?.hash,
				);
				const input = {
					principal,
					message: "One original contribution intent",
					edits: [
						{
							op: "insert" as const,
							entry: {
								id: rowId,
								domain,
								title: "Fresh intent",
								content: "No uncommitted residue",
							},
						},
					],
				};
				armed = true;
				const error = await contributions.create(input).catch((error) => error);
				expect(error).toMatchObject({
					name: "KnowledgeWriteOutcomeUnknownError",
					retryable: false,
					receipt: { lookup: { branch: expect.stringMatching(/^contrib\//) } },
				});
				expect(branch).toMatch(/^contrib\//);
				expect(edits).toBe(stage === "content" ? 1 : 0);
				expect(resets).toBe(0);
				expect(commits).toBe(0);
				expect(nativeSettled).toBe(false);
				await competitor.unsafe("SELECT 1");
				rival = await competitor.reserve();
				const session = rival;
				await expect
					.poll(
						async () => {
							try {
								const guard = await acquireDoltWriterLocks(session, {
									protocol: "database",
									lockWaitMs: 0,
								});
								earlyAdmission ||= !nativeSettled;
								await guard.release();
								return true;
							} catch {
								return false;
							}
						},
						{ timeout: 5000 },
					)
					.toBe(true);
				expect(earlyAdmission).toBe(false);
				expect(nativeSettled).toBe(true);
				expect(resets).toBe(stage === "content" ? 1 : 0);
				expect(edits).toBe(stage === "content" ? 1 : 0);
				expect(commits).toBe(0);
				await expect(
					writer.unsafe("SELECT active_branch() AS branch"),
				).resolves.toEqual([{ branch: "main" }]);
				await expect(
					writer.unsafe("SELECT * FROM dolt.status"),
				).resolves.toHaveLength(0);
				await expect(
					reader.unsafe(
						`SELECT id FROM knowledge_contributions WHERE branch = '${branch}'`,
					),
				).resolves.toHaveLength(0);
				const guard = await acquireDoltWriterLocks(session, {
					protocol: "database",
					lockWaitMs: 0,
				});
				try {
					await session.unsafe(`SELECT dolt_checkout('${branch}')`);
					await expect(
						session.unsafe("SELECT dolt_hashof('HEAD') AS hash"),
					).resolves.toEqual([{ hash: base }]);
					await expect(
						session.unsafe("SELECT * FROM dolt.status"),
					).resolves.toHaveLength(0);
					await expect(
						session.unsafe(`SELECT id FROM knowledge WHERE id = '${rowId}'`),
					).resolves.toHaveLength(0);
					await session.unsafe("SELECT dolt_checkout('main')");
				} finally {
					await guard.release();
				}
				rival.release();
				rival = undefined;
				armed = false;
				fresh = await contributions.create({
					...input,
					message: "New inspected request after settlement",
				});
				expect(fresh.commitCount).toBe(1);
				expect(fresh.branch).not.toBe(branch);
				expect(edits).toBe(stage === "content" ? 1 : 0);
				expect(commits).toBe(0);
				await expect(
					reader.unsafe(
						`SELECT commit_count FROM knowledge_contributions WHERE id = '${fresh.contributionId}'`,
					),
				).resolves.toEqual([{ commit_count: 1 }]);
			} finally {
				await pending?.catch(() => undefined);
				rival?.release();
				armed = false;
				if (fresh)
					await contributions
						.close({
							contributionId: fresh.contributionId,
							principal,
							reason: "Fresh proof cleanup",
						})
						.catch(() => undefined);
				await Promise.allSettled(
					[writer, reader, competitor].map((client) =>
						client.end({ timeout: 0 }),
					),
				);
			}
		},
		15000,
	);
	it.each(["create", "append", "close"] as const)(
		"recovers finite %s metadata only on its owned operation branch",
		async (stage) => {
			const writer = postgres(dbUrl, { max: 1, fetch_types: false });
			const reader = postgres(dbUrl, { max: 1, fetch_types: false });
			const competitor = postgres(dbUrl, { max: 1, fetch_types: false });
			const runner = new DoltBranchSessionRunner(writer, {
				writerProtocol: "database",
				queryTimeoutMs: 500,
			});
			const contributions = new DoltgresKnowledgeContributionAdapter({
				sql: reader,
				writerSession: runner,
			});
			const store = new DoltgresKnowledgeStoreAdapter({
				sql: reader,
				writerSession: runner,
			});
			const principal = {
				id: `native-metadata-${stage}`,
				kind: "agent" as const,
			};
			const domain = `metadata-native-${stage}`,
				rowId = `metadata-native-entry-${stage}`;
			let armed = false,
				nativeSettled = false,
				earlyAdmission = false,
				metadataCalls = 0,
				edits = 0,
				resets = 0;
			let branch = "",
				metadataBranch = "",
				metadataBase = "";
			let pending: Promise<unknown> | undefined;
			let seed: Awaited<ReturnType<typeof contributions.create>> | undefined;
			let fresh: Awaited<ReturnType<typeof contributions.create>> | undefined;
			let rival: Awaited<ReturnType<Sql["reserve"]>> | undefined;
			const reserve = writer.reserve.bind(writer),
				wrapped = new WeakSet<object>();
			writer.reserve = (async () => {
				const session = await reserve();
				if (wrapped.has(session)) return session;
				wrapped.add(session);
				const unsafe = session.unsafe.bind(session);
				session.unsafe = (async (query: string) => {
					if (query.startsWith("SELECT dolt_checkout('-b', 'contrib/"))
						branch = query.split("'")[3]!;
					if (armed && query.startsWith("UPDATE knowledge SET")) edits++;
					if (query === "SELECT dolt_reset('--hard', 'HEAD')") resets++;
					const targeted =
						stage === "create"
							? query.startsWith("INSERT INTO knowledge_contributions ")
							: stage === "append"
								? query.startsWith(
										"UPDATE knowledge_contributions SET head_commit",
									)
								: query.startsWith(
										"UPDATE knowledge_contributions SET state = 'closed'",
									);
					if (armed && targeted) {
						metadataCalls++;
						metadataBranch = String(
							(await unsafe("SELECT active_branch() AS branch"))[0]?.branch,
						);
						metadataBase = String(
							(await unsafe("SELECT dolt_hashof('HEAD') AS hash"))[0]?.hash,
						);
						const rows = await unsafe(query);
						if (!pending) {
							pending = unsafe("SELECT pg_sleep(2)").then(() => {
								nativeSettled = true;
								return rows;
							});
							return pending;
						}
						return rows;
					}
					return unsafe(query);
				}) as typeof session.unsafe;
				return session;
			}) as typeof writer.reserve;
			const createInput = {
				principal,
				message: "Historical metadata intent",
				edits: [
					{
						op: "insert" as const,
						entry: {
							id: rowId,
							domain,
							title: "Historical entry",
							content: "Keep committed content",
						},
					},
				],
			};
			try {
				await store.registerDomain({
					id: domain,
					name: "Native metadata proof",
				});
				if (stage !== "create") seed = await contributions.create(createInput);
				armed = true;
				const outcome = await (
					stage === "create"
						? contributions.create(createInput)
						: stage === "close"
							? contributions.close({
									contributionId: seed!.contributionId,
									principal,
									reason: "Finite close metadata",
								})
							: contributions.appendCommit({
									contributionId: seed!.contributionId,
									principal,
									message: "Persisted append metadata",
									edits: [
										{
											op: "patch",
											targetRowId: rowId,
											entry: { useWhen: "historical committed append" },
										},
									],
								})
				).catch((error) => error);
				expect(outcome).toMatchObject({
					name: "KnowledgeWriteOutcomeUnknownError",
					retryable: false,
					receipt: { lookup: { branch: expect.stringMatching(/^dolt-op\//) } },
				});
				expect(metadataBranch).toMatch(/^dolt-op\//);
				expect(metadataCalls).toBe(1);
				expect(resets).toBe(0);
				expect(nativeSettled).toBe(false);
				await competitor.unsafe("SELECT 1");
				rival = await competitor.reserve();
				const session = rival;
				await expect
					.poll(
						async () => {
							try {
								const guard = await acquireDoltWriterLocks(session, {
									protocol: "database",
									lockWaitMs: 0,
								});
								earlyAdmission ||= !nativeSettled;
								await guard.release();
								return true;
							} catch {
								return false;
							}
						},
						{ timeout: 5000 },
					)
					.toBe(true);
				expect(earlyAdmission).toBe(false);
				expect(nativeSettled).toBe(true);
				expect(resets).toBe(1);
				expect(metadataCalls).toBe(1);
				await expect(
					writer.unsafe("SELECT active_branch() AS branch"),
				).resolves.toEqual([{ branch: "main" }]);
				await expect(
					writer.unsafe("SELECT * FROM dolt.status"),
				).resolves.toHaveLength(0);
				await expect(
					reader.unsafe(
						`SELECT state, head_commit, commit_count FROM knowledge_contributions WHERE branch = '${branch}'`,
					),
				).resolves.toEqual(
					stage === "create"
						? []
						: [
								{
									state: "open",
									head_commit: seed!.headCommit,
									commit_count: 1,
								},
							],
				);
				const guard = await acquireDoltWriterLocks(session, {
					protocol: "database",
					lockWaitMs: 0,
				});
				try {
					await session.unsafe(`SELECT dolt_checkout('${metadataBranch}')`);
					await expect(
						session.unsafe("SELECT dolt_hashof('HEAD') AS hash"),
					).resolves.toEqual([{ hash: metadataBase }]);
					await expect(
						session.unsafe("SELECT * FROM dolt.status"),
					).resolves.toHaveLength(0);
					await session.unsafe(`SELECT dolt_checkout('${branch}')`);
					const hash = String(
						(await session.unsafe("SELECT dolt_hashof('HEAD') AS hash"))[0]
							?.hash,
					);
					expect(hash).toMatch(/^[a-z0-9]{32}$/);
					if (stage === "append") expect(hash).not.toBe(seed!.headCommit);
					if (stage === "close") expect(hash).toBe(seed!.headCommit);
					await expect(
						session.unsafe(
							`SELECT content, use_when FROM knowledge WHERE id = '${rowId}'`,
						),
					).resolves.toEqual([
						{
							content: "Keep committed content",
							use_when:
								stage === "append" ? "historical committed append" : null,
						},
					]);
					await session.unsafe("SELECT dolt_checkout('main')");
				} finally {
					await guard.release();
				}
				rival.release();
				rival = undefined;
				if (stage === "append") {
					await expect(
						contributions.appendCommit({
							contributionId: seed!.contributionId,
							principal,
							message: "Inspect before replay",
							edits: [
								{
									op: "patch",
									targetRowId: rowId,
									entry: { useWhen: "must not replay" },
								},
							],
						}),
					).rejects.toMatchObject({ name: "ContributionConflictError" });
					expect(edits).toBe(1);
					expect(metadataCalls).toBe(1);
				}
				armed = false;
				fresh = await contributions.create({
					principal,
					message: "Distinct fresh intent after settlement",
				});
				expect(fresh.state).toBe("open");
				expect(metadataCalls).toBe(1);
			} finally {
				await pending?.catch(() => undefined);
				rival?.release();
				armed = false;
				for (const contribution of [seed, fresh])
					if (contribution)
						await contributions
							.close({
								contributionId: contribution.contributionId,
								principal,
								reason: "Native metadata proof cleanup",
							})
							.catch(() => undefined);
				// A create whose metadata never landed retains its historical branch as
				// an inspection receipt; no automatic reset/deletion of that evidence.
				await Promise.allSettled(
					[writer, reader, competitor].map((client) =>
						client.end({ timeout: 0 }),
					),
				);
			}
		},
		15000,
	);
	it("accounts for two admitted producers and waits for their finite native cleanup", async () => {
		const sleepSeconds = 12;
		const queryTimeoutMs = 500;
		// Fixture allocation: two independent max-one producer generations. This
		// is explicit workload accounting, not a server-enforced production cap.
		const fixtureOverlapBudget = 2;
		let stallPrime = true;
		let primeSettled = false;
		let freshCreated = false;
		const clients: Sql[] = [];
		const producerPids: number[] = [];
		const snapshots: unknown[] = [];
		const observer = postgres(dbUrl, { max: 1, fetch_types: false });
		const reader = postgres(dbUrl, { max: 1, fetch_types: false });
		let retirements = 0;
		let recreations = 0;
		let admissions = 0;
		let mutationQueries = 0;
		let lastSleepStartedAt = 0;
		const pause = (ms: number) =>
			new Promise((resolve) => setTimeout(resolve, ms));
		const makeWriter = () => {
			const client = postgres(dbUrl, { max: 1, fetch_types: false });
			const unsafe = client.unsafe.bind(client);
			const end = client.end.bind(client);
			const reserve = client.reserve.bind(client);
			client.unsafe = ((query: string) => {
				if (query === "SELECT 1 AS work_items_ready" && stallPrime) {
					lastSleepStartedAt = Date.now();
					// Real finite engine work at the production pre-guard prime seam.
					return unsafe(`SELECT pg_sleep(${sleepSeconds})`).then(() => {
						primeSettled = true;
						return [];
					});
				}
				if (/INSERT|UPDATE|DELETE|dolt_|advisory/i.test(query))
					mutationQueries++;
				return unsafe(query);
			}) as typeof client.unsafe;
			client.reserve = (async () => {
				admissions++;
				const session = await reserve();
				const execute = session.unsafe.bind(session);
				session.unsafe = ((query: string) => {
					if (/^(INSERT|UPDATE|DELETE)\b/i.test(query)) mutationQueries++;
					return execute(query);
				}) as typeof session.unsafe;
				return session;
			}) as typeof client.reserve;
			client.end = (async (options) => {
				await end(options);
				retirements++;
			}) as typeof client.end;
			clients.push(client);
			return client;
		};
		let writer = makeWriter();
		const adapter = new DoltgresWorkItemAdapter(writer, {
			readClient: reader,
			writerLockProtocol: "database",
			queryTimeoutMs,
			recreateClient: () => {
				recreations++;
				writer = makeWriter();
				return writer;
			},
		});
		const census = async () =>
			observer.unsafe<{ pid: number; state: string; query: string }[]>(
				`SELECT DISTINCT pid, state, query FROM pg_catalog.pg_stat_activity WHERE pid IN (${producerPids.join(",")}) ORDER BY pid`,
			);
		const confirmNativeSleep = async (pid: number) => {
			const deadline = Date.now() + queryTimeoutMs;
			while (Date.now() < deadline) {
				const rows = await census();
				if (
					rows.some(
						(row) =>
							Number(row.pid) === pid &&
							row.state === "active" &&
							row.query.includes("pg_sleep"),
					)
				)
					return;
				await pause(5);
			}
			throw new Error(
				`Native sleep did not start before retirement for PID ${pid}`,
			);
		};
		let child: ReturnType<typeof spawn> | undefined;
		let childDeadline: ReturnType<typeof setTimeout> | undefined;
		let childClosed:
			| Promise<{ code: number | null; signal: string | null }>
			| undefined;
		let firstSleepStartedAt = 0;
		try {
			const observerPid = Number(
				(await observer.unsafe("SELECT pg_backend_pid() AS pid"))[0]?.pid,
			);
			const original = writer;
			const pid = Number(
				(await writer.unsafe("SELECT pg_backend_pid() AS pid"))[0]?.pid,
			);
			expect(Number.isInteger(pid)).toBe(true);
			expect(pid).not.toBe(observerPid);
			producerPids.push(pid);
			for (let wave = 0; wave < 4; wave++) {
				const result = adapter
					.create(
						{
							id: toWorkItemId("task.9610"),
							type: "task",
							title: "Must never execute",
						},
						"orphan-budget-probe",
					)
					.catch((error: unknown) => error);
				if (wave === 0) {
					await confirmNativeSleep(pid);
					firstSleepStartedAt = lastSleepStartedAt;
				}
				expect(await result).toBeInstanceOf(WorkItemsBusyError);
				expect(retirements).toBe(0);
				expect(recreations).toBe(0);
				expect(writer).toBe(original);
				const rows = await census();
				expect(rows).toHaveLength(1);
				expect(Number(rows[0]?.pid)).toBe(pid);
				snapshots.push({ wave, rows });
			}

			// A separate Node process imports the BUILT public adapter, not Vitest's
			// workspace alias. Its independently admitted pool adds one generation;
			// process exit is not native completion, so count its retained query.
			const adapterUrl = pathToFileURL(
				path.join(
					REPO_ROOT,
					"packages/work-items/dist/adapters/doltgres/index.js",
				),
			).href;
			const source = `
	import postgres from 'postgres';
	import { DoltgresWorkItemAdapter, WorkItemsBusyError } from ${JSON.stringify(adapterUrl)};
	const pools = [];
	let retired = 0, recreated = 0, admissions = 0, mutations = 0;
	function makeWriter() {
	  const pool = postgres(process.env.ORPHAN_PROBE_DB_URL, {max: 1, fetch_types: false});
	  const unsafe = pool.unsafe.bind(pool), end = pool.end.bind(pool), reserve = pool.reserve.bind(pool);
	  pool.unsafe = query => query === 'SELECT 1 AS work_items_ready'
	    ? unsafe('SELECT pg_sleep(${sleepSeconds})').then(() => [])
	    : (mutations += /INSERT|UPDATE|DELETE|dolt_|advisory/i.test(query) ? 1 : 0, unsafe(query));
	  pool.reserve = () => { admissions++; return reserve(); };
	  pool.end = async options => { await end(options); retired++; };
	  pools.push(pool); return pool;
	}
	const writer = makeWriter();
	const reader = postgres(process.env.ORPHAN_PROBE_DB_URL, {max: 1, fetch_types: false});
	const adapter = new DoltgresWorkItemAdapter(writer, {readClient: reader, writerLockProtocol: 'database', queryTimeoutMs: ${queryTimeoutMs},
	  recreateClient: () => { recreated++; return makeWriter(); }});
	const pid = Number((await writer.unsafe('SELECT pg_backend_pid() AS pid'))[0].pid);
	process.send({phase: 'ready', pid, processPid: process.pid});
	await new Promise(resolve => process.once('message', resolve));
	const result = await adapter.create({id: 'task.9611', type: 'task', title: 'Must never execute'}, 'orphan-child').catch(error => error);
	process.send({phase: 'result', busy: result instanceof WorkItemsBusyError, retired, recreated, admissions, mutations}, async () => {
	  await Promise.allSettled([...pools, reader].map(pool => pool.end({timeout: 0})));
	  process.exit(0);
	});`;
			child = spawn(
				process.execPath,
				["--input-type=module", "--eval", source],
				{
					cwd: path.join(REPO_ROOT, "app"),
					env: { ...process.env, ORPHAN_PROBE_DB_URL: dbUrl },
					stdio: ["ignore", "pipe", "pipe", "ipc"],
				},
			);
			const childProcess = child;
			let diagnostics = "";
			child.stderr?.on("data", (data: Buffer) => {
				diagnostics += data.toString();
			});
			childClosed = new Promise((resolve, reject) => {
				childProcess.once("error", reject);
				childProcess.once("close", (code, signal) => resolve({ code, signal }));
			});
			childDeadline = setTimeout(() => childProcess.kill("SIGKILL"), 6_000);
			const message = (phase: string) =>
				new Promise<Record<string, unknown>>((resolve, reject) => {
					const receive = (value: unknown) => {
						if (
							value &&
							typeof value === "object" &&
							"phase" in value &&
							value.phase === phase
						) {
							childProcess.off("message", receive);
							resolve(value as Record<string, unknown>);
						}
					};
					childProcess.on("message", receive);
					void childClosed?.then(
						() =>
							reject(new Error(`Child exited before ${phase}: ${diagnostics}`)),
						reject,
					);
				});
			const ready = await message("ready");
			expect(ready.processPid).toBe(child.pid);
			expect(ready.processPid).not.toBe(process.pid);
			const childPid = Number(ready.pid);
			expect(Number.isInteger(childPid)).toBe(true);
			expect(childPid).toBeGreaterThan(0);
			expect(childPid).not.toBe(observerPid);
			expect(producerPids).not.toContain(childPid);
			producerPids.push(childPid);
			const resultMessage = message("result");
			// Preserve a setup/invariant failure if the teardown closes IPC before
			// this result is awaited; the original promise still propagates below.
			void resultMessage.catch(() => undefined);
			lastSleepStartedAt = Date.now();
			child.send({ phase: "retry" });
			await confirmNativeSleep(childPid);
			expect(await resultMessage).toMatchObject({
				busy: true,
				retired: 0,
				recreated: 0,
				admissions: 0,
				mutations: 0,
			});
			expect(await childClosed, diagnostics).toEqual({ code: 0, signal: null });
			clearTimeout(childDeadline);
			expect(admissions).toBe(0);
			expect(mutationQueries).toBe(0);
			expect(new Set(producerPids).size).toBe(2);
			const remaining = await census();
			snapshots.push({ phase: "after-child-exit", rows: remaining });
			console.info(
				"native admitted producer overlap",
				JSON.stringify({ fixtureOverlapBudget, producerPids, snapshots }),
			);
			// Reject a timing-induced false pass: no sleep may have finished
			// naturally before the native resource bound is measured.
			expect(Date.now() - firstSleepStartedAt).toBeLessThan(
				(sleepSeconds - 1) * 1_000,
			);
			expect(remaining.length, JSON.stringify(snapshots)).toBeLessThanOrEqual(
				fixtureOverlapBudget,
			);
			expect(remaining).toHaveLength(2);
			await expect
				.poll(
					async () => {
						const rows = await census();
						return (
							rows.some((row) => Number(row.pid) === childPid) ||
							rows.some(
								(row) =>
									row.state === "active" && row.query.includes("pg_sleep"),
							)
						);
					},
					{ timeout: sleepSeconds * 1_000 + 2_000 },
				)
				.toBe(false);
			expect(primeSettled).toBe(true);
			await pause(0);
			stallPrime = false;
			await expect(adapter.get(toWorkItemId("task.9610"))).resolves.toBeNull();
			const fresh = await adapter.create(
				{
					id: toWorkItemId("task.9612"),
					type: "task",
					title: "New intent after actual settlement",
				},
				"orphan-budget-probe",
			);
			freshCreated = true;
			expect(fresh.id).toBe("task.9612");
			expect(admissions).toBe(1);
			expect(mutationQueries).toBe(1);
			expect(retirements).toBe(0);
			expect(recreations).toBe(0);
		} finally {
			if (freshCreated)
				await adapter
					.patch(
						{ id: toWorkItemId("task.9612"), set: { status: "cancelled" } },
						"orphan-budget-probe",
					)
					.catch(() => undefined);
			if (childDeadline) clearTimeout(childDeadline);
			if (child && child.exitCode === null && child.signalCode === null)
				child.kill("SIGKILL");
			await childClosed?.catch(() => undefined);
			await Promise.allSettled(
				[...clients, reader].map((client) => client.end({ timeout: 0 })),
			);
			// Finite owned work only: let the last sleep finish before closing
			// the auditor; suite teardown then destroys the disposable engine.
			await pause(
				Math.max(
					0,
					lastSleepStartedAt + sleepSeconds * 1_000 + 250 - Date.now(),
				),
			);
			await observer.end({ timeout: 0 });
		}
	}, 30_000);
	it.each(["pre-guard", "merged"] as const)(
		"replaces a sole crashed producer after %s with explicit overlap and canonical recovery",
		async (stage) => {
			const sleepSeconds = 8;
			// Two generations are explicitly admitted for this fixture. This is not
			// a Dolt-native cap or a production deployment allocation certificate.
			const fixtureOverlapBudget = 2;
			const observer = postgres(dbUrl, { max: 1, fetch_types: false });
			const itemId = stage === "merged" ? "task.9622" : "task.9620";
			const freshId = "task.9623";
			const adapterUrl = pathToFileURL(
				path.join(
					REPO_ROOT,
					"packages/work-items/dist/adapters/doltgres/index.js",
				),
			).href;
			const children: Array<ReturnType<typeof start>> = [];
			let sleepStartedAt = 0;
			function start(role: "original" | "replacement") {
				const source = `
import postgres from 'postgres';
import { DoltgresWorkItemAdapter } from ${JSON.stringify(adapterUrl)};
const stage = ${JSON.stringify(stage)}, role = ${JSON.stringify(role)}, itemId = ${JSON.stringify(itemId)};
const writer = postgres(process.env.RESTART_PROBE_DB_URL, {max: 1, fetch_types: false});
const reader = postgres(process.env.RESTART_PROBE_DB_URL, {max: 1, fetch_types: false});
const unsafe = writer.unsafe.bind(writer), reserve = writer.reserve.bind(writer);
let inserts = 0, delayed = false;
writer.unsafe = query => role === 'original' && stage === 'pre-guard' && query === 'SELECT 1 AS work_items_ready'
 ? unsafe('SELECT pg_sleep(${sleepSeconds})').then(() => []) : unsafe(query);
writer.reserve = async () => {
 const session = await reserve(), execute = session.unsafe.bind(session);
 session.unsafe = async query => {
  if (query.startsWith('INSERT INTO work_items')) inserts++;
  const rows = await execute(query);
  if (role === 'original' && stage === 'merged' && query.startsWith('SELECT hash, fast_forward, conflicts, message FROM dolt_merge(') && !delayed) {
   delayed = true;
   return execute('SELECT pg_sleep(${sleepSeconds})').then(() => rows);
  }
  return rows;
 };
 return session;
};
const adapter = new DoltgresWorkItemAdapter(writer, {readClient: reader, writerLockProtocol: 'database', queryTimeoutMs: role === 'original' ? 1000 : 5000});
const wait = phase => new Promise(resolve => { const receive = message => { if (message?.phase === phase) { process.off('message', receive); resolve(); } }; process.on('message', receive); });
const pid = Number((await writer.unsafe('SELECT pg_backend_pid() AS pid'))[0].pid);
process.send({phase: 'ready', pid, processPid: process.pid});
await wait('go');
if (role === 'original') {
 const error = await adapter.create({id: itemId, type: 'task', title: 'One canonical original intent'}, 'restart-probe').catch(error => error);
 process.send({phase: 'outcome', name: error.name, retryable: error.retryable, lookup: error.receipt?.lookup ?? null, inserts});
 await new Promise(() => {});
} else {
 if (stage === 'merged') {
  const item = await adapter.get(itemId);
  process.send({phase: 'lookup', item});
  await wait('admit');
 }
 // A nonretryable landed-intent receipt is resolved by canonical lookup;
 // it is never permission to issue the original DML a second time.
 const retry = stage === 'merged' ? await adapter.get(itemId) : await adapter.create({id: itemId, type: 'task', title: 'One canonical original intent'}, 'restart-probe').catch(error => error);
 if (stage === 'merged') await adapter.create({id: ${JSON.stringify(freshId)}, type: 'task', title: 'Distinct new request'}, 'restart-probe');
 const item = await adapter.get(itemId);
 // Test-only quiescence probe: waits for the reserved cleanup to return the
 // max-one writer before process teardown, without cancelling native work.
 await writer.unsafe('SELECT 1');
 process.send({phase: 'result', item, retryName: retry.name ?? null, retryId: retry.id ?? null, inserts}, async () => {
  await Promise.allSettled([writer, reader].map(client => client.end({timeout: 0})));
  process.exit(0);
 });
}`;
				const child = spawn(
					process.execPath,
					["--input-type=module", "--eval", source],
					{
						cwd: path.join(REPO_ROOT, "app"),
						env: { ...process.env, RESTART_PROBE_DB_URL: dbUrl },
						stdio: ["ignore", "ignore", "pipe", "ipc"],
					},
				);
				const buffered = new Map<string, Record<string, unknown>>();
				const listeners = new Map<
					string,
					(value: Record<string, unknown>) => void
				>();
				let diagnostics = "";
				child.stderr?.on("data", (data: Buffer) => {
					diagnostics += data.toString();
				});
				child.on("message", (value) => {
					if (
						!value ||
						typeof value !== "object" ||
						!("phase" in value) ||
						typeof value.phase !== "string"
					)
						return;
					const receive = listeners.get(value.phase);
					if (receive) {
						listeners.delete(value.phase);
						receive(value as Record<string, unknown>);
					} else buffered.set(value.phase, value as Record<string, unknown>);
				});
				const closed = new Promise<{
					code: number | null;
					signal: string | null;
				}>((resolve, reject) => {
					child.once("error", reject);
					child.once("close", (code, signal) => resolve({ code, signal }));
				});
				void closed.catch(() => undefined);
				const deadline = setTimeout(() => child.kill("SIGKILL"), 20_000);
				void closed
					.finally(() => clearTimeout(deadline))
					.catch(() => undefined);
				return {
					child,
					closed,
					wait: (phase: string) => {
						const existing = buffered.get(phase);
						if (existing) {
							buffered.delete(phase);
							return Promise.resolve(existing);
						}
						return new Promise<Record<string, unknown>>((resolve, reject) => {
							listeners.set(phase, resolve);
							void closed.then(
								() =>
									reject(
										new Error(
											`Producer exited before ${phase}: ${diagnostics}`,
										),
									),
								reject,
							);
						});
					},
				};
			}
			try {
				await observer.unsafe("SELECT 1");
				const original = start("original");
				children.push(original);
				const readyA = await original.wait("ready");
				expect(readyA.processPid).toBe(original.child.pid);
				const pidA = Number(readyA.pid);
				expect(Number.isInteger(pidA) && pidA > 0).toBe(true);
				sleepStartedAt = Date.now();
				original.child.send({ phase: "go" });
				await expect
					.poll(
						async () =>
							(
								await observer.unsafe(
									`SELECT pid FROM pg_catalog.pg_stat_activity WHERE pid = ${pidA} AND state = 'active' AND query LIKE '%pg_sleep%'`,
								)
							).length,
						{ timeout: 3_000 },
					)
					.toBe(1);
				const outcome = await original.wait("outcome");
				expect(outcome.inserts).toBe(stage === "merged" ? 1 : 0);
				if (stage === "merged")
					expect(outcome).toMatchObject({
						name: "WorkItemWriteOutcomeUnknownError",
						retryable: false,
						lookup: { itemId },
					});
				else expect(outcome.name).toBe("WorkItemsBusyError");
				original.child.kill("SIGKILL");
				expect(await original.closed).toEqual({
					code: null,
					signal: "SIGKILL",
				});
				const retained = await observer.unsafe(
					`SELECT pid, state, query FROM pg_catalog.pg_stat_activity WHERE pid = ${pidA}`,
				);
				expect(retained).toMatchObject([
					{
						pid: pidA,
						state: "active",
						query: expect.stringContaining("pg_sleep"),
					},
				]);
				// Only now create the replacement OS process; A is never restarted.
				const replacement = start("replacement");
				children.push(replacement);
				const readyB = await replacement.wait("ready");
				expect(readyB.processPid).toBe(replacement.child.pid);
				expect(readyB.processPid).not.toBe(readyA.processPid);
				const pidB = Number(readyB.pid);
				expect(Number.isInteger(pidB) && pidB > 0 && pidB !== pidA).toBe(true);
				const overlap = await observer.unsafe(
					`SELECT DISTINCT pid, state, query FROM pg_catalog.pg_stat_activity WHERE pid IN (${pidA}, ${pidB})`,
				);
				expect(overlap).toHaveLength(fixtureOverlapBudget);
				console.info(
					"native producer replacement overlap",
					JSON.stringify({
						stage,
						fixtureOverlapBudget,
						overlap,
						oldProcessExited: true,
					}),
				);
				replacement.child.send({ phase: "go" });
				if (stage === "merged") {
					const lookup = await replacement.wait("lookup");
					expect(lookup.item).toMatchObject({
						id: itemId,
						title: "One canonical original intent",
						revision: 0,
					});
					// The nonretryable receipt is read back while the old native guard is
					// still counted. Admission waits for actual engine cleanup, not EOF.
					await expect
						.poll(
							async () =>
								(
									await observer.unsafe(
										`SELECT pid FROM pg_catalog.pg_stat_activity WHERE pid = ${pidA}`,
									)
								).length,
							{ timeout: 10_000 },
						)
						.toBe(0);
					replacement.child.send({ phase: "admit" });
				}
				const result = await replacement.wait("result");
				expect(result.item).toMatchObject({ id: itemId, revision: 0 });
				expect(result.inserts).toBe(1);
				expect(result.retryName).toBeNull();
				expect(result.retryId).toBe(itemId);
				expect(await replacement.closed).toEqual({ code: 0, signal: null });
				await expect
					.poll(
						async () =>
							(
								await observer.unsafe(
									`SELECT pid FROM pg_catalog.pg_stat_activity WHERE pid IN (${pidA}, ${pidB})`,
								)
							).length,
						{ timeout: 10_000 },
					)
					.toBe(0);
				await expect(
					observer.unsafe(
						`SELECT id, revision FROM work_items WHERE id = '${itemId}'`,
					),
				).resolves.toEqual([{ id: itemId, revision: 0 }]);
				if (stage === "merged") {
					const lookup = outcome.lookup as { branch: string };
					expect(lookup.branch).toMatch(/^work-item-op\//);
					await expect(
						observer.unsafe(
							`SELECT name FROM dolt.branches WHERE name = '${lookup.branch}'`,
						),
					).resolves.toHaveLength(0);
				}
			} finally {
				for (const producer of children)
					if (
						producer.child.exitCode === null &&
						producer.child.signalCode === null
					)
						producer.child.kill("SIGKILL");
				await Promise.allSettled(children.map((producer) => producer.closed));
				await new Promise((resolve) =>
					setTimeout(
						resolve,
						Math.max(
							0,
							sleepStartedAt + sleepSeconds * 1_000 + 500 - Date.now(),
						),
					),
				);
				await observer.end({ timeout: 0 });
			}
		},
		30_000,
	);
	it("canonical writer recreation rejects an explicit duplicate and admits a distinct fresh create", async () => {
		const observer = postgres(dbUrl, { max: 1, fetch_types: false });
		const reader = postgres(dbUrl, { max: 1, fetch_types: false });
		const writers: Sql[] = [];
		let inserts = 0;
		const recreateClient = () => {
			const pool = postgres(dbUrl, { max: 1, fetch_types: false });
			const reserve = pool.reserve.bind(pool),
				wrapped = new WeakSet<object>();
			pool.reserve = (async () => {
				const session = await reserve();
				if (wrapped.has(session)) return session;
				wrapped.add(session);
				const unsafe = session.unsafe.bind(session);
				session.unsafe = (async (query: string) => {
					if (query.startsWith("INSERT INTO work_items")) inserts++;
					return unsafe(query);
				}) as typeof session.unsafe;
				return session;
			}) as typeof pool.reserve;
			writers.push(pool);
			return pool;
		};
		const initial = recreateClient();
		const adapter = new DoltgresWorkItemAdapter(initial, {
			readClient: reader,
			recreateClient,
			writerLockProtocol: "database",
		});
		const id = toWorkItemId("task.9624"),
			freshId = toWorkItemId("task.9625");
		try {
			await adapter.create(
				{ id, type: "task", title: "Canonical duplicate fixture" },
				"native-duplicate-proof",
			);
			await initial.unsafe("SELECT 1");
			const pidA = Number(
				(await initial.unsafe("SELECT pg_backend_pid() AS pid"))[0]?.pid,
			);
			await expect(
				adapter.create(
					{ id, type: "task", title: "Canonical duplicate fixture" },
					"native-duplicate-proof",
				),
			).rejects.toMatchObject({ name: "WorkItemAlreadyExistsError" });
			// Existing terminal domain-error recovery retires the settled session.
			// Canonical DI supplies this factory; a factoryless constructor remains
			// unavailable after this path. This is not unknown-transport recovery.
			expect(writers).toHaveLength(2);
			const replacement = writers[1]!;
			const pidB = Number(
				(await replacement.unsafe("SELECT pg_backend_pid() AS pid"))[0]?.pid,
			);
			expect(Number.isInteger(pidA) && pidA > 0).toBe(true);
			expect(Number.isInteger(pidB) && pidB > 0 && pidB !== pidA).toBe(true);
			const nativeGenerations = await observer.unsafe(
				`SELECT pid, state, query FROM pg_catalog.pg_stat_activity WHERE pid IN (${pidA}, ${pidB})`,
			);
			expect(nativeGenerations.length).toBeLessThanOrEqual(2);
			console.info(
				"canonical duplicate recovery generations",
				JSON.stringify({
					perPoolBudget: 1,
					admittedGenerations: writers.length,
					nativeGenerations,
				}),
			);
			await expect
				.poll(
					async () =>
						(
							await observer.unsafe(
								`SELECT pid FROM pg_catalog.pg_stat_activity WHERE pid = ${pidA}`,
							)
						).length,
					{ timeout: 5000 },
				)
				.toBe(0);
			await expect(
				adapter.create(
					{
						id: freshId,
						type: "task",
						title: "Distinct request after duplicate",
					},
					"native-duplicate-proof",
				),
			).resolves.toMatchObject({ id: freshId, revision: 0 });
			await replacement.unsafe("SELECT 1");
			expect(writers).toHaveLength(2);
			expect(inserts).toBe(3);
			await expect(
				reader.unsafe(
					`SELECT id, revision FROM work_items WHERE id IN ('${id}', '${freshId}') ORDER BY id`,
				),
			).resolves.toEqual([
				{ id, revision: 0 },
				{ id: freshId, revision: 0 },
			]);
		} finally {
			await Promise.allSettled(
				[...writers, reader, observer].map((client) =>
					client.end({ timeout: 0 }),
				),
			);
		}
	});
	it("knowledge and work-item writers share one database scope throughout a logical write", async () => {
		// Load the actual shipped JS bundles rather than Vitest workspace aliases.
		// Each public package embeds its own helper realm; the native DB mutex must still coordinate them.
		const { DoltBranchSessionRunner, DoltgresKnowledgeStoreAdapter } =
			(await import(
				/* @vite-ignore */ pathToFileURL(
					path.join(
						REPO_ROOT,
						"packages/knowledge-store/dist/adapters/doltgres/index.js",
					),
				).href
			)) as typeof import("@cogni/knowledge-store/adapters/doltgres");
		const { DoltgresWorkItemAdapter, WorkItemsBusyError } = (await import(
			/* @vite-ignore */ pathToFileURL(
				path.join(
					REPO_ROOT,
					"packages/work-items/dist/adapters/doltgres/index.js",
				),
			).href
		)) as typeof import("@cogni/work-items/adapters/doltgres");
		const knowledgeSql = postgres(dbUrl, { max: 1, fetch_types: false });
		const knowledgeRead = postgres(dbUrl, { max: 1, fetch_types: false });
		const workSql = postgres(dbUrl, { max: 1, fetch_types: false });
		const workRead = postgres(dbUrl, { max: 1, fetch_types: false });
		const store = new DoltgresKnowledgeStoreAdapter({
			sql: knowledgeRead,
			writerSession: new DoltBranchSessionRunner(knowledgeSql, {
				writerProtocol: "database",
			}),
		});
		const work = new DoltgresWorkItemAdapter(workSql, {
			writerLockProtocol: "database",
			readClient: workRead,
			lockWaitMs: 100,
			lockRetryMs: 10,
		});
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let entered: () => void = () => {};
		let failed: (error: unknown) => void = () => {};
		const ready = new Promise<void>((resolve, reject) => {
			entered = resolve;
			failed = reject;
		});
		let holding: Promise<unknown> | undefined;
		const id = toWorkItemId("task.9600");
		try {
			await store.registerDomain({ id: "scope-mix", name: "Scope proof" });
			await work.create(
				{ id, type: "task", title: "before mixed write" },
				"mixed-principal",
			);
			// Preserve the historical null-title case through the public write API.
			await store.withWrite(
				{
					operationId: "native.citation.seed",
					message: "seed direct citation pages"
				},
				async (write) => {
					await write.addKnowledge({
						id: "native-citation-root",
						domain: "scope-mix",
						title: "Citation root",
						content: "Root body",
						sourceType: "agent",
					});
					for (let i = 0; i < 7; i++) {
						const neighbor = `native-citation-${i}`;
						await write.addKnowledge({
							id: neighbor,
							domain: "scope-mix",
							title: `Neighbor ${i}`,
							content: "Neighbor body",
							sourceType: "agent",
						});
						await write.addCitation({
							id: `native-citation-edge-${i}`,
							citingId: i % 2 ? neighbor : "native-citation-root",
							citedId: i % 2 ? "native-citation-root" : neighbor,
							citationType: "supports",
						});
					}
					await write.deleteKnowledge("native-citation-0");
					await write.addKnowledge({
						id: "goal-native-committed",
						domain: "scope-mix",
						title: "Committed goal",
						content: "Existing commitment",
						entryType: "goal",
						evaluateAt: new Date("2027-01-01T00:00:00Z"),
						sourceType: "human"
					});
				}
			);
			const mainBefore = await knowledgeRead.unsafe(
				"SELECT dolt_hashof('main') AS hash",
			);
			holding = store.withWrite(
				{
					operationId: "native.knowledge.workitem.mix",
					message: "mixed writer proof"
				},
				async (write) => {
					await write.addKnowledge({
						id: "native-mixed-scope",
						domain: "scope-mix",
						title: "Scoped knowledge",
						content: "Atomic content",
						entryType: "finding",
						sourceType: "agent",
					});
					await write.addKnowledge({
						id: "goal-native-dirty",
						domain: "scope-mix",
						title: "Uncommitted goal",
						content: "Must remain branch-local",
						entryType: "goal",
						evaluateAt: new Date("2027-02-01T00:00:00Z"),
						sourceType: "human"
					});
					entered();
					await gate;
					return "committed";
				}
			);
			void holding.catch(failed);
			await ready;
			// Both pages must finish before releasing the independently held writer.
			// The shipped JS read adapter stays on MAIN while the writer has dirty branch DML.
			let pageDeadline: ReturnType<typeof setTimeout> | undefined;
			const pages = await Promise.race([
				(async () => {
					const goals = await store.listActiveGoals();
					expect(goals).toContainEqual({
						id: "goal-native-committed",
						title: "Committed goal",
						content: "Existing commitment",
						evaluateAt: new Date("2027-01-01T00:00:00Z")
					});
					expect(goals.some((goal) => goal.id === "goal-native-dirty")).toBe(
						false
					);
					const first = await store.listCitationLinks("native-citation-root");
					expect(first.links.map((link) => link.id)).toEqual(
						Array.from({ length: 5 }, (_, i) => `native-citation-edge-${i}`),
					);
					expect(first.nextCursor).toBe("native-citation-edge-4");
					const cursor = first.nextCursor;
					if (!cursor) throw new Error("missing citation continuation cursor");
					const second = await store.listCitationLinks("native-citation-root", cursor);
					expect(second.links.map((link) => link.id)).toEqual([
						"native-citation-edge-5",
						"native-citation-edge-6",
					]);
					expect(second.nextCursor).toBeNull();
					return [...first.links, ...second.links];
				})(),
				new Promise<never>((_, reject) => {
					pageDeadline = setTimeout(
						() => reject(new Error("citation read waited for writer release")),
						2_000,
					);
				})
			]).finally(() => clearTimeout(pageDeadline));
			expect(new Set(pages.map((link) => link.id)).size).toBe(7);
			for (const link of pages) {
				expect([link.citingId, link.citedId]).toContain("native-citation-root");
				expect(link).not.toHaveProperty("content");
				expect(link).not.toHaveProperty("outcome");
			}
			expect(pages[0]).toMatchObject({
				sourceTitle: "Citation root", targetTitle: null, context: null,
			});
			expect(pages[1]).toMatchObject({
				sourceTitle: "Neighbor 1", targetTitle: "Citation root",
			});
			await expect(store.getKnowledge("native-mixed-scope")).resolves.toBeNull();
			expect(
				await knowledgeRead.unsafe("SELECT dolt_hashof('main') AS hash"),
			).toEqual(mainBefore);
			expect(await knowledgeRead.unsafe("SELECT * FROM dolt_status")).toHaveLength(0);
			await expect(
				work.patch({ id, set: { title: "must wait" } }, "mixed-principal"),
			).rejects.toBeInstanceOf(WorkItemsBusyError);
			await expect(work.get(id)).resolves.toMatchObject({
				title: "before mixed write",
			});
			release();
			await expect(holding).resolves.toBe("committed");
			expect((await store.listActiveGoals()).map((goal) => goal.id)).toContain(
				"goal-native-dirty"
			);
			await expect(
				store.getKnowledge("native-mixed-scope"),
			).resolves.toMatchObject({ content: "Atomic content" });
			await expect(
				work.patch(
					{ id, set: { title: "after knowledge acknowledgement" } },
					"mixed-principal",
				),
			).resolves.toMatchObject({ title: "after knowledge acknowledgement" });
		} finally {
			release();
			await holding?.catch(() => undefined);
			await Promise.all(
				[knowledgeSql, knowledgeRead, workSql, workRead].map((client) =>
					client.end({ timeout: 0 }),
				),
			);
		}
	}, 15_000);
});
