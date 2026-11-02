import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";

const readWorkflow = (name) => parse(readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), "utf8"));

test("memory candidate push produces artifacts without signing or publishing a Release", () => {
  const workflow = readWorkflow("release");
  assert.deepEqual(workflow.on.push.branches, ["feat/memory-http-config"]);
  assert.deepEqual(workflow.on.push.tags, ["v*.*.*"]);
  assert.equal(workflow.permissions.contents, "read");
  assert.equal(workflow.jobs.publish.if, "startsWith(github.ref, 'refs/tags/v')");
  assert.equal(workflow.jobs.build.env.MACOS_SIGN_RELEASE, "${{ startsWith(github.ref, 'refs/tags/v') || (github.event_name == 'workflow_dispatch' && inputs.sign_macos == true) }}");
  assert.match(workflow.jobs.build.env.MACOS_LANE_ENABLED, /github\.ref == 'refs\/heads\/feat\/memory-http-config'/);
  assert.ok(workflow.jobs.build.steps.some((step) => step.uses?.startsWith("actions/upload-artifact@")));
  assert.ok(workflow.jobs['pi-host-bundle'].steps.some((step) => step.uses?.startsWith("actions/upload-artifact@")));
});

test("clean CI and package verification build a real native Host before Desktop tests", () => {
  for (const [workflowName, jobName] of [["ci", "js"], ["release", "verify"]]) {
    const job = readWorkflow(workflowName).jobs[jobName];
    const hostBuild = job.steps.findIndex((step) => step.run === "cargo build -p host-core --locked");
    const tests = job.steps.findIndex((step) => step.run === "pnpm -r --if-present test");
    assert.ok(hostBuild >= 0 && hostBuild < tests, `${workflowName} must provide a candidate native binary before unit/integration tests`);
    assert.ok(job.steps.some((step) => step.uses === "dtolnay/rust-toolchain@stable"));
    assert.ok(job.steps.some((step) => step.run === "pnpm install --frozen-lockfile"));
  }
});
