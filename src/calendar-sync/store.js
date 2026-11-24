import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {Store,persistTaskChange} from '../storage.js';
import {applyOccurrenceChange,calendarOccurrence,createScheduleSeries,updateScheduleSeries} from '../schedule-store.js';
import {planTaskCreation,validateTask} from '../tasks.js';
import {equivalentRecurrence,isDeadlineTask,linkedTaskTiming,localEvent,localHash,localTiming,originalStartKey,preserveUnspecifiedEnd,remoteHash,remoteSeries,remoteSeriesInput,remoteTiming,seal,unseal} from './mapping.js';

const origin = {origin:'google'};
const actor = 'google-calendar';
const reason = 'Google Calendar 동기화';
const seriesColumns = '*,start_date::text as start_date,end_date_exclusive::text as end_date_exclusive';
export const connectionArgs = connection => [connection.family_id,connection.id];

export async function withLease(db,connection,fn) {
  return db.tx(async c => {
    const current = (await c.query(`select s.*,f.settings from assistant.calendar_sync_state s
      join assistant.families f on f.id=s.family_id
      where s.family_id=$1 and s.id=$2 and s.lease_owner=$3 and s.lease_until>clock_timestamp()
      and s.mode=$4 and f.active for update of s`,
    [...connectionArgs(connection),connection.lease_owner,connection.mode])).rows[0];
    if (!current) throw Object.assign(new Error('Calendar lease lost'),{code:'lease_lost'});
    const result=await fn(c,current);
    await c.query(`update assistant.calendar_sync_state set lease_until=clock_timestamp()+interval '2 minutes'
      where family_id=$1 and id=$2`,connectionArgs(connection));
    return result;
  });
}

export function calendarStore(pool,familyId) {
  return new Store(pool,familyId);
}

export async function remoteLink(c,connection,id) {
  return (await c.query(`select * from assistant.calendar_event_links
    where family_id=$1 and connection_id=$2 and google_event_id=$3`,[...connectionArgs(connection),id])).rows[0];
}

export async function loadLocal(c,connection,kind,id,payload={}) {
  const family = connection.family_id;
  if (kind === 'task') return (await c.query('select data from assistant.tasks where family_id=$1 and id=$2 for update',[family,id])).rows[0]?.data;
  if (kind === 'series') return (await c.query('select '+seriesColumns+
    ' from assistant.schedule_series where family_id=$1 and id=$2 for update',[family,id])).rows[0];
  if (!payload.seriesId || !payload.original) return null;
  return calendarOccurrence(c,family,payload.seriesId,payload.original,zoneOf(connection));
}

export const zoneOf = connection => connection.settings?.timeZone ?? 'Asia/Seoul';
export const detachmentOf = link => link?.agreed_fields?.detachment;

