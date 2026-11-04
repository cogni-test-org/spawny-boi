// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/cognition/_bundle`
 * Purpose: Pure composition of the session-start kickstart bundle — the
 *   irreducible tooling invariants (code-owned) plus the markdown renderer
 *   that frames local governing triggers and static operator navigation.
 * Scope: Pure functions + the invariants constant. No I/O, no env, no container.
 * Invariants:
 *   - IRREDUCIBLE_INVARIANTS_ALWAYS_PRESENT: the constant is the one piece of
 *     cognition that must render even when the hub is empty/unreachable.
 *   - ORIENTATION_LOADED_IN_FULL: renders pointers (id + title + recall path)
 *     for skills/domains, but the current-node `<slug>-agent-orientation` entry
 *     is rendered IN FULL — the bootstrap IS the agent's operating map, so the
 *     git skeleton stays minimal and the Dolt orientation carries the substance.
 *   - GOALS_AFTER_MISSION: the approved goals render as `## Goals` right after
 *     the orientation. The section text (zero-goal bootstrap instruction,
 *     `goals unavailable: …`) ships in `@cogni/knowledge-store`'s
 *     `renderGoalsLines`; this file is only the call site (story.5101).
 * Side-effects: none
 * Links: docs/spec/node-baas-architecture.md
 * @internal
 */

import {
	type GoalsSection,
	renderGoalsLines,
	isGoverningEntryType,
} from "@cogni/knowledge-store";
import {
	OPERATOR_KNOWLEDGE_ORIGIN,
	OPERATOR_GUIDANCE_POINTERS,
	OPERATOR_KNOWLEDGE_SHELVES,
	COGNITION_CREDENTIAL_NAMES,
} from "@cogni/knowledge-base/cognition-navigation";
import type {
	CognitionGoverningPointer,
	CognitionDomainPointer,
	CognitionSkillPointer,
} from "@cogni/node-contracts";

/**
 * The Markdown projection budgets 64 KiB before falling back to method/shelf
 * pointers. The native response retains the complete governingIndex, and
 * mandatory local orientation, goals and bootstrap are never truncated.
 * Harness delivery channels and the node-local loader remain unchanged.
 */

/**
 * The irreducible session contract. This is the ONLY cognition that is
 * code-owned rather than hub-delivered: it must survive an empty or unreachable
 * hub so every session still bootstraps. Everything expandable (skills, guides,
 * domain expertise) is delivered live from the knowledge hub on top of this.
 */
export const SESSION_BOOTSTRAP_INVARIANTS: readonly string[] = [
	"ONE work item + ONE node per session (CI-gated) — it IS your plan. Claim it, write your definition of done as an ordered checklist in `outcome` BEFORE you act, and refine it IN PLACE as rungs land — `outcome` is GET-readable, so a plan or 'path forward' lives THERE, never only in chat. Heartbeat; link your PR; coordination.nextAction is authoritative.",
	"Recall before you write. Search the hub first — merged (/api/v1/knowledge?domain=) and your own open branch — and refine in place over adding new.",
	"Ship via PR: same-repo branch → CI green → flight to candidate → merge. The operator is the deploy plane (flight, logs, secrets); code, work, and knowledge live in the node repo + hub. Watch each async gate (CI, flight, deploy) the ONE portable way — see <watch-gate> below.",
	"Done = validated on candidate, not merged. Flight, exercise the live surface, read your request back from Loki at that SHA, and post a /validate-candidate scorecard — the merge gate.",
	"Your <slug>-agent-orientation is the operating map: recall it first, refine it as the node changes.",
];

/**
 * How to watch an async CI/CD gate — the ONE portable technique, tagged for
 * machine parse + recall. Code-owned (survives an empty hub) and XML-structured
 * so any harness (Claude, Codex, OpenAI, plain shell) extracts the exact command
 * without prose parsing. Deliberately terse: five tagged atoms, no run-on prose.
 */
