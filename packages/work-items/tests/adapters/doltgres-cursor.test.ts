// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
/** Native-key roundtrips and order/version mismatch rejection. */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MarkdownWorkItemAdapter } from "../../src/adapters/markdown/adapter.js";
import { toWorkItemId } from "../../src/types.js";
import { DoltgresWorkItemAdapter } from "../../src/adapters/doltgres/adapter.js";
import { independentReadPool, makeFakeDoltgresSql } from "./fake-doltgres-sql.js";
import {
  decodeCursor,
  encodeCursor,
  queryIdentity,
  type WorkItemCursor,
} from "../../src/adapters/doltgres/cursor.js";

describe("order-bound work cursor", () => {
  it.each(["1.2000000000000002", null])(
    "retains exact native numeric key %s",
    (key) => {
      const c: WorkItemCursor = {
        v: 2,
        filter: queryIdentity(),
        sortBy: "rankScore",
        sortDirection: "desc",
        key,
        id: "task.5042",
      };
      expect(decodeCursor(encodeCursor(c), undefined, queryIdentity())).toEqual(
        c,
      );
    },
  );
  it("binds normalized filters while rejecting changed filters", () => {
    const filter = queryIdentity({
      statuses: ["done", "blocked", "done"],
      rankMin: 4,
    });
    expect(queryIdentity({ statuses: ["blocked", "done"], rankMin: 4 })).toBe(
      filter,
    );
    const raw = encodeCursor({
      v: 2,
      filter,
      sortBy: "rankScore",
      sortDirection: "desc",
      key: "6",
      id: "task.0001",
    });
    expect(() =>
      decodeCursor(
        raw,
        undefined,
        queryIdentity({ statuses: ["done"], rankMin: 4 }),
      ),
    ).toThrow(/restart pagination/);
    expect(() =>
      decodeCursor(
        raw,
        undefined,
        queryIdentity({ statuses: ["done", "blocked"], rankMin: 5 }),
      ),
    ).toThrow(/restart pagination/);
  });
  it("roundtrips a bounded reference to an arbitrarily long project key", () => {
    const key = "proj." + "x".repeat(5000);
    const cursor: WorkItemCursor = { v: 2, filter: queryIdentity(), sortBy: "projectId", sortDirection: "asc", key: null, keyRef: createHash("sha256").update(key).digest("hex"), id: "task.0001" };
    const encoded = encodeCursor(cursor);
    expect(encoded.length).toBeLessThan(2048);
    expect(decodeCursor(encoded, undefined, queryIdentity())).toEqual(cursor);
  });
  it("preserves timestamp microseconds rather than a DTO Date", () => {
    const c: WorkItemCursor = {
      v: 2,
      filter: queryIdentity(),
      sortBy: "createdAt",
      sortDirection: "asc",
      key: "2026-04-30 12:00:00.123456+00",
      id: "task.5042",
    };
    expect(decodeCursor(encodeCursor(c), undefined, queryIdentity())).toEqual(
      c,
    );
  });
  it("rejects legacy, malformed and sort-mismatched cursors", () => {
    for (const raw of [
      "!!!",
      "e30",
      Buffer.from(
        JSON.stringify({
          p: 1,
          r: 2,
          ts: "2026-04-30T00:00:00.000Z",
          id: "task.5042",
        }),
      ).toString("base64url"),
    ])
      expect(() => decodeCursor(raw, undefined, queryIdentity())).toThrow(/restart pagination/);
    const raw = encodeCursor({
      v: 2,
      filter: queryIdentity(),
      sortBy: "rankScore",
      sortDirection: "desc",
      key: "1",
      id: "task.5042",
    });
    expect(() =>
      decodeCursor(
        raw,
        { sortBy: "priority", sortDirection: "asc" },
        queryIdentity(),
      ),
    ).toThrow(/restart pagination/);
  });
});


it("applies inclusive rank and projects before the page limit", async () => {
  const sql: string[] = [];
  const reader = makeFakeDoltgresSql(() => [], sql);
  const adapter = new DoltgresWorkItemAdapter(independentReadPool(reader), { readClient: reader });
  await adapter.list({ rankMin: 4, rankMax: 12, projectIds: [toWorkItemId("proj.a"), toWorkItemId("proj.b")], limit: 10 });
  const query = sql.find(q => q.includes("AS ordered")) ?? "";
  expect(query).toContain("project_id IN ('proj.a', 'proj.b')");
  expect(query).toContain(">= 4");
  expect(query).toContain("<= 12");
  expect(query).toContain("LIMIT 11");
  expect(query.indexOf(">= 4")).toBeLessThan(query.indexOf("LIMIT 11"));
});


