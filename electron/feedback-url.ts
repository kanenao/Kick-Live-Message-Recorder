/** A report is a draft only. The user reviews and submits it on GitHub. */
export function buildFeedbackIssueUrl(kind:unknown,details:unknown,version:string):string{
 if(kind!=="bug"&&kind!=="feature")throw new Error("報告の種類が不正です。");
 if(typeof details!=="string"||!details.trim()||details.trim().length>500)throw new Error("報告内容を1〜500文字で入力してください。");
 if(!/^\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(version))throw new Error("バージョン情報が不正です。");
 const body=details.trim();
 if(/(?:user_session|cookie|authorization|password|パスワード|api[_ -]?key|client[_ -]?secret|access[_ -]?token|refresh[_ -]?token)\s*["']?\s*[:=]\s*\S/i.test(body)||/\bBearer\s+[A-Za-z0-9._~+/-]{8,}/i.test(body))throw new Error("認証情報が含まれる可能性があります。伏せ字にしてください。");
 const beta=version.includes("-beta.");
 const form=beta?(kind==="bug"?"01-beta-bug.yml":"03-beta-feature.yml"):(kind==="bug"?"02-stable-bug.yml":"04-stable-feature.yml");
 const url=new URL("https://github.com/kanenao/Kick-Live-Message-Recorder/issues/new");
 url.searchParams.set("template",form);
 url.searchParams.set("app_version",version);
 url.searchParams.set(kind==="bug"?"problem":"request",body);
 url.searchParams.set("title","["+(beta?"β版":"製品版")+"]["+(kind==="bug"?"不具合情報":"機能要望")+"] "+Array.from(body.replace(/\s+/g," ")).slice(0,55).join(""));
 return url.toString();
}
