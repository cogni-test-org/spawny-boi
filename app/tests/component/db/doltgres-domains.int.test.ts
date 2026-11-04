// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `tests/component/db/doltgres-domains.int.test.ts`
 * Purpose: Prove against a real Doltgres that domain update / delete are atomic, committed exactly once per change, and respect the empty-only delete rule.
 * Scope: Component test — boots `dolthub/doltgresql:0.57.3` via testcontainers and drives `DoltgresKnowledgeStoreAdapter` directly. Does not exercise HTTP routes or auth (see tests/contract/app/knowledge.domains.crud.test.ts).
 * Invariants:
 *   - DOMAIN_MUTATION_AUTOCOMMITS: one Dolt commit per changing write; a patch that changes nothing makes none.
 *   - DOMAIN_DELETE_REFUSES_NONEMPTY: a domain with entries is not deleted; nothing is cascaded; no commit is made.
 *   - DOMAIN_ID_IS_IMMUTABLE: only `name` and `description` change; `created_at` and the entry link survive.
 *   - `description: null` clears the column (UPDATE ... = NULL on Doltgres).
 * Side-effects: Docker container, sub-process (migrator), database writes.
 * Links: packages/knowledge-store/src/adapters/doltgres/index.ts, hub `knowledge-domain-crud-design`
 */

import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DomainNotEmptyError,
  DomainNotRegisteredError,
} from "@cogni/knowledge-store";
import {
  buildDoltgresClient,
  DoltBranchSessionRunner,
  DoltgresKnowledgeStoreAdapter,
} from "@cogni/knowledge-store/adapters/doltgres";
import postgres, { type Sql } from "postgres";
import {
  GenericContainer,
  type StartedTestContainer,
  Wait,
} from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const MIGRATE_SCRIPT = path.resolve(
  REPO_ROOT,
  "scripts/db/migrate-doltgres.mjs"
);
const MIGRATIONS_DIR = path.resolve(
  REPO_ROOT,
  "app/src/adapters/server/db/doltgres-migrations"
);

const DG_USER = "postgres";
const DG_PASSWORD = "doltgres";
const DG_DB = "knowledge_operator";