export async function recordLink(c,connection,kind,local,event,{protectedTitle=false,previous=null,original=null,source}={}) {
  const zone = zoneOf(connection);
  const recurrence = local.recurrence;
  const status = event.status === 'cancelled' && kind !== 'occurrence' ? 'deleted' : 'active';
  if (previous && previous !== event.id) await c.query(`update assistant.calendar_event_links set status='replaced'
    where family_id=$1 and connection_id=$2 and google_event_id=$3`,[...connectionArgs(connection),previous]);
  await c.query(`insert into assistant.calendar_event_links
    (family_id,connection_id,google_event_id,task_id,series_id,anchor_key,google_parent_id,original_start_key,
    ical_uid,last_seen_etag,agreed_etag,agreed_local_version,agreed_fields,remote_timing,visibility_policy,status,previous_google_event_id,deleted_at,protected_payload)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$11,$12,$13,$14,$15,$16,case when $15='deleted' then now() end,$17)
    on conflict(family_id,connection_id,google_event_id) do update set
    task_id=case when calendar_event_links.agreed_fields ? 'detachment' then excluded.task_id else calendar_event_links.task_id end,
    series_id=case when calendar_event_links.agreed_fields ? 'detachment' then excluded.series_id else calendar_event_links.series_id end,
    anchor_key=case when calendar_event_links.agreed_fields ? 'detachment' then excluded.anchor_key else calendar_event_links.anchor_key end,
    google_parent_id=case when calendar_event_links.agreed_fields ? 'detachment' then excluded.google_parent_id else calendar_event_links.google_parent_id end,
    original_start_key=case when calendar_event_links.agreed_fields ? 'detachment' then excluded.original_start_key else calendar_event_links.original_start_key end,
    last_seen_etag=excluded.last_seen_etag,agreed_etag=excluded.agreed_etag,
    agreed_local_version=excluded.agreed_local_version,
    agreed_fields=jsonb_strip_nulls(jsonb_build_object(
      'source',calendar_event_links.agreed_fields->'source',
      'managementHistory',case when calendar_event_links.agreed_fields->'detachment' ? 'token'
        then coalesce(calendar_event_links.agreed_fields->'managementHistory','[]'::jsonb) ||
          jsonb_build_array(jsonb_build_object('action','reconnect','localId',coalesce(excluded.task_id,excluded.series_id),
            'version',excluded.agreed_local_version->'version','at',now()))
        else calendar_event_links.agreed_fields->'managementHistory' end)) || excluded.agreed_fields,
    remote_timing=case when calendar_event_links.agreed_fields ? 'detachment' then excluded.remote_timing
      else coalesce(excluded.remote_timing,calendar_event_links.remote_timing) end,
    status=excluded.status,deleted_at=excluded.deleted_at,visibility_policy=excluded.visibility_policy,
    protected_payload=case when calendar_event_links.agreed_fields ? 'detachment' then excluded.protected_payload
      else coalesce(excluded.protected_payload,calendar_event_links.protected_payload) end`,
  [...connectionArgs(connection),event.id,kind==='task'?local.id:null,kind==='series'?local.id:recurrence?.seriesId??null,
    recurrence?.anchor??null,recurrence?event.recurringEventId:null,recurrence?original:null,event.iCalUID??null,
    event.etag??null,{version:local.version},{...(source && {source}),local:localHash(kind,local,zone),remote:remoteHash(event),
      projection:localEvent(kind,local,zone)},
    remoteTiming(event,zone),protectedTitle?'protected':'standard',status,previous,
    protectedTitle && connection.key && event.summary !== undefined ? Buffer.from(seal(connection.key,event)) : null]);
}

export async function conflict(c,connection,kind,id,link,local,event,why) {
  await c.query(`insert into assistant.calendar_sync_conflicts
    (family_id,connection_id,id,target_kind,target_id,base_data,local_data,remote_data,local_version,remote_etag,reason)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    on conflict(family_id,connection_id,target_kind,target_id) where state='open' do update set
    local_data=excluded.local_data,remote_data=excluded.remote_data,local_version=excluded.local_version,
    remote_etag=excluded.remote_etag,reason=excluded.reason`,
  [...connectionArgs(connection),randomUUID(),kind,id,link?.agreed_fields??null,
    {hash:localHash(kind,local,zoneOf(connection))},event?{sealed:seal(connection.key,event)}:null,
    {version:local?.version??null},event?.etag??null,why]);
}

const held = code => ({state:'held',code});
const done = {state:'applied',code:null};
const ignored = {state:'ignored',code:null};
const safeTitle = 'Google 일정';
const validTitles = title => typeof title === 'string' && title.trim() === title && title.length > 0 && title.length <= 300;

export const publicGoogleTitle = event =>
  !['private','confidential'].includes(event.visibility) && validTitles(event.summary);

export async function saveGoogleInstances(c,connection,id,snapshot) {
  await c.query(`update assistant.calendar_event_links set remote_timing=jsonb_set(
      coalesce(remote_timing,'{}'::jsonb),'{googleInstances}',$4::jsonb)
    where family_id=$1 and connection_id=$2 and google_event_id=$3 and status='active'`,
  [...connectionArgs(connection),id,snapshot]);
}

