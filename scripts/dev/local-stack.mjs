// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Node-owned local composition: run this repository's app and LangGraph dev.
 * Shared local infrastructure is an explicit prerequisite; this does not provision
 * infrastructure, seed knowledge, copy another node's sources, or use test adapters.
 */
import { execFileSync, spawn } from "node:child_process";
import { createWriteStream, mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { parse } from "yaml";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const mode = process.argv[2] ?? "stack";
if (!["stack", "graph", "check", "migrate"].includes(mode)) {
  throw new Error("Usage: local-stack.mjs [stack|graph|check|migrate]");
}
const env = {
  ...process.env,
  ...parseEnv(readFileSync(resolve(root, ".env.local"), "utf8")),
};
if (env.TZ && env.TZ !== "UTC")
  throw new Error("Local development requires TZ=UTC");
env.TZ = "UTC";
const identity = parse(
  readFileSync(resolve(root, ".cogni/repo-spec.yaml"), "utf8")
);
const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]);
function localUrl(name, protocols) {
  if (!env[name]) throw new Error(`${name} is required in .env.local`);
  const url = new URL(env[name]);
  if (!loopback.has(url.hostname) || !protocols.includes(url.protocol)) {
    throw new Error(`${name} must use a loopback local service`);
  }
  return url;
}
function port(name) {
  const value = Number(env[name]);
  if (!Number.isInteger(value) || value < 1024 || value > 65535) {
    throw new Error(`${name} must be an integer from 1024 through 65535`);
  }
  return value;
}
const appPort = port("PORT");
const graphPort = port("LANGGRAPH_PORT");
if (appPort === graphPort)
  throw new Error("App and LangGraph ports must differ");
if (env.APP_ENV !== "production" || env.DEPLOY_ENVIRONMENT !== "local") {
  throw new Error(
    "Use APP_ENV=production and DEPLOY_ENVIRONMENT=local for real local adapters"
  );
}
for (const name of [
  "DATABASE_URL",
  "DATABASE_SERVICE_URL",
  "DATABASE_MIGRATION_URL",
  "DOLTGRES_URL",
]) {
  localUrl(name, ["postgres:", "postgresql:"]);
}
localUrl("REDIS_URL", ["redis:"]);
localUrl("LITELLM_BASE_URL", ["http:"]);
localUrl("SCHEDULER_WORKER_HEALTH_URL", ["http:"]);
for (const [name, expectedPort] of [
  ["APP_BASE_URL", appPort],
  ["LANGGRAPH_DEV_URL", graphPort],
]) {
  const url = localUrl(name, ["http:"]);
  if (Number(url.port) !== expectedPort || url.pathname !== "/") {
    throw new Error(`${name} must match its local process port`);
  }
}
if (
  !env.TEMPORAL_ADDRESS ||
  !loopback.has(new URL(`http://${env.TEMPORAL_ADDRESS}`).hostname)
) {
  throw new Error("TEMPORAL_ADDRESS must use the local Temporal server");
}
if (!env.TEMPORAL_NAMESPACE?.startsWith("cogni-local")) {
  throw new Error(
    "TEMPORAL_NAMESPACE must be an explicit cogni-local namespace"
  );
}
for (const name of [
  "AUTH_SECRET",
  "BILLING_INGEST_TOKEN",
  "SCHEDULER_API_TOKEN",
]) {
  if (
    !env[name] ||
    env[name].length < 32 ||
    /replace-me|pending/.test(env[name])
  ) {
    throw new Error(
      `${name} must be a configured local token with at least 32 characters`
    );
  }
}
if (
  !env.LITELLM_MASTER_KEY?.startsWith("sk-") ||
  /replace-me|pending/.test(env.LITELLM_MASTER_KEY)
) {
  throw new Error(
    "LITELLM_MASTER_KEY must be the configured sk- local gateway key"
  );
}
if (env.DOLTHUB_REMOTE_URL)
  throw new Error("Local development must not push a DoltHub remote");
