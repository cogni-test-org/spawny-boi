// Self-tests for check-node-ci-workflow.mjs.
//
// WHY THIS FILE EXISTS: the checker's whole purpose is to prove that every context
// named in .cogni/repo-policy.json is actually emitted, on review events, by exactly
// one job that cannot skip. A checker that silently stops catching drift is worse than
// no checker — it reports "protected" while a spawned node's required check never
// reports and its default branch deadlocks. A green run against the current tree
// proves nothing about that; only a mutation that MUST fail does.
//
// Each case mutates a throwaway copy of the real workflow/policy files and asserts the
// checker exits non-zero with a recognisable message.
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CHECKER = join(REPO_ROOT, "scripts", "check-node-ci-workflow.mjs");
const FILES = [
  ".github/workflows/ci.yaml",
  ".github/workflows/pr-build.yml",
  ".github/workflows/pr-lint.yaml",
  ".github/workflows/publish-packages.yml",
  ".cogni/repo-policy.json",
];

function runCheckerOn(mutate) {
  const dir = mkdtempSync(join(tmpdir(), "node-ci-policy-"));
  for (const file of FILES) {
    cpSync(join(REPO_ROOT, file), join(dir, file), { recursive: true });
  }
  mutate({
    read: (file) => readFileSync(join(dir, file), "utf8"),
    write: (file, text) => writeFileSync(join(dir, file), text),
  });
  // The checker resolves its inputs relative to CWD, so running it from the fixture
  // dir points it at the mutated copies while `yaml` still resolves from the repo.
  const result = spawnSync(process.execPath, [CHECKER], { cwd: dir, encoding: "utf8" });
  return { code: result.status, output: `${result.stdout}${result.stderr}` };
}

const edit = (file, from, to) => ({ read, write }) => {
  const before = read(file);
  if (!before.includes(from)) throw new Error(`fixture anchor missing in ${file}: ${from}`);
  write(file, before.replace(from, to));
};

const contractInstall =
  "pnpm --filter @cogni/repo-spec... install --frozen-lockfile --ignore-scripts --config.dedupe-peer-dependents=false";
const mainCacheExport =
  "${{ github.event_name == 'push' && github.ref == 'refs/heads/main' && format('type=gha,mode=max,scope=node-template-{0}', matrix.target.artifact) || '' }}";
const editPrBuildJob = (job, from, to) => ({ read, write }) => {
  const path = ".github/workflows/pr-build.yml";
  const before = read(path);
  const marker = `\n  ${job}:\n`;
  const index = before.indexOf(marker);
  if (index < 0 || !before.slice(index).includes(from)) throw new Error(`missing ${job} fixture`);
  write(path, before.slice(0, index) + before.slice(index).replace(from, to));
};