export function googleInstanceSnapshot(event,window,occurrences) {
  return {...window,occurrences,hideTitle:!publicGoogleTitle(event),
    refreshAfter:new Date(Date.now()+86400000).toISOString()};
}

export async function importGoogleInstances(c,connection,row,event,snapshot,{privateTitle=false,reconnect=false,localId,version}) {
  if (row.resource_kind!=='series' || event.status==='cancelled' ||
      !Array.isArray(event.recurrence) || !event.recurrence.length ||
      !event.recurrence.every(line=>typeof line==='string') || !snapshot.occurrences.length) {
    return held('no_verified_occurrences');
  }
  const link=await remoteLink(c,connection,event.id);
  if (link && !reconnect) return held('already_linked');
  const timing=remoteTiming(event,zoneOf(connection));
  if (!timing) return held('unsupported_timing');
  const protectedTitle=privateTitle || !publicGoogleTitle(event) ||
    (Boolean(localId) && link?.visibility_policy==='protected');
  let local;
  if (localId) {
    local=await loadLocal(c,connection,'series',localId);
    if (link?.series_id!==localId || local?.status!=='active' ||
        local.edit_mode!=='read_only' || local.version!==version) return held('approval_stale');
    if ((await c.query(`select 1 from assistant.calendar_event_links where family_id=$1 and connection_id=$2
      and series_id=$3 and anchor_key is null and status='active'`,[...connectionArgs(connection),localId])).rowCount) {
      return held('local_already_linked');
    }
  } else {
    const input=remoteSeriesInput(event,timing,protectedTitle?safeTitle:event.summary);
    local=await createScheduleSeries(c,connection.family_id,input,actor,{...origin,readOnly:true});
  }
  await recordLink(c,connection,'series',local,event,{protectedTitle,
    source:localId?undefined:'import'});
  await saveGoogleInstances(c,connection,event.id,{...snapshot,hideTitle:protectedTitle});
  return done;
}

