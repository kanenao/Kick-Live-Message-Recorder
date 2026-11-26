export const SUPPORT_WINDOW_SECONDS=60;
export const SUPPORT_ZERO_CONFIRM_SECONDS=10;
/** Positive received events are eligible immediately; never infer a gift from elapsed time. */
export function supportRankValue(value:number|null,seconds:number):number|null{
 return Number.isFinite(seconds)&&seconds>=0&&seconds<=SUPPORT_WINDOW_SECONDS&&typeof value==="number"&&Number.isSafeInteger(value)&&value>0?value:null;
}
/** Retry faster only if no requested feed is subscribed, to avoid resetting healthy observation. */
export function supportRetryDelayMs(hasSubscription:boolean):number{return hasSubscription?120000:20000;}
