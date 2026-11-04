import { readFileSync } from "node:fs";
import { parse } from "yaml";

const CI_WORKFLOW_PATH = ".github/workflows/ci.yaml";
const PR_BUILD_WORKFLOW_PATH = ".github/workflows/pr-build.yml";
const PR_LINT_WORKFLOW_PATH = ".github/workflows/pr-lint.yaml";
const PUBLISH_WORKFLOW_PATH = ".github/workflows/publish-packages.yml";
const REPO_POLICY_PATH = ".cogni/repo-policy.json";
const CONTRACT_INSTALL_COMMAND =
  "pnpm --filter @cogni/repo-spec... install --frozen-lockfile --ignore-scripts --config.dedupe-peer-dependents=false";
const MAIN_CACHE_EXPORT =
  "${{ github.event_name == 'push' && github.ref == 'refs/heads/main' && format('type=gha,mode=max,scope=node-template-{0}', matrix.target.artifact) || '' }}";

const ciWorkflow = readWorkflow(CI_WORKFLOW_PATH);
const prBuildWorkflow = readWorkflow(PR_BUILD_WORKFLOW_PATH);
const prLintWorkflow = readWorkflow(PR_LINT_WORKFLOW_PATH);
const publishWorkflow = readWorkflow(PUBLISH_WORKFLOW_PATH);
const repoPolicy = JSON.parse(readFileSync(REPO_POLICY_PATH, "utf8"));

function readWorkflow(path) {
  return parse(readFileSync(path, "utf8"));
}

function fail(path, message) {
  console.error(`${path}: ${message}`);
  process.exitCode = 1;
}

function expectEqual(path, actual, expected, label) {
  if (actual !== expected) {
    fail(path, `${label} must be ${JSON.stringify(expected)}; got ${JSON.stringify(actual)}`);
  }
}

function expectOwnKey(path, object, key, label) {
  if (!object || typeof object !== "object" || !Object.hasOwn(object, key)) {
    fail(path, `${label} must define ${key}`);
    return undefined;
  }
  return object[key];
}

function expectIncludes(path, value, fragment, label) {
  if (!String(value ?? "").includes(fragment)) {
    fail(path, `${label} must include ${JSON.stringify(fragment)}`);
  }
}

function expectStep(path, steps, name) {
  const step = steps.find((candidate) => candidate?.name === name);
  if (!step) fail(path, `steps must include ${JSON.stringify(name)}`);
  return step;
}

// These jobs consume one contract; required CI owns the full app/test closure.
function expectContractInstall(steps, jobName) {
  const install = expectStep(PR_BUILD_WORKFLOW_PATH, steps, "Install");
  expectEqual(
    PR_BUILD_WORKFLOW_PATH,
    install?.run,
    CONTRACT_INSTALL_COMMAND,
    `${jobName} frozen contract install`
  );
  const node = expectStep(PR_BUILD_WORKFLOW_PATH, steps, "Set up Node");
  for (const key of ["cache", "cache-dependency-path"]) {
    if (Object.hasOwn(node?.with ?? {}, key)) {
      fail(PR_BUILD_WORKFLOW_PATH, `${jobName} must not hydrate a broad Node cache`);
    }
  }
}

function expectTrigger(path, workflow, trigger) {
  const triggers = expectOwnKey(path, workflow, "on", "workflow");
  return expectOwnKey(path, triggers, trigger, "workflow triggers");
}

function expectMainPush(path, workflow) {
  const push = expectTrigger(path, workflow, "push");
  const branches = Array.isArray(push?.branches) ? push.branches : [];
  if (!branches.includes("main")) {
    fail(path, "push trigger must include main");
  }
}

function expectNoWorkflowDispatch(path, workflow) {
  const triggers = expectOwnKey(path, workflow, "on", "workflow");
  if (Object.hasOwn(triggers ?? {}, "workflow_dispatch")) {
    fail(path, "workflow must not use workflow_dispatch as launch or image evidence");
  }
}

