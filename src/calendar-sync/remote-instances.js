import {calendarDay,wallInstants,wallTime} from '../recurrence.js';
import {originalStartKey,remoteTiming} from './mapping.js';
import {validDay} from '../time.js';

const zone='Asia/Seoul';
const maxPages=10;
const boundary=day=>new Date(wallInstants(day+'T00:00:00',zone)[0]).toISOString();

export function instanceWindow(now=new Date()) {
  const today=wallTime(+now,zone).slice(0,10);
  return {since:calendarDay(today,-90),until:calendarDay(today,1097)};
}

export async function readRemoteInstances(api,id,{since,until,firstOnly=false,signal}={}) {
  if (!validDay(since) || until!=null && (!validDay(until) || until<=since)) throw new RangeError('Invalid occurrence window');
  // Pad for the Google calendar's time zone. Apply the exact Seoul/date boundary locally.
  const timeMin=boundary(calendarDay(since,-2)), timeMax=until?boundary(calendarDay(until,2)):undefined;
  const startBoundary=boundary(since),endBoundary=until?boundary(until):null;
  const entries=new Map(), seenPages=new Set();
  let pageToken;
  for (let pages=0;pages<maxPages;pages++) {
    signal?.throwIfAborted();
    const page=await api.instancePage(id,{timeMin,timeMax,pageToken});
    if (!page || !Array.isArray(page.items) && !(page.items==null && page.kind==='calendar#events')) {
      throw new Error('Invalid Google occurrence page');
    }
    const items=page.items??[];
    for (const item of items) {
      if (item.recurringEventId!==id) throw new Error('Unexpected occurrence parent');
      const anchor=originalStartKey(item.originalStartTime);
      if (!anchor) throw new Error('Missing original occurrence start');
      if (item.status==='cancelled') {
        entries.set(anchor,null);
        continue;
      }
      const timing=remoteTiming(item,zone);
      if (!timing) throw new Error('Unsupported occurrence timing');
      const lower=timing.allDay?since:startBoundary,upper=timing.allDay?until:endBoundary;
      if (timing.end<=lower || upper && timing.start>=upper) continue;
      if (!entries.has(anchor) || entries.get(anchor)!==null) entries.set(anchor,{anchor,...timing});
    }
    pageToken=page.nextPageToken;
    const occurrences=[...entries.values()].filter(Boolean);
    if (!pageToken || firstOnly && occurrences.length) {
      return {complete:!pageToken,occurrences:occurrences.sort((a,b)=>a.start.localeCompare(b.start))};
    }
    if (seenPages.has(pageToken)) break;
    seenPages.add(pageToken);
  }
  return {complete:false,occurrences:[...entries.values()].filter(Boolean)};
}
