// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Bounded migration execution; the node owns journals, SQL, identity and lifecycle. */
import {
  DoltBranchMutationUncertainError,
  DoltNativeSessionExecutor,
  runDoltBranchMutation,
} from "@cogni-dao/doltgres-admission";

// Keep public declarations independent of the private build-only engine package.
export interface DoltgresMigrationConnection {
  unsafe(query: string): PromiseLike<readonly Record<string, unknown>[]>;
}
export interface DoltgresMigrationPool extends DoltgresMigrationConnection {
  reserve(): PromiseLike<DoltgresMigrationConnection & { release(): void }>;
}
export interface DoltgresMigrationOptions {
  readonly writerProtocol: "bridge" | "database";
  readonly errors: {
    busy(message: string): Error;
    fault(message: string): Error;
    outcomeUnknown(
      operationId: string,
      branch: string,
      commitHash?: string
    ): Error;
  };
}
export interface DoltgresMigrationSession<T> {
  readonly sql: DoltgresMigrationConnection;
  mutate(
    message: string,
    run: (sql: DoltgresMigrationConnection) => Promise<T>
  ): Promise<T>;
}
export interface DoltgresMigrationRunner {
  run<T>(
    operationId: string,
    run: (session: DoltgresMigrationSession<T>) => Promise<T>
  ): Promise<T>;
}

export function isDoltgresMigrationOutcomeUncertain(error: unknown): boolean {
  return error instanceof DoltBranchMutationUncertainError;
}

/** Executor and branch helper share this bundled module's opaque guard realm. */
export function createDoltgresMigrationRunner(
  pool: DoltgresMigrationPool,
  options: DoltgresMigrationOptions
): DoltgresMigrationRunner {
  const executor = new DoltNativeSessionExecutor(pool, options);
  return {
    async run<T>(
      operationId: string,
      run: (session: DoltgresMigrationSession<T>) => Promise<T>
    ): Promise<T> {
      let active = true;
      const assertActive = () => {
        if (!active) throw options.errors.fault("migration session is closed");
      };
      try {
        return await executor.run<T>(
          operationId,
          async (sql, guard, owner) => {
            return run({
              sql: {
                unsafe(query) {
                  assertActive();
                  return sql.unsafe(query);
                },
              },
              async mutate(message, callback) {
                assertActive();
                const result = await runDoltBranchMutation(sql, {
                  guard,
                  operationId,
                  message,
                  onSessionUncertain: (error) => executor.retire(sql, error),
                  onReconcile: owner.registerReconciliation,
                  onCommitted: owner.committed,
                  run: async (scoped) =>
                    callback({
                      unsafe(query) {
                        assertActive();
                        return scoped.unsafe(query);
                      },
                    }),
                });
                return result.value;
              },
            });
          },
          { operationId, awaitSettlement: true }
        );
      } finally {
        active = false;
      }
    },
  };
}
