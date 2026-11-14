import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");

const match = packageJson.version.match(/^(\d+\.\d+\.\d+)-beta\.(\d+)$/);
assert.ok(match, "package.json must use the beta version format while beta-only development is active");
const currentVersion = packageJson.version;
// β51は開発ブランチのみで公開していないため、公開版番号は開発番号と独立して管理する。
// 新しいβ版をGitHub Releasesへ実際に公開したときだけ、この値を更新する。
const latestPublicVersion = "0.1.0-beta.50";

assert.ok(readme.includes("開発中：" + currentVersion), "README must show the current development version");
assert.ok(readme.includes("最新公開版：" + latestPublicVersion), "README must show the previous public beta version");
assert.ok(readme.includes("CHANGELOG.md"), "README must link to the version history");
assert.ok(!readme.includes("0.1.0-beta.15"), "README must not retain the obsolete beta15 version");
assert.ok(changelog.includes("## " + currentVersion), "CHANGELOG must include the current development version");
assert.ok(changelog.includes("## " + latestPublicVersion), "CHANGELOG must include the latest public version");

console.log("README／更新履歴のバージョン整合性テスト成功（開発中: " + currentVersion + "、公開版: " + latestPublicVersion + "）");
