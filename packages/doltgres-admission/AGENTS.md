# doltgres-admission · AGENTS.md

Private build-only workspace package; never publish a new standalone release. Existing tags/assets remain immutable. Domain packages bundle these shared internals, and the node migrator consumes knowledge-store/migrations.

Shared engine primitives and an injected native session executor for published knowledge/work-item adapters. No domain policy, runtime configuration, pool creation or environment loading. Mutation queries execute exclusively through the injected reserved, bounded connection; the executor primes only its injected writer pool before reserving. Ordinary pooled reads never enter this package.

The common writer lock is derived from the native base database. Doltgres 0.57.3 advisory names are process-wide. Bridge mode holds legacy work-item key 5001001, legacy knowledge key 5001002 and the common database key in that fixed order for the whole logical mutation. Database mode holds only the common database key; callers may select it only after proving that database has no legacy runtime. Both participants must share this protocol. Release reverses acquisition. An uncertain acquisition/release requires the caller to destroy its owned session before returning any pool slot.

The native session executor owns FIFO admission, configured deadlines, native settlement and private cleanup. Adapters supply domain errors, telemetry and budgets; the executor neither creates nor replaces pools. Branch mutation code preserves interrupted evidence and never automatically replays callbacks after an uncertain acknowledgement. Keep installed tarballs free of private workspace imports in runtime code AND declarations.

Guards are opaque capabilities bound to one module instance and exact bounded connection object. Acquire and branch mutation must execute within the same built module/chunk; a guard from an independently bundled helper copy is deliberately rejected. Installed-consumer proof must execute the published runner-to-store path, not just resolve exports. TypeScript emits declarations only; tsup owns runtime JavaScript so the later workspace declaration build cannot overwrite bundled helpers.
