// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Native engine regression: advisory names are process-wide; writer scopes are not. */
import {
	runDoltBranchMutation,
	acquireDoltWriterLocks,
	doltWriterLockKey,
	DoltNativeSessionExecutor,
	type DoltWriterLock,
} from "@cogni-dao/doltgres-admission";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import postgres, { type ReservedSql, type Sql } from "postgres";
import {
	GenericContainer,
	type StartedTestContainer,
	Wait,
} from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PASSWORD = "admission-test";
const DATABASE_A = "admission_a";
const DATABASE_B = "admission_b";

describe("Doltgres 0.57.3 common per-database writer protocol", () => {
	let container: StartedTestContainer;
	let origin: string;
	let first: Sql;
	let peer: Sql;
	let second: Sql;
	let a: ReservedSql;
	let aPeer: ReservedSql;
	let b: ReservedSql;
	beforeAll(async () => {
		container = await new GenericContainer("dolthub/doltgresql:0.57.3")
			.withEnvironment({ DOLTGRES_PASSWORD: PASSWORD })
			.withExposedPorts(5432)
			.withWaitStrategy(
				Wait.forLogMessage(/server (started|listening)/i, 1).withStartupTimeout(
					60_000,
				),
			)
			.start();
		origin = `postgresql://postgres:${PASSWORD}@${container.getHost()}:${container.getMappedPort(5432)}`;
		const admin = postgres(`${origin}/postgres`, {
			max: 1,
			fetch_types: false,
		});
		try {
			await admin.unsafe(`CREATE DATABASE ${DATABASE_A}`);
			await admin.unsafe(`CREATE DATABASE ${DATABASE_B}`);
		} finally {
			await admin.end({ timeout: 1 });
		}
		first = postgres(`${origin}/${DATABASE_A}`, { max: 1, fetch_types: false });
		peer = postgres(`${origin}/${DATABASE_A}`, { max: 1, fetch_types: false });
		second = postgres(`${origin}/${DATABASE_B}`, {
			max: 1,
			fetch_types: false,
		});
		// fetch_types=false cold reserve requires a completed priming query.
		for (const sql of [first, peer, second]) await sql.unsafe("SELECT 1");
		[a, aPeer, b] = await Promise.all([
			first.reserve(),
			peer.reserve(),
			second.reserve(),
		]);
	}, 90_000);
	afterAll(async () => {
		a?.release();
		aPeer?.release();
		b?.release();
		await Promise.all([
			first?.end({ timeout: 0 }),
			peer?.end({ timeout: 0 }),
			second?.end({ timeout: 0 }),
		]);
		await container?.stop();
	});

	it("native current_database revision identity maps checkout to the same physical root", async () => {
		const before = await a.unsafe("SELECT current_database() AS identity");
		expect(before[0]?.identity).toBe(DATABASE_A);
		await a.unsafe("SELECT dolt_checkout('-b', 'identity-proof', 'main')");
		try {
			const branch = await a.unsafe("SELECT current_database() AS identity");
			expect([DATABASE_A, `${DATABASE_A}/identity-proof`]).toContain(
				branch[0]?.identity,
			);
			expect(doltWriterLockKey(String(branch[0]?.identity))).toBe(
				doltWriterLockKey(DATABASE_A),
			);
		} finally {
			await a.unsafe("SELECT dolt_checkout('main')");
			await a.unsafe("SELECT dolt_branch('-D', 'identity-proof')");
		}
	});

	it("the unscoped legacy key blocks another database on the exact pinned engine", async () => {
		const held = await a.unsafe("SELECT pg_try_advisory_lock(5001001)");
		expect(held[0]?.pg_try_advisory_lock).toBe(true);
		try {
			const cross = await b.unsafe("SELECT pg_try_advisory_lock(5001001)");
			expect(cross[0]?.pg_try_advisory_lock).toBe(false);
			await expect(
				acquireDoltWriterLocks(b, { lockWaitMs: 20, lockRetryMs: 5 }),
			).rejects.toMatchObject({
				reason: "lock_contended",
				discardSession: false,
			});
		} finally {
			await a.unsafe("SELECT pg_advisory_unlock(5001001)");
		}
	});

	it("scoped unrelated databases progress, same-database bridge/scoped contenders exclude, partial locks are released", async () => {
		let scopedA: DoltWriterLock | undefined;
		let scopedB: DoltWriterLock | undefined;
		let bridgeA: DoltWriterLock | undefined;
		try {
			scopedA = await acquireDoltWriterLocks(a, { protocol: "database" });
			scopedB = await acquireDoltWriterLocks(b, { protocol: "database" });
			expect(scopedA.baseDatabase).toBe(DATABASE_A);
			expect(scopedB.baseDatabase).toBe(DATABASE_B);
			expect(scopedA.keys).not.toEqual(scopedB.keys);
			// A bridge acquires both global domains before reaching the busy native scope.
			await expect(
				acquireDoltWriterLocks(aPeer, { lockWaitMs: 20, lockRetryMs: 5 }),
			).rejects.toMatchObject({
				reason: "lock_contended",
				discardSession: false,
			});
			for (const key of [5001001, 5001002]) {
				expect(
					(await aPeer.unsafe(`SELECT pg_try_advisory_lock(${key})`))[0]
						?.pg_try_advisory_lock,
				).toBe(true);
				await aPeer.unsafe(`SELECT pg_advisory_unlock(${key})`);
			}
			await scopedA.release();
			scopedA = undefined;
			bridgeA = await acquireDoltWriterLocks(a);
			await expect(
				acquireDoltWriterLocks(aPeer, {
					protocol: "database",
					lockWaitMs: 20,
					lockRetryMs: 5,
				}),
			).rejects.toMatchObject({
				reason: "lock_contended",
				discardSession: false,
			});
			// B remains protected solely by its independent native key throughout A's bridge.
			expect(
				(await b.unsafe("SELECT current_database() AS identity"))[0]?.identity,
			).toBe(DATABASE_B);
		} finally {
			await bridgeA?.release();
			await scopedA?.release();
			await scopedB?.release();
		}
	});
	it("documents unsupported native CancelRequest while a sibling read progresses", async () => {
		const readers = postgres(`${origin}/${DATABASE_A}`, {
			max: 2,
			fetch_types: false,
		});
		try {
			await readers.unsafe("SELECT 1");
			const started = Date.now();
			const slow = readers.unsafe("SELECT pg_sleep(0.4)").execute();
			// Query execution begins before the protocol cancellation request is sent.
			await new Promise((resolve) => setTimeout(resolve, 100));
			slow.cancel();
			expect((await readers.unsafe("SELECT 7 AS neighbor"))[0]?.neighbor).toBe(
				7,
			);
			await slow;
			// v0.57.3 rejects CancelRequest at startup: finite work still completes.
			// This is a recorded engine limitation, NOT isolated timeout recovery proof.
			expect(Date.now() - started).toBeGreaterThanOrEqual(350);
		} finally {
			await readers.end({ timeout: 0 });
		}
	}, 5_000);

	it("commits a scoped logical write on an isolated branch and exposes exact main ancestry", async () => {
		const guard = await acquireDoltWriterLocks(a);
		try {
			await a.unsafe(
				"CREATE TABLE IF NOT EXISTS scope_probe (id text PRIMARY KEY, value text)",
			);
			await a.unsafe("SELECT dolt_commit('-Am', 'scope fixture')");
			const result = await runDoltBranchMutation(a, {
				guard,
				operationId: "native.scope.success",
				message: "native scoped row",
				onSessionUncertain: async (error) => {
					throw error;
				},
				run: async (scoped) => {
					await scoped.unsafe(
						"INSERT INTO scope_probe VALUES ('success','committed')",
					);
					return "success";
				},
			});
			expect(result.value).toBe("success");
			expect(result.commitHash).toMatch(/^[0-9a-v]{32}$/);
			expect(
				(
					await aPeer.unsafe("SELECT value FROM scope_probe WHERE id='success'")
				)[0]?.value,
			).toBe("committed");
			expect(await a.unsafe("SELECT * FROM dolt.status")).toHaveLength(0);
		} finally {
			await guard.release();
		}
	});

	it("bug.5544: an interrupted executor write frees the advisory lock and the next op serves (no wedge)", async () => {
		// Drive the REAL DoltNativeSessionExecutor against real Doltgres. An
		// interrupted write must evict + release the server-global advisory lock so
		// a PEER connection (standing in for the separate work-items writer) can
		// re-acquire the scoped key, and the SAME executor must admit the next op.
		// Old code quarantined the connection and held the lock until pod restart.
		const errors = {
			busy: (message: string) => new Error(message),
			outcomeUnknown: (operationId: string, branch: string, hash?: string) =>
				Object.assign(new Error(`outcome-unknown ${operationId}`), {
					name: "OutcomeUnknown",
					operationId,
					branch,
					hash,
				}),
			fault: (message: string) => new Error(message),
		};
		const writerPool = postgres(`${origin}/${DATABASE_A}`, {
			max: 1,
			fetch_types: false,
		});
		await writerPool.unsafe("SELECT 1");
		const executor = new DoltNativeSessionExecutor(writerPool, {
			errors,
			writerProtocol: "database",
			lockWaitMs: 2_000,
			lockRetryMs: 50,
		});
		const scopedKey = doltWriterLockKey(DATABASE_A);
		try {
			await a.unsafe(
				"CREATE TABLE IF NOT EXISTS wedge_probe (id text PRIMARY KEY)",
			);
			await a.unsafe("SELECT dolt_commit('-Am', 'wedge fixture')");

			// 1) Interrupted write: the callback throws AFTER a DML.
			await expect(
				executor.run(
					"wedge.interrupt",
					async (conn, guard, owner) =>
						runDoltBranchMutation(conn, {
							guard,
							operationId: "wedge.interrupt",
							message: "interrupted after DML",
							onSessionUncertain: (error) => executor.retire(conn, error),
							onReconcile: owner.registerReconciliation,
							onCommitted: owner.committed,
							run: async (scoped) => {
								await scoped.unsafe(
									"INSERT INTO wedge_probe VALUES ('interrupted')",
								);
								throw new Error("interrupted after DML");
							},
						}),
					{ operationId: "wedge.interrupt", awaitSettlement: true },
				),
			).rejects.toThrow();

			// 2) PROOF the lock is FREE: a peer connection acquires the scoped key.
			//    Old code held it here -> this would be false (wedge).
			const got = await aPeer.unsafe(
				`SELECT pg_try_advisory_lock(${scopedKey})`,
			);
			expect(got[0]?.pg_try_advisory_lock).toBe(true);
			await aPeer.unsafe(`SELECT pg_advisory_unlock(${scopedKey})`);

			// 3) PROOF no wedge: the SAME executor admits and completes the next op.
			const served = await executor.run(
				"wedge.after",
				async (conn, guard, owner) =>
					runDoltBranchMutation(conn, {
						guard,
						operationId: "wedge.after",
						message: "serves after interruption",
						onSessionUncertain: (error) => executor.retire(conn, error),
						onReconcile: owner.registerReconciliation,
						onCommitted: owner.committed,
						run: async (scoped) => {
							await scoped.unsafe(
								"INSERT INTO wedge_probe VALUES ('after') ON CONFLICT DO NOTHING",
							);
							return "served";
						},
					}),
				{ operationId: "wedge.after" },
			);
			expect(served).toBe("served");
		} finally {
			await writerPool.end({ timeout: 0 });
		}
	}, 30_000);

	it("callback failure after DML never carries dirty operation changes into main", async () => {
		const guard = await acquireDoltWriterLocks(a);
		const before = String(
			(await a.unsafe("SELECT dolt_hashof('main') AS hash"))[0]?.hash,
		);
		let poisoned = false;
		try {
			await expect(
				runDoltBranchMutation(a, {
					guard,
					operationId: "native.scope.callback-failure",
					message: "must not land",
					onSessionUncertain: async () => {
						poisoned = true;
					},
					run: async (scoped) => {
						await scoped.unsafe(
							"INSERT INTO scope_probe VALUES ('rejected','must remain absent')",
						);
						throw new Error("domain validation rejected citation");
					},
				}),
			).rejects.toThrow("domain validation rejected citation");
			expect(poisoned).toBe(false);
			expect(
				(await a.unsafe("SELECT active_branch() AS branch"))[0]?.branch,
			).toBe("main");
			expect(
				String((await a.unsafe("SELECT dolt_hashof('main') AS hash"))[0]?.hash),
			).toBe(before);
			expect(
				await aPeer.unsafe("SELECT * FROM scope_probe WHERE id='rejected'"),
			).toHaveLength(0);
			expect(await a.unsafe("SELECT * FROM dolt.status")).toHaveLength(0);
		} finally {
			await guard.release();
		}
	});

  async function cliFixture(database: string, nodeName = database.replace(/^knowledge_/, "").replaceAll("_", "-")) {
    const folder = await mkdtemp(path.join(tmpdir(), "doltgres-cli-"));
    await mkdir(path.join(folder, "meta"));
    const entry = (idx: number) => ({ idx, version: "7", when: idx + 1, tag: `000${idx}_probe`, breakpoints: true });
    const table = (name: string) => ({ name, columns: { id: { name: "id", type: "integer", notNull: true } }, indexes: {} });
    const writeJournal = async (pending: boolean) => {
      await writeFile(path.join(folder, "meta/_journal.json"), JSON.stringify({ version: "7", dialect: "postgresql", entries: pending ? [entry(0), entry(1)] : [entry(0)] }));
      await writeFile(path.join(folder, "0000_probe.sql"), "CREATE TABLE migration_probe (id integer NOT NULL);");
      await writeFile(path.join(folder, "meta/0000_snapshot.json"), JSON.stringify({ tables: { "public.migration_probe": table("migration_probe") } }));
      if (pending) {
        await writeFile(path.join(folder, "0001_probe.sql"), "CREATE TABLE migration_once (id integer NOT NULL);");
        await writeFile(path.join(folder, "meta/0001_snapshot.json"), JSON.stringify({ tables: { "public.migration_probe": table("migration_probe"), "public.migration_once": table("migration_once") } }));
      }
    };
    await writeJournal(false);
    const admin = postgres(`${origin}/postgres`, { max: 1, fetch_types: false });
    await admin.unsafe(`CREATE DATABASE ${database}`);
    const url = `${origin}/${database}`;
    const root = path.resolve(__dirname, "../../../..");
    const migrate = async (timeout = 30_000, databaseUrl = url) => {
      try {
        const result = await promisify(execFile)(process.execPath, [path.join(root, "scripts/db/migrate-doltgres.mjs"), folder], {
          cwd: root, env: { ...process.env, NODE_NAME: nodeName, DATABASE_URL: databaseUrl }, timeout,
        });
        return { code: 0, output: result.stdout + result.stderr };
      } catch (error) {
        const result = error as { code: number; stdout: string; stderr: string };
        return { code: result.code, output: result.stdout + result.stderr };
      }
    };
    expect((await migrate()).code).toBe(0);
    return { admin, url, root, folder, database, migrate, writeJournal, async close() { await admin.end({ timeout: 1 }); await rm(folder, { recursive: true, force: true }); } };
  }

  it("suffixed lane startup then already-applied init is read-only beside a dirty live writer", async () => {
    const fixture = await cliFixture("knowledge_cli_noop_candidate_a", "cli-noop");
    const writer = postgres(fixture.url, { max: 1, fetch_types: false });
    try {
      await writer.unsafe("INSERT INTO migration_probe VALUES (42)");
      const before = await writer.unsafe("SELECT dolt_hashof('main') AS head");
      const dirty = await writer.unsafe("SELECT * FROM dolt.status");
      expect(dirty.length).toBeGreaterThan(0);
      const result = await fixture.migrate();
      expect(result).toMatchObject({ code: 0 });
      expect(result.output).toContain("read-only no-op; no journal DDL or commit");
      expect(await writer.unsafe("SELECT dolt_hashof('main') AS head")).toEqual(before);
      expect(await writer.unsafe("SELECT * FROM dolt.status")).toEqual(dirty);
      expect(await writer.unsafe("SELECT id FROM migration_probe")).toEqual([{ id: 42 }]);
      expect(await writer.unsafe("SELECT COUNT(*)::integer AS count FROM drizzle.__drizzle_migrations")).toEqual([{ count: 1 }]);
      for (const pathname of [
        "knowledge_foreign_candidate_a",
        "knowledge_cli_noop_candidate_z",
        "knowledge_cli_noop_candidate_a_preview",
        "knowledge_cli_noop_candidate_a/branch",
        "knowledge_cli_noop%2Fcandidate_a",
        "knowledge_cli_noop_candidаte_a", // Cyrillic a is not a canonical ASCII lane.
      ]) {
        const rejected = new URL(fixture.url);
        rejected.port = "1"; // A connection attempt cannot satisfy this control.
        rejected.pathname = `/${pathname}`;
        const negative = await fixture.migrate(5_000, rejected.toString());
        expect(negative.code).toBe(1);
        expect(negative.output).toContain('"code":"migration_database_identity_mismatch"');
      }
    } finally { await writer.end({ timeout: 1 }); await fixture.close(); }
  });

  it.each(["SIGKILL", "public deadline"])("actual CLI %s retains native guard through late DML; same batch never replays", async (boundary) => {
    const database = boundary === "SIGKILL" ? "knowledge_cli_pending" : "knowledge_cli_deadline";
    const fixture = await cliFixture(database);
    const sleepSeconds = boundary === "SIGKILL" ? 15 : 45;
    const probe = `migration_cli_${database}`;
    let child: ReturnType<typeof spawn> | undefined;
    let observer: Sql | undefined;
    try {
      await fixture.writeJournal(true);
      await writeFile(path.join(fixture.folder, "0001_probe.sql"), `CREATE TABLE migration_once (id integer NOT NULL);
--> statement-breakpoint
INSERT INTO migration_once SELECT 7 WHERE pg_sleep(${sleepSeconds}) IS NULL /* ${probe} */;`);
      child = spawn(process.execPath, [path.join(fixture.root, "scripts/db/migrate-doltgres.mjs"), fixture.folder], {
        cwd: fixture.root, env: { ...process.env, NODE_NAME: database.replace(/^knowledge_/, "").replaceAll("_", "-"), DATABASE_URL: fixture.url }, stdio: ["ignore", "pipe", "pipe"],
      });
      let diagnostics = "";
      child.stdout?.on("data", (data: Buffer) => { diagnostics += data.toString(); });
      child.stderr?.on("data", (data: Buffer) => { diagnostics += data.toString(); });
      const cli = child;
      let pid = 0;
      let observed: unknown[] = [];
      try { await expect.poll(async () => {
        if (cli.exitCode !== null || cli.signalCode !== null)
          throw new Error(`CLI exited before native delayed SQL: code=${cli.exitCode} signal=${cli.signalCode} ${diagnostics}`);
        const rows = await fixture.admin.unsafe("SELECT pid,datname,state,query FROM pg_catalog.pg_stat_activity");
        observed = rows.slice(0, 40).map(({ pid, datname, state, query }) => ({ pid, datname, state, query: String(query).slice(0, 240) }));
        // Native 0.57.3 reports datname=NULL even during branch SQL. Bind
        // this exact child to its unique fixture query, never infer a DB name.
        const active = rows.filter((row) => row.state === "active" && String(row.query).includes(probe) && String(row.query).includes(`pg_sleep(${sleepSeconds})`));
        if (active.length > 1) throw new Error("duplicate native CLI probe sessions");
        pid = Number(active[0]?.pid ?? 0);
        return pid > 0;
      }, { timeout: 10_000 }).toBe(true);
      } catch (cause) {
        throw new Error(`Native CLI observation failed: exit=${cli.exitCode} signal=${cli.signalCode} output=${diagnostics} census=${JSON.stringify(observed)}`, { cause });
      }
      const census = () => fixture.admin.unsafe(`SELECT pid FROM pg_catalog.pg_stat_activity WHERE pid = ${pid} AND state = 'active' AND query LIKE '%pg_sleep%'`);
      const exited = once(child, "exit", { signal: AbortSignal.timeout(40_000) });
      if (boundary === "SIGKILL") child.kill("SIGKILL");
      const [exitCode, signal] = await exited;
      let terminal: { code: string; retryable: boolean; operationId: string; branch: string; commitHash: null } | undefined;
      if (boundary === "public deadline") {
        expect(exitCode).toBe(1);
        expect(signal).toBeNull();
        const line = diagnostics.split("\n").find((value) => value.startsWith("MIGRATION_OUTCOME "));
        expect(line).toBeDefined();
        terminal = JSON.parse(String(line).slice("MIGRATION_OUTCOME ".length));
        expect(terminal).toMatchObject({ code: "migration_write_outcome_unknown", retryable: false, commitHash: null });
        expect(terminal?.operationId).toMatch(new RegExp(`^migration[.]${database}[.][a-f0-9]{64}$`));
      } else expect(signal).toBe("SIGKILL");
      expect(await census()).toHaveLength(1);
      const refused = await fixture.migrate();
      expect(refused.code).toBe(1);
      expect(refused.output).toContain("migration_writer_busy");
      expect(await census()).toHaveLength(1);
      await expect.poll(async () => (await fixture.admin.unsafe(`SELECT pid FROM pg_catalog.pg_stat_activity WHERE pid = ${pid}`)).length, { timeout: 25_000 }).toBe(0);
      observer = postgres(fixture.url, { max: 1, fetch_types: false });
      const mainHead = await observer.unsafe("SELECT dolt_hashof('main') AS head");
      expect(await observer.unsafe("SELECT COUNT(*)::integer AS count FROM drizzle.__drizzle_migrations")).toEqual([{ count: 1 }]);
      const branches = await observer.unsafe("SELECT name FROM dolt.branches WHERE name LIKE 'dolt-op/%'");
      expect(branches).toHaveLength(1);
      const branch = String(branches[0]?.name);
      if (terminal) expect(terminal.branch).toBe(branch);
      await observer.unsafe(`SELECT dolt_checkout('${branch}')`);
      expect(await observer.unsafe("SELECT id FROM migration_once")).toEqual([{ id: 7 }]);
      const operationHead = await observer.unsafe("SELECT dolt_hashof('HEAD') AS head");
      // Keep this branch's working set intact. A new process must refuse the
      // existing batch receipt before dispatching the original DML again.
      // Close this branch-scoped observer without checkout, reset or merge.
      await observer.end({ timeout: 1 }); observer = undefined;
      const retry = await fixture.migrate(5_000);
      expect(retry.code).not.toBe(0);
      expect(retry.output).toContain("existing_operation_branch");
      observer = postgres(fixture.url, { max: 1, fetch_types: false });
      expect(await observer.unsafe("SELECT dolt_hashof('main') AS head")).toEqual(mainHead);
      await observer.unsafe(`SELECT dolt_checkout('${branch}')`);
      expect(await observer.unsafe("SELECT dolt_hashof('HEAD') AS head")).toEqual(operationHead);
      expect(await observer.unsafe("SELECT id FROM migration_once")).toEqual([{ id: 7 }]);
    } finally {
      child?.kill("SIGKILL");
      await observer?.end({ timeout: 1 });
      await fixture.close();
    }
  });
});
