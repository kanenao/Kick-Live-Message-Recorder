import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {validatePending,readChaseJournal,writeChaseJournal} from "../electron/chase-recovery-journal.ts";
const root=mkdtempSync(join(tmpdir(),"chase-journal-"));
try{
 const now=Date.now(), request={slug:"sample",startedAt:new Date(now-600000).toISOString(),outputDirectory:root,recoverVodChat:true};
 const row={request,attempt:2,createdAt:now};
 assert.equal(validatePending([row,row],now).length,1);
 assert.equal(validatePending([{...row,attempt:6},{...row,createdAt:now-86400001},{...row,request:{...request,outputDirectory:"relative"}}],now).length,0);
 const path=join(root,"pending.json");
 writeChaseJournal(path,[row]);assert.deepEqual(readChaseJournal(path),[row]);
 writeChaseJournal(path,[]);assert.deepEqual(readChaseJournal(path),[]);
}finally{rmSync(root,{recursive:true,force:true});}
console.log("追っかけ補完待ち：保存・復元・期限・重複・相対パス拒否");