export const SESSION_WATCH_GATE = `<watch-gate rule="ONE blocking command; its exit code or matched value IS the verdict — no harness-specific monitor/background/notification primitive, never fire-and-forget, re-read the ground-truth signal before reporting">
  <ci-green>gh pr checks {PR} --watch --fail-fast — blocks; 0=all pass, nonzero=failed. NOT --required (omits real gates, e.g. build). Re-read after (one-shot 8=pending) — finished ≠ green.</ci-green>
  <flight-landed>poll curl -s {candidate}/version until .buildSha == PR-head SHA → then /validate-candidate. Bound it; no match = flight FAILED, report not hang. host: {node}-test.cognidao.org.</flight-landed>
  <deploy-landed>poll curl -s {target}/version until .buildSha == promoted SHA; bound, report on no-match. host: {node-}{preview,}cognidao.org.</deploy-landed>
  <truth>/version.buildSha is the only ground truth — CI and workflow "success" can lie.</truth>
</watch-gate>`;

/** Compatibility name; the shared store remains the sole membership-policy owner. */
export const isCognitionEntry = isGoverningEntryType;
export const WHOLE_BUNDLE_BUDGET_BYTES = 64 * 1024;

function operatorNavigationLines(): string[] {
	const { node, operator, legacyOperator } = COGNITION_CREDENTIAL_NAMES;
	return [
		"## Operator guidance — explicit reads after local boot",
		"",
		...OPERATOR_GUIDANCE_POINTERS.map(
			(p) =>
				`- ${p.intent}: \`GET ${OPERATOR_KNOWLEDGE_ORIGIN}/api/v1/knowledge/${p.id}\` (${p.domain}).`,
		),
		`- Operator shelves: ${OPERATOR_KNOWLEDGE_SHELVES.join(", ")} — \`GET ${OPERATOR_KNOWLEDGE_ORIGIN}/api/v1/knowledge/index?domain=<shelf>\`. Keep governing rows with a nonblank useWhen and current supersedes semantics; read chosen bodies before acting.`,
		`- Your local hub uses \`${node}\`. Explicit operator reads use your own operator-issued \`${operator}\`; only if absent, use saved compatibility alias \`${legacyOperator}\`. Canonical wins when both exist. Never retry another key or host on 401/403. These are agent Bearers, not vendor or workload-service keys.`,
		"- Verify GET /api/v1/agent/me on the operator host you address. grantsAvailable:false means unknown. Request the normal owner-approved developer grant (node.flight); do not self-approve or borrow credentials.",
		"- Sovereign logical lanes use the production operator reader; own operator preview/candidate use their own serving credential/receipt realm. Follow node-ai-traces-read for exact hosts and query contracts.",
		"- This navigation never fetches the operator during local boot, copies guide bodies, or seeds your hub. Local mission, goals and orientation remain node-owned.",
		"",
	];
}

function governingLines(
	rows: readonly CognitionGoverningPointer[],
	mode: "whole" | "method" | "pointer",
	origin: string,
): string[] {
	const inline =
		mode === "whole"
			? rows
			: mode === "method"
				? rows.filter((r) => r.domain === "method")
				: [];
	return [
		"## Governing index — pick by use-when, read before acting",
		"",
		mode === "whole"
			? `Read chosen entries with \`GET ${origin}/api/v1/knowledge/{id}\` before acting.`
			: `The governing index exceeds the 64 KiB Markdown budget. ${mode === "method" ? "Only the method shelf is inline. " : ""}Retrieve the complete \`governingIndex\` from this same node: \`GET ${origin}/api/v1/cognition\`. Select the required shelf locally by filtering that already governed array on \`domain\`, then read chosen entries with \`GET ${origin}/api/v1/knowledge/{id}\`. Do not rebuild membership through another endpoint or selector.`,
		"",
		"| entry | type | domain | use when |",
		"| --- | --- | --- | --- |",
		...(inline.length
			? inline.map(
					(r) =>
						`| \`${r.id}\` | ${r.entryType} | ${r.domain} | ${escapeCell(r.useWhen)} |`,
				)
			: ["| _(none inline)_ | | | |"]),
		"",
	];
}

/** Make a string safe to drop into a GFM table cell (no `|`, no line breaks). */
export function escapeCell(value: string | null | undefined): string {
	return (value ?? "")
		.replace(/\s*\r?\n\s*/g, " ")
		.replace(/\|/g, "\\|")
		.trim();
}

