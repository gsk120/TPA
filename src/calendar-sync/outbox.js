import {cancelled,eventId,isDeadlineTask,localEvent,localHash} from './mapping.js';
import {isDeepStrictEqual} from 'node:util';

export async function isCalendarTargetDetached(c,familyId,connectionId,taskId,seriesId) {
  return (await c.query(`select 1 from assistant.calendar_event_links l
    where family_id=$1 and connection_id=$2 and anchor_key is null and agreed_fields ? 'detachment'
    and (task_id=$3 or series_id=$4) and not exists (select 1 from assistant.calendar_event_links active
      where active.family_id=l.family_id and active.connection_id=l.connection_id and active.anchor_key is null
      and active.status='active' and (active.task_id=l.task_id or active.series_id=l.series_id)) limit 1`,
  [familyId,connectionId,taskId,seriesId])).rowCount>0;
}

export async function queueCalendarChange(c,familyId,kind,before,after,{origin='local',force=false,restoreCancellation=false}={}) {
  const deadlineAdded = isDeadlineTask(kind,after) && !isDeadlineTask(kind,before);
  if (origin !== 'local' || process.env.CALENDAR_SYNC_ENABLED !== 'true' ||
      process.env.CALENDAR_SYNC_FAMILY_ID?.toLowerCase() !== familyId.toLowerCase() ||
      !(['appointment','event'].includes(after.kind) || after.kind==='task' &&
        (isDeadlineTask(kind,after) || isDeadlineTask(kind,before)))) return;
  const exists = (await c.query("select to_regclass('assistant.calendar_sync_outbox') is not null as ready")).rows[0].ready;
  if (!exists) return;
  const connection = (await c.query(`select s.*, f.settings from assistant.calendar_sync_state s
    join assistant.families f on f.id=s.family_id where s.family_id=$1 and s.calendar_id=$2 and f.active
    and (s.mode='bidirectional' or s.mode='paused' and s.last_success_at is not null)`,[familyId,process.env.GOOGLE_CALENDAR_ID])).rows[0];
  if (!connection) return;
  const zone = connection.settings?.timeZone ?? 'Asia/Seoul';
  if (!force && before && localHash(kind,before,zone) === localHash(kind,after,zone)) return;
  const seriesId = kind === 'series' ? after.id : after.recurrence?.seriesId;
  const anchor = after.recurrence?.anchor;
  const original = after.recurrence?.original;
  if (await isCalendarTargetDetached(c,familyId,connection.id,kind==='task'?after.id:null,seriesId??null)) return;
  const link = (await c.query(`select * from assistant.calendar_event_links
    where family_id=$1 and connection_id=$2 and (task_id=$3 or
    (series_id=$4 and anchor_key is not distinct from $5::text))
    order by (status='active') desc,deleted_at desc nulls last limit 1`,
  [familyId,connection.id,kind==='task'?after.id:null,seriesId??null,anchor??null])).rows[0];
  let parent = kind === 'occurrence' ? (await c.query(`select * from assistant.calendar_event_links
    where family_id=$1 and connection_id=$2 and series_id=$3 and anchor_key is null and status='active'`,
  [familyId,connection.id,seriesId])).rows[0] : null;
  if (kind==='occurrence' && !parent) {
    parent=(await c.query(`select google_event_id from assistant.calendar_sync_outbox
      where family_id=$1 and connection_id=$2 and target_kind='series' and target_id=$3 and operation='create'
      and state in ('pending','sending','uncertain') and google_event_id is not null limit 1`,
    [familyId,connection.id,seriesId])).rows[0];
  }
  if (connection.mode==='paused' && !link && !parent && !before) return;
  if (!force && !link && !parent && before && !deadlineAdded) {
    const previous = (await c.query(`select 1 from assistant.calendar_sync_outbox where family_id=$1
      and connection_id=$2 and target_kind=$3 and target_id=$4 and operation='create'
      and state in ('pending','sending','uncertain','held')`,[familyId,connection.id,kind,after.id])).rowCount;
    if (!previous) return;
  }
  if (kind === 'occurrence' && !parent) return;
  const target=[familyId,connection.id,kind,after.id];
  const cancelJob=restoreCancellation && (await c.query(`select state,google_event_id,expected_etag,attempts,source_version
    from assistant.calendar_sync_outbox where family_id=$1 and connection_id=$2 and target_kind=$3
      and target_id=$4 and operation='cancel' and source_version->>'version'=$5 for update`,
  [...target,String(before.version)])).rows[0];
  const restore=cancelJob && (cancelJob.state==='done' || cancelJob.attempts>0);
  const cancel = cancelled(after);
  const active = link?.status === 'active';
  const projection = localEvent(kind,after,zone);
  const operation = cancel ? 'cancel' : restore || active || kind === 'occurrence' ? 'update' : 'create';
  const id = restore ? cancelJob.google_event_id ?? link?.google_event_id : active || cancel ? link?.google_event_id :
    kind === 'occurrence' ? null : eventId(connection.id,kind,after.id,link?.google_event_id);
  const baseline = link?.agreed_fields?.projection;
  let event = projection;
  if (operation==='update' && !restore && projection && baseline) {
    event = Object.fromEntries(Object.entries(projection).filter(([key,value])=>!isDeepStrictEqual(value,baseline[key])));
  }
  const protectedTitle=link?.visibility_policy==='protected' || parent?.visibility_policy==='protected';
  if (event && protectedTitle) {
    event={...event};
    delete event.summary;
  }
  const noChange=operation==='update' && event && !Object.keys(event).length;
  if (noChange && !cancelJob) return;
  const held = (!projection && !cancel) || (cancel && process.env.CALENDAR_SYNC_ALLOW_DELETE !== 'true') ||
    (link && !active && !force && !restore);
  const version = {version:after.version,...(after.recurrence && {series:after.recurrence.seriesVersion})};
  const payload = {event,anchor,seriesId,original,protectedTitle,parentId:parent?.google_event_id,
    parentEtag:parent?.agreed_etag,hash:localHash(kind,after,zone),
    ...(restore && {restoreVersion:cancelJob.source_version,
      ...(kind!=='occurrence' && id && {restoreEventId:eventId(connection.id,kind,after.id,id)})})};
  await c.query(`update assistant.calendar_sync_outbox set state='superseded'
    where family_id=$1 and connection_id=$2 and target_kind=$3 and target_id=$4 and state in ('pending','held')`,
  target);
  if (noChange) return;
  await c.query(`insert into assistant.calendar_sync_outbox
    (family_id,connection_id,target_kind,target_id,source_version,operation,google_event_id,expected_etag,payload,state,last_error_code)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    on conflict (family_id,connection_id,target_kind,target_id,source_version,operation) do update set
      google_event_id=excluded.google_event_id,expected_etag=excluded.expected_etag,
      payload=excluded.payload,state=excluded.state,last_error_code=excluded.last_error_code,
      attempts=0,next_attempt_at=now()
    where $12 and calendar_sync_outbox.state='superseded' and excluded.state='pending'`,
  [...target,version,operation,id??null,restore ? cancelJob.expected_etag : active?link.agreed_etag:null,
    payload,held?'held':'pending',held?'policy':null,force]);
}