function requiredCheckContexts(policy) {
  expectEqual(
    REPO_POLICY_PATH,
    policy?.schemaVersion,
    "cogni.node-repo-policy.v1",
    "schemaVersion"
  );
  expectEqual(
    REPO_POLICY_PATH,
    policy?.ruleset?.target,
    "default_branch",
    "ruleset.target"
  );
  expectEqual(
    REPO_POLICY_PATH,
    policy?.ruleset?.enforcement,
    "active",
    "ruleset.enforcement"
  );
  const bypassActors = policy?.ruleset?.bypassActors;
  if (!Array.isArray(bypassActors) || bypassActors.length !== 0) {
    fail(REPO_POLICY_PATH, "ruleset.bypassActors must be an empty array");
  }
  const contexts = policy?.ruleset?.requiredStatusChecks?.contexts;
  if (
    !Array.isArray(contexts) ||
    contexts.length === 0 ||
    contexts.some(
      (context) => typeof context !== "string" || context.length === 0
    ) ||
    new Set(contexts).size !== contexts.length
  ) {
    fail(
      REPO_POLICY_PATH,
      "ruleset.requiredStatusChecks.contexts must be non-empty unique strings"
    );
    return [];
  }
  return contexts;
}

// GitHub names a check run after the job's static `name` when one is present, and
// falls back to the job ID otherwise. Matching a required context against the job ID
// alone is therefore unsound: adding `name: Unit Tests` to job `unit` leaves the job
// ID intact while the emitted context becomes "Unit Tests" — the required check
// `unit` then never reports and the ruleset deadlocks the repo. Resolve the effective
// name the same way GitHub does.
function effectiveCheckName(jobId, job) {
  const declared = job?.name;
  return typeof declared === "string" && declared.length > 0 ? declared : jobId;
}

// A required context must resolve to ONE statically-known check name. Expressions are
// interpolated at run time and matrices fan one job out into `name (value)` per leg,
// so neither can be proven to emit the exact context this policy requires.
function unprovableCheckNameReason(jobId, job) {
  if (String(job?.name ?? "").includes("${{")) {
    return "declares a templated `name:` whose emitted check context cannot be resolved statically";
  }
  if (job?.strategy?.matrix !== undefined) {
    return "uses `strategy.matrix`, which emits one check per matrix leg rather than the bare context";
  }
  return null;
}

function findRequiredCheckProviders(workflows, context) {
  const providers = [];
  for (const { path, workflow } of workflows) {
    for (const [jobId, job] of Object.entries(workflow?.jobs ?? {})) {
      if (effectiveCheckName(jobId, job) === context) {
        providers.push({ path, workflow, jobId, job });
      }
    }
  }
  return providers;
}

function assertRequiredChecksRunOnReviewEvents(policy, workflows) {
  for (const context of requiredCheckContexts(policy)) {
    const providers = findRequiredCheckProviders(workflows, context);
    if (providers.length !== 1) {
      // Name the near-miss explicitly: a job whose ID matches but whose `name:` has
      // been changed is the exact drift this check exists to catch, and "found 0" on
      // its own sends the reader hunting for a deleted job.
      const renamed = workflows.flatMap(({ path, workflow }) =>
        Object.entries(workflow?.jobs ?? {})
          .filter(([jobId, job]) => jobId === context && effectiveCheckName(jobId, job) !== context)
          .map(([jobId, job]) => `${path} job ${jobId} now emits ${JSON.stringify(effectiveCheckName(jobId, job))}`)
      );
      fail(
        REPO_POLICY_PATH,
        `required check ${JSON.stringify(context)} must be emitted by exactly one job; found ${providers.length}` +
          (renamed.length ? ` (${renamed.join("; ")})` : "")
      );
      continue;
    }
    const [{ path, workflow, jobId, job }] = providers;
    const unprovable = unprovableCheckNameReason(jobId, job);
    if (unprovable) {
      fail(path, `required check ${JSON.stringify(context)} ${unprovable}`);
    }
    expectTrigger(path, workflow, "pull_request");
    expectTrigger(path, workflow, "merge_group");
    const jobIf = String(job?.if ?? "");
    if (
      jobIf.includes("github.event_name") ||
      jobIf.includes("github.event.action")
    ) {
      fail(
        path,
        `required job ${JSON.stringify(context)} must not conditionally disappear for a review event`
      );
    }
  }
}

