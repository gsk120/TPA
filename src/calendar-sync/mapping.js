import {createCipheriv,createDecipheriv,createHash,randomBytes} from 'node:crypto';
import {calendarDay,expandSeries,parseRule,validateSeries,wallInstants,wallTime} from '../recurrence.js';
import {validDay,validInstant,validTimeZone} from '../time.js';

const defaultDurationMs = 60 * 60 * 1000;
const daypartStarts = new Map([['아침','08:00'],['점심','12:00'],['저녁','18:00']]);

function daypartStart(row) {
  return !row?.time && (row?.timeType == null || row.timeType === 'condition')
    ? daypartStarts.get(row?.timeNote?.trim()) : undefined;
}

export function isDeadlineTask(kind,row) {
  return kind === 'task' && row?.kind === 'task' && validDay(row.dueDate);
}

function hasUnspecifiedStart(row) {
  return ['appointment','event'].includes(row?.kind) && validDay(row.dueDate) && !row.time &&
    (row.endDate == null || row.endDate === row.dueDate) &&
    (row.timeType === 'unknown' || row.timeType == null &&
      (!row.timeNote?.trim() || row.timeNote.trim() === '시간 미정'));
}

export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const eventId = (connection,kind,id,previous = null) => digest([connection,kind,id,previous]);
export const seal = (key,value) => {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm',key,iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);
  return Buffer.concat([iv,cipher.getAuthTag(),data]).toString('base64');
};
export function unseal(key,value) {
  const bytes = Buffer.from(value,'base64');
  const decipher = createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));
  decipher.setAuthTag(bytes.subarray(12,28));
  return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]));
}

export const originalStartKey = value => validDay(value?.date) ? value.date :
  validInstant(value?.dateTime) ? new Date(value.dateTime).toISOString() : null;
export const resourceKind = event => event.recurringEventId || event.originalStartTime
  ? event.status === 'cancelled' ? 'cancelled_occurrence' : 'modified_occurrence'
  : event.status === 'cancelled' ? 'deleted' : event.recurrence?.length ? 'series' : 'single';
export const remoteHash = event => digest([event.summary ?? null,event.status === 'cancelled',
  originalStartKey(event.start),originalStartKey(event.end),event.start?.timeZone ?? null,
  event.end?.timeZone ?? null,event.recurrence ?? null,event.visibility ?? null,
  event.endTimeUnspecified ?? false,event.eventType ?? 'default',event.locked ?? false]);

export function remoteTiming(event,zone) {
  const start = originalStartKey(event.start), end = originalStartKey(event.end);
  if (!start || !end || end <= start || event.endTimeUnspecified || validDay(start) !== validDay(end)) return null;
  const timezone = event.start.timeZone ?? zone;
  if (!validTimeZone(timezone)) return null;
  return {start,end,timezone,allDay:validDay(start)};
}

function usesDefaultEnd(kind,row) {
  if (!row) return false;
  const type = kind === 'series' ? row.time_type : row.timeType;
  if (type != null && type !== 'timed') return false;
  if (kind === 'series') return !row.all_day && row.end_at == null;
  if (kind === 'occurrence') return Boolean(row.time) && row.recurrence.timing.end == null;
  return Boolean(row.time) &&
    row.endTime == null && (row.endDate == null || row.endDate === row.dueDate);
}

export function preserveUnspecifiedEnd(kind,row,timing) {
  return timing && !timing.allDay && usesDefaultEnd(kind,row) &&
    Date.parse(timing.end) - Date.parse(timing.start) === defaultDurationMs;
}

export function localTiming(timing,zone,{startOnly=false}={}) {
  if (timing.allDay) return {dueDate:timing.start,time:null,endDate:calendarDay(timing.end,-1),
    timeType:'all_day',sourceTimeZone:timing.timezone};
  const start = wallTime(Date.parse(timing.start),zone);
  if (startOnly) return {dueDate:start.slice(0,10),time:start.slice(11,16),endDate:null,
    timeType:'timed',sourceTimeZone:timing.timezone};
  const end = wallTime(Date.parse(timing.end),zone);
  return {dueDate:start.slice(0,10),time:start.slice(11,16),endDate:end.slice(0,10),
    endTime:end.slice(11,16),timeType:'range',sourceTimeZone:timing.timezone};
}

export function linkedTaskTiming(row,timing,zone,{startOnly=false}={}) {
  if (isDeadlineTask('task',row)) {
    const current = localEvent('task',row,zone);
    if (timing.start === originalStartKey(current?.start)) return {};
    const fields = timing.allDay
      ? {dueDate:timing.start,time:null,endDate:null,timeType:'date_only',sourceTimeZone:timing.timezone}
      : localTiming(timing,zone,{startOnly:true});
    return {...fields,endTime:null};
  }
  const defaultStart = daypartStart(row);
  if (defaultStart) {
    const fields = localTiming(timing,zone,{startOnly:true});
    if (fields.time === defaultStart) {
      return {dueDate:fields.dueDate};
    }
    return {...fields,timeNote:null};
  }
  if (hasUnspecifiedStart(row)) {
    if (timing.allDay) {
      return {dueDate:timing.start,...(row.endDate && {endDate:timing.start})};
    }
    const fields = localTiming(timing,zone,{startOnly});
    return row.timeNote?.trim() === '시간 미정' ? {...fields,timeNote:null} : fields;
  }
  return localTiming(timing,zone,{startOnly});
}