/** The current-node orientation entry — rendered in full as the session map. */
export interface OrientationEntry {
	id: string;
	content: string;
}

/** Minimal read surface `resolveOrientation` needs from the knowledge store. */
export interface OrientationLookupPort {
	getKnowledge(
		id: string,
	): Promise<{ id: string; content: string } | null | undefined>;
}

/**
 * Resolve the current-node orientation entry by direct id lookup.
 *
 * The legacy orientation fallback scan only reads the newest
 * PER_DOMAIN_LIMIT rows per domain, so once a domain outgrows the limit an
 * older `<slug>-agent-orientation` entry silently drops out of the scan and
 * the bundle reports it as unseeded (bug.5280). Direct lookup by exact id is
 * the ground truth; the scan result is only a fallback for suffix-named
 * entries, and the generic starter seed every node inherits comes last.
 */
export async function resolveOrientation(
	port: OrientationLookupPort,
	exactOrientationId: string,
	scannedOrientationId: string | null,
): Promise<OrientationEntry | null> {
	const candidates = [
		exactOrientationId,
		scannedOrientationId,
		"cogni-agent-orientation",
	];
	for (const id of candidates) {
		if (!id) continue;
		const entry = await port.getKnowledge(id);
		if (entry) {
			return { id: entry.id, content: entry.content };
		}
	}
	return null;
}

export interface RenderBundleInput {
	governingIndex: readonly CognitionGoverningPointer[];
	node: string;
	name: string;
	mission: string | null;
	generatedAt: string;
	origin: string;
	buildSha: string;
	toolingInvariants: readonly string[];
	skillsIndex: readonly CognitionSkillPointer[];
	domainPointers: readonly CognitionDomainPointer[];
	/** The current node's `<slug>-agent-orientation` entry (full), or null if unseeded. */
	orientation: OrientationEntry | null;
	/** Approved goals (`listActiveGoals`), rendered right after the orientation. */
	goals: GoalsSection;
}

/**
 * Render the kickstart bundle as GFM markdown. A SessionStart hook echoes this
 * verbatim to stdout; Claude Code and Codex both inject SessionStart stdout
 * into the model's context.
 */
export function renderBundle(input: RenderBundleInput) {
	const whole = renderWith(input, "whole");
	const wholeBytes = new TextEncoder().encode(whole).byteLength;
	let markdown = whole;
	let mode: "whole-index" | "shelf-pointer" = "whole-index";
	if (wholeBytes > WHOLE_BUNDLE_BUDGET_BYTES) {
		mode = "shelf-pointer";
		markdown = renderWith(input, "method");
		if (
			new TextEncoder().encode(markdown).byteLength > WHOLE_BUNDLE_BUDGET_BYTES
		)
			markdown = renderWith(input, "pointer");
	}
	const overBudget =
		new TextEncoder().encode(markdown).byteLength > WHOLE_BUNDLE_BUDGET_BYTES;
	if (overBudget)
		markdown +=
			"\n_Local cognition still exceeds the 64 KiB budget; preserved whole. The complete governingIndex remains in this response._\n";
	return {
		markdown,
		governingRender: {
			mode,
			wholeBytes,
			servedBytes: new TextEncoder().encode(markdown).byteLength,
			overBudget,
		},
	};
}

export function renderBundleMarkdown(input: RenderBundleInput): string {
	return renderBundle(input).markdown;
}

