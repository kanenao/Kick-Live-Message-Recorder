import assert from "node:assert/strict";
import feedbackRelay, { FeedbackReceipt } from "../feedback-relay/src/index.mjs";

const valid = {
  requestId: "11111111-1111-4111-8111-111111111111",
  kind: "bug",
  edition: "beta",
  version: "1.0.1-beta.96",
  title: "録画が開始されない",
  description: "録画ボタンを押しても開始できません",
  steps: "1. 録画専用を開く\n2. 録画を押す"
};
let githubCalls = [];
const initialFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  githubCalls.push({ url, options });
  return Response.json({ number: 314 });
};
const objects = new Map();
const env = () => {
  const e = {GITHUB_TOKEN:"test-only-secret",FEEDBACK_RATE_LIMITER:{limit:async()=>({success:true})}};
  e.FEEDBACK_RECEIPTS = {
    idFromName:id=>id,
    get(id) {
      if (!objects.has(id)) {
        const records = new Map();
        let chain = Promise.resolve();
        const storage = {
          get:async key=>records.get(key),
          put:async (key,value)=>{records.set(key,value);},
          transaction(fn) { const next=chain.then(()=>fn(storage)); chain=next.catch(()=>{}); return next; }
        };
        objects.set(id,new FeedbackReceipt({storage},e));
      }
      return {fetch:(url,init)=>objects.get(id).fetch(new Request(url,init))};
    }
  };
  return e;
};
const request = (body, headers = {}) => new Request("https://example.workers.dev/api/feedback", {
  method: "POST",
  headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.20", ...headers },
  body: typeof body === "string" ? body : JSON.stringify(body)
});
const send = (body, override = env()) => feedbackRelay.fetch(request(body), override);

try {
  let response = await send(valid);
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { issueNumber: 314 });
  assert.equal(githubCalls.length, 1);
  const posted = JSON.parse(githubCalls[0].options.body);
  response = await send(valid);
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{issueNumber:314});
  assert.equal(githubCalls.length,1,"retry must not create a second Issue");
  response = await send({...valid,title:"別の内容"});
  assert.equal(response.status,409);
  assert.equal(githubCalls.length,1);
  assert.ok(posted.title.includes("[不具合情報][β版]"));
  assert.deepEqual(posted.labels, ["不具合情報", "β版", "AI判定待ち"]);
  assert.ok(posted.body.includes("1. 録画専用を開く"));
  assert.ok(!githubCalls[0].options.body.includes("test-only-secret"));

  response = await send({ ...valid, description: "" });
  assert.equal(response.status, 400);
  response = await send({ ...valid, edition: "stable" });
  assert.equal(response.status, 400);
  response = await send({ ...valid, description: "Cookie: secret" });
  assert.equal(response.status, 400);
  response = await send({ ...valid, title: "x".repeat(121) });
  assert.equal(response.status, 400);
  response = await send({ ...valid, description: "x".repeat(33000) });
  assert.equal(response.status, 413);
  assert.equal(githubCalls.length, 1);

  response = await send(valid, { GITHUB_TOKEN: "", FEEDBACK_RATE_LIMITER: { limit: async () => ({ success: true }) } });
  assert.equal(response.status, 503);
  response = await send(valid, { ...env(), FEEDBACK_RATE_LIMITER: { limit: async () => ({ success: false }) } });
  assert.equal(response.status, 429);
  response = await feedbackRelay.fetch(new Request("https://example.workers.dev/api/feedback", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(valid)
  }), env());
  assert.equal(response.status, 403);
  response = await feedbackRelay.fetch(new Request("https://example.workers.dev/api/feedback", {
    method: "GET", headers: { "CF-Connecting-IP": "203.0.113.20" }
  }), env());
  assert.equal(response.status, 405);
  response = await feedbackRelay.fetch(new Request("https://example.workers.dev/health"), env());
  assert.equal(response.status, 200);

  let attempts=0;
  globalThis.fetch = async () => { attempts++; return new Response("error",{status:502}); };
  const uncertain={...valid,requestId:"22222222-2222-4222-8222-222222222222"};
  response = await send(uncertain);
  assert.equal(response.status,502);
  response = await send(uncertain);
  assert.equal(response.status,409);
  assert.equal(attempts,1,"ambiguous GitHub result must not be posted again");
  let concurrent=0;
  globalThis.fetch=async()=>{concurrent++;await new Promise(resolve=>setTimeout(resolve,10));return Response.json({number:315});};
  const same={...valid,requestId:"33333333-3333-4333-8333-333333333333"};
  const results=await Promise.all([send(same),send(same)]);
  assert.equal(concurrent,1,"simultaneous retries must reserve only once");
  assert.ok(results.some(x=>x.status===201));
  assert.ok(results.every(x=>[200,201,409].includes(x.status)));
  assert.equal((await (await send(same)).json()).issueNumber,315);
  console.log("受付サーバーの送信・タグ付け・入力制限・機密情報拒否・レート制限・障害処理テスト成功");
} finally {
  globalThis.fetch = initialFetch;
}
