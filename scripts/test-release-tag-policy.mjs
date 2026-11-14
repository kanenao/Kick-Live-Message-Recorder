import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const workflowText = readFileSync(new URL("../.github/workflows/build.yml", import.meta.url), "utf8");
const betaVersionPattern = /^\d+\.\d+\.\d+-beta\.\d+$/;
const betaTagPattern = /^v.*-beta.*$/;
const betaReleaseBranchPattern = /^release\/.*-beta.*$/;

assert.match(packageJson.version, betaVersionPattern, "package.json must use a beta version while beta-only distribution is active");
assert.ok(workflowText.includes('tags: ["v*-beta*"]'), "GitHub Actions must listen to beta-only tags");
assert.ok(!workflowText.includes('tags: ["v*"]'), "Broad version tag triggers must not be present");
assert.ok(workflowText.includes("name: β版専用タグの振り分けテスト"), "The beta tag policy test must run in CI");
const publishConditionLines = workflowText.split(String.fromCharCode(10)).filter(line =>
  line.trim().startsWith("if:") &&
  (line.includes("contains(github.ref, '-beta')") || line.includes("steps.release_tag"))
);
assert.equal(publishConditionLines.length, 3, "Expected job, duplicate-cleanup and publish guards");
for (const condition of publishConditionLines) {
  assert.ok(condition.includes("contains(github.ref, '-beta')"), "Every release-related condition must require -beta");
  assert.ok(!condition.includes("refs/heads/release/"), "A branch push must not publish a Release");
}
assert.equal((workflowText.match(/β版インストーラーと更新情報をGitHub Releasesへ公開/g) ?? []).length, 1, "Only one publish step must exist");

const tagCases = [
  ["v0.1.0-beta.51", true],
  ["v0.1.0-beta.52", true],
  ["v1.0.0-beta.1", true],
  ["v1.0.0", false],
  ["v1.0.0-rc.1", false],
  ["v1.0.0-alpha.1", false],
  ["0.1.0-beta.51", false]
];
for (const [tag, expected] of tagCases) {
  assert.equal(betaTagPattern.test(tag), expected, "Unexpected beta tag classification: " + tag);
}

const branchCases = [
  ["release/v0.1.0-beta.51", true],
  ["release/v0.1.0-beta.52", true],
  ["release/v1.0.0", false],
  ["release/v1.0.0-rc.1", false],
  ["feature/beta51-ai-article-live", false]
];
for (const [branch, expected] of branchCases) {
  assert.equal(betaReleaseBranchPattern.test(branch), expected, "Unexpected release branch classification: " + branch);
}

const shouldPublishRef = ref =>
  ref.startsWith("refs/tags/v") && ref.includes("-beta");

const refCases = [
  ["refs/tags/v0.1.0-beta.51", true],
  ["refs/tags/v1.0.0", false],
  ["refs/tags/v1.0.0-rc.1", false],
  ["refs/heads/release/v0.1.0-beta.51", false],
  ["refs/heads/release/v1.0.0", false],
  ["refs/heads/feature/beta51-ai-article-live", false]
];
for (const [ref, expected] of refCases) {
  assert.equal(shouldPublishRef(ref), expected, "Unexpected publish condition: " + ref);
}

console.log("β版タグ振り分けテスト成功（package.json: " + packageJson.version + "）");
