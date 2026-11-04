# components/kit/feedback · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** stable
- **Last reviewed:** 2026-10-30
- **Parent:** [components/kit](../../../AGENTS.md)

## Purpose

Provides reusable feedback UI components for error states, loading indicators, and user notifications.

## Pointers

- [Parent: Kit Components](../../../AGENTS.md)
- [UI Implementation Guide](../../../../../../docs/spec/ui-implementation.md)
- [Error Handling Architecture](../../../../../../docs/spec/error-handling.md)

## Boundaries

```json
{
  "layer": "components",
  "may_import": ["shared", "types"],
  "must_not_import": [
    "app",
    "features",
    "adapters",
    "core",
    "ports",
    "contracts"
  ]
}
```

## Public Surface

- **Exports:** ErrorAlert via the component barrel; BrainLoading for shared route/chat loading
- **Files considered API:** ErrorAlert.tsx, BrainLoading.tsx

## Responsibilities

- **This directory does:** Provide domain-agnostic feedback components for errors, alerts, and notifications with retry/CTA button support
- **This directory does not:** Import domain contracts, implement retry logic, or manage application state

## Usage

```typescript
import { ErrorAlert } from "@/components";

<ErrorAlert
  code="INSUFFICIENT_CREDITS"
  message="You need more credits"
  retryable={true}
  showRetry={true}
  showSwitchFree={false}
  showAddCredits={true}
  onRetry={() => handleRetry()}
  onAddCredits={() => navigate("/credits")}
/>
```

## Standards

- Generic components only (no contract imports)
- Semantic tokens for all styling
- Support deduplication (same error code shown once)
- Export through parent index.ts
- Action buttons are optional props (consumers control visibility)

## Dependencies

- **Internal:** @/shared/util/cn, @/components/kit/inputs (Button)
- **External:** react, lucide-react

## Change Protocol

- Update index.ts and parent index.ts when adding component exports
- Prop changes are breaking (require consumer updates)
- Keep components domain-agnostic (presenters receive primitive props)

## Notes

- `BrainLoading` keeps the brain stationary inside one linear SVG activity arc. Use the existing `motion-safe:animate-spin` utility; do not add logo scale, tumbling, or custom loop easing.
- The SVG mask turns while its spectrum counter-rotates at the same speed, keeping rainbow hues aligned with the brain. Both transforms stop under reduced motion; the gradient and mask themselves remain static.
- ErrorAlert deduplicates by code (prevents spam)
- Supports up to 3 action buttons (retry, switchFree, addCredits)
- Auto-dismiss timeout configurable via prop
