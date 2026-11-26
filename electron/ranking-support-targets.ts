/** Two bounded groups preserve healthy subscriptions when one group changes. */
export function supportTargetGroups(top:readonly string[],previous:readonly (readonly string[])[]):string[][]{
 const wanted=[...new Set(top.filter(s=>/^[a-z0-9_]{1,25}$/.test(s)))].slice(0,10);
 const remaining=new Set(wanted);
 const groups=Array.from({length:2},(_,i)=>{
  const group:string[]=[];
  for(const s of previous[i]??[]){if(group.length<5&&remaining.delete(s))group.push(s);}
  return group;
 });
 for(const s of wanted){if(!remaining.has(s))continue;const group=groups.find(g=>g.length<5);if(group){group.push(s);remaining.delete(s);}}
 return groups.map(g=>g.sort());
}