it("binds cursor filters consistently with Markdown matching", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "work-cursor-"));
  try {
    const itemsDir = path.join(dir, "work", "items");
    await mkdir(itemsDir, { recursive: true });
    await mkdir(path.join(dir, "work", "projects"), { recursive: true });
    for (const [id, actor] of [["task.0001", "ai"], ["task.0002", "human"], ["task.0003", "either"]]) {
      await writeFile(path.join(itemsDir, `${id}.md`), `---\nid: ${id}\ntype: task\ntitle: ${id}\nstatus: needs_design\nactor: ${actor}\n---\n`);
    }
    const adapter = new MarkdownWorkItemAdapter(dir);
    const first = await adapter.list({ limit: 1 });
    expect(first.nextCursor).toBeDefined();
    const same = await adapter.list({ limit: 1, cursor: first.nextCursor, ids: [], types: [], statuses: [], actor: "either" });
    expect(same.items).toHaveLength(1);
    await expect(adapter.list({ limit: 1, cursor: first.nextCursor, statuses: ["done"] })).rejects.toThrow(/restart pagination/);
    expect(queryIdentity({assignee: {kind: "user", userId: "u"}})).toBe(queryIdentity({assignee: {userId: "u", kind: "user"}}));
  } finally { await rm(dir, { recursive: true, force: true }); }
});


it("pages by a long project key and rejects a changed boundary", async () => {
  const key = "proj." + "x".repeat(5000);
  let boundary = key;
  const queries: string[] = [];
  const row = (id: string, project: string) => ({ id, type: "task", title: id, status: "needs_design", project_id: project, __sort_key: project });
  const reader = makeFakeDoltgresSql((sql) => {
    if (sql.startsWith("SELECT * FROM work_items WHERE id =")) return [row("task.0001", boundary)];
    if (sql.includes("AS ordered")) return sql.includes("WHERE (__sort_value") ? [row("task.0002", "z")] : [row("task.0001", key), row("task.0002", "z")];
    return [];
  }, queries);
  const adapter = new DoltgresWorkItemAdapter(independentReadPool(reader), { readClient: reader });
  const first = await adapter.list({ sortBy: "projectId", sortDirection: "asc", limit: 1 });
  expect(first.nextCursor?.length).toBeLessThan(2048);
  const second = await adapter.list({ sortBy: "projectId", sortDirection: "asc", limit: 1, cursor: first.nextCursor });
  expect(second.items.map(item => item.id)).toEqual(["task.0002"]);
  boundary = "changed";
  await expect(adapter.list({ sortBy: "projectId", sortDirection: "asc", limit: 1, cursor: first.nextCursor })).rejects.toThrow(/restart pagination/);
});


it("preserves Markdown phrase search and matches labels separately before paging", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "work-text-"));
  try {
    const itemsDir = path.join(dir, "work", "items");
    await mkdir(itemsDir, { recursive: true });
    await mkdir(path.join(dir, "work", "projects"), { recursive: true });
    await writeFile(path.join(itemsDir, "task.0001.md"), `---\nid: task.0001\ntype: task\ntitle: Decoy\nstatus: needs_design\n---\n`);
    await writeFile(path.join(itemsDir, "task.0002.md"), `---\nid: task.0002\ntype: task\ntitle: Deploy alpha\nsummary: beta service\nstatus: needs_design\nlabels: ["area:web", "goal:work", "part,one"]\n---\n`);
    await writeFile(path.join(itemsDir, "task.0003.md"), `---\nid: task.0003\ntype: task\ntitle: Unrelated\nstatus: needs_design\n---\n`);
    await writeFile(path.join(itemsDir, "task.0004.md"), `---\nid: task.0004\ntype: task\ntitle: Deploy alpha\nsummary: beta service\nstatus: needs_design\n---\n`);
    const adapter = new MarkdownWorkItemAdapter(dir);
    const first = await adapter.list({ text: "alpha beta", limit: 1 });
    expect(first.items.map(i => i.id)).toEqual(["task.0002"]);
    expect(first.nextCursor).toBeDefined();
    const second = await adapter.list({ text: "alpha beta", limit: 1, cursor: first.nextCursor });
    expect(second.items.map(i => i.id)).toEqual(["task.0004"]);
    expect(second.nextCursor).toBeUndefined();
    expect((await adapter.list({ text: "web,goal", limit: 1 })).items).toHaveLength(0);
    expect((await adapter.list({ text: "part,one", limit: 1 })).items.map(i => i.id)).toEqual(["task.0002"]);
    expect((await adapter.list({ text: "task.0002", limit: 1 })).items.map(i => i.id)).toEqual(["task.0002"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it("matches Dolt labels separately, including literal commas", async () => {
  const queries: string[] = [];
  let labels: unknown = ["area:web", "goal:work", "part,one"];
  const reader = makeFakeDoltgresSql((sql) => sql.includes("AS ordered") ? [{ id: "task.0001", type: "task", status: "needs_design", title: "Example", labels, __sort_key: null }] : [], queries);
  const adapter = new DoltgresWorkItemAdapter(independentReadPool(reader), { readClient: reader });
  expect((await adapter.list({ text: "web,goal", limit: 1 })).items).toHaveLength(0);
  expect((await adapter.list({ text: "part,one", limit: 1 })).items.map(i => i.id)).toEqual(["task.0001"]);
  labels = JSON.stringify(labels);
  expect((await adapter.list({ text: "web,goal", limit: 1 })).items).toHaveLength(0);
  expect((await adapter.list({ text: "part,one", limit: 1 })).items.map(i => i.id)).toEqual(["task.0001"]);
});
