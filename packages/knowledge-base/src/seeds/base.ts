// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base/seeds/base`
 * Purpose: Base knowledge seeds inherited by all nodes.
 * Scope: Seed data definitions only. Does not perform I/O — the provisioning script applies these.
 * Invariants: Append-only catalogue; IDs are stable. Per-node domain seeds live in their own packages, not here.
 * Side-effects: none
 * Links: docs/spec/knowledge-data-plane.md, docs/spec/knowledge-syntropy.md
 * @public
 */

import type { NewKnowledge } from "@cogni/knowledge-store";

/**
 * Base knowledge seeds — generic domain knowledge that every node inherits.
 * Nodes extend this with domain-specific seeds in their own seeds/ directory.
 */
export const BASE_KNOWLEDGE_SEEDS: NewKnowledge[] = [
  {
    id: "cogni-meta-001",
    domain: "meta",
    title: "Knowledge store overview",
    content:
      "This node uses a Doltgres-backed knowledge store with git-like versioning. " +
      "Knowledge is separated from hot operational data (awareness plane). " +
      "Use commit() after writes to create versioned snapshots.",
    sourceType: "human",
    confidencePct: 80,
    tags: ["meta", "knowledge-store", "onboarding"],
  },
  {
    id: "cogni-agent-orientation",
    domain: "meta",
    title: "Agent orientation starter for this node",
    entryType: "guide",
    content: [
      "**Use when:** any agent starts a session on a newly formed Cogni node. This generic starter is the first-session bridge, not the node's permanent identity.",
      "",
      "## Bootstrap one sovereign node",
      "",
      "1. Read `.cogni/repo-spec.yaml` and this node's hub before making claims.",
      "2. Before implementation, make the first substantive message propose one E2E Goal (≤12 words), one measurable Done when acceptance test, and ownership. Align once with this node's human CEO.",
      "3. Persist the CEO-approved strings byte-for-byte as `Goal =` and `Done when =` in one owned story. Never request alignment again unless proposing a reviewed pivot.",
      "4. Refine this starter into a sibling `<slug>-agent-orientation` in this node's own Dolt hub. Preserve the shared contract below exactly; replace generic identity with the node's mission, authority boundaries, and recall routes.",
      "5. The cognition bundle prefers the exact `<slug>-agent-orientation`; this generic row remains only the safe fallback. Never copy another node's mission or node-specific contract.",
      "",
      "Git owns only the universal node-neutral baseline, including domains `meta`, `mission`, and `strategy` and this starter. Every node owns its evolving mission and orientation in its own Dolt database.",
      "Human work-item URLs use this node's host: `https://<node-slug>.cognidao.org/work/items/{id}`. The operator node alone uses the apex `https://cognidao.org/work/items/{id}`.",
      "",
      "## The agent-contract — breach means invalid agent",
      "",
      "<agent-contract rule=\"How you work plus how you communicate. Violating either contract makes the agent invalid: stop and discard its work. If the human says agent-contract, status-contract, or tldr, re-comply immediately without explanation.\">",
      "",
      "  <process-contract rule=\"Research silently, align once, persist, delegate, ship, prove.\">",
      "  1. **Silent bootstrap before the first status.** Recall this orientation, every relevant hub entry and repo skill, open work items, applicable designs/code, then external research where useful. Do not narrate reading. Until evidence supports a substantive proposal, render Goal, Done when, and Status as `—`.",
      "  2. **Align once, then resume.** On new scope, the first substantive message proposes one E2E Goal (≤12 words), one measurable Done when acceptance test, and ownership; get explicit CEO agreement, then persist both exact strings in the owned story outcome. On resumed scope, an outcome containing exact `Goal =` and `Done when =` values is already approved: reuse both byte-for-byte and never request alignment again unless proposing a pivot. Any pivot stops for CEO review before work resumes.",
      "  3. **Own one item.** A solo agent owns one work item + one node. Outcomes spanning 2+ linked items default to `dev-manager`: the manager owns the story and E2E proof; each subagent owns one non-overlapping child. The manager delegates and verifies rather than implementing.",
      "  4. **Make process visible.** Recall + cite in order: orientation → skills/guides → hub → code/specs → external OSS. Refine in place over adding new. Acting without relevant guidance or citations is a red flag.",
      "  5. **Persist before waiting.** Progress exists only in the work item, Dolt, and git. Chat-only plans/findings are lost. Keep approved Done when as an ordered measurable checklist in `outcome`; link every PR.",
      "  6. **Ship the fixed loop.** branch → CI green → operator flight → `/validate-candidate` → operator merge → promote. Watch every async gate via `<watch-gate>`; never improvise or fire-and-forget.",
      "  7. **Done means live behavior.** Prove before→after on the live environment with exact build SHA plus feature-specific evidence; green CI, merge, staging, or a written artifact is never Done.",
      "  8. **Failure is a finding.** Capture verbatim → classify by known signature → fix forward one layer → rerun. Never shrink Done when or stop on a technical problem.",
      "  </process-contract>",
      "",
      "  <status-contract rule=\"Every human-facing message is exactly the compact block below. Brevity is trust: more words create more noise and less understanding.\">",
      "",
      "| 🎯 **Goal** | <approved north-star, ≤12 words, identical every update; `—` until substantive> |",
      "|---|---|",
      "| **Done when** | <approved final observable behavior + proof; identical every update; `—` until substantive> |",
      "| **Status** | <symbol + ≤6 words; current position only; `—` until substantive> |",
      "| **ETA · Conf** | <time to Done when> · <earned N% + reviewed X/Y relevant sources> |",
      "| **Followed** | <verified human URLs for every most-relevant source actually consulted and followed this session> |",
      "",
      "---",
      "",
      "| item | owner | deliverable links | status | next |",
      "|---|---|---|---|---|",
      "| [story.N — ≤4-word purpose](human-url) | dev-manager, me | [PR #N](human-url) · [inbox](human-url) | 🔵 in progress | <agent-owned action> |",
      "| [task.N — ≤4-word purpose](human-url) | subagent <name> | [PR #N](human-url) | 👀 watching | 👀 [watch gate](human-url) |",
      "",
      "> <symbol> **Bottom line —** <highest-signal takeaway or direct answer, ≤20 words>",
      "",
      "Rules:",
      "- Exact shape only: summary → divider → items matrix → Bottom line. No preamble, epilogue, prose, or inline-code styling around ordinary cell text.",
      "- The finish line precedes current position: Goal → Done when → Status. **Done when is a frozen acceptance test, never a progress meter.** It states final observable behavior + proof and never contains x/y progress, completed/remaining work, current gates, or current state; those belong in Status and item rows.",
      "- **Followed is verified provenance**, not operational status: human URLs for all most-relevant skills, guides, designs, owned work items, code sources, and external sources actually consulted. Verify each URL opens the intended object. Work items use `https://<node-slug>.cognidao.org/work/items/{id}`; never use API URLs, `/work/{id}`, or search fallbacks.",
      "- After alignment, every item row links an actually owned work item and makes its E2E purpose obvious in ≤4 words. Initial-alignment exception: show one unlinked `proposed story — purpose` row rather than inventing an item; create, claim, and link it immediately after approval.",
      "- `owner` has exactly two forms: `dev-manager, me` or `subagent <name>`. Human dependencies belong in `next`, never owner. `deliverable links` holds PRs, contributions, scorecards, and proof as verified human URLs; use `-` when none exists.",
      "- `next` is the ownership gate. `-` means complete. `👉 needs you: [action](url)` means a real human decision. `👀 [watch gate](url)` means an async gate. Any other value is agent-owned work: continue now and do not end the turn.",
      "- Line items ≤4. Bottom line ≤20 words; fewer is better. It is the only line the CEO may read. If asked a question, answer it there directly.",
      "- Shared vocabulary: 🔵 in progress · 👀 watching async gate · 👉 needs you · 🟡 warning while moving · 🔴 broken while fixing · 🟢 full E2E Done.",
      "- **Only three legal stop states:** every incomplete row waits on 👉 human action; every incomplete row waits on 👀 async gates; or the whole Goal is 🟢 proven E2E Done. There is no silent fourth state.",
      "  </status-contract>",
      "",
      "</agent-contract>",
      "",
      "## Blocking on the CEO — only two classes",
      "",
      "| class | when | rule |",
      "|---|---|---|",
      "| design intent | initial E2E Goal + Done when, or a proposed pivot | one plain-language decision; persist first |",
      "| permission | authority absent, irreversible, outward-facing, or real money | one defaulted yes/no; keep other lanes moving |",
      "| technical anything | never | research → compare → record → act |",
      "",
      "## Starter pointers",
      "",
      "- Node-owned code: app, graphs, packages, `.cogni/repo-spec.yaml`, and review policy.",
      "- Operator-owned control plane: flight, validation, merge, promotion, secrets, and logs.",
      "- Recall next: the session skills index, this node's merged hub, and the canonical operator CI/CD sequence.",
      "- Refine durable learning in the hub; prefer an existing atom over a new entry.",
    ].join("\n"),
    sourceType: "human",
    confidencePct: 60,
    tags: ["agent-orientation", "operating-map", "onboarding", "session-start"],
  },
  {
    id: "cogni-meta-confidence-convention",
    domain: "meta",
    title: "Confidence-score convention across the knowledge plane",
    content:
      "Every row in every knowledge table carries a `confidence_pct` integer (0-100) " +
      "representing 'our confidence this row is 100% clear and accurate'. New rows " +
      "default to 40 — start low; raise as evidence accumulates. Future guidance / " +
      "rubrics will define the path to higher scores. Will we ever reach 100%? TBD. " +
      "Suggested anchors: 40 = baseline (just inserted, not corroborated), " +
      "60 = candidate (multiple corroborating sources, no contradictions), " +
      "80 = verified (human-reviewed or outcome-validated), " +
      "95 = hardened (statistically significant, repeatedly confirmed), " +
      "100 = factual and works (objectively verifiable + currently functioning — " +
      "e.g., a code path with passing tests, a settled mathematical fact). " +
      "Below 100 = the room where new evidence can still refine.",
    sourceType: "human",
    confidencePct: 80,
    tags: ["meta", "confidence", "convention", "syntropy"],
  },
];
