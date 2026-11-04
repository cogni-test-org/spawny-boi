// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/** Read-only and scheduled scores capabilities for the shared-harness node programs. */
import {
  GET_CURRENT_TIME_NAME,
  GOAL_LIST_NAME,
  KNOWLEDGE_READ_NAME,
  KNOWLEDGE_SEARCH_NAME,
  WORK_ITEM_QUERY_NAME,
  WORK_ITEM_READ_NAME,
  WORK_ITEM_TRANSITION_NAME,
} from "@cogni/ai-tools";

export { WORK_ITEM_READ_NAME };
export const COGNI_READ_TOOL_IDS = [
  GOAL_LIST_NAME,
  WORK_ITEM_QUERY_NAME,
  WORK_ITEM_READ_NAME,
  KNOWLEDGE_SEARCH_NAME,
  KNOWLEDGE_READ_NAME,
  GET_CURRENT_TIME_NAME,
] as const;
export const FLASH_SUBAGENT_MODEL = "deepseek-v4-flash";
export const COGNI_DECIDE_TOOL_IDS = [
  GOAL_LIST_NAME,
  KNOWLEDGE_READ_NAME,
  KNOWLEDGE_SEARCH_NAME,
  WORK_ITEM_QUERY_NAME,
  WORK_ITEM_READ_NAME,
  WORK_ITEM_TRANSITION_NAME,
  GET_CURRENT_TIME_NAME,
] as const;
export const MAX_SCORE_WRITES_PER_TICK = 5;
export const SCORES_WRITE_NAME = "work_item_scores_write";
export const OPEN_STATUSES = [
  "needs_triage",
  "needs_research",
  "needs_design",
  "needs_implement",
  "needs_closeout",
  "needs_merge",
  "blocked",
] as const;

export const WORK_PRIORITIZER_TOOL_IDS = COGNI_DECIDE_TOOL_IDS;
