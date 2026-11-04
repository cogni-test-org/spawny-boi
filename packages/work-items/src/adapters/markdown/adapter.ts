// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/work-items/adapters/markdown/adapter`
 * Purpose: Markdown file-backed adapter implementing WorkItemQueryPort and WorkItemCommandPort.
 * Scope: Reads/writes YAML frontmatter in work item markdown files. Does not import from app src/.
 * Invariants:
 * - ROUND_TRIP_SAFE: Unknown frontmatter keys preserved on write.
 * - OPTIMISTIC_CONCURRENCY: Every write checks SHA-256 revision.
 * - TRANSITION_ENFORCEMENT: transitionStatus() validates via isValidTransition().
 * - BODY_PRESERVED: Markdown body never modified by adapter writes.
 * - ASSIGNEE_COMPAT: Plain string assignees map to { kind: "user", userId }.
 * - ID_ALLOC_ATOMIC: create() scans files for max numeric suffix, allocates next.
 * - NO_SILENT_DROP: `scores` (Doltgres-only, story.5111) throws UnsupportedWorkItemFieldError; nothing is written.
 * Side-effects: IO (filesystem read/write)
 * Links: docs/spec/development-lifecycle.md
 * @public
 */

import {
  compareWorkItems,
  compareWorkItemKeys,
  workItemOrderKey,
  type WorkItemOrderKey,
  normalizeWorkItemOrder,
  type WorkItemOrder
} from "../../query-order.js";
import { InvalidCursorError, queryIdentity } from "../doltgres/cursor.js";

import { readdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type { WorkItemCommandPort, WorkItemQueryPort } from "../../ports.js";
import { isValidTransition } from "../../transitions.js";
import type {
  ExternalRef,
  RelationType,
  Revision,
  SubjectRef,
  WorkItem,
  WorkItemId,
  WorkItemScores,
  WorkItemStatus,
  WorkItemType,
  WorkQuery,
  WorkRelation
} from "../../types.js";
import { toWorkItemId } from "../../types.js";
import { rankScore } from "../../scores.js";
import {
  InvalidTransitionError,
  StaleRevisionError,
  UnsupportedWorkItemFieldError
} from "./errors.js";
import {
  assigneesToRaw,
  parseFrontmatter,
  rawToWorkItem,
  serializeFrontmatter,
  workItemFieldsToRaw,
  workItemIdToRaw
} from "./frontmatter.js";

// ── Internals ────────────────────────────────────────

interface FileEntry {
  filePath: string;
  raw: Record<string, unknown>;
  body: string;
  revision: string;
  item: WorkItem;
}

const SKIP_FILES = new Set(["_index.md"]);
const SKIP_DIRS = new Set(["_archive", "_templates"]);

/** List all markdown files in a directory, skipping _index.md and special dirs. */
async function listMdFiles(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  return entries.filter(
    (f) => f.endsWith(".md") && !SKIP_FILES.has(f) && !SKIP_DIRS.has(f)
  );
}

/** Read and parse a single markdown file. Returns null if file is missing or unparseable. */
async function readEntry(filePath: string): Promise<FileEntry | null> {
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch {
    return null;
  }
  try {
    const { raw, body, revision } = parseFrontmatter(content);
    const item = rawToWorkItem(raw);
    return { filePath, raw, body, revision, item };
  } catch {
    return null;
  }
}

/** Scan all work item files across items/ and projects/ directories. */
async function scanAllEntries(workDir: string): Promise<FileEntry[]> {
  const dirs = [
    path.join(workDir, "work", "items"),
    path.join(workDir, "work", "projects")
  ];

  const entries: FileEntry[] = [];
  for (const dir of dirs) {
    const files = await listMdFiles(dir);
    const results = await Promise.all(
      files.map((f) => readEntry(path.join(dir, f)))
    );
    for (const entry of results) {
      if (entry) entries.push(entry);
    }
  }
  return entries;
}

/** Find the file entry for a given work item ID. */
async function findById(
  workDir: string,
  id: WorkItemId
): Promise<FileEntry | null> {
  const entries = await scanAllEntries(workDir);
  return entries.find((e) => (e.item.id as string) === (id as string)) ?? null;
}

/** Atomic read-modify-write: re-read, check revision, apply changes, write back. */
async function atomicWrite(
  filePath: string,
  expectedRevision: Revision,
  mutate: (raw: Record<string, unknown>) => void
): Promise<FileEntry> {
  const content = await readFile(filePath, "utf8");
  const { raw, body, revision } = parseFrontmatter(content);
  const itemId = String(raw.id ?? "");

  if (revision !== expectedRevision) {
    throw new StaleRevisionError(itemId, expectedRevision, revision);
  }

  mutate(raw);
  const newContent = serializeFrontmatter(raw, body);
  await writeFile(filePath, newContent, "utf8");

  // Re-parse to get new revision
  const updated = parseFrontmatter(newContent);
  return {
    filePath,
    raw: updated.raw,
    body: updated.body,
    revision: updated.revision,
    item: rawToWorkItem(updated.raw)
  };
}

/** Allocate the next numeric work item ID. */
async function allocateNextId(
  workDir: string,
  type: WorkItemType
): Promise<{ id: WorkItemId; numStr: string }> {
  const entries = await scanAllEntries(workDir);
  let maxNum = 0;
  for (const entry of entries) {
    const idStr = entry.item.id as string;
    const m = idStr.match(/\.(\d+)$/);
    if (m) {
      const n = Number(m[1]);
      if (n > maxNum) maxNum = n;
    }
  }
  const numStr = String(maxNum + 1).padStart(4, "0");
  return { id: toWorkItemId(`${type}.${numStr}`), numStr };
}

/** Slugify a title for use in filenames. No regex on uncontrolled input (CodeQL js/polynomial-redos). */
function slugify(title: string): string {
  const slug = Array.from(title.toLowerCase(), (ch) =>
    (ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9") ? ch : "-"
  ).join("");
  // Collapse consecutive dashes and trim — input is now controlled (only a-z, 0-9, -)
  return slug
    .replace(/-{2,}/g, "-")
    .replace(/^-/, "")
    .replace(/-$/, "")
    .slice(0, 60);
}

/** Verify a resolved path is inside the expected directory. Throws on traversal. */
function assertContained(resolved: string, parent: string): void {
  const norm = path.resolve(resolved);
  const container = path.resolve(parent);
  if (!norm.startsWith(container + path.sep) && norm !== container) {
    throw new Error(`Path traversal blocked: ${norm} is outside ${container}`);
  }
}

// ── Query helpers ────────────────────────────────────

function matchesQuery(item: WorkItem, query: WorkQuery): boolean {
  if (
    query.ids?.length &&
    !query.ids.some((qid) => (qid as string) === (item.id as string))
  ) {
    return false;
  }
  if (query.types?.length && !query.types.includes(item.type)) {
    return false;
  }
  if (query.statuses?.length && !query.statuses.includes(item.status)) {
    return false;
  }
  if (
    query.projectId &&
    (item.projectId as string) !== (query.projectId as string)
  ) {
    return false;
  }
  if (
    query.projectIds?.length &&
    (!item.projectId || !query.projectIds.includes(item.projectId))
  )
    return false;
  const score = rankScore(item.scores);
  if (
    query.rankMin !== undefined &&
    (score === undefined || score < query.rankMin)
  )
    return false;
  if (
    query.rankMax !== undefined &&
    (score === undefined || score > query.rankMax)
  )
    return false;
  if (query.assignee) {
    const a = query.assignee;
    const found = item.assignees.some((ref) => {
      if (a.kind !== ref.kind) return false;
      if (a.kind === "user" && ref.kind === "user")
        return a.userId === ref.userId;
      if (a.kind === "agent" && ref.kind === "agent")
        return a.agentId === ref.agentId;
      if (a.kind === "system" && ref.kind === "system")
        return a.serviceId === ref.serviceId;
      return false;
    });
    if (!found) return false;
  }
  if (query.actor && query.actor !== "either" && item.actor !== query.actor && item.actor !== "either") {
    return false;
  }
  if (query.node) {
    const want = Array.isArray(query.node) ? query.node : [query.node];
    if (want.length && !want.includes(item.node)) return false;
  }
  if (query.labels?.length) {
    if (!query.labels.some((label) => item.labels.includes(label)))
      return false;
  }
  if (query.labelPrefix) {
    const prefix = query.labelPrefix;
    if (!item.labels.some((label) => label.startsWith(prefix))) return false;
  }
  if (query.scored !== undefined) {
    // Scores are Doltgres-only, so a markdown item is always unscored.
    if ((rankScore(item.scores) !== undefined) !== query.scored) return false;
  }
  if (query.text) {
    const t = query.text.toLowerCase();
    const titleAndSummary = `${item.title} ${item.summary ?? ""}`.toLowerCase();
    if (!titleAndSummary.includes(t) && !String(item.id).toLowerCase().includes(t) && !item.labels.some(label => label.toLowerCase().includes(t))) return false;
  }
  return true;
}

// ── Pagination cursor ────────────────────────────────

const MARKDOWN_CURSOR_PREFIX = "md3:";
function encodeMarkdownCursor(item: WorkItem, order: WorkItemOrder, query: WorkQuery): string {
  const key = workItemOrderKey(item, order);
  const encode = (payload: object) => MARKDOWN_CURSOR_PREFIX + Buffer.from(JSON.stringify(payload)).toString("base64url");
  const common = { id: key.id, ...order, filter: queryIdentity(query) };
  if (typeof key.value === "string") {
    if (key.value.length <= 1024) {
      const cursor = encode({ value: key.value, ...common });
      if (cursor.length <= 2048) return cursor;
    }
    return encode({ keyRef: createHash("sha256").update(key.value).digest("hex"), ...common });
  }
  return encode({ value: key.value ?? null, ...common });
}
function decodeMarkdownCursor(cursor: string | undefined, order: WorkItemOrder, query: WorkQuery, entries: FileEntry[]): WorkItemOrderKey | undefined {
  if (cursor === undefined) return undefined;
  try {
    if (!cursor.startsWith(MARKDOWN_CURSOR_PREFIX) || cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(cursor.slice(MARKDOWN_CURSOR_PREFIX.length))) throw new Error();
    const parsed: unknown = JSON.parse(Buffer.from(cursor.slice(MARKDOWN_CURSOR_PREFIX.length), "base64url").toString());
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    const value = parsed as Record<string, unknown>;
    const numeric = ["rankScore", "priority", "rank", "estimate"].includes(order.sortBy);
    if (typeof value.id !== "string" || !value.id || value.id.length > 512 ||
      value.filter !== queryIdentity(query) || value.sortBy !== order.sortBy || value.sortDirection !== order.sortDirection) throw new Error();
    if (value.keyRef !== undefined) {
      if (numeric || value.value !== undefined || typeof value.keyRef !== "string" || !/^[a-f0-9]{64}$/.test(value.keyRef)) throw new Error();
      const entry = entries.find((candidate) => candidate.item.id === value.id);
      if (!entry) throw new Error();
      const key = workItemOrderKey(entry.item, order);
      if (typeof key.value !== "string" || createHash("sha256").update(key.value).digest("hex") !== value.keyRef) throw new Error();
      return key;
    }
    if (!(value.value === null || (numeric ? typeof value.value === "number" && Number.isFinite(value.value) : typeof value.value === "string" && value.value.length <= 1024))) throw new Error();
    return { id: value.id, value: value.value === null ? undefined : value.value as string | number };
  } catch { throw new InvalidCursorError(); }
}

// ── Adapter class ────────────────────────────────────

export class MarkdownWorkItemAdapter
  implements WorkItemQueryPort, WorkItemCommandPort
{
  constructor(private readonly workDir: string) {}

  // ── QueryPort ──────────────────────────────────────

  async get(id: WorkItemId): Promise<WorkItem | null> {
    const entry = await findById(this.workDir, id);
    return entry?.item ?? null;
  }

  async list(
    query?: WorkQuery
  ): Promise<{ items: WorkItem[]; nextCursor?: string }> {
    queryIdentity(query ?? {});
    const entries = await scanAllEntries(this.workDir);
    let items = entries.map((e) => e.item);

    if (query) {
      items = items.filter((item) => matchesQuery(item, query));
    }

    const order = normalizeWorkItemOrder(query);
    items.sort((a, b) => compareWorkItems(a, b, order));

    // NO_SILENT_TRUNCATION: a page cut short by `limit` returns `nextCursor`, so a
    // caller that walks pages (e.g. a complete backlog snapshot) never mistakes the
    // first page for the whole backlog.
    const boundary = decodeMarkdownCursor(query?.cursor, order, query ?? {}, entries);
    const rest = boundary ? items.filter((item) => compareWorkItemKeys(workItemOrderKey(item, order), boundary, order) > 0) : items;
    if (query?.limit && rest.length > query.limit) {
      return {
        items: rest.slice(0, query.limit),
        nextCursor: encodeMarkdownCursor(rest[query.limit - 1]!, order, query)
      };
    }
    return { items: rest };
  }

  async listRelations(id: WorkItemId): Promise<WorkRelation[]> {
    const entries = await scanAllEntries(this.workDir);
    const relations: WorkRelation[] = [];
    const idStr = id as string;

    for (const entry of entries) {
      const rawRelations = entry.raw.relations;
      if (!Array.isArray(rawRelations)) continue;

      const fromId = entry.item.id;
      for (const rel of rawRelations) {
        if (!rel || typeof rel !== "object") continue;
        const toStr = String(rel.to ?? "");
        const relType = String(rel.type ?? "") as RelationType;

        // Include if this entry is the source and target matches, or target is the queried id
        if ((fromId as string) === idStr || toStr === idStr) {
          relations.push({
            fromId,
            toId: toWorkItemId(toStr),
            type: relType
          });
        }
      }
    }

    return relations;
  }

  // ── CommandPort ────────────────────────────────────

  async create(input: {
    type: WorkItemType;
    title: string;
    summary?: string;
    outcome?: string;
    specRefs?: string[];
    projectId?: WorkItemId;
    parentId?: WorkItemId;
    labels?: string[];
    assignees?: SubjectRef[];
    node?: string;
    scores?: WorkItemScores;
  }): Promise<WorkItem> {
    if (input.scores !== undefined) {
      throw new UnsupportedWorkItemFieldError("scores");
    }
    const { id, numStr } = await allocateNextId(this.workDir, input.type);
    const slug = slugify(input.title);
    const filename = `${input.type}.${numStr}.${slug}.md`;
    const today = new Date().toISOString().slice(0, 10);

    const raw: Record<string, unknown> = {
      id: workItemIdToRaw(id),
      type: input.type,
      title: input.title,
      status: "needs_triage",
      actor: "either",
      priority: 0,
      rank: 99,
      estimate: 0,
      summary: input.summary ?? "",
      outcome: input.outcome ?? "",
      spec_refs: input.specRefs ?? [],
      assignees: input.assignees ? assigneesToRaw(input.assignees) : [],
      credit: null,
      project: input.projectId ? workItemIdToRaw(input.projectId) : null,
      branch: null,
      pr: null,
      reviewer: null,
      revision: 0,
      blocked_by: null,
      deploy_verified: false,
      created: today,
      updated: today,
      labels: input.labels ?? [],
      external_refs: null,
      node: input.node ?? "shared"
    };

    if (input.parentId) {
      raw.parent = workItemIdToRaw(input.parentId);
    }

    const body = `\n\n# ${input.title}\n`;
    const content = serializeFrontmatter(raw, body);

    const itemsDir = path.join(this.workDir, "work", "items");
    const filePath = path.join(itemsDir, filename);
    assertContained(filePath, itemsDir);
    await writeFile(filePath, content, "utf8");

    const parsed = parseFrontmatter(content);
    return rawToWorkItem(parsed.raw);
  }

  async patch(input: {
    id: WorkItemId;
    expectedRevision: Revision;
    set?: Partial<
      Pick<
        WorkItem,
        | "title"
        | "summary"
        | "outcome"
        | "estimate"
        | "priority"
        | "rank"
        | "status"
        | "specRefs"
        | "labels"
        | "branch"
        | "pr"
        | "reviewer"
        | "node"
      >
    > & { scores?: WorkItemScores | null };
  }): Promise<WorkItem> {
    if (input.set?.scores !== undefined) {
      throw new UnsupportedWorkItemFieldError("scores");
    }
    const entry = await findById(this.workDir, input.id);
    if (!entry) throw new Error(`Work item not found: ${input.id as string}`);

    const result = await atomicWrite(
      entry.filePath,
      input.expectedRevision,
      (raw) => {
        if (input.set) {
          const mapped = workItemFieldsToRaw(input.set);
          Object.assign(raw, mapped);
        }
        raw.updated = new Date().toISOString().slice(0, 10);
      }
    );
    return result.item;
  }

  async transitionStatus(input: {
    id: WorkItemId;
    expectedRevision: Revision;
    toStatus: WorkItemStatus;
    reason?: string;
    blockedBy?: WorkItemId;
  }): Promise<WorkItem> {
    const entry = await findById(this.workDir, input.id);
    if (!entry) throw new Error(`Work item not found: ${input.id as string}`);

    if (!isValidTransition(entry.item.status, input.toStatus)) {
      throw new InvalidTransitionError(
        entry.item.id as string,
        entry.item.status,
        input.toStatus
      );
    }

    const result = await atomicWrite(
      entry.filePath,
      input.expectedRevision,
      (raw) => {
        raw.status = input.toStatus;
        if (input.blockedBy) {
          raw.blocked_by = workItemIdToRaw(input.blockedBy);
        }
        raw.updated = new Date().toISOString().slice(0, 10);
      }
    );
    return result.item;
  }

  async setAssignees(input: {
    id: WorkItemId;
    expectedRevision: Revision;
    assignees: SubjectRef[];
  }): Promise<WorkItem> {
    const entry = await findById(this.workDir, input.id);
    if (!entry) throw new Error(`Work item not found: ${input.id as string}`);

    const result = await atomicWrite(
      entry.filePath,
      input.expectedRevision,
      (raw) => {
        raw.assignees = assigneesToRaw(input.assignees);
        raw.updated = new Date().toISOString().slice(0, 10);
      }
    );
    return result.item;
  }

  async upsertRelation(rel: WorkRelation): Promise<void> {
    const entry = await findById(this.workDir, rel.fromId);
    if (!entry) throw new Error(`Work item not found: ${rel.fromId as string}`);

    const content = await readFile(entry.filePath, "utf8");
    const { raw, body } = parseFrontmatter(content);

    const relations: Array<{ to: string; type: string }> = Array.isArray(
      raw.relations
    )
      ? [...(raw.relations as Array<{ to: string; type: string }>)]
      : [];

    // Upsert: remove existing relation with same to+type, then add
    const idx = relations.findIndex(
      (r) => r.to === (rel.toId as string) && r.type === rel.type
    );
    if (idx >= 0) {
      relations[idx] = { to: rel.toId as string, type: rel.type };
    } else {
      relations.push({ to: rel.toId as string, type: rel.type });
    }

    raw.relations = relations;
    raw.updated = new Date().toISOString().slice(0, 10);
    await writeFile(entry.filePath, serializeFrontmatter(raw, body), "utf8");
  }

  async removeRelation(rel: {
    fromId: WorkItemId;
    toId: WorkItemId;
    type: RelationType;
  }): Promise<void> {
    const entry = await findById(this.workDir, rel.fromId);
    if (!entry) throw new Error(`Work item not found: ${rel.fromId as string}`);

    const content = await readFile(entry.filePath, "utf8");
    const { raw, body } = parseFrontmatter(content);

    if (!Array.isArray(raw.relations)) return;

    raw.relations = (
      raw.relations as Array<{ to: string; type: string }>
    ).filter((r) => !(r.to === (rel.toId as string) && r.type === rel.type));
    raw.updated = new Date().toISOString().slice(0, 10);
    await writeFile(entry.filePath, serializeFrontmatter(raw, body), "utf8");
  }

  async upsertExternalRef(input: {
    id: WorkItemId;
    expectedRevision: Revision;
    ref: ExternalRef;
  }): Promise<WorkItem> {
    const entry = await findById(this.workDir, input.id);
    if (!entry) throw new Error(`Work item not found: ${input.id as string}`);

    const result = await atomicWrite(
      entry.filePath,
      input.expectedRevision,
      (raw) => {
        const refs: ExternalRef[] = Array.isArray(raw.external_refs)
          ? [...(raw.external_refs as ExternalRef[])]
          : [];

        // Upsert by system + kind
        const idx = refs.findIndex(
          (r) => r.system === input.ref.system && r.kind === input.ref.kind
        );
        if (idx >= 0) {
          refs[idx] = input.ref;
        } else {
          refs.push(input.ref);
        }

        raw.external_refs = refs;
        raw.updated = new Date().toISOString().slice(0, 10);
      }
    );
    return result.item;
  }

  async claim(input: {
    id: WorkItemId;
    runId: string;
    command: string;
  }): Promise<WorkItem> {
    const entry = await findById(this.workDir, input.id);
    if (!entry) throw new Error(`Work item not found: ${input.id as string}`);

    const content = await readFile(entry.filePath, "utf8");
    const { raw, body } = parseFrontmatter(content);

    raw.claimed_by_run = input.runId;
    raw.claimed_at = new Date().toISOString();
    raw.last_command = input.command;
    raw.updated = new Date().toISOString().slice(0, 10);

    const newContent = serializeFrontmatter(raw, body);
    await writeFile(entry.filePath, newContent, "utf8");

    const parsed = parseFrontmatter(newContent);
    return rawToWorkItem(parsed.raw);
  }

  async release(input: { id: WorkItemId; runId: string }): Promise<WorkItem> {
    const entry = await findById(this.workDir, input.id);
    if (!entry) throw new Error(`Work item not found: ${input.id as string}`);

    const content = await readFile(entry.filePath, "utf8");
    const { raw, body } = parseFrontmatter(content);

    // Only release if claimed by the same run
    if (raw.claimed_by_run === input.runId) {
      raw.claimed_by_run = null;
      raw.claimed_at = null;
    }
    raw.updated = new Date().toISOString().slice(0, 10);

    const newContent = serializeFrontmatter(raw, body);
    await writeFile(entry.filePath, newContent, "utf8");

    const parsed = parseFrontmatter(newContent);
    return rawToWorkItem(parsed.raw);
  }
}