export async function applyInbox(c,connection,row,event,{allowDelete,initial=false,approval=null}) {
  const family = connection.family_id, zone = zoneOf(connection);
  let link = await remoteLink(c,connection,event.id);
  const occurrence = row.resource_kind.endsWith('_occurrence');
  const deletion = event.status === 'cancelled';
  const parentId=event.recurringEventId??link?.google_parent_id;
  const parent=parentId?await remoteLink(c,connection,parentId):null;
  if (detachmentOf(parent)) return ignored;
  const detachment=detachmentOf(link);
  if (link?.status==='replaced') {
    if (!(approval?.reconnect && detachment && !occurrence) &&
        !(occurrence && detachment?.state==='child' && parent?.status==='active')) return ignored;
    link=null;
  }
  if (!link && deletion && !occurrence) return ignored;
  const readOnlyLink=occurrence?parent:link;
  const snapshot=readOnlyLink?.remote_timing?.googleInstances;
  if (snapshot) {
    if (!occurrence && deletion) {
      await c.query(`update assistant.calendar_event_links set status='deleted',deleted_at=now(),last_seen_etag=$4
        where family_id=$1 and connection_id=$2 and google_event_id=$3`,
      [...connectionArgs(connection),event.id,event.etag??null]);
    } else if (readOnlyLink.status==='active' || !occurrence) {
      if (!occurrence && readOnlyLink.status==='deleted') {
        await c.query(`update assistant.calendar_event_links set status='active',deleted_at=null
          where family_id=$1 and connection_id=$2 and google_event_id=$3`,[...connectionArgs(connection),event.id]);
      }
      await saveGoogleInstances(c,connection,readOnlyLink.google_event_id,
        {...snapshot,refreshAfter:null,hideTitle:!occurrence&&!publicGoogleTitle(event)||snapshot.hideTitle});
    }
    return done;
  }
  if (occurrence && (!parent || parent.status !== 'active')) return held('parent_unlinked');
  const original = occurrence ? originalStartKey(event.originalStartTime) : null;
  if (occurrence && (!original || (link && link.original_start_key !== original))) return held('invalid_anchor');
  if (occurrence) {
    const other = (await c.query(`select google_event_id from assistant.calendar_event_links
      where family_id=$1 and connection_id=$2 and google_parent_id=$3 and original_start_key=$4 and status='active'`,
    [...connectionArgs(connection),event.recurringEventId,original])).rows[0];
    if (other && other.google_event_id !== event.id) return held('ambiguous_anchor');
  }
  if (!link && !approval && !occurrence && (initial || (await c.query(`select 1 from assistant.calendar_sync_inbox
    where family_id=$1 and connection_id=$2 and google_event_id=$3 and result_code='initial_review' limit 1`,
  [...connectionArgs(connection),event.id])).rowCount)) return held('initial_review');
  if (!deletion && (event.locked || (event.eventType && event.eventType !== 'default'))) return held('unsupported_event');
  const kind = occurrence ? 'occurrence' : link?.series_id || row.resource_kind === 'series' ? 'series' : 'task';
  if (link && !deletion && !occurrence && (Boolean(link.series_id) !== (row.resource_kind === 'series'))) return held('resource_kind_changed');
  let local = await loadLocal(c,connection,kind,approval?.localId ?? link?.task_id ?? link?.series_id,
    {seriesId:parent?.series_id,original});
  if (occurrence && !local || link && !local) return held('local_missing');
  if (approval?.localId) {
    if (link || !local || local.version !== approval.version || deletion || occurrence) return held('approval_stale');
    const existing = (await c.query(`select 1 from assistant.calendar_event_links where family_id=$1 and connection_id=$2
      and status='active' and (task_id=$3 or (series_id=$3 and anchor_key is null))`,
    [...connectionArgs(connection),local.id])).rowCount;
    if (existing) return held('local_already_linked');
    const projection = localEvent(kind,local,zone);
    const protectedTitle=approval.reconnect && detachment?.protectedTitle;
    if (!protectedTitle && !publicGoogleTitle(event)) return held('title_not_linkable');
    if (!projection || (!protectedTitle && projection.summary !== event.summary) ||
        originalStartKey(projection.start) !== originalStartKey(event.start) ||
        originalStartKey(projection.end) !== originalStartKey(event.end) ||
        kind==='series' && (local.timezone !== remoteTiming(event,zone)?.timezone ||
          !equivalentRecurrence(event,projection,zone))) return held('approval_requires_equivalent_schedule');
    await recordLink(c,connection,kind,local,event,{protectedTitle,
      source:approval.reconnect && detachment.localId===local.id?undefined:'link'});
    return done;
  }
  const localId = local?.id;
  const remoteChanged = !link || link.agreed_fields?.remote !== remoteHash(event);
  const localChanged = link && link.agreed_fields?.local !== localHash(kind,local,zone);
  if (link && !remoteChanged) {
    await c.query(`update assistant.calendar_event_links set last_seen_etag=$4,agreed_etag=$4
      where family_id=$1 and connection_id=$2 and google_event_id=$3`,
    [...connectionArgs(connection),event.id,event.etag??null]);
    return done;
  }
  if (!occurrence && !deletion && local && local.status==='cancelled' && !link) return held('local_cancelled');
  const pendingTarget = localId && (await c.query(`select 1 from assistant.calendar_sync_outbox
    where family_id=$1 and connection_id=$2 and target_kind=$3 and target_id=$4
    and state in ('pending','sending','uncertain','held') limit 1`,[...connectionArgs(connection),kind,localId])).rowCount;
  if (localId && (localChanged || (!link && pendingTarget))) {
    await conflict(c,connection,kind,localId,link,local,event,'concurrent_change');
    return held('conflict');
  }
  if (deletion && !allowDelete) return held('delete_disabled');
  const timing = deletion ? null : remoteTiming(event,zone);
  if (!deletion && !timing) return held('unsupported_timing');
  const startOnly=preserveUnspecifiedEnd(kind,local,timing);
  const alreadyProtected=link?.visibility_policy==='protected';
  const hideTitle=parent?.visibility_policy==='protected' || Boolean(approval?.privateTitle) ||
    (!deletion && !publicGoogleTitle(event));
  const protectedTitle=alreadyProtected || hideTitle;
  const title = deletion || alreadyProtected ? local?.title ?? safeTitle :
    hideTitle ? safeTitle : event.summary;
  if (kind === 'series') {
    const series = timing && remoteSeries(event,timing,title,{startOnly});
    if (!series && !deletion) return held('unsupported_recurrence');
    if (local && series && (local.timezone!==series.timezone || local.all_day!==series.all_day ||
      !isDeepStrictEqual(local.recurrence_raw,series.recurrence_raw) ||
      (local.start_date ?? new Date(local.start_at).toISOString())!==(series.start_date ?? series.start_at))) {
      const exceptions = (await c.query('select 1 from assistant.schedule_exceptions where family_id=$1 and series_id=$2 limit 1',[family,local.id])).rowCount;
      if (exceptions) {
        await conflict(c,connection,kind,localId,link,local,event,'series_exceptions');
        return held('conflict');
      }
    }
    if (local) {
      const {kind:unused,...patch} = series ?? {status:'cancelled'};
      local = await updateScheduleSeries(c,family,local.id,local.version,
        {...patch,...(series && {status:'active'})},actor,origin);
    } else local = await createScheduleSeries(c,family,series,actor,origin);
  } else {
    const fields = timing
      ? kind==='task' && local ? linkedTaskTiming(local,timing,zone,{startOnly}) : localTiming(timing,zone,{startOnly})
      : {};
    if (!local) {
      const input = {kind:'event',status:'open',title,notes:'',remindAt:[],dueDate:null,time:null,endDate:null,
        timeNote:null,person:null,assignee:null,followUpDate:null,actualDeadline:null,...fields};
      let change;
      try { change = planTaskCreation(input,reason,new Date()); } catch { return held('unsupported_timing'); }
      await persistTaskChange(c,family,actor,change,origin);
      local=change.after;
    } else if (!isDeadlineTask(kind,local) || deletion || title!==local.title || Object.keys(fields).length) {
      const moved = timing && ['dueDate','time','endDate','endTime','timeType'].some(key=>
        Object.hasOwn(fields,key) && (fields[key]??null)!==(local[key]??null));
      const after = {...local,...fields,title,version:local.version+1,updatedAt:new Date().toISOString(),
        status:deletion?'cancelled':local.status==='cancelled'?'open':local.status,
        remindAt:deletion||moved?[]:local.remindAt};
      if (timing && Object.hasOwn(fields,'timeType') && !fields.endTime) delete after.endTime;
      if (deletion || after.status==='open') after.completedAt=null;
      try { validateTask({...after,remindAt:[]}); } catch { return held('unsupported_timing'); }
      const change = {before:local,after,reason};
      if (occurrence) {
        const occurrenceTiming=timing && {start:timing.start,end:startOnly?null:timing.end};
        const currentTiming=local.recurrence.timing;
        if (occurrenceTiming && (moved || currentTiming.start!==occurrenceTiming.start ||
            currentTiming.end!==occurrenceTiming.end)) {
          change.restoreTiming=occurrenceTiming;
        }
        await applyOccurrenceChange(c,family,actor,change,origin);
        if (occurrenceTiming) after.recurrence={...local.recurrence,timing:occurrenceTiming};
      } else await persistTaskChange(c,family,actor,change,origin);
      local=after;
    }
  }
  await recordLink(c,connection,kind,local,event,{protectedTitle,original,source:!link&&!localId&&!occurrence?'import':undefined});
  return done;
}

export function readInboxEvent(connection,row) {
  return unseal(connection.key,row.payload.sealed);
}
