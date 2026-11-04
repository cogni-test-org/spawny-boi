// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/direct-relation-links`
 * Purpose: Load one direct relation page initially and expose explicit pagination.
 * Scope: Shared React request and rendering state. Does not own auth, routing, or styles.
 * Invariants: FIVE_INITIAL_LINKS, EXPLICIT_PAGINATION, STALE_REQUESTS_IGNORED.
 * Side-effects: IO (injected page loader)
 * Links: https://github.com/cogni-dao/cogni/issues/2832
 * @public
 */

"use client";

import {
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

/** Metadata for one direct adjacency page; cursors never imply prefetching. */
export interface DirectRelationPage<T> {
  readonly links: readonly T[];
  readonly nextCursor: string | null;
}

export interface DirectRelationLinksProps<T extends { readonly id: string }> {
  readonly entityId: string;
  /** Keep this callback stable. The node retains its authenticated transport. */
  readonly loadPage: (
    entityId: string,
    cursor?: string
  ) => Promise<DirectRelationPage<T>>;
  /** The node retains routing and its own chip or link appearance. */
  readonly renderLink: (link: T) => ReactNode;
  readonly className?: string;
  readonly headingClassName?: string;
  readonly linksClassName?: string;
  readonly moreButtonClassName?: string;
}

interface LinkState<T> extends DirectRelationPage<T> {
  readonly entityId: string;
  readonly loading: boolean;
  readonly error: boolean;
}

/**
 * Shared bounded relationship UI: one initial page, then explicit human paging.
 * Never walks links or loads neighboring bodies. Transport and routing are injected.
 */
export function DirectRelationLinks<T extends { readonly id: string }>({
  entityId,
  loadPage,
  renderLink,
  className,
  headingClassName,
  linksClassName,
  moreButtonClassName,
}: DirectRelationLinksProps<T>): ReactElement | null {
  const generation = useRef(0);
  const inFlight = useRef(false);
  const [state, setState] = useState<LinkState<T>>({
    entityId,
    links: [],
    nextCursor: null,
    loading: true,
    error: false,
  });

  const requestPage = useCallback(
    async (cursor: string | undefined, requestGeneration: number) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setState((previous) => ({ ...previous, loading: true, error: false }));
      try {
        const page = await loadPage(entityId, cursor);
        if (generation.current !== requestGeneration) return;
        setState((previous) => {
          const links = cursor ? [...previous.links] : [];
          const ids = new Set(links.map((link) => link.id));
          for (const link of page.links.slice(0, 5)) {
            if (ids.has(link.id)) continue;
            links.push(link);
            ids.add(link.id);
          }
          return {
            entityId,
            links,
            nextCursor: page.nextCursor === cursor ? null : page.nextCursor,
            loading: false,
            error: false,
          };
        });
      } catch {
        if (generation.current !== requestGeneration) return;
        setState((previous) => ({ ...previous, loading: false, error: true }));
      } finally {
        if (generation.current === requestGeneration) inFlight.current = false;
      }
    },
    [entityId, loadPage]
  );

  useEffect(() => {
    const currentGeneration = ++generation.current;
    inFlight.current = false;
    setState({
      entityId,
      links: [],
      nextCursor: null,
      loading: true,
      error: false,
    });
    void requestPage(undefined, currentGeneration);
    return () => {
      generation.current++;
    };
  }, [entityId, requestPage]);

  if (state.entityId !== entityId) return null;
  if (!state.loading && !state.error && state.links.length === 0) return null;

  return (
    <section aria-label="Related links" className={className}>
      <span className={headingClassName}>
        Links
      </span>
      <div className={linksClassName}>
        {state.links.map((link) => (
          <span key={link.id}>{renderLink(link)}</span>
        ))}
      </div>
      {state.loading && <span role="status">Loading links…</span>}
      {state.error && (
        <span role="alert">Could not load links. Try again.</span>
      )}
      {(state.nextCursor || (state.error && state.links.length === 0)) && (
        <button
          type="button"
          className={moreButtonClassName}
          disabled={state.loading}
          onClick={() =>
            void requestPage(state.nextCursor ?? undefined, generation.current)
          }
        >
          {state.links.length === 0 ? "Retry links" : "More links"}
        </button>
      )}
    </section>
  );
}
