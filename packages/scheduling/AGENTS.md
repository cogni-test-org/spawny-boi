# scheduling

Published `@cogni-dao/scheduling` owns wire contracts, owner-scoped run readback and pure run presentation.

- Root exports contracts, read ports, service and typed errors. No app, private workspace, environment or HTTP imports.
- `/adapters/postgres` uses an injected app-role postgres.js client; no client creation, role switching, schema execution or pool lifecycle.
- `/presentation` is pure and framework-neutral. Nodes own routes, auth, components and styles.
- Keep PostgreSQL cursor precision, explicit schedule ownership, RLS, null-slot ordering and limit+1 semantics.
- Root and adapter must share the same error constructors in packed ESM.
- Build declarations only with tsc; tsup owns JavaScript. Verify packed entrypoints and a clean consumer before publication.
- Design: https://cognidao.org/knowledge/inbox/contrib-flock-leader-conductor-ee9eb314