// A required context that can SKIP is a required context that can pass while nothing
// ran — GitHub scores a skipped required check as success. Any required job whose
// upstream deps are themselves optional must therefore run under a bare `always()`
// and assert those deps itself, rather than gating its own `if` on their results.
function assertRequiredChecksFailClosed(policy, workflows) {
  for (const context of requiredCheckContexts(policy)) {
    const providers = findRequiredCheckProviders(workflows, context);
    if (providers.length !== 1) continue; // already reported by the emitter check
    const [{ path, job }] = providers;
    if (!Object.hasOwn(job ?? {}, "if")) continue; // no condition: cannot skip
    const condition = String(job.if).replace(/\s+/g, " ").trim();
    if (condition === "always()") continue;
    if (condition.includes("needs.") && condition.includes(".result")) {
      fail(
        path,
        `required check ${JSON.stringify(context)} gates its own \`if\` on upstream ` +
          `results (${JSON.stringify(condition)}); it would SKIP on upstream failure and ` +
          "GitHub scores a skipped required check as SUCCESS. Use `if: always()` and " +
          "assert the upstream results in a failing step instead."
      );
      continue;
    }
    fail(
      path,
      `required check ${JSON.stringify(context)} declares a conditional \`if\` ` +
        `(${JSON.stringify(condition)}); a required check must not be skippable`
    );
  }
}

expectEqual(CI_WORKFLOW_PATH, ciWorkflow?.name, "CI", "workflow name");
expectTrigger(CI_WORKFLOW_PATH, ciWorkflow, "pull_request");
expectTrigger(CI_WORKFLOW_PATH, ciWorkflow, "merge_group");
expectMainPush(CI_WORKFLOW_PATH, ciWorkflow);
expectNoWorkflowDispatch(CI_WORKFLOW_PATH, ciWorkflow);
expectEqual(CI_WORKFLOW_PATH, ciWorkflow?.permissions?.contents, "read", "permissions.contents");
expectIncludes(CI_WORKFLOW_PATH, ciWorkflow?.concurrency?.group, "ci-${{ github.workflow }}-${{ github.ref }}", "concurrency.group");
expectEqual(CI_WORKFLOW_PATH, ciWorkflow?.concurrency?.["cancel-in-progress"], true, "concurrency.cancel-in-progress");

const staticJob = ciWorkflow?.jobs?.static;
if (!staticJob) fail(CI_WORKFLOW_PATH, "jobs must include static");
const staticSteps = Array.isArray(staticJob?.steps) ? staticJob.steps : [];
expectStep(CI_WORKFLOW_PATH, staticSteps, "Install dependencies");
expectStep(CI_WORKFLOW_PATH, staticSteps, "Build workspace packages");
for (const [name, command] of [
  ["Database schema checks", "pnpm db:check"],
  ["Type check", "pnpm typecheck"],
  ["Workflow contract check", "pnpm check:workflow"],
]) {
  const step = expectStep(CI_WORKFLOW_PATH, staticSteps, name);
  expectEqual(CI_WORKFLOW_PATH, step?.run, command, `static ${name} command`);
}

const unitJob = ciWorkflow?.jobs?.unit;
if (!unitJob) fail(CI_WORKFLOW_PATH, "jobs must include unit");
// unit runs in PARALLEL with static (no `needs: static`): it does its own
// install + packages:build (asserted below), so gating on static only serialized
// the fast gate onto the critical path for a fail-fast the merge queue re-checks.
// The required-check contract (static/unit/component exist + are required) is
// enforced via repo-policy requiredStatusChecks, independent of job ordering.
// Contract: unit must NOT depend on static (keeps the parallel shape uniform).
if (Object.hasOwn(unitJob, "needs")) {
  fail(CI_WORKFLOW_PATH, `jobs.unit must run in parallel (no \`needs\`); got ${JSON.stringify(unitJob.needs)}`);
}
const unitSteps = Array.isArray(unitJob?.steps) ? unitJob.steps : [];
expectStep(CI_WORKFLOW_PATH, unitSteps, "Install dependencies");
expectStep(CI_WORKFLOW_PATH, unitSteps, "Build workspace packages");
const unitTestStep = expectStep(
  CI_WORKFLOW_PATH,
  unitSteps,
  "Unit + contract coverage tests"
);
expectEqual(
  CI_WORKFLOW_PATH,
  unitTestStep?.run,
  "pnpm test:ci",
  "unit test command"
);

