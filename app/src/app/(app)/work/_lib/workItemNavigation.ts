// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Pure URL/history policy for route-backed work-item selection. */

type SerializableSearchParams = Pick<URLSearchParams, "toString">;
type WorkRouter = {
  push(href: string, options: { scroll: boolean }): void;
  replace(href: string, options: { scroll: boolean }): void;
};

interface WorkListState {
  readonly type: readonly string[];
  readonly status: readonly string[];
  readonly project: readonly string[];
  readonly sort: string | null;
  readonly query: string;
  readonly rankRange?: readonly [number | undefined, number | undefined];
}

export function workListHref(searchParams: SerializableSearchParams): string {
  const query = searchParams.toString();
  return query ? `/work?${query}` : "/work";
}

export function workItemHref(
  id: string,
  searchParams: SerializableSearchParams,
): string {
  const query = searchParams.toString();
  const path = `/work/items/${encodeURIComponent(id)}`;
  return query ? `${path}?${query}` : path;
}

function setListParam(
  params: URLSearchParams,
  key: string,
  values: readonly string[],
): void {
  params.delete(key);
  if (values.length > 0) params.set(key, values.join(","));
}

/** Updates owned list controls without discarding unrelated URL-backed state. */
export function workViewHref(
  selectedItemId: string | undefined,
  searchParams: SerializableSearchParams,
  state: WorkListState,
): string {
  const params = new URLSearchParams(searchParams.toString());
  params.delete("cursor");
  setListParam(params, "type", state.type);
  setListParam(params, "status", state.status);
  if (state.status.length === 0) params.set("status", "all");
  setListParam(params, "project", state.project);
  params.delete("sort");
  if (state.sort) params.set("sort", state.sort);
  params.delete("q");
  if (state.query) params.set("q", state.query);
  if (state.rankRange !== undefined) {
    for (const [index, key] of ["rankMin", "rankMax"].entries()) {
      const value = state.rankRange[index];
      params.set(key, value === undefined ? "" : String(value));
    }
  }
  return selectedItemId
    ? workItemHref(selectedItemId, params)
    : workListHref(params);
}

export function openWorkItemPermalink(
  router: WorkRouter,
  id: string,
  searchParams: SerializableSearchParams,
): void {
  router.push(workItemHref(id, searchParams), { scroll: false });
}

export function closeWorkItemPermalink(
  router: WorkRouter,
  searchParams: SerializableSearchParams,
): void {
  router.replace(workListHref(searchParams), { scroll: false });
}
