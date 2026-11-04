// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/.well-known/agent.json`
 * Purpose: Discovery document for machine agents — publishes the register,
 *   runs, runStream, and completions URLs plus the auth scheme so external
 *   clients can bootstrap without hard-coding paths or reading docs.
 * Scope: Single GET handler. Honors `x-forwarded-host`/`x-forwarded-proto`
 *   from Caddy / k8s ingress so the published URLs are externally reachable
 *   (falling back to the raw Host header then request.url for local dev).
 *   Public endpoint — no auth.
 * Invariants:
 *   - NO_INTERNAL_BIND_ADDR: URLs must never expose `0.0.0.0:3000` or other
 *     in-pod addresses. Always derive origin from forwarded headers first.
 * Side-effects: none
 * Links: docs/guides/agent-api-validation.md
 * @public
 */

import {
	workItemsClaimOperation,
	workItemsCoordinationOperation,
	workItemsCreateOperation,
	workItemsGetOperation,
	workItemsHeartbeatOperation,
	workItemsListOperation,
	workItemsPatchOperation,
	workItemsReleaseOperation,
} from "@cogni/node-contracts";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
	getNodeBrandColor,
	getNodeBrandIcon,
	getNodeHook,
	getNodeMission,
	getNodeName,
	getNodeThumbnail,
} from "@/shared/config/repoSpec.server";
import { serverEnv } from "@/shared/env";

export const runtime = "nodejs";

/**
 * Resolve the public origin this request reached us through. In prod the app
 * runs behind Caddy / k8s ingress, so Next.js's `request.url` exposes the
 * in-pod bind address (e.g. `http://0.0.0.0:3000`) rather than the external
 * host clients are using. Prefer the forwarded headers the proxy injects,
 * falling back to the raw `host` and `request.url` for local/dev usage.
 */
function publicOrigin(request: Request): string {
	const url = new URL(request.url);
	const host =
		request.headers.get("x-forwarded-host") ??
		request.headers.get("host") ??
		url.host;
	const proto =
		request.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
	return `${proto}://${host}`;
}

export async function GET(request: Request) {
	const env = serverEnv();
	const origin = publicOrigin(request);
	return NextResponse.json({
		name: "Cogni Node API",
		version: "v1",
		buildSha: env.APP_BUILD_SHA,
		// IDENTITY_IS_REPO_SPEC_PROJECTION: the node's display identity, projected from its own repo-spec
		// `intent` (never hardcoded). The operator reads THIS to render gallery cards — no operator-side
		// per-node literals. A node customizes itself by editing repo-spec, not operator code.
		identity: {
			name: getNodeName(),
			hook: getNodeHook(),
			mission: getNodeMission(),
			brand: {
				icon: getNodeBrandIcon(),
				color: getNodeBrandColor(),
				thumbnail: getNodeThumbnail(),
			},
		},
		registrationUrl: `${origin}/api/v1/agent/register`,
		auth: { type: "bearer", keyPrefix: "cogni_ag_sk_v1_" },
		endpoints: {
			openapi: `${origin}/openapi.json`,
			completions: `${origin}/api/v1/chat/completions`,
			graphs: `${origin}/api/v1/ai/agents`,
			runs: `${origin}/api/v1/agent/runs`,
			runStream: `${origin}/api/v1/agent/runs/{runId}/stream`,
			// Cognition substrate: session-start bundle (invariants + live skills
			// index + domain pointers). A SessionStart hook fetches + injects it.
			cognition: `${origin}/api/v1/cognition`,
			workItems: `${origin}/api/v1/work/items`,
			workItemClaims: `${origin}/api/v1/work/items/{id}/claims`,
			workItemHeartbeat: `${origin}/api/v1/work/items/{id}/heartbeat`,
			workItemCoordination: `${origin}/api/v1/work/items/{id}/coordination`,
		},
		actions: {
			listWorkItems: {
				method: "GET",
				endpoint: `${origin}/api/v1/work/items`,
				auth: { type: "bearer" },
				inputSchema: z.toJSONSchema(workItemsListOperation.input),
				outputSchema: z.toJSONSchema(workItemsListOperation.output),
			},
			createWorkItem: {
				method: "POST",
				endpoint: `${origin}/api/v1/work/items`,
				auth: { type: "bearer" },
				inputSchema: z.toJSONSchema(workItemsCreateOperation.input),
				outputSchema: z.toJSONSchema(workItemsCreateOperation.output),
			},
			getWorkItem: {
				method: "GET",
				endpoint: `${origin}/api/v1/work/items/{id}`,
				auth: { type: "bearer" },
				inputSchema: z.toJSONSchema(workItemsGetOperation.input),
				outputSchema: z.toJSONSchema(workItemsGetOperation.output),
			},
			updateWorkItem: {
				method: "PATCH",
				endpoint: `${origin}/api/v1/work/items/{id}`,
				auth: { type: "bearer" },
				inputSchema: z.toJSONSchema(workItemsPatchOperation.input),
				outputSchema: z.toJSONSchema(workItemsPatchOperation.output),
			},
			claimWorkItem: {
				method: "POST",
				endpoint: `${origin}/api/v1/work/items/{id}/claims`,
				auth: { type: "bearer" },
				inputSchema: z.toJSONSchema(workItemsClaimOperation.input),
				outputSchema: z.toJSONSchema(workItemsClaimOperation.output),
			},
			heartbeatWorkItem: {
				method: "POST",
				endpoint: `${origin}/api/v1/work/items/{id}/heartbeat`,
				auth: { type: "bearer" },
				inputSchema: z.toJSONSchema(workItemsHeartbeatOperation.input),
				outputSchema: z.toJSONSchema(workItemsHeartbeatOperation.output),
			},
			releaseWorkItem: {
				method: "DELETE",
				endpoint: `${origin}/api/v1/work/items/{id}/claims?runId={runId}&leaseToken={leaseToken}`,
				auth: { type: "bearer" },
				inputSchema: z.toJSONSchema(workItemsReleaseOperation.input),
				outputSchema: z.toJSONSchema(workItemsReleaseOperation.output),
			},
			getWorkItemCoordination: {
				method: "GET",
				endpoint: `${origin}/api/v1/work/items/{id}/coordination`,
				auth: { type: "bearer" },
				inputSchema: z.toJSONSchema(workItemsCoordinationOperation.input),
				outputSchema: z.toJSONSchema(workItemsCoordinationOperation.output),
			},
		},
		cognition: {
			bootstrapUrl: `${origin}/api/v1/cognition`,
			sessionStartHook: `curl -fsS ${origin}/api/v1/cognition | jq -r .markdown`,
		},
		defaults: {
			model: "gpt-4o-mini",
			graph_name: "poet",
		},
		usage: {
			note: "completions requires graph_name for newly registered agents",
			example: {
				model: "gpt-4o-mini",
				graph_name: "poet",
				messages: [{ role: "user", content: "Hello" }],
			},
		},
	});
}
