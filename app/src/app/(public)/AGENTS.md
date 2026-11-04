# (public) · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** draft
- **Last reviewed:** 2026-10-30

## Purpose

Public (unauthenticated) pages wrapped in `AppHeader` + `AppFooter` shell. Server-side session check redirects signed-in users to `/chat`. Primary auth routing enforced at proxy level (`src/proxy.ts`).

## Pointers

- [App AGENTS.md](../AGENTS.md)
- [Architecture](../../../../../docs/spec/architecture.md)

## Boundaries

```json
{
  "layer": "app",
  "may_import": ["features", "shared", "components", "contracts"],
  "must_not_import": ["adapters", "core", "ports"]
}
```

## Public Surface

- **Exports:** none
- **Routes:** `/` (homepage — redirects signed-in users to `/chat`)
- **Files considered API:** `layout.tsx`, `page.tsx`, `AuthRedirect.tsx`

## Responsibilities

- This directory **does**: Render the public page shell (header + footer), redirect authenticated users to `/chat` via server-side session check (defense-in-depth; proxy.ts is the primary authority).
- This directory **does not**: Implement authentication, render protected data, or manage session state.

## Usage

```bash
pnpm dev     # start dev server
pnpm build   # build for production
```

## Standards

- Server-side redirect (`getServerSessionUser` + `redirect()`) is defense-in-depth; `proxy.ts` handles primary auth routing.
- `AuthRedirect` completes an already-authenticated SIWE sign-in with a hard `/chat` navigation, so proxy.ts re-evaluates the new cookie. It is not an auth guard; proxy.ts remains the routing authority.
- That handoff uses the same `AppShell` + `BrainLoading` as protected pages. Do not add a separate text spinner or duplicate shell dimensions.
- No auth guard — pages render for unauthenticated visitors.

## Dependencies

- **Internal:** `@/features/layout` (AppHeader, AppFooter), `@/features/home` (LandingHero, ShowcaseCards, ActivityFeed, HomeStats — all copy/data in `content.ts`), `@/lib/auth/server` (getServerSessionUser)
- **External:** next, react

## Change Protocol

- Update this file when **Routes** change
- Bump **Last reviewed** date

## Notes

- `AuthRedirect` is mounted only on the public homepage; its shared app shell renders only after the session is authenticated.
