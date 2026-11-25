import {existsSync,mkdirSync,readFileSync,renameSync,statSync,unlinkSync,writeFileSync} from "node:fs";
import {dirname,isAbsolute} from "node:path";
import type {PendingChaseRecovery} from "./chase-vod-recovery";
export function validatePending(value:unknown,now=Date.now()):PendingChaseRecovery[]{
  if(!Array.isArray(value))return [];
  const seen=new Set<string>(),entries:PendingChaseRecovery[]=[];
  for(const raw of value.slice(0,50)){
    if(!raw||typeof raw!=="object"||!raw.request||typeof raw.request!=="object")continue;
    const {request,attempt,createdAt}=raw;
    if(typeof request.slug!=="string"||!/^[a-z0-9_-]{1,40}$/.test(request.slug)||typeof request.startedAt!=="string"||!Number.isFinite(Date.parse(request.startedAt))||typeof request.outputDirectory!=="string"||request.outputDirectory.length>4096||!isAbsolute(request.outputDirectory)||request.outputDirectory.includes("\0")||!Number.isSafeInteger(attempt)||attempt<0||attempt>=6||!Number.isSafeInteger(createdAt)||createdAt>now||now-createdAt>86400000)continue;
    const id=request.slug+"|"+Date.parse(request.startedAt);if(seen.has(id))continue;seen.add(id);
    entries.push({request:{slug:request.slug,startedAt:request.startedAt,outputDirectory:request.outputDirectory,recoverVodChat:request.recoverVodChat===true},attempt,createdAt});
    if(entries.length>=5)break;
  }return entries;
}
export function readChaseJournal(path:string):PendingChaseRecovery[]{
  if(!existsSync(path))return [];
  if(statSync(path).size>65536)throw Error("補完待ち履歴が上限を超えています。");
  return validatePending(JSON.parse(readFileSync(path,"utf8")));
}
export function writeChaseJournal(path:string,pending:PendingChaseRecovery[]):void{
  mkdirSync(dirname(path),{recursive:true});
  const temp=path+".tmp";
  try{writeFileSync(temp,JSON.stringify(pending),{encoding:"utf8",mode:0o600});renameSync(temp,path);}
  finally{if(existsSync(temp))unlinkSync(temp);}
}