expectEqual(PR_BUILD_WORKFLOW_PATH, prBuildWorkflow?.name, "PR Build", "workflow name");
expectTrigger(PR_BUILD_WORKFLOW_PATH, prBuildWorkflow, "pull_request");
expectTrigger(PR_BUILD_WORKFLOW_PATH, prBuildWorkflow, "merge_group");
expectMainPush(PR_BUILD_WORKFLOW_PATH, prBuildWorkflow);
// MONOREPO PARITY (bug.5057): pr-build MUST support the operator's RBAC-gated
// trusted-build `workflow_dispatch` (build an approved fork PR head → flightable
// image). This is the operator dispatch path, NOT a fork self-pushing — the
// `should_push=false` fork guard below still holds. The old `expectNoWorkflowDispatch`
// here was split-brain vs the monorepo and is removed; require the trusted-build
// inputs instead so the dispatch contract can't silently drift.
expectTrigger(PR_BUILD_WORKFLOW_PATH, prBuildWorkflow, "workflow_dispatch");
{
  const dispatchInputs =
    prBuildWorkflow?.on?.workflow_dispatch?.inputs ?? {};
  for (const required of ["head_repo", "head_sha"]) {
    if (!Object.hasOwn(dispatchInputs, required)) {
      fail(
        PR_BUILD_WORKFLOW_PATH,
        `workflow_dispatch must declare the trusted-build input "${required}"`
      );
    }
  }
}
expectEqual(PR_BUILD_WORKFLOW_PATH, prBuildWorkflow?.permissions?.contents, "read", "permissions.contents");
expectEqual(PR_BUILD_WORKFLOW_PATH, prBuildWorkflow?.permissions?.packages, "write", "permissions.packages");
// cancel-in-progress must NOT cancel a push:main (publishes the deployable) or a
// trusted dispatch (each fork build keyed by its own head_sha) — same as the monorepo.
// So it is an expression, not a literal `true`; assert it is present.
if (prBuildWorkflow?.concurrency?.["cancel-in-progress"] === undefined) {
  fail(PR_BUILD_WORKFLOW_PATH, "concurrency.cancel-in-progress must be set");
}

const resolveJob = prBuildWorkflow?.jobs?.resolve;
if (!resolveJob) fail(PR_BUILD_WORKFLOW_PATH, "jobs must include resolve");
const resolveSteps = Array.isArray(resolveJob?.steps) ? resolveJob.steps : [];
const sourceStep = expectStep(PR_BUILD_WORKFLOW_PATH, resolveSteps, "Resolve source metadata");
const sourceRun = String(sourceStep?.run ?? "");
expectIncludes(PR_BUILD_WORKFLOW_PATH, sourceRun, 'source_sha="$PR_HEAD_SHA"', "pull_request source SHA");
expectIncludes(PR_BUILD_WORKFLOW_PATH, sourceRun, 'source_sha="$PUSH_SHA"', "push source SHA");
expectIncludes(PR_BUILD_WORKFLOW_PATH, sourceRun, "image_name=ghcr.io/${owner_lc}/${repo_lc}", "repo-owned image name");
expectIncludes(PR_BUILD_WORKFLOW_PATH, sourceRun, "image_tag=sha-${source_sha}", "source SHA image tag");
expectIncludes(PR_BUILD_WORKFLOW_PATH, sourceRun, "should_push=false", "fork pull_request push guard");

