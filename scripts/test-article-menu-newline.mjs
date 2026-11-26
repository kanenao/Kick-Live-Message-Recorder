import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const read=p=>readFileSync(new URL("../"+p,import.meta.url),"utf8");
const ui=read("src/ui/App.tsx"),main=read("electron/main.ts"),preload=read("electron/preload.ts"),library=read("electron/library-sessions.ts");
assert.ok(!ui.includes('tab === "articles"'));assert.ok(!ui.includes('setTab("articles")'));assert.ok(!ui.includes('getAiArticleStatus()'));assert.ok(!main.includes('ipcMain.handle("articles:'));assert.ok(!main.includes('ipcMain.handle("ai-article:'));assert.ok(!main.includes('new LiveStreamArticleManager'));assert.ok(!preload.includes('ipcRenderer.invoke("articles:'));assert.ok(!library.includes('listStreamArticles'));assert.ok(main.includes('settings.rankingAiModel'));assert.ok(ui.includes('コメント付き動画'));
console.log("記事機能の廃止、録画とランキングAIの維持");
