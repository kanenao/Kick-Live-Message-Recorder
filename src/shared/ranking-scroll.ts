type CardPosition={slug:string;top:number;bottom?:number};
export type RankingScroll={y:number;anchor:string|null;offset:number};
export function captureRankingScroll(y:number,height:number,cards:readonly CardPosition[]):RankingScroll{
 const scroll=Number.isFinite(y)?Math.max(0,y):0;
 // At the top or before the first card, preserve the actual document position.
 const anchor=scroll>0?cards.find(c=>c.slug&&Number.isFinite(c.top)&&Number.isFinite(c.bottom)&&(c.bottom??0)>0&&c.top<height):undefined;
 return {y:scroll,anchor:anchor?.slug??null,offset:anchor?.top??0};
}
export function restoreRankingScroll(saved:RankingScroll,currentY:number,cards:readonly CardPosition[],maxY:number):number{
 const anchor=saved.anchor?cards.find(c=>c.slug===saved.anchor&&Number.isFinite(c.top)):undefined;
 const target=anchor&&Number.isFinite(currentY)&&Number.isFinite(saved.offset)?currentY+anchor.top-saved.offset:saved.y;
 return Math.max(0,Math.min(Number.isFinite(maxY)?Math.max(0,maxY):0,Number.isFinite(target)?target:0));
}