const detectJob = prBuildWorkflow?.jobs?.detect;
if (!detectJob) fail(PR_BUILD_WORKFLOW_PATH, "jobs must include detect");
expectEqual(PR_BUILD_WORKFLOW_PATH, detectJob?.needs, "resolve", "jobs.detect.needs");
const detectSteps = Array.isArray(detectJob?.steps) ? detectJob.steps : [];
expectContractInstall(detectSteps, "detect");
const detectBuildStep = expectStep(
  PR_BUILD_WORKFLOW_PATH,
  detectSteps,
  "Build repo-spec contract"
);
expectEqual(
  PR_BUILD_WORKFLOW_PATH,
  detectBuildStep?.run,
  "pnpm --filter @cogni/repo-spec build",
  "detect dependency build"
);
// The image path consumes a build contract; ci.yaml owns verification. Catch
// reintroducing the duplicated full check/test gate under a different step name.
for (const step of detectSteps) {
  if (
    /\bpnpm\s+(?:run\s+)?(?:check(?::[\w:-]+)?|test(?::[\w:-]+)?|typecheck|db:check)(?=\s|$|[;&|])/.test(
      String(step?.run ?? "")
    )
  ) {
    fail(
      PR_BUILD_WORKFLOW_PATH,
      "jobs.detect must not duplicate CI checks or tests"
    );
  }
}
expectStep(PR_BUILD_WORKFLOW_PATH, detectSteps, "Detect node image targets");

const buildJob = prBuildWorkflow?.jobs?.build;
if (!buildJob) fail(PR_BUILD_WORKFLOW_PATH, "jobs must include build");
if (!Array.isArray(buildJob?.needs) || buildJob.needs.join(",") !== "resolve,detect") {
  fail(PR_BUILD_WORKFLOW_PATH, "jobs.build.needs must be [\"resolve\", \"detect\"]");
}
expectEqual(PR_BUILD_WORKFLOW_PATH, buildJob?.strategy?.["fail-fast"], false, "jobs.build.strategy.fail-fast");
const buildSteps = Array.isArray(buildJob?.steps) ? buildJob.steps : [];
// Omitting Buildx teardown is bounded to this disposable GitHub-hosted job.
expectEqual(PR_BUILD_WORKFLOW_PATH, buildJob?.["runs-on"], "ubuntu-latest", "ephemeral image runner");
const buildxStep = expectStep(PR_BUILD_WORKFLOW_PATH, buildSteps, "Set up Docker Buildx");
expectEqual(PR_BUILD_WORKFLOW_PATH, buildxStep?.with?.cleanup, false, "ephemeral Buildx cleanup");
expectStep(PR_BUILD_WORKFLOW_PATH, buildSteps, "Checkout");
expectStep(PR_BUILD_WORKFLOW_PATH, buildSteps, "Login to GHCR");
const imageBuildStep = expectStep(PR_BUILD_WORKFLOW_PATH, buildSteps, "Build app image");
expectEqual(
  PR_BUILD_WORKFLOW_PATH,
  imageBuildStep?.with?.["cache-to"],
  MAIN_CACHE_EXPORT,
  "trusted main cache export"
);
expectEqual(
  PR_BUILD_WORKFLOW_PATH,
  imageBuildStep?.with?.context,
  "${{ matrix.target.context }}",
  "declared artifact build context"
);
expectEqual(
  PR_BUILD_WORKFLOW_PATH,
  imageBuildStep?.with?.file,
  "${{ matrix.target.dockerfile }}",
  "declared artifact Dockerfile"
);
expectStep(PR_BUILD_WORKFLOW_PATH, buildSteps, "Write build fragment");
expectStep(PR_BUILD_WORKFLOW_PATH, buildSteps, "Upload build fragment");

