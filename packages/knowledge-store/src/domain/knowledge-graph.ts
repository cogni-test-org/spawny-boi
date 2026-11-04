// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/domain/knowledge-graph`
 * Purpose: Pure assembly of the knowledge-graph view model (entry nodes +
 *   citation edges) from raw port reads. Shared so every node builds the graph
 *   identically instead of re-copying the assembly into each app's route.
 * Scope: Pure function + view-model types. No I/O, no env, no framework deps —
 *   the caller supplies entries + citations from the KnowledgeStorePort.
 * Invariants:
 *   - EDGE_ENDPOINTS_EXIST: an edge is kept only when BOTH endpoints are entry
 *     nodes in the set. Drops work-item `tracks` edges and dangling refs so the
 *     client never renders a floating edge. This matches the legacy per-entry
 *     outgoing-citation gather (source was always an entry; target was checked).
 * Side-effects: none
 * Links: docs/spec/knowledge-syntropy.md
 * @public
 */

import type { Citation } from "./schemas.js";

export interface KnowledgeGraphNode {
  id: string;
  domain: string;
  title: string;
  entryType: string;
  confidencePct: number | null;
  sourceType: string;
}

export interface KnowledgeGraphEdge {
  id: string;
  source: string;
  target: string;
  citationType: string;
}

export interface KnowledgeGraphModel {
  nodes: KnowledgeGraphNode[];
  edges: KnowledgeGraphEdge[];
  domains: string[];
}

/**
 * Build the graph view model. `citations` is the full edge set (one query);
 * edges are filtered to those whose citing AND cited endpoints are both entry
 * nodes, yielding the exact edge list the legacy N+1-per-entry gather produced.
 */
export function buildKnowledgeGraph(input: {
  domains: string[];
  nodes: readonly KnowledgeGraphNode[];
  citations: readonly Citation[];
}): KnowledgeGraphModel {
  const { domains, nodes: inputNodes, citations } = input;

  const nodeIds = new Set<string>();
  const nodes: KnowledgeGraphNode[] = [];
  for (const n of inputNodes) {
    nodeIds.add(n.id);
    nodes.push({
      id: n.id,
      domain: n.domain,
      title: n.title,
      entryType: n.entryType,
      confidencePct: n.confidencePct,
      sourceType: n.sourceType,
    });
  }

  const edges: KnowledgeGraphEdge[] = [];
  for (const c of citations) {
    if (!nodeIds.has(c.citingId) || !nodeIds.has(c.citedId)) continue;
    edges.push({
      id: c.id,
      source: c.citingId,
      target: c.citedId,
      citationType: c.citationType,
    });
  }

  return { nodes, edges, domains };
}
