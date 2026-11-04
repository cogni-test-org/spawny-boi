---
description: Read node app and declared-service logs through the operator proxy. Recall the authoritative log API contract first.
---

# logs

Read [node-service-logs-read](https://cognidao.org/knowledge/node-service-logs-read) before retrieving logs. Use your saved operator-issued key:

```bash
set -o pipefail
: "${COGNI_OPERATOR_NODE_API_KEY:?Load your saved operator Cogni API key}"
curl -fsS --max-time 30 \
  -H "Authorization: Bearer $COGNI_OPERATOR_NODE_API_KEY" \
  https://cognidao.org/api/v1/knowledge/node-service-logs-read \
  | jq -er '.content | select(type == "string" and length > 0)'
```

The hub owns slug/UUID resolution, environment and service selection, time windows, response fields, authorization, and empty-stream interpretation. Follow it for this node's repo-spec identity and declared services. If recall fails, report the failure and retry before retrieving logs.