const manifestJob = prBuildWorkflow?.jobs?.manifest;
if (!manifestJob) fail(PR_BUILD_WORKFLOW_PATH, "jobs must include manifest");
if (!Array.isArray(manifestJob?.needs) || manifestJob.needs.join(",") !== "resolve,detect,build") {
  fail(PR_BUILD_WORKFLOW_PATH, "jobs.manifest.needs must be [\"resolve\", \"detect\", \"build\"]");
}
const manifestSteps = Array.isArray(manifestJob?.steps) ? manifestJob.steps : [];
expectContractInstall(manifestSteps, "manifest");
expectStep(PR_BUILD_WORKFLOW_PATH, manifestSteps, "Download build fragments");
expectStep(PR_BUILD_WORKFLOW_PATH, manifestSteps, "Build repo-spec contract");
const setupOrasStep = expectStep(PR_BUILD_WORKFLOW_PATH, manifestSteps, "Set up ORAS");
expectEqual(
  PR_BUILD_WORKFLOW_PATH,
  setupOrasStep?.if,
  "needs.resolve.outputs.should_push == 'true'",
  "ORAS setup trust gate"
);
const writeManifestStep = expectStep(
  PR_BUILD_WORKFLOW_PATH,
  manifestSteps,
  "Write build manifest"
);
expectEqual(
  PR_BUILD_WORKFLOW_PATH,
  writeManifestStep?.env?.EMIT_BUNDLE,
  "${{ needs.resolve.outputs.should_push }}",
  "trusted bundle publication gate"
);
const publishBundleStep = expectStep(
  PR_BUILD_WORKFLOW_PATH,
  manifestSteps,
  "Publish immutable node artifact bundle"
);
expectEqual(
  PR_BUILD_WORKFLOW_PATH,
  publishBundleStep?.if,
  "needs.resolve.outputs.should_push == 'true'",
  "OCI bundle publication trust gate"
);
expectIncludes(
  PR_BUILD_WORKFLOW_PATH,
  publishBundleStep?.run,
  "oras push",
  "OCI bundle publisher"
);
expectIncludes(
  PR_BUILD_WORKFLOW_PATH,
  publishBundleStep?.run,
  ":bundle-sha-${SOURCE_SHA}",
  "deterministic source-SHA bundle tag"
);
expectIncludes(
  PR_BUILD_WORKFLOW_PATH,
  publishBundleStep?.run,
  "node-artifact-bundle.json:${PAYLOAD_MEDIA_TYPE}",
  "canonical OCI payload filename"
);
expectStep(PR_BUILD_WORKFLOW_PATH, manifestSteps, "Upload build manifest");
const uploadBundleStep = expectStep(
  PR_BUILD_WORKFLOW_PATH,
  manifestSteps,
  "Upload node artifact bundle"
);
expectEqual(
  PR_BUILD_WORKFLOW_PATH,
  uploadBundleStep?.if,
  "needs.resolve.outputs.should_push == 'true'",
  "immutable bundle upload trust gate"
);

expectEqual(PR_LINT_WORKFLOW_PATH, prLintWorkflow?.name, "Lint PR", "workflow name");
expectTrigger(PR_LINT_WORKFLOW_PATH, prLintWorkflow, "pull_request");
expectNoWorkflowDispatch(PR_LINT_WORKFLOW_PATH, prLintWorkflow);

// The publish lane distributes bytes that every node repo then pins. The checks
// below are the invariants that make a published version trustworthy; each one is
// here because its absence was a live defect in the first version of this
// workflow (story.5069), and each is cheap to re-break by hand.
expectEqual(PUBLISH_WORKFLOW_PATH, publishWorkflow?.name, "Publish Packages", "workflow name");
// THE PACKAGE REGISTRY IS THE CONTRACT. `env.PACKAGES` in the publish workflow is
// the single source of truth for which packages this repo distributes; `on.push.tags`
// is what makes each one reachable. Those two drifting apart is silent in both
// directions — an entry with no tag filter can never be published, and a tag filter
// with no entry starts a run whose `select` job fails after the tag is already pushed
// (and a pushed tag is not retractable in any consumer's eyes). Assert the bijection.
//
// The registry lives in the workflow YAML rather than being derived from
// `packages/*/package.json` on purpose: the self-test harness copies only the 5 files
// in its FILES list into a tmpdir, so a checker that read package manifests would be
// unrunnable there. Keeping it in `env.PACKAGES` satisfies that by construction.
const publishRegistry = (() => {
  const raw = publishWorkflow?.env?.PACKAGES;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    fail(PUBLISH_WORKFLOW_PATH, "env.PACKAGES must declare the publishable package registry");
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    fail(PUBLISH_WORKFLOW_PATH, `env.PACKAGES must be valid JSON; ${error.message}`);
    return [];
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    fail(PUBLISH_WORKFLOW_PATH, "env.PACKAGES must be a non-empty JSON array");
    return [];
  }
  const seen = new Set();
  for (const [index, entry] of parsed.entries()) {
    for (const field of ["name", "dir", "tagPrefix"]) {
      if (typeof entry?.[field] !== "string" || entry[field].length === 0) {
        fail(
          PUBLISH_WORKFLOW_PATH,
          `env.PACKAGES[${index}] must declare a non-empty string "${field}"`
        );
      }
    }
    // Two entries under one name would publish twice from one tag, or silently
    // shadow each other in the matrix.
    if (typeof entry?.name === "string") {
      if (seen.has(entry.name)) {
        fail(PUBLISH_WORKFLOW_PATH, `env.PACKAGES declares ${entry.name} more than once`);
      }
      seen.add(entry.name);
    }
  }
  return parsed;
})();

