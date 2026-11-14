import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const workflowText = readFileSync(new URL("../.github/workflows/build.yml", import.meta.url), "utf8");
const alphaVersionPattern = /^\d+\.\d+\.\d+-alpha\.\d+$/;
const alphaTagPattern = /^v.*-alpha.*$/;
const alphaReleaseBranchPattern = /^release\/.*-alpha.*$/;

assert.match(packageJson.version, alphaVersionPattern, "package.json must use an alpha version while alpha development is active");
assert.ok(workflowText.includes('tags: ["v*-alpha*"]'), "GitHub Actions must listen to alpha-only tags");
assert.ok(!workflowText.includes('tags: ["v*-beta*"]'), "Old beta tags must not publish new releases");
assert.ok(!workflowText.includes('tags: ["v*"]'), "Broad version tag triggers must not be present");
assert.ok(workflowText.includes("name: α版専用タグの振り分けテスト"), "The alpha tag policy test must run in CI");
const publishConditionLines = workflowText.split(String.fromCharCode(10)).filter(line =>
  line.trim().startsWith("if:") &&
  (line.includes("contains(github.ref, '-alpha')") || line.includes("steps.release_tag"))
);
assert.equal(publishConditionLines.length, 3, "Expected job, duplicate-cleanup and publish guards");
for (const condition of publishConditionLines) {
  assert.ok(condition.includes("contains(github.ref, '-alpha')"), "Every release-related condition must require -alpha");
  assert.ok(!condition.includes("refs/heads/release/"), "A branch push must not publish a Release");
}
assert.equal((workflowText.match(/α版インストーラーと更新情報をGitHub Releasesへ公開/g) ?? []).length, 1, "Only one publish step must exist");

const tagCases = [
  ["v0.1.0-alpha.51", true],
  ["v0.1.0-alpha.52", true],
  ["v0.1.1-alpha.53", true],
  ["v0.1.2-alpha.54", true],
  ["v0.2.0-alpha.55", true],
  ["v0.2.1-alpha.56", true],
  ["v0.2.2-alpha.57", true],
  ["v1.0.0-alpha.55", true],
  ["v1.0.0-beta.50", false],
  ["v0.1.0-beta.51", false],
  ["v1.0.0", false],
  ["v1.0.0-rc.1", false],
  ["0.1.0-alpha.52", false]
];
for (const [tag, expected] of tagCases) {
  assert.equal(alphaTagPattern.test(tag), expected, "Unexpected alpha tag classification: " + tag);
}

const branchCases = [
  ["release/v0.1.0-alpha.51", true],
  ["release/v0.1.0-alpha.52", true],
  ["release/v1.0.0", false],
  ["release/v1.0.0-rc.1", false],
  ["release/v0.1.0-beta.50", false],
  ["feature/alpha52-broadcast-newspaper-layout", false]
];
for (const [branch, expected] of branchCases) {
  assert.equal(alphaReleaseBranchPattern.test(branch), expected, "Unexpected alpha release branch classification: " + branch);
}

const shouldPublishRef = ref =>
  ref.startsWith("refs/tags/v") && ref.includes("-alpha");

const refCases = [
  ["refs/tags/v0.1.0-alpha.52", true],
  ["refs/tags/v0.1.1-alpha.53", true],
  ["refs/tags/v0.1.2-alpha.54", true],
  ["refs/tags/v0.2.0-alpha.55", true],
  ["refs/tags/v0.2.1-alpha.56", true],
  ["refs/tags/v0.2.2-alpha.57", true],
  ["refs/tags/v1.0.0-alpha.55", true],
  ["refs/tags/v0.1.0-beta.50", false],
  ["refs/tags/v1.0.0", false],
  ["refs/tags/v1.0.0-rc.1", false],
  ["refs/heads/release/v0.1.0-alpha.52", false],
  ["refs/heads/release/v1.0.0", false],
  ["refs/heads/feature/alpha52-broadcast-newspaper-layout", false]
];
for (const [ref, expected] of refCases) {
  assert.equal(shouldPublishRef(ref), expected, "Unexpected publish condition: " + ref);
}

console.log("α版タグ振り分けテスト成功（package.json: " + packageJson.version + "、β版タグは非公開対象）");