function renderWith(
	input: RenderBundleInput,
	mode: "whole" | "method" | "pointer",
): string {
	const {
		node,
		name,
		mission,
		generatedAt,
		origin,
		buildSha,
		toolingInvariants,
		orientation,
		goals,
	} = input;
	const { skillsIndex, domainPointers } = input;
	// "2026-06-16 14:20" — human date, not an ISO wall of digits.
	const loadedAt = generatedAt.replace("T", " ").slice(0, 16);
	const subtitle = [
		mission,
		`${skillsIndex.length} skills`,
		`${domainPointers.length} domains`,
		`loaded ${loadedAt}`,
	]
		.filter(Boolean)
		.join(" · ");

	const invariants = toolingInvariants
		.map((line, i) => `${i + 1}. ${line}`)
		.join("\n");

	// The node's candidate (pre-merge flight slot) — where "validated on
	// candidate" happens. operator is the primary test apex; every other node is
	// a slugged test host. Concrete so agents stop guessing the hostname.
	const candidateHost =
		name === "operator" ? "test.cognidao.org" : `${name}-test.cognidao.org`;

	const domainRows =
		domainPointers.length > 0
			? domainPointers
					.map(
						(d) =>
							`| \`${d.domain}\` | ${d.entryCount} | ${escapeCell(d.description)} |`,
					)
					.join("\n")
			: "| _(none)_ | | |";

	// The map, not just the constitution: the current-node orientation entry
	// rendered IN FULL — the bootstrap IS the orientation (no second recall).
	// Falls back to a seed prompt when unset so the convention surfaces even
	// before the entry exists.
	const orientationLines = orientation
		? ["## Orientation — recall this first", "", orientation.content]
		: [
				"## Orientation — recall this first",
				"",
				`_No \`${name}-agent-orientation\` entry yet. Recall the hub, then seed one — the current-node operating map for agents (what this node is, where authority lives, what's safe, what to recall next) — and refine it as the repo changes._`,
			];

	return [
		`# ${name} — Cogni Session Cognition`,
		"",
		`> ${subtitle}`,
		">",
		`> Delivered at session start from ${origin}/api/v1/cognition — replaces git-synced AGENTS.md sprawl. (node \`${node}\` · build \`${buildSha}\`)`,
		"",
		...orientationLines,
		...renderGoalsLines(goals),
		"",
		"## Tooling invariants",
		"",
		invariants,
		"",
		`_Your candidate (flight + validate target): \`https://${candidateHost}\` · Loki namespace \`cogni-candidate-a\`._`,
		"",
		"## Watch an async gate — CI · flight · deploy",
		"",
		SESSION_WATCH_GATE,
		"",
		...operatorNavigationLines(),
		...governingLines(input.governingIndex, mode, origin),
		"## Knowledge domains — RECALL_BEFORE_WRITE",
		"",
		"| domain | entries | about |",
		"| --- | --- | --- |",
		domainRows,
		"",
		"## Work items — this node's own ledger",
		"",
		`Your items live in THIS node's store (\`${origin}\`) — each node owns its own \`knowledge_<slug>\` database, so there is no central ledger to fall back to. ONE work item + ONE node per session.`,
		"",
		`- Find work: \`GET ${origin}/api/v1/work/items?statuses=needs_implement,needs_design\` — adopt over create.`,
		`- File one: \`POST ${origin}/api/v1/work/items\` \`{type,title,summary,outcome}\` — \`type\` ∈ task|bug|story|spike|subtask; the server allocates the id, never send one.`,
		`- Progress: \`PATCH ${origin}/api/v1/work/items/{id}\` \`{"set":{...}}\` — the wrapper is \`set\`, NOT \`patch\`.`,
		"- `status` ∈ needs_triage|needs_research|needs_design|needs_implement|needs_closeout|needs_merge|done|blocked|cancelled. There is no `in_progress`.",
		'- Close with `{"set":{"status":"done"}}` only after the PR merges.',
		`- Machine schemas for the two writes: \`GET ${origin}/.well-known/agent.json\` → \`actions.createWorkItem\` / \`actions.updateWorkItem\`.`,
		"",
		"## Recall + contribute",
		"",
		`- Browse a domain: \`GET ${origin}/api/v1/knowledge?domain=<domain>\``,
		`- Full entry body: \`GET ${origin}/api/v1/knowledge/{id}\``,
		`- Discovery doc: \`GET ${origin}/.well-known/agent.json\``,
		"- Contribute durable knowledge: `/contribute-knowledge-to-cogni` (refine in place > write new).",
		`- Cite an existing entry in your edit: \`POST ${origin}/api/v1/knowledge/contributions/{id}/commits\` with \`{op:"cite", citingId, citedId, citationType}\` — cross-plane cites (target on main) resolve and stay valid post-merge.`,
		"",
	].join("\n");
}