const CASES = [
  {
    name: "baseline tree passes",
    mutate: () => {},
    expectExit: 0,
  },
  ...["detect", "manifest"].map((job) => ({
    name: `${job} must not restore the full workspace install`,
    mutate: editPrBuildJob(job, contractInstall, "pnpm install --frozen-lockfile"),
    expectExit: 1,
    expectMatch: /frozen contract install/,
  })),
  {
    name: "contract installs must retain frozen lock enforcement",
    mutate: editPrBuildJob("detect", contractInstall, contractInstall.replace(" --frozen-lockfile", "")),
    expectExit: 1,
    expectMatch: /frozen contract install/,
  },
  {
    name: "contract jobs must not hydrate the broad workspace cache",
    mutate: editPrBuildJob("manifest", "          node-version: 22", "          node-version: 22\n          cache: pnpm"),
    expectExit: 1,
    expectMatch: /must not hydrate a broad Node cache/,
  },
  {
    name: "PRs must not export the trusted main image cache",
    mutate: edit(".github/workflows/pr-build.yml", mainCacheExport, "type=gha,mode=max,scope=node-template-${{ matrix.target.artifact }}"),
    expectExit: 1,
    expectMatch: /trusted main cache export/,
  },
  {
    name: "workflow dispatch must not become a main cache writer",
    mutate: edit(".github/workflows/pr-build.yml", mainCacheExport, mainCacheExport.replace("github.event_name == 'push' && ", "")),
    expectExit: 1,
    expectMatch: /trusted main cache export/,
  },
  {
    name: "the disposable image job must not restore slow Buildx teardown",
    mutate: edit(".github/workflows/pr-build.yml", "          cleanup: false", "          cleanup: true"),
    expectExit: 1,
    expectMatch: /ephemeral Buildx cleanup/,
  },
  {
    name: "omitting teardown must not silently move to a persistent runner",
    mutate: editPrBuildJob("build", "    runs-on: ubuntu-latest", "    runs-on: self-hosted"),
    expectExit: 1,
    expectMatch: /ephemeral image runner/,
  },
  {
    name: "detection must build the contract its target reader imports",
    mutate: edit(
      ".github/workflows/pr-build.yml",
      "      - name: Build repo-spec contract\n        run: pnpm --filter @cogni/repo-spec build",
      "      - name: Build repo-spec contract\n        run: pnpm check"
    ),
    expectExit: 1,
    expectMatch: /detect dependency build/,
  },
  {
    name: "a second detection step must not rerun the suite under another name",
    mutate: edit(
      ".github/workflows/pr-build.yml",
      "      - name: Detect node image targets",
      "      - name: Redundant verification\n        run: pnpm test:ci\n\n      - name: Detect node image targets"
    ),
    expectExit: 1,
    expectMatch: /jobs.detect must not duplicate CI checks or tests/,
  },
  {
    name: "removing detection checks must not remove the required unit suite",
    mutate: edit(
      ".github/workflows/ci.yaml",
      "run: pnpm test:ci",
      "run: echo tests skipped"
    ),
    expectExit: 1,
    expectMatch: /unit test command/,
  },
  {
    name: "schema verification remains owned by required static CI",
    mutate: edit(
      ".github/workflows/ci.yaml",
      "run: pnpm db:check",
      "run: echo schema checks skipped"
    ),
    expectExit: 1,
    expectMatch: /static Database schema checks command/,
  },
  {
    name: "renaming a required job breaks the emitted context (the deadlock case)",
    mutate: edit(".github/workflows/ci.yaml", "\n  unit:\n", "\n  unit:\n    name: Unit Tests\n"),
    expectExit: 1,
    expectMatch: /required check "unit" must be emitted by exactly one job/,
  },
  {
    name: "a templated job name cannot be statically resolved",
    mutate: edit(".github/workflows/ci.yaml", "\n  static:\n", "\n  static:\n    name: static-${{ github.event_name }}\n"),
    expectExit: 1,
    expectMatch: /required check "static"/,
  },
  {
    name: "a matrix on a required job fans the context out per leg",
    mutate: edit(".github/workflows/ci.yaml", "\n  component:\n", "\n  component:\n    strategy:\n      matrix:\n        shard: [1, 2]\n"),
    expectExit: 1,
    expectMatch: /strategy\.matrix/,
  },
  {
    name: "a required check gated on upstream results can skip, and skip scores as success",
    mutate: edit(
      ".github/workflows/pr-build.yml",
      "  manifest:\n    needs: [resolve, detect, build]\n    if: always()",
      "  manifest:\n    needs: [resolve, detect, build]\n    if: |\n      always() &&\n      needs.detect.result == 'success'"
    ),
    expectExit: 1,
    expectMatch: /scores a skipped required check as SUCCESS/,
  },
  {
    name: "a policy context with no emitting job at all is rejected",
    mutate: edit(".cogni/repo-policy.json", '"manifest"]', '"manifest", "nonexistent-check"]'),
    expectExit: 1,
    expectMatch: /required check "nonexistent-check"/,
  },
  {
    name: "a --clobber in the publish lane makes a published version mutable",
    mutate: edit(
      ".github/workflows/publish-packages.yml",
      'gh release create "$GITHUB_REF_NAME" "${{ steps.pack.outputs.tgz }}" \\',
      'gh release upload "$GITHUB_REF_NAME" "${{ steps.pack.outputs.tgz }}" --clobber \\'
    ),
    expectExit: 1,
    expectMatch: /uses --clobber/,
  },
  {
    name: "a continue-on-error publish step cannot fail, so it proves nothing",
    mutate: edit(
      ".github/workflows/publish-packages.yml",
      "      - name: Attach the tarball to a Release\n        if: github.event_name == 'push'",
      "      - name: Attach the tarball to a Release\n        continue-on-error: true\n        if: github.event_name == 'push'"
    ),
    expectExit: 1,
    expectMatch: /continue-on-error/,
  },
  {
    name: "an ungated release step lets workflow_dispatch publish without a tag",
    mutate: edit(
      ".github/workflows/publish-packages.yml",
      "      - name: Attach the tarball to a Release\n        if: github.event_name == 'push'\n",
      "      - name: Attach the tarball to a Release\n"
    ),
    expectExit: 1,
    expectMatch: /publishes or attests but is not gated/,
  },
  {
    name: "deleting the required-checks gate lets an ungated commit be published",
    mutate: edit(
      ".github/workflows/publish-packages.yml",
      "      - name: Tagged commit must have passed every required check",
      "      - name: Tagged commit checks are assumed green"
    ),
    expectExit: 1,
    expectMatch: /Tagged commit must have passed every required check/,
  },
  {
    name: "re-adding packages: write signals a second, unreachable distribution channel",
    mutate: edit(
      ".github/workflows/publish-packages.yml",
      "  id-token: write\n  attestations: write",
      "  id-token: write\n  attestations: write\n  packages: write"
    ),
    expectExit: 1,
    expectMatch: /permissions\.packages must not be granted/,
  },
  {
    name: "building the artifact on a different Node major than CI gates it",
    mutate: edit(".github/workflows/publish-packages.yml", 'NODE_VERSION: "22"', 'NODE_VERSION: "24"'),
    expectExit: 1,
    expectMatch: /env\.NODE_VERSION must match/,
  },
  // The registry <-> tag-filter bijection. Drift in EITHER direction is silent at
  // author time and only surfaces once a tag has been pushed, which is too late.
  {
    name: "a registered package with no tag filter can never be published",
    mutate: edit(
      ".github/workflows/publish-packages.yml",
      '      - "knowledge-store-v*"\n',
      ""
    ),
    expectExit: 1,
    expectMatch: /must include the tag filter "knowledge-store-v\*"/,
  },
  {
    name: "a tag filter with no registry entry fires a run that selects nothing",
    mutate: edit(
      ".github/workflows/publish-packages.yml",
      '      - "knowledge-base-v*"\n',
      '      - "knowledge-base-v*"\n      - "node-core-v*"\n'
    ),
    expectExit: 1,
    expectMatch: /tag filter "node-core-v\*" matches no env\.PACKAGES entry/,
  },
  {
    name: "deleting a registry entry while its tag filter remains is rejected",
    mutate: edit(
      ".github/workflows/publish-packages.yml",
      '     {"name":"@cogni-dao/knowledge-base","dir":"packages/knowledge-base","tagPrefix":"knowledge-base-v"},\n',
      ""
    ),
    expectExit: 1,
    expectMatch: /tag filter "knowledge-base-v\*" matches no env\.PACKAGES entry/,
  },
  {
    name: "an unparseable registry is rejected rather than silently skipped",
    mutate: edit(
      ".github/workflows/publish-packages.yml",
      '  PACKAGES: >-\n',
      '  PACKAGES: "not json"\n  PACKAGES_OLD: >-\n'
    ),
    expectExit: 1,
    expectMatch: /env\.PACKAGES must be valid JSON/,
  },
  {
    name: "a registry entry missing its dir cannot locate the package to pack",
    mutate: edit(
      ".github/workflows/publish-packages.yml",
      '{"name":"@cogni-dao/work-items","dir":"packages/work-items","tagPrefix":"work-items-v"}',
      '{"name":"@cogni-dao/work-items","tagPrefix":"work-items-v"}'
    ),
    expectExit: 1,
    expectMatch: /env\.PACKAGES\[0\] must declare a non-empty string "dir"/,
  },
  {
    name: "a static matrix replaces the derived one, and matrix is not available in jobs.<id>.if",
    mutate: edit(
      ".github/workflows/publish-packages.yml",
      "        pkg: ${{ fromJSON(needs.select.outputs.packages) }}",
      '        pkg:\n          - {"name":"@cogni-dao/work-items","dir":"packages/work-items","tagPrefix":"work-items-v"}'
    ),
    expectExit: 1,
    expectMatch: /matrix\.pkg must be derived from jobs\.select/,
  },
  {
    name: "dropping jobs.select removes the thing that narrows a tag to one package",
    mutate: edit(
      ".github/workflows/publish-packages.yml",
      "  select:\n    runs-on: ubuntu-latest\n    outputs:\n      packages: ${{ steps.select.outputs.packages }}\n",
      "  select:\n    runs-on: ubuntu-latest\n"
    ),
    expectExit: 1,
    expectMatch: /jobs\.select must expose a non-empty `packages` output/,
  },
  {
    name: "publish must not run without select, or the matrix resolves to nothing",
    mutate: edit(
      ".github/workflows/publish-packages.yml",
      "  publish:\n    needs: select\n",
      "  publish:\n"
    ),
    expectExit: 1,
    expectMatch: /jobs\.publish\.needs must include "select"/,
  },
];

let failed = 0;
for (const testCase of CASES) {
  const { code, output } = runCheckerOn(testCase.mutate);
  const exitOk = code === testCase.expectExit;
  const matchOk = !testCase.expectMatch || testCase.expectMatch.test(output);
  if (exitOk && matchOk) {
    console.log(`ok   ${testCase.name}`);
    continue;
  }
  failed += 1;
  console.error(`FAIL ${testCase.name}`);
  console.error(`     expected exit ${testCase.expectExit}, got ${code}`);
  if (!matchOk) console.error(`     expected output to match ${testCase.expectMatch}`);
  console.error(output.replace(/^/gm, "     | "));
}

if (failed > 0) {
  console.error(`\n${failed} of ${CASES.length} self-tests failed`);
  process.exit(1);
}
console.log(`\nall ${CASES.length} self-tests passed`);