describe("knowledge domain update + delete (real Doltgres)", () => {
  let container: StartedTestContainer;
  let readClient: Sql;
  let branchClient: Sql;
  let store: DoltgresKnowledgeStoreAdapter;

  async function commitCount(prefix: string): Promise<number> {
    const rows = await readClient.unsafe(
      `SELECT COUNT(*) AS n FROM dolt_log WHERE message LIKE '${prefix}%'`
    );
    return Number((rows[0] as Record<string, unknown>).n);
  }

  beforeAll(async () => {
    container = await new GenericContainer("dolthub/doltgresql:0.57.3")
      .withEnvironment({ DOLTGRES_PASSWORD: DG_PASSWORD })
      .withExposedPorts(5432)
      .withWaitStrategy(
        Wait.forLogMessage(/server (started|listening)/i, 1).withStartupTimeout(
          60_000
        )
      )
      .start();

    const host = container.getHost();
    const port = container.getMappedPort(5432);
    const baseUrl = `postgresql://${DG_USER}:${DG_PASSWORD}@${host}:${port}/postgres`;
    const dbUrl = `postgresql://${DG_USER}:${DG_PASSWORD}@${host}:${port}/${DG_DB}`;

    const bootstrap = postgres(baseUrl, { max: 1 });
    try {
      await bootstrap.unsafe(`CREATE DATABASE ${DG_DB}`);
    } catch (err) {
      if (!/already exists/i.test(String(err))) throw err;
    } finally {
      await bootstrap.end({ timeout: 5 });
    }

    execSync(`node ${MIGRATE_SCRIPT} ${MIGRATIONS_DIR}`, {
      env: { ...process.env, DATABASE_URL: dbUrl, NODE_NAME: "operator" },
      encoding: "utf8",
      stdio: "pipe",
    });

    readClient = buildDoltgresClient({ connectionString: dbUrl });
    const createBranchClient = () =>
      buildDoltgresClient({ connectionString: dbUrl, max: 1 });
    branchClient = createBranchClient();
    const writerSession = new DoltBranchSessionRunner(branchClient, {
      writerProtocol: "database",
      recreateClient: createBranchClient,
    });
    store = new DoltgresKnowledgeStoreAdapter({
      sql: readClient,
      writerSession,
    });
  }, 240_000);

  afterAll(async () => {
    await readClient?.end({ timeout: 5 }).catch(() => undefined);
    await branchClient?.end({ timeout: 5 }).catch(() => undefined);
    if (container) await container.stop();
  });

  it("updates name and description with one commit, clears with null, and no-ops without a commit", async () => {
    const created = await store.registerDomain({
      id: "evals",
      name: "evals",
      description: "probe",
    });
    expect(created.description).toBe("probe");

    const before = await commitCount("update domain evals");
    const updated = await store.updateDomain("evals", {
      name: "Build: Evals",
      description: "Eval harnesses and scorecards.",
    });
    expect(updated).toMatchObject({
      id: "evals",
      name: "Build: Evals",
      description: "Eval harnesses and scorecards.",
      createdAt: created.createdAt,
    });
    expect(await commitCount("update domain evals")).toBe(before + 1);
    // Read back through a fresh query: the change is on main.
    expect(await store.getDomain("evals")).toMatchObject({
      name: "Build: Evals",
      description: "Eval harnesses and scorecards.",
    });

    const cleared = await store.updateDomain("evals", { description: null });
    expect(cleared.description).toBeNull();
    expect(await commitCount("update domain evals")).toBe(before + 2);

    const noop = await store.updateDomain("evals", { description: null });
    expect(noop.description).toBeNull();
    expect(await commitCount("update domain evals")).toBe(before + 2);
  });

  it("escapes quotes in a description (no SQL injection through the patch)", async () => {
    const hostile = "it's a 'quoted'; DROP TABLE domains; --";
    await store.updateDomain("evals", { description: hostile });
    expect((await store.getDomain("evals"))?.description).toBe(hostile);
    expect(await store.domainExists("evals")).toBe(true);
  });

  it("refuses to delete a non-empty domain: no change, no commit, entry intact", async () => {
    await store.registerDomain({ id: "full-shelf", name: "Full" });
    await store.withWrite(
      { operationId: "test.seed-entry", message: "seed entry" },
      async (write) => {
        await write.upsertKnowledge({
          id: "full-entry",
          domain: "full-shelf",
          title: "Full entry",
          content: "body",
          sourceType: "agent",
        });
      }
    );
    const before = await commitCount("delete domain full-shelf");
    await expect(store.deleteDomain("full-shelf")).rejects.toBeInstanceOf(
      DomainNotEmptyError
    );
    expect(await commitCount("delete domain full-shelf")).toBe(before);
    expect(await store.domainExists("full-shelf")).toBe(true);
    expect((await store.getDomain("full-shelf"))?.entryCount).toBe(1);
    expect(await store.getKnowledge("full-entry")).not.toBeNull();
  });

  it("deletes an empty domain with one commit and can register the id again", async () => {
    await store.registerDomain({ id: "tmp-shelf", name: "Tmp" });
    const before = await commitCount("delete domain tmp-shelf");
    await store.deleteDomain("tmp-shelf");
    expect(await commitCount("delete domain tmp-shelf")).toBe(before + 1);
    expect(await store.getDomain("tmp-shelf")).toBeNull();
    expect(
      (await store.listDomainsFull()).some((d) => d.id === "tmp-shelf")
    ).toBe(false);
    const again = await store.registerDomain({ id: "tmp-shelf", name: "Tmp2" });
    expect(again.name).toBe("Tmp2");
  });

  it("rejects update and delete of an unregistered id with DomainNotRegisteredError", async () => {
    await expect(
      store.updateDomain("ghost", { name: "x" })
    ).rejects.toBeInstanceOf(DomainNotRegisteredError);
    await expect(store.deleteDomain("ghost")).rejects.toBeInstanceOf(
      DomainNotRegisteredError
    );
  });
});
