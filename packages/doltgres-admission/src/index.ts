// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

export {
  acquireDoltWriterLocks,
  assertDoltWriterLock,
  doltWriterLockKey,
  DoltWriterAdmissionError,
} from "./locks.js";
export type {
  DoltWriterConnection,
  DoltWriterLock,
  DoltWriterProtocol,
} from "./locks.js";
export {
  runDoltBranchMutation,
  reconcileAbandonedDoltOperation,
  captureDoltPersistedCleanEdit,
  captureDoltFreshCleanEdit,
  DoltPersistedCleanEditConflictError,
  DoltBranchMutationUncertainError,
} from "./branch-mutation.js";
export type {
  DoltBranchMutationOptions,
  DoltBranchMutationResult,
  DoltAbandonedOperationProof,
  DoltPersistedCleanEditReceipt,
  DoltFreshCleanEditReceipt,
} from "./branch-mutation.js";

export { DoltNativeSessionExecutor } from "./native-session-executor.js";
export type {
  DoltNativeSessionOptions,
  DoltNativeSessionErrors,
  DoltNativeSessionLogger,
  DoltNativeWriterPool,
  DoltNativeReservedConnection,
  DoltNativeWriteConnection,
  DoltNativeWriterGuard,
} from "./native-session-executor.js";
