/** Last two fully elapsed five-second buckets. Never treat incomplete observation as zero. */
export function recentChatCount(buckets:ReadonlyMap<number,number>|undefined,connectedSince:number|null,startedAt:string|null,now:number,capacityReached=false):number|null{
 const started=Date.parse(startedAt??"");
 if(connectedSince===null||!Number.isFinite(connectedSince)||!Number.isFinite(started)||!Number.isFinite(now))return null;
 const end=Math.floor(now/5000),begin=end-2;
 if(Math.max(connectedSince,started)>begin*5000||(!buckets&&capacityReached))return null;
 return (buckets?.get(begin)??0)+(buckets?.get(begin+1)??0);
}
