Run /closeout for: #$ITEM

Keep #$ITEM bound to the current node; preserve all invocation arguments.
Read the complete owning procedure:

```bash
set -euo pipefail
set -a
source "$(git rev-parse --show-toplevel)/.env.cogni"
set +a
operator_key="${COGNI_OPERATOR_NODE_API_KEY-${COGNI_OPERATOR_API_KEY-}}"
: "${operator_key:?saved operator credential required}"
body=$(curl -fsS --max-time 20 --retry 1 \
  -H "Authorization: Bearer $operator_key" \
  "https://cognidao.org/api/v1/knowledge/closeout")
printf '%s\n' "$body" | jq -er '.content | select(type == "string" and length > 0)'
```

Use the saved canonical operator credential; the legacy alias applies only when
the canonical variable is absent. Never forward a sovereign node bearer or retry
another key or host after a 401/403.
Read required dependencies in full when the procedure requires their action.
If credentials, retrieval, content or a required dependency fails, stop that
stage and record the failed gate on the node-local item; repair it before acting.
