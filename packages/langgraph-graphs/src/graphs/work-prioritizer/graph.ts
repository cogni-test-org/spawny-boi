// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/** Pure scoring-program configuration of the shared native harness.
 * Host intent admits bounded scores patches; program-owned receipts preserve the evidence guard.
 */
import { WORK_ITEM_TRANSITION_NAME } from "@cogni/ai-tools";
import { cogniProfile, createCogniProgram } from "../cogni/graph";
import type { CreateReactAgentGraphOptions } from "../types";
import {
  COGNI_READ_PROMPT,
  COGNI_DECIDE_PROMPT,
  EVIDENCE_READER_DESCRIPTION,
  EVIDENCE_READER_PROMPT,
  LEDGER_READER_DESCRIPTION,
  LEDGER_READER_PROMPT,
  REQUIRED_GUIDANCE_IDS,
  prioritizerPrompt,
} from "./prompts";
import { RunReceipts } from "./receipts";
import { projectMissionCycleReport } from "./report";
import { createScoresGuard } from "./score-guard";
import { COGNI_READ_TOOL_IDS } from "./tools";
export {
  cycleScores,
  cycleTelemetry,
  projectMissionCycleReport,
  type MissionLoopTelemetry,
} from "./report";
export const WORK_PRIORITIZER_GRAPH_NAME = "work-prioritizer" as const;

export function createWorkPrioritizerGraph(opts: CreateReactAgentGraphOptions) {
  const receipts = opts.programState as RunReceipts | undefined;
  // Behavior mode is the program: READ (chat) answers and files nothing; the scheduled programs
  // DECIDE. The read topology has no write tool bound at all.
  const readAuthority = new Set<string>(opts.readToolIds ?? COGNI_READ_TOOL_IDS);
  const readToolIds = opts.tools
    .map((tool) => tool.name)
    .filter(
      (name) =>
        name !== WORK_ITEM_TRANSITION_NAME &&
        readAuthority.has(name),
    );
  const deciding =
    (opts.program === "cogni-decide" || opts.program === "work-review") &&
    opts.requestIntent === "decide";
  const writer = opts.tools.find(
    (tool) => tool.name === WORK_ITEM_TRANSITION_NAME,
  );
  const requiredGuidanceIds = deciding ? REQUIRED_GUIDANCE_IDS : [];
  const profile = cogniProfile({
    id: opts.program ?? "work-review",
    instructions: prioritizerPrompt(
      opts.systemPrompt ?? (deciding ? COGNI_DECIDE_PROMPT : COGNI_READ_PROMPT),
      deciding,
    ),
    modelTier: "main",
    toolIds: readToolIds,
    allowedChildProfiles: ["general-purpose", "ledger-reader"],
    skillIds: (opts.sourceContext?.governingIndex ?? []).map(
      (entry) => entry.id,
    ),
  });
  const guardedTools =
    deciding && receipts && writer
      ? [createScoresGuard(receipts, writer, requiredGuidanceIds)]
      : [];
  return createCogniProgram({
    ...opts,
    onSkillReadFailure: () => {
      if (receipts) receipts.denied = true;
    },
    guardedTools,
    profile,
    children: [
      {
        description: EVIDENCE_READER_DESCRIPTION,
        profile: cogniProfile({
          id: "general-purpose",
          instructions: EVIDENCE_READER_PROMPT,
          modelTier: "flash",
          toolIds: readToolIds,
          skillIds: profile.skillIds,
          allowedChildProfiles: [],
        }),
      },
      {
        description: LEDGER_READER_DESCRIPTION,
        profile: cogniProfile({
          id: "ledger-reader",
          instructions: LEDGER_READER_PROMPT,
          modelTier: "flash",
          toolIds: [
            "core__goal_list",
            "core__work_item_query",
            "core__work_item_read",
            "core__knowledge_read",
            "core__get_current_time",
          ],
          skillIds: profile.skillIds,
          allowedChildProfiles: [],
        }),
      },
    ],
  });
}

export function createPrioritizerRunHooks(context: {
  program?: CreateReactAgentGraphOptions["program"];
  origin?: string;
}) {
  const receipts = new RunReceipts(context.origin ?? "");
  return {
    graphOptions: { programState: receipts },
    onSkillReadFailure: () => {
      receipts.denied = true;
    },
    observeTool: (
      name: string,
      args: unknown,
      result: { ok: boolean; value?: unknown; errorCode?: string },
      toolCallId?: string,
    ) => {
      if (result.ok)
        receipts.observe(name, args, result.value);
      else receipts.denied = true;
      if (
        !context.program ||
        context.program === "work-review" ||
        context.program === "cogni-decide"
      )
        receipts.recordTool(
          name,
          args,
          result.ok
            ? result.value
            : { error: result.errorCode ?? "tool_error" },
          toolCallId,
        );
    },
    projectOutput: (answer: string) =>
      projectMissionCycleReport(
        context.program ?? "work-review",
        receipts,
        answer,
      ),
  };
}
createWorkPrioritizerGraph.createRunHooks = createPrioritizerRunHooks;
createWorkPrioritizerGraph.tierModelIds = { flash: "deepseek-v4-flash" };
