import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {buildFeedbackIssueUrl} from "../electron/feedback-url.ts";
for(const [version,edition] of [["1.1.4-beta.102","β版"],["1.0.1","製品版"]]){
 for(const kind of ["bug","feature"]){
  const message="録画停止 & 日本語\n詳細 #1";
  const url=new URL(buildFeedbackIssueUrl(kind,message,version));
  assert.equal(url.origin,"https://github.com");
  assert.equal(url.pathname,"/kanenao/Kick-Live-Message-Recorder/issues/new");
  assert.equal(url.searchParams.get("template"),edition==="β版"?(kind==="bug"?"01-beta-bug.yml":"03-beta-feature.yml"):(kind==="bug"?"02-stable-bug.yml":"04-stable-feature.yml"));
  assert.equal(url.searchParams.get("app_version"),version);
  assert.equal(url.searchParams.get(kind==="bug"?"problem":"request"),message);
  assert.ok(url.searchParams.get("title").startsWith("["+edition+"]["+(kind==="bug"?"不具合情報":"機能要望")+"]"));
 }
}
for(const value of [""," ","a".repeat(501),"user_session=abcdef","Cookie: secret","API_KEY=abcd","Authorization: Bearer secret","client_secret=secret"]){
 assert.throws(()=>buildFeedbackIssueUrl("bug",value,"1.0.1"));
}
assert.throws(()=>buildFeedbackIssueUrl("other","test","1.0.1"));
assert.throws(()=>buildFeedbackIssueUrl("bug","test","invalid"));
assert.equal(new URL(buildFeedbackIssueUrl("bug","a".repeat(500),"1.0.1")).searchParams.get("problem").length,500);
const source=p=>readFileSync(new URL("../"+p,import.meta.url),"utf8");
assert.match(source("electron/main.ts"),/assertTrustedSender\(event\);\s*const link = buildFeedbackIssueUrl\(kind, details, app\.getVersion\(\)\)/);
assert.match(source("electron/main.ts"),/shell\.openExternal\(link\)/);
assert.match(source("electron/preload.ts"),/ipcRenderer\.invoke\("feedback:open", kind, details\)/);
assert.match(source("src/types/electron.d.ts"),/openFeedbackForm: \(kind: "bug" \| "feature", details: string\)/);
assert.match(source("src/ui/App.tsx"),/maxLength=\{500\}/);
assert.match(source("src/ui/App.tsx"),/openFeedbackForm\(kind, details\)/);
assert.ok(!source("electron/main.ts").includes("issues:create"));
console.log("報告フォーム：版別4経路、入力制限、秘密情報保護、本人送信の回帰テスト成功");
