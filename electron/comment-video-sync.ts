import { parseBroadcastFileStem } from "./recording-filenames";
/** Modern VOD files have a verified identity. Relative VOD timestamps cannot
 * be used unchanged for partial LIVE recordings. Keep legacy behavior when
 * a filename cannot be classified. */
export function commentOffsetForVideo(raw:Record<string,unknown>,videoName:string,anchorMs:number):number {
  const video=parseBroadcastFileStem(videoName);
  const offset=typeof raw.timeInSeconds==="number"&&Number.isFinite(raw.timeInSeconds)?raw.timeInSeconds:NaN;
  const id=typeof raw.videoId==="string"?raw.videoId.toLowerCase():"";
  if(video?.kind==="VOD" && id){
    if(video.videoId && video.videoId!==id)return NaN;
    if(Number.isFinite(offset))return offset;
  }
  if((!video || !id) && Number.isFinite(offset))return offset;
  const created=typeof raw.createdAt==="string"?raw.createdAt:typeof raw.created_at==="string"?raw.created_at:"";
  const ms=Date.parse(created);
  return Number.isFinite(ms)&&Number.isFinite(anchorMs)?(ms-anchorMs)/1000:NaN;
}
