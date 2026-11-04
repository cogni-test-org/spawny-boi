---
description: Route the bound node work item to its lifecycle command.
---

Continue the current node's owned work item: #$ITEM.
Invoke the command for its status, preserving all invocation arguments.

| status          | invoke                       |
| --------------- | ---------------------------- |
| needs_triage    | /triage                      |
| needs_research  | /research                    |
| needs_design    | /design, then /review-design |
| needs_implement | /implement                   |
| needs_merge     | /review-implementation       |
| needs_closeout  | /closeout                    |

Each command loads its owning procedure and any required dependencies.
A multi-task outcome uses dev-manager. Knowledge-only contributions use
contribute-knowledge-to-cogni.