{
  const tags = publishWorkflow?.on?.push?.tags;
  if (!Array.isArray(tags) || tags.length === 0) {
    fail(PUBLISH_WORKFLOW_PATH, "push trigger must declare tag filters");
  } else {
    const tagSet = new Set(tags);
    // Every registered package must be taggable.
    for (const entry of publishRegistry) {
      if (typeof entry?.tagPrefix !== "string") continue;
      const filter = `${entry.tagPrefix}*`;
      if (!tagSet.has(filter)) {
        fail(
          PUBLISH_WORKFLOW_PATH,
          `push trigger must include the tag filter ${JSON.stringify(filter)} for ` +
            `${entry.name}; without it no tag can ever publish that package`
        );
      }
    }
    // ...and every tag filter must map back to a registered package, or pushing a
    // matching tag starts a run that `select` can only fail.
    const prefixes = publishRegistry
      .map((entry) => entry?.tagPrefix)
      .filter((prefix) => typeof prefix === "string");
    for (const filter of tags) {
      if (!prefixes.some((prefix) => filter === `${prefix}*`)) {
        fail(
          PUBLISH_WORKFLOW_PATH,
          `tag filter ${JSON.stringify(filter)} matches no env.PACKAGES entry; it would ` +
            "fire a publish run that selects nothing"
        );
      }
    }
  }
}

