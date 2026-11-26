/** Last real observation; never advance the timestamp on a failed poll. */
export function observationStatus(at:string|null,now:number,sameScope:boolean,failed:boolean){
 const time=at?Date.parse(at):NaN;
 const age=Number.isFinite(time)&&Number.isFinite(now)?Math.max(0,now-time):Infinity;
 return {usable:sameScope&&age<=30000,delayed:failed||age>15000,age};
}
