---
name: dolt-human-visuals
description: Use when authoring a Cogni knowledge entry whose primary consumer is a HUMAN reviewing it visually (design diagram, scorecard, roadmap, status surface, PR-review summary) — route to entryType html, not text-heavy prose. Trigger when a /design run produces its human-facing design, or when posting to /api/v1/knowledge/contributions for human review.
metadata:
  role: specialist
  scope: implementation
---

# dolt-human-visuals

> The contract lives in the hub, not here. This file is only the trigger.

Fetch the human-visual authoring contract — when to use `entryType: html`, the `.cogni-*` utility classes, design tokens, and sandbox-safe HTML:

- `GET /api/v1/knowledge/knowledge-human-visuals`

Do not reconstruct or preserve a fallback copy in this repository.