// The matrix must be DERIVED from `select`, never a static list. GitHub does not
// expose `matrix` in `jobs.<id>.if`, so a static matrix could only be narrowed to the
// pushed tag step-by-step — which forces every mutating step's `if` into a compound
// expression and breaks the `github.event_name == 'push'` exact-equality assertion
// below. Deriving it means every emitted leg is one that should run, and the gate
// stays a literal.
{
  const selectJob = publishWorkflow?.jobs?.select;
  if (!selectJob) {
    fail(PUBLISH_WORKFLOW_PATH, "jobs must include select (it resolves the publish matrix)");
  } else if (typeof selectJob?.outputs?.packages !== "string" || selectJob.outputs.packages.length === 0) {
    fail(PUBLISH_WORKFLOW_PATH, "jobs.select must expose a non-empty `packages` output");
  }

  const publishNeeds = publishWorkflow?.jobs?.publish?.needs;
  const needsList = Array.isArray(publishNeeds) ? publishNeeds : [publishNeeds];
  if (!needsList.includes("select")) {
    fail(
      PUBLISH_WORKFLOW_PATH,
      `jobs.publish.needs must include "select"; got ${JSON.stringify(publishNeeds)}`
    );
  }

  expectEqual(
    PUBLISH_WORKFLOW_PATH,
    publishWorkflow?.jobs?.publish?.strategy?.matrix?.pkg,
    "${{ fromJSON(needs.select.outputs.packages) }}",
    "jobs.publish.strategy.matrix.pkg must be derived from jobs.select"
  );
}
expectEqual(PUBLISH_WORKFLOW_PATH, publishWorkflow?.permissions?.contents, "write", "permissions.contents");
// Provenance is not optional: `npm publish --provenance` only works against
// registry.npmjs.org, so a Release asset's equivalent is an attestation over the
// exact tarball, and that needs Sigstore OIDC plus attestation storage.
expectEqual(PUBLISH_WORKFLOW_PATH, publishWorkflow?.permissions?.["id-token"], "write", "permissions.id-token");
expectEqual(PUBLISH_WORKFLOW_PATH, publishWorkflow?.permissions?.attestations, "write", "permissions.attestations");
// Least privilege, and an honesty check. A `packages: write` grant here means
// someone re-added a GitHub Packages publish — a registry that returns 401 even
// for a public package in a public repo, so it is unreachable for the forks this
// repo exists to serve. One distribution channel, or consumers cannot tell which
// bytes are canonical.
if (publishWorkflow?.permissions?.packages !== undefined) {
  fail(
    PUBLISH_WORKFLOW_PATH,
    "permissions.packages must not be granted: the Release asset is the only distribution channel"
  );
}
// A publish must never be cancelled mid-upload, or a Release exists with no asset.
expectEqual(
  PUBLISH_WORKFLOW_PATH,
  publishWorkflow?.concurrency?.["cancel-in-progress"],
  false,
  "concurrency.cancel-in-progress"
);
// Build the artifact on the toolchain that gates it and runs it. Skew here ships
// dist + .d.ts files off a Node major no consumer uses.
expectEqual(
  PUBLISH_WORKFLOW_PATH,
  publishWorkflow?.env?.NODE_VERSION,
  ciWorkflow?.env?.NODE_VERSION,
  `env.NODE_VERSION must match ${CI_WORKFLOW_PATH}`
);
{
  const publishJob = publishWorkflow?.jobs?.publish;
  if (!publishJob) fail(PUBLISH_WORKFLOW_PATH, "jobs must include publish");
  const publishSteps = Array.isArray(publishJob?.steps) ? publishJob.steps : [];

  // Each of these encodes one fail-closed assertion. Deleting a step is the
  // regression this guards, so require them by name.
  for (const name of [
    "Tagged commit must have passed every required check",
    "Tag must match the package version",
    "Release must not already exist",
    "Tarball must contain every declared entrypoint",
    "Tarball must carry its licence",
    "Attest the tarball",
    "Attach the tarball to a Release",
  ]) {
    expectStep(PUBLISH_WORKFLOW_PATH, publishSteps, name);
  }

  for (const step of publishSteps) {
    const label = JSON.stringify(step?.name ?? step?.uses ?? "<unnamed step>");

    // A version is immutable or it is not a version. `--clobber` replaces the
    // asset bytes at an already-published version, so every consumer pinning that
    // URL either breaks on an integrity mismatch or silently receives different
    // code under a version they already reviewed.
    if (String(step?.run ?? "").includes("--clobber")) {
      fail(
        PUBLISH_WORKFLOW_PATH,
        `step ${label} uses --clobber; a published version must never be overwritten. Bump the version instead.`
      );
    }

    // A step that cannot fail proves nothing, and reads as coverage it does not have.
    if (step?.["continue-on-error"] === true) {
      fail(
        PUBLISH_WORKFLOW_PATH,
        `step ${label} sets continue-on-error: true; a publish step that cannot fail proves nothing`
      );
    }

    // Anything that mutates the published world must be unreachable from
    // workflow_dispatch, which carries no tag and therefore skips the
    // tag/version correspondence proof.
    const mutatesPublishedState =
      /gh release (create|upload|edit|delete)/.test(String(step?.run ?? "")) ||
      /\b(npm|pnpm)\b[^\n]*\bpublish\b/.test(String(step?.run ?? "")) ||
      String(step?.uses ?? "").includes("attest-build-provenance");
    if (mutatesPublishedState && step?.if !== "github.event_name == 'push'") {
      fail(
        PUBLISH_WORKFLOW_PATH,
        `step ${label} publishes or attests but is not gated on \`if: github.event_name == 'push'\`; ` +
          "a workflow_dispatch carries no tag, so it cannot prove the version it would publish"
      );
    }
  }
}

const REQUIRED_CHECK_WORKFLOWS = [
  { path: CI_WORKFLOW_PATH, workflow: ciWorkflow },
  { path: PR_BUILD_WORKFLOW_PATH, workflow: prBuildWorkflow },
  { path: PR_LINT_WORKFLOW_PATH, workflow: prLintWorkflow },
];

assertRequiredChecksRunOnReviewEvents(repoPolicy, REQUIRED_CHECK_WORKFLOWS);
assertRequiredChecksFailClosed(repoPolicy, REQUIRED_CHECK_WORKFLOWS);
