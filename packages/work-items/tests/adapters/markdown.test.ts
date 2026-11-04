// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/work-items/tests/adapters/markdown`
 * Purpose: Bind the portable contract test suite to the MarkdownWorkItemAdapter.
 * Scope: Test binding only. Does not test adapter internals; delegates to contract suite.
 * Invariants: Each test gets a clean temp directory with work/items/ and work/projects/.
 * Side-effects: IO (temp directory creation/cleanup)
 * Links: tests/contract/work-item-port.contract.ts
 * @internal
 */

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MarkdownWorkItemAdapter } from "../../src/adapters/markdown/adapter.js";
import { UnsupportedWorkItemFieldError } from "../../src/adapters/markdown/errors.js";
import { parseFrontmatter } from "../../src/adapters/markdown/frontmatter.js";
import type { WorkItemId } from "../../src/types.js";
import { toWorkItemId } from "../../src/types.js";
import { workItemPortContract } from "../contract/work-item-port.contract.js";

describe("MarkdownWorkItemAdapter", () => {
  workItemPortContract(async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "work-items-test-"));
    await mkdir(path.join(tmpDir, "work", "items"), { recursive: true });
    await mkdir(path.join(tmpDir, "work", "projects"), { recursive: true });

    const adapter = new MarkdownWorkItemAdapter(tmpDir);

    return {
      query: adapter,
      command: adapter,
      getRevision: async (id: WorkItemId): Promise<string> => {
        // Find the file and compute its revision
        const itemsDir = path.join(tmpDir, "work", "items");
        const { readdir } = await import("node:fs/promises");
        const files = await readdir(itemsDir);
        for (const file of files) {
          const content = await readFile(path.join(itemsDir, file), "utf8");
          const { raw, revision } = parseFrontmatter(content);
          if (String(raw.id) === String(id)) {
            return revision;
          }
        }
        throw new Error(`File not found for ID: ${String(id)}`);
      },
      cleanup: async () => {
        await rm(tmpDir, { recursive: true, force: true });
      }
    };
  });

  describe("label + scored filters (bug.5552)", () => {
    let tmpDir: string;
    let adapter: MarkdownWorkItemAdapter;

    beforeEach(async () => {
      tmpDir = await mkdtemp(path.join(os.tmpdir(), "work-items-filter-"));
      await mkdir(path.join(tmpDir, "work", "items"), { recursive: true });
      await mkdir(path.join(tmpDir, "work", "projects"), { recursive: true });
      adapter = new MarkdownWorkItemAdapter(tmpDir);
      await adapter.create({ type: "task", title: "Goal A", labels: ["goal"] });
      await adapter.create({
        type: "task",
        title: "Area web",
        labels: ["area:web", "roadmap"]
      });
      await adapter.create({ type: "task", title: "Unlabeled" });
    });

    afterEach(async () => {
      await rm(tmpDir, { recursive: true, force: true });
    });

    it("labels is an any-of match", async () => {
      const titles = (await adapter.list({ labels: ["goal", "roadmap"] })).items
        .map((i) => i.title)
        .sort();
      expect(titles).toEqual(["Area web", "Goal A"]);
    });

    it("labelPrefix keeps items with a label that starts with the prefix", async () => {
      const titles = (await adapter.list({ labelPrefix: "area:" })).items.map(
        (i) => i.title
      );
      expect(titles).toEqual(["Area web"]);
    });

    it("scored:false returns every item because markdown items are always unscored", async () => {
      const unscored = await adapter.list({ scored: false });
      expect(unscored.items).toHaveLength(3);
      const scored = await adapter.list({ scored: true });
      expect(scored.items).toHaveLength(0);
    });
  });

  describe("pagination (NO_SILENT_TRUNCATION)", () => {
    let tmpDir: string;
    let adapter: MarkdownWorkItemAdapter;

    beforeEach(async () => {
      tmpDir = await mkdtemp(path.join(os.tmpdir(), "work-items-page-"));
      await mkdir(path.join(tmpDir, "work", "items"), { recursive: true });
      await mkdir(path.join(tmpDir, "work", "projects"), { recursive: true });
      adapter = new MarkdownWorkItemAdapter(tmpDir);
      for (const title of ["A", "B", "C", "D", "E"]) {
        await adapter.create({ type: "task", title: `Task ${title}` });
      }
    });

    afterEach(async () => {
      await rm(tmpDir, { recursive: true, force: true });
    });

    it("returns nextCursor when limit truncates, and walking it yields every item once", async () => {
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await adapter.list({
          limit: 2,
          ...(cursor && { cursor })
        });
        seen.push(...page.items.map((i) => String(i.id)));
        cursor = page.nextCursor;
        pages++;
      } while (cursor && pages < 10);

      expect(pages).toBe(3);
      expect(new Set(seen).size).toBe(5);
      const all = await adapter.list();
      expect(seen).toEqual(all.items.map((i) => String(i.id)));
      expect(all.nextCursor).toBeUndefined();
    });

    it("seeks after deleted or filtered boundary rows and ignores earlier insertions", async () => {
      const query = { limit: 2, statuses: ["needs_triage" as const], sortBy: "rankScore" as const };
      const page = await adapter.list(query);
      const files = await readdir(path.join(tmpDir, "work", "items"));
      const first = files.find((file) => file.startsWith(`${page.items[0]!.id}.`))!;
      await rm(path.join(tmpDir, "work", "items", first));
      const second = page.items[1]!;
      const secondFile = files.find((file) => file.startsWith(`${second.id}.`))!;
      const revision = parseFrontmatter(await readFile(path.join(tmpDir, "work", "items", secondFile), "utf8")).revision;
      await adapter.patch({ id: second.id, expectedRevision: revision, set: { status: "done" } });
      const inserted = await adapter.create({ type: "bug", title: "Earlier item" });
      expect(inserted.id < second.id).toBe(true);
      const next = await adapter.list({ ...query, cursor: page.nextCursor });
      expect(next.items.map((item) => String(item.id))).toEqual(["task.0003", "task.0004"]);
    });

    it("walks every sort and direction with tied and unknown keys", async () => {
      const fields = ["rankScore", "priority", "rank", "createdAt", "updatedAt", "type", "status", "projectId", "estimate"] as const;
      for (const sortBy of fields) for (const sortDirection of ["asc", "desc"] as const) {
        const query = { sortBy, sortDirection };
        const expected = (await adapter.list(query)).items.map((item) => item.id);
        const seen = [];
        let cursor: string | undefined;
        do {
          const page = await adapter.list({ ...query, limit: 2, cursor });
          seen.push(...page.items.map((item) => item.id));
          cursor = page.nextCursor;
        } while (cursor);
        expect(seen).toEqual(expected);
      }
    });

    it.each(["x".repeat(1100), "界".repeat(800)])("roundtrips long project keys in both directions", async (project) => {
      for (const suffix of ["a", "b", "b", "c"]) {
        await adapter.create({ type: "task", title: suffix, projectId: toWorkItemId(project + suffix) });
      }
      for (const sortDirection of ["asc", "desc"] as const) {
        const query = { sortBy: "projectId" as const, sortDirection, limit: 1 };
        const expected = (await adapter.list({ ...query, limit: 100 })).items.map((item) => item.id);
        const seen = [];
        let cursor: string | undefined;
        do {
          const page = await adapter.list({ ...query, cursor });
          seen.push(...page.items.map((item) => item.id));
          cursor = page.nextCursor;
          if (cursor) expect(cursor.length).toBeLessThanOrEqual(2048);
        } while (cursor);
        expect(seen).toEqual(expected);
      }
    });

    it("resolves long boundaries before filtering and rejects changed or missing references", async () => {
      const project = "界".repeat(800);
      const boundary = await adapter.create({ type: "task", title: "boundary", projectId: toWorkItemId(project) });
      await adapter.create({ type: "task", title: "next", projectId: toWorkItemId(`${project}z`) });
      const query = { sortBy: "projectId" as const, sortDirection: "asc" as const, statuses: ["needs_triage" as const], limit: 1 };
      const page = await adapter.list(query);
      expect(page.items[0]?.id).toBe(boundary.id);
      const dir = path.join(tmpDir, "work", "items");
      const file = path.join(dir, (await readdir(dir)).find((name) => name.startsWith(`${boundary.id}.`))!);
      const original = await readFile(file, "utf8");
      const revision = parseFrontmatter(original).revision;
      await adapter.patch({ id: boundary.id, expectedRevision: revision, set: { status: "done" } });
      expect((await adapter.list({ ...query, cursor: page.nextCursor })).items[0]?.title).toBe("next");
      await writeFile(file, original.replace(project, `${project}changed`));
      await expect(adapter.list({ ...query, cursor: page.nextCursor })).rejects.toThrow(/invalid_cursor.*restart/);
      await rm(file);
      await expect(adapter.list({ ...query, cursor: page.nextCursor })).rejects.toThrow(/invalid_cursor.*restart/);
    });

    it("rejects old, malformed, wrong-type and mismatched cursors", async () => {
      const page = await adapter.list({ limit: 2, sortBy: "rank" });
      const payload = JSON.parse(Buffer.from(page.nextCursor!.slice(4), "base64url").toString());
      const invalid = `md3:${Buffer.from(JSON.stringify({ ...payload, value: "not a number" })).toString("base64url")}`;
      for (const cursor of ["md2:eyJvZmZzZXQiOjJ9", invalid, `${page.nextCursor}!`, "md3:" + "a".repeat(2049)]) {
        await expect(adapter.list({ limit: 2, sortBy: "rank", cursor })).rejects.toThrow(/invalid_cursor/);
      }
      await expect(adapter.list({ limit: 2, sortBy: "rank", statuses: ["done"], cursor: page.nextCursor })).rejects.toThrow(/invalid_cursor/);
      await expect(adapter.list({ limit: 2, sortBy: "rank", sortDirection: "desc", cursor: page.nextCursor })).rejects.toThrow(/invalid_cursor/);
    });

    it("omits nextCursor when the page is not truncated", async () => {
      const page = await adapter.list({ limit: 5 });
      expect(page.items).toHaveLength(5);
      expect(page.nextCursor).toBeUndefined();
    });

    it("rejects a cursor it did not issue", async () => {
      await expect(adapter.list({ limit: 2, cursor: "bogus" })).rejects.toThrow(
        /invalid_cursor/
      );
    });
  });
});