export function remoteSeriesInput(event,timing,title) {
  return {title,kind:'event',timezone:timing.timezone,all_day:timing.allDay,
    time_type:timing.allDay ? 'all_day' : 'range',recurrence_raw:event.recurrence,
    ...(timing.allDay ? {start_date:timing.start,end_date_exclusive:timing.end} :
      {start_at:timing.start,end_at:timing.end})};
}

export function remoteSeries(event,timing,title,{startOnly=false}={}) {
  const input=remoteSeriesInput(event,timing,title);
  if (startOnly) {
    input.time_type='timed';
    input.end_at=null;
  }
  try { validateSeries(input); return input; } catch { return null; }
}

export function equivalentRecurrence(a,b,zone) {
  if (JSON.stringify(a.recurrence??null)===JSON.stringify(b.recurrence??null)) return true;
  if (!a.recurrence?.length || !b.recurrence?.length) return false;
  const yearlySignature=event=>{
    const timing=remoteTiming(event,zone);
    if (!timing || !remoteSeries(event,timing,'Preview')) return null;
    const rule=parseRule(event.recurrence,timing.allDay);
    return rule.frequency==='YEARLY' ? JSON.stringify([timing.start,timing.timezone,rule.interval,rule.count,rule.until]) : null;
  };
  const signature=yearlySignature(a);
  return signature!==null && signature===yearlySignature(b);
}

export function previewDateScope(event,since,zone,exceptions=[]) {
  const boundary=wallInstants(since+'T00:00:00','Asia/Seoul')[0];
  const overlaps=(start,end)=>validDay(start)
    ? (validDay(end) ? end>since : start>=since)
    : (validInstant(end) ? Date.parse(end)>boundary : validInstant(start) && Date.parse(start)>=boundary);
  if (!event.recurrence?.length) {
    const start=originalStartKey(event.start);
    if (!start) return 'review';
    return overlaps(start,originalStartKey(event.end))?'included':'excluded';
  }
  const overrides=new Set();
  for (const item of exceptions) {
    if (item.status!=='cancelled' && overlaps(originalStartKey(item.start),originalStartKey(item.end))) return 'included';
    const original=originalStartKey(item.originalStartTime);
    if (original) overrides.add(original);
  }
  const timing=remoteTiming(event,zone);
  const series=timing && remoteSeries(event,timing,'Preview');
  if (!series) return 'review';
  const baseDay=timing.allDay?since:wallTime(boundary,timing.timezone).slice(0,10);
  const overlapDays=Math.ceil((Date.parse(timing.end)-Date.parse(timing.start))/86400000)+2;
  const start=calendarDay(baseDay,-overlapDays);
  for (const occurrence of expandSeries(series,start,'9999-12-31')) {
    if (!overrides.has(occurrence.start) && overlaps(occurrence.start,occurrence.end)) return 'included';
  }
  return 'excluded';
}

function dates(start,end,zone) {
  if (validDay(start) && validDay(end) && end > start) return {start:{date:start},end:{date:end}};
  if (start == null || end == null || !validTimeZone(zone)) return null;
  const from = new Date(start), to = new Date(end);
  if (!(to > from)) return null;
  return {start:{dateTime:from.toISOString(),timeZone:zone},
    end:{dateTime:to.toISOString(),timeZone:zone}};
}

function datesWithDefaultEnd(start,end,zone,useDefault) {
  return dates(start,useDefault && start != null ? +new Date(start) + defaultDurationMs : end,zone);
}

function oneHourEvent(day,clock,zone) {
  if (!validDay(day)) return null;
  const start = wallInstants(day+'T'+clock+':00',zone);
  return start.length === 1 ? dates(start[0],start[0]+defaultDurationMs,zone) : null;
}

export function localEvent(kind,row,zone) {
  if (isDeadlineTask(kind,row)) {
    const when = row.time ? oneHourEvent(row.dueDate,row.time,zone)
      : dates(row.dueDate,calendarDay(row.dueDate,1),zone);
    return when && {summary:row.title,...when};
  }
  if (!row || !['appointment','event'].includes(row.kind)) return null;
  let when;
  const useDefault = usesDefaultEnd(kind,row);
  if (kind === 'series') {
    if (row.edit_mode !== 'supported') return null;
    when = datesWithDefaultEnd(row.start_date ?? row.start_at,row.end_date_exclusive ?? row.end_at,row.timezone,useDefault);
  } else if (kind === 'occurrence') {
    if (row.recurrence.readOnly) return null;
    when = datesWithDefaultEnd(row.recurrence.timing.start,row.recurrence.timing.end,
      row.recurrence.seriesTimeZone ?? row.recurrence.timeZone,useDefault);
  } else if (row.timeType === 'all_day' && validDay(row.dueDate)) {
    when = dates(row.dueDate,calendarDay(row.endDate ?? row.dueDate,1),zone);
  } else if (hasUnspecifiedStart(row)) {
    when = dates(row.dueDate,calendarDay(row.dueDate,1),zone);
  } else if (row.timeType === 'range') {
    const start = wallInstants(row.dueDate+'T'+row.time+':00',zone);
    const end = wallInstants((row.endDate ?? row.dueDate)+'T'+row.endTime+':00',zone);
    if (start.length === 1 && end.length === 1) when = dates(start[0],end[0],zone);
  } else {
    const start = useDefault ? row.time : daypartStart(row);
    if (start) when = oneHourEvent(row.dueDate,start,zone);
  }
  if (!when) return null;
  return {summary:row.title,...when,...(kind === 'series' && {recurrence:row.recurrence_raw})};
}

export const cancelled = row => row?.status === 'cancelled';
export const localHash = (kind,row,zone) => digest([cancelled(row),localEvent(kind,row,zone)]);