const dbName = `cogni_${identity.intent.name.replaceAll("-", "_")}`;
const postgresTargets = [
  "DATABASE_URL",
  "DATABASE_SERVICE_URL",
  "DATABASE_MIGRATION_URL",
].map((name) => {
  const url = new URL(env[name]);
  return `${url.hostname}:${url.port || "5432"}${url.pathname}`;
});
if (new Set(postgresTargets).size !== 1) {
  throw new Error(
    "PostgreSQL app, service and migration DSNs must use the same local host, port and database"
  );
}
const roles = ["app", "service", "migration"];
for (const [index, name] of [
  "DATABASE_URL",
  "DATABASE_SERVICE_URL",
  "DATABASE_MIGRATION_URL",
].entries()) {
  const url = new URL(env[name]);
  if (
    url.pathname !== `/${dbName}` ||
    decodeURIComponent(url.username) !==
      `${roles[index]}_${identity.intent.name.replaceAll("-", "_")}`
  ) {
    throw new Error(
      `${name} must name this node's own database and consumer role`
    );
  }
}
if (
  new URL(env.DOLTGRES_URL).pathname !==
  `/knowledge_${identity.intent.name.replaceAll("-", "_")}`
) {
  throw new Error("DOLTGRES_URL must name this node's own knowledge database");
}
const migrationUrl = env.DATABASE_MIGRATION_URL;
// Migration authority stays out of both runtime child processes.
delete env.DATABASE_MIGRATION_URL;
env.NODE_ENV = "development";
env.COGNI_REPO_PATH = root;
env.MCP_CONFIG_PATH = resolve(root, "config/mcp.servers.json");
env.NEXT_TELEMETRY_DISABLED = "1";
env.COGNI_LOCAL_INPROC = "true";
console.log(
  `Local ${identity.intent.name} (${identity.node_id}): app=${appPort}, LangGraph=${graphPort}, Temporal=${env.TEMPORAL_NAMESPACE}`
);
if (mode === "check") process.exit(0);

// Build workspace packages before migrations or the app so steps that statically
// import built dist (e.g. the Doltgres migrator importing @cogni-dao/knowledge-store)
// resolve on a fresh checkout, and the stale/unbuilt "./types.js" footgun cannot occur.
execFileSync("pnpm", ["packages:build"], { cwd: root, env, stdio: "inherit" });

// Refuse occupied ports before starting either process. Never kill a sibling.
async function assertFree(value) {
  await new Promise((accept, reject) => {
    const server = createServer();
    server.once("error", () =>
      reject(
        new Error(`Port ${value} is occupied; stop its owning process first`)
      )
    );
    server.listen(value, "127.0.0.1", () => server.close(accept));
  });
}
if (mode !== "migrate")
  for (const value of mode === "graph" ? [graphPort] : [appPort, graphPort])
    await assertFree(value);
if (mode === "stack" || mode === "migrate") {
  for (const [script, folder, databaseUrl] of [
    ["migrate.mjs", "migrations", migrationUrl],
    ["migrate-doltgres.mjs", "doltgres-migrations", env.DOLTGRES_URL],
  ]) {
    execFileSync(
      process.execPath,
      [
        resolve(root, "scripts/db", script),
        resolve(root, "app/src/adapters/server/db", folder),
      ],
      {
        cwd: root,
        env: {
          ...env,
          NODE_NAME: identity.intent.name,
          DATABASE_URL: databaseUrl,
        },
        stdio: "inherit",
      }
    );
  }
  if (mode === "migrate") process.exit(0);
}
const logDir = resolve(root, ".context/dev-logs");
mkdirSync(logDir, { recursive: true, mode: 0o700 });
// A wrapper can die while its descendants keep running in the owned group.
// Retain every group through teardown, independently of wrapper lifetime.
const processGroups = new Set();
let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const group of processGroups) {
    try {
      process.kill(-group, "SIGTERM");
    } catch {
      /* already exited */
    }
  }
  // Keep escalation alive even when every wrapper has already exited.
  setTimeout(() => {
    for (const group of processGroups) {
      try {
        process.kill(-group, "SIGKILL");
      } catch {
        /* already exited */
      }
    }
  }, 5000);
}
function run(args, cwd, logName) {
  const log = createWriteStream(resolve(logDir, logName), {
    flags: "a",
    mode: 0o600,
  });
  const child = spawn("pnpm", args, {
    cwd,
    env,
    stdio: ["inherit", "pipe", "pipe"],
    detached: true,
  });
  child.stdout.pipe(process.stdout, { end: false });
  child.stderr.pipe(process.stderr, { end: false });
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  child.once("close", () => log.end());
  if (child.pid) processGroups.add(child.pid);
  child.once("error", (error) => {
    console.error(error.message);
    stop(1);
  });
  child.once("exit", (code, signal) => {
    if (!stopping) {
      console.error(
        `Local process exited (${signal ?? code}); stopping its companion`
      );
      stop(code || 1);
    }
  });
}
process.once("SIGINT", () => stop(130));
process.once("SIGTERM", () => stop(143));
run(
  [
    "exec",
    "langgraphjs",
    "dev",
    "--host",
    "127.0.0.1",
    "--port",
    String(graphPort),
    "--no-browser",
  ],
  resolve(root, "packages/langgraph-graphs"),
  "langgraph.log"
);
if (mode === "stack")
  run(
    [
      "exec",
      "next",
      "dev",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(appPort),
    ],
    resolve(root, "app"),
    "app.log"
  );
