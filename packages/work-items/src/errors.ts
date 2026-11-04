// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

export class WorkItemLeaseConflictError extends Error {
  constructor(public readonly id: string) {
    super(`Work item is claimed by another principal or lease: ${id}`);
    this.name = "WorkItemLeaseConflictError";
  }
}

export class WorkItemsBusyError extends Error {
  constructor(message = "Work-item store is busy; retry shortly") {
    super(message);
    this.name = "WorkItemsBusyError";
  }
}

/** Native work still owns capacity; caller retries must not create a replacement. */
export class WorkItemsCapacityError extends WorkItemsBusyError {
  readonly code = "work_items_native_capacity_held" as const;
  constructor(readonly nativeState: "pending" | "unknown") {
    super(
      `Work-item native capacity is ${nativeState}; retry after settlement`
    );
  }
}

/** Durable identities are never reused; cancel the versioned row instead. */
export class WorkItemDeletionRetiredError extends Error {
  constructor() {
    super(
      "Work-item hard deletion is retired; PATCH status=cancelled to preserve identity and provenance"
    );
    this.name = "WorkItemDeletionRetiredError";
  }
}

/** Current intent may have committed; inspect its durable branch before any replay. */
export class WorkItemWriteOutcomeUnknownError extends Error {
  readonly code = "work_item_write_outcome_unknown" as const;
  readonly retryable = false;
  constructor(
    readonly operationId: string,
    readonly branch: string,
    readonly commitHash?: string,
    readonly itemId?: string
  ) {
    super(
      `Work-item write outcome requires inspection; do not replay ${operationId}. Inspect main and ${branch} using the operation receipt.`
    );
    this.name = "WorkItemWriteOutcomeUnknownError";
  }
  get receipt(): {
    code: string;
    retryable: false;
    lookup: Readonly<Record<string, string | null>>;
  } {
    return {
      code: this.code,
      retryable: false,
      lookup: {
        operationId: this.operationId,
        branch: this.branch,
        commitHash: this.commitHash ?? null,
        itemId: this.itemId ?? null,
      },
    };
  }
}

/** A requested revision no longer matches; no content commit was made. */
export class WorkItemRevisionConflictError extends Error {
  constructor(
    public readonly id: string,
    public readonly expectedRevision: number,
    public readonly currentRevision: number
  ) {
    super(
      `Work item revision conflict: ${id} expected revision ${expectedRevision}, current ${currentRevision}`
    );
    this.name = "WorkItemRevisionConflictError";
  }
}

/** A `scores` write broke the package bounds (`parseWorkItemScores`); nothing was written. */
export class WorkItemScoresInvalidError extends Error {
  readonly code = "work_item_scores_invalid" as const;
  constructor(
    readonly issues: ReadonlyArray<{
      readonly code: string;
      readonly path: readonly string[];
      readonly message: string;
    }>
  ) {
    super(
      `Invalid work-item scores: ${issues
        .map((issue) =>
          issue.path.length
            ? `${issue.path.join(".")}: ${issue.message}`
            : issue.message
        )
        .join("; ")}`
    );
    this.name = "WorkItemScoresInvalidError";
  }
}