describe("MarkdownWorkItemAdapter — scores are Doltgres-only (story.5111)", () => {
  const scores = { ease: { v: 3 } };

  async function harness() {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "work-items-scores-"));
    const itemsDir = path.join(tmpDir, "work", "items");
    await mkdir(itemsDir, { recursive: true });
    await mkdir(path.join(tmpDir, "work", "projects"), { recursive: true });
    return { tmpDir, itemsDir, adapter: new MarkdownWorkItemAdapter(tmpDir) };
  }

  it("create with scores throws UnsupportedWorkItemFieldError and writes no file", async () => {
    const { tmpDir, itemsDir, adapter } = await harness();
    try {
      await expect(
        adapter.create({ type: "task", title: "scored", scores })
      ).rejects.toMatchObject({
        name: "UnsupportedWorkItemFieldError",
        code: "work_item_field_unsupported",
        field: "scores"
      });
      await expect(
        adapter.create({ type: "task", title: "scored", scores })
      ).rejects.toBeInstanceOf(UnsupportedWorkItemFieldError);
      expect(await readdir(itemsDir)).toEqual([]);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it.each([
    ["an object", scores],
    ["null", null]
  ])("patch with scores = %s throws and leaves the file untouched", async (_label, value) => {
    const { tmpDir, itemsDir, adapter } = await harness();
    try {
      const created = await adapter.create({ type: "task", title: "plain" });
      const [file] = await readdir(itemsDir);
      const filePath = path.join(itemsDir, file as string);
      const before = await readFile(filePath, "utf8");
      const { revision } = parseFrontmatter(before);

      await expect(
        adapter.patch({
          id: created.id,
          expectedRevision: revision,
          set: { title: "renamed", scores: value }
        })
      ).rejects.toBeInstanceOf(UnsupportedWorkItemFieldError);
      expect(await readFile(filePath, "utf8")).toBe(before);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
