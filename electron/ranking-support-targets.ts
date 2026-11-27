import {SUPPORT_GROUP_COUNT,SUPPORT_GROUP_SIZE} from "./ranking-support-policy";
/** Keep established assignments while replacing only departed targets. */
export function stableTargetGroups(top:readonly string[],previous:readonly (readonly string[])[],count:number,size:number):string[][]{
 const wanted=[...new Set(top.filter(s=>/^[a-z0-9_]{1,25}$/.test(s)))].slice(0,count*size);
 const remaining=new Set(wanted);
 const groups=Array.from({length:count},(_,i)=>{
  const group:string[]=[];
  for(const s of previous[i]??[]){if(group.length<size&&remaining.delete(s))group.push(s);}
  return group;
 });
 for(const s of wanted){if(!remaining.has(s))continue;const group=groups.find(g=>g.length<size);if(group){group.push(s);remaining.delete(s);}}
 return groups.map(g=>g.sort());
}
export function supportTargetGroups(top:readonly string[],previous:readonly (readonly string[])[]):string[][]{
 return stableTargetGroups(top,previous,SUPPORT_GROUP_COUNT,SUPPORT_GROUP_SIZE);
}
