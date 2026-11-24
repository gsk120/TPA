import {randomUUID} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import {calendarClient} from './google.js';
import {applyInbox,calendarStore,conflict,connectionArgs,googleInstanceSnapshot,loadLocal,readInboxEvent,recordLink,remoteLink,saveGoogleInstances,withLease,zoneOf} from './store.js';
import {localHash,originalStartKey,remoteHash,resourceKind,seal,unseal} from './mapping.js';
import {instanceWindow,readRemoteInstances} from './remote-instances.js';

const receipt = 'where family_id=$1 and connection_id=$2 and target_kind=$3 and target_id=$4 and source_version=$5 and operation=$6';
const argsFor = job => [job.family_id,job.connection_id,job.target_kind,job.target_id,job.source_version,job.operation];
const statusCode = error => error.status ?? error.code ?? 'sync_failed';
const MAX_BATCH = 50;

async function markJob(c,job,state,error=null) {
  const retry = Math.min(3600,15*2**Math.min(job.attempts,8));
  await c.query(`update assistant.calendar_sync_outbox set state=$7,last_error_code=$8,
    lease_owner=null,lease_until=null,next_attempt_at=now()+$9*interval '1 second' ${receipt}`,
  [...argsFor(job),state,error,retry]);
}

async function claim(pool,settings,force) {
  return (await pool.query(`update assistant.calendar_sync_state s set lease_owner=$3,
    lease_until=now()+interval '2 minutes' from assistant.families f
    where f.id=s.family_id and f.active and s.family_id=$1 and s.calendar_id=$2 and s.mode<>'paused'
    and (s.lease_until is null or s.lease_until<now())
    and ($4::boolean or s.next_poll_at is null or s.next_poll_at<=now())
    returning s.*,f.settings`,[settings.familyId,settings.calendarId,randomUUID(),force])).rows[0];
}

async function receive(db,connection,api,signal) {
  let run = await withLease(db,connection,async(c,current)=>{
    if (current.run_id) return current;
    return (await c.query(`update assistant.calendar_sync_state set run_id=$3,next_page_token=null
      where family_id=$1 and id=$2 returning *`,[...connectionArgs(connection),randomUUID()])).rows[0];
  });
  const full = !run.sync_token;
  while (!signal.aborted) {
    let page;
    try { page=await api.list(run.sync_token,run.next_page_token); }
    catch(error) {
      if (error.status !== 410 || !run.sync_token && !run.next_page_token) throw error;
      run=await withLease(db,connection,async c => {
        await c.query(`update assistant.calendar_sync_inbox set state='ignored',result_code='abandoned_run'
          where family_id=$1 and connection_id=$2 and run_id=$3 and state='pending'`,
        [...connectionArgs(connection),run.run_id]);
        return (await c.query(`update assistant.calendar_sync_state set sync_token=null,sync_epoch=sync_epoch+1,
          next_page_token=null,run_id=null where family_id=$1 and id=$2 returning *`,connectionArgs(connection))).rows[0];
      });
      return false;
    }
    if (!page.nextPageToken && !page.nextSyncToken) throw new Error('Missing Google Calendar cursor');
    const events=new Map();
    for (const event of page.items ?? []) {
      if (!event.id) throw new Error('Missing Google Calendar event ID');
      events.set(event.id,{google_event_id:event.id,resource_kind:resourceKind(event),etag:event.etag??null,
        payload:{sealed:seal(connection.key,event),full}});
    }
    await withLease(db,connection,async c=>{
      if (events.size) {
        await c.query(`update assistant.calendar_sync_inbox set state='ignored'
          where family_id=$1 and connection_id=$2 and run_id<>$3 and google_event_id=any($4::text[])
          and state in ('pending','held')`,[...connectionArgs(connection),run.run_id,[...events.keys()]]);
        await c.query(`insert into assistant.calendar_sync_inbox
          (family_id,connection_id,run_id,google_event_id,resource_kind,etag,payload)
          select $1,$2,$3,e.google_event_id,e.resource_kind,e.etag,e.payload
          from jsonb_to_recordset($4::jsonb) as e(google_event_id text,resource_kind text,etag text,payload jsonb)
          on conflict(family_id,connection_id,run_id,google_event_id) do update set
          resource_kind=excluded.resource_kind,etag=excluded.etag,payload=excluded.payload`,
        [...connectionArgs(connection),run.run_id,JSON.stringify([...events.values()])]);
      }
      if (full && !page.nextPageToken && connection.mode!=='preview') {
        const missing=(await c.query(`select l.* from assistant.calendar_event_links l
          where l.family_id=$1 and l.connection_id=$2 and l.status='active' and l.anchor_key is null
          and not exists(select 1 from assistant.calendar_sync_inbox i where i.family_id=l.family_id
            and i.connection_id=l.connection_id and i.run_id=$3 and i.google_event_id=l.google_event_id)`,
        [...connectionArgs(connection),run.run_id])).rows;
        for (const link of missing) {
          const kind=link.task_id?'task':'series', id=link.task_id??link.series_id;
          const local=await loadLocal(c,connection,kind,id);
          await conflict(c,connection,kind,id,link,local,null,'remote_missing_after_full');
        }
      }
      await c.query(`update assistant.calendar_sync_state set next_page_token=$3,
        sync_token=coalesce($4,sync_token),run_id=case when $3::text is null then null else run_id end
        where family_id=$1 and id=$2`,
      [...connectionArgs(connection),page.nextPageToken??null,page.nextPageToken?null:page.nextSyncToken]);
    });
    if (!page.nextPageToken) return true;
    run.next_page_token=page.nextPageToken;
  }
  return false;
}

async function applyPending(db,connection,settings,signal) {
  if (connection.mode==='preview') {
    if (signal.aborted) return false;
    const claimed=await withLease(db,connection,async c=>(await c.query(`with batch as (
      select run_id,google_event_id from assistant.calendar_sync_inbox
      where family_id=$1 and connection_id=$2 and state='pending'
      order by run_id,google_event_id limit $3
    )
    update assistant.calendar_sync_inbox i set state='held',result_code='initial_review'
    from batch b where i.family_id=$1 and i.connection_id=$2 and i.run_id=b.run_id and i.google_event_id=b.google_event_id`,
    [...connectionArgs(connection),MAX_BATCH])).rowCount);
    return claimed < MAX_BATCH;
  }
  for (let i=0;i<MAX_BATCH&&!signal.aborted;i++) {
    const found=await withLease(db,connection,async c=>{
      const row=(await c.query(`select * from assistant.calendar_sync_inbox
        where family_id=$1 and connection_id=$2 and state='pending'
        order by case resource_kind when 'series' then 0 when 'single' then 1 when 'deleted' then 2 else 3 end,
        google_event_id limit 1`,connectionArgs(connection))).rows[0];
      if (!row) return false;
      const event=readInboxEvent(connection,row);
      const inFlight=(await c.query(`select 1 from assistant.calendar_sync_outbox
        where family_id=$1 and connection_id=$2 and
          (google_event_id=$3 and (state in ('sending','uncertain') or state='pending' and payload ? 'restoreVersion' and $4)
            or payload->>'restoreEventId'=$3 and state in ('pending','sending','uncertain')) limit 1`,
      [...connectionArgs(connection),event.id,event.status==='cancelled'])).rowCount;
      const result=inFlight ? {state:'held',code:'await_receipt'} :
        await applyInbox(c,connection,row,event,{allowDelete:settings.allowDelete,initial:row.payload.full});
      await c.query(`update assistant.calendar_sync_inbox set state=$5,result_code=$6
        where family_id=$1 and connection_id=$2 and run_id=$3 and google_event_id=$4`,
      [...connectionArgs(connection),row.run_id,row.google_event_id,result.state,result.code]);
      return true;
    });
    if (!found) return true;
  }
  return false;
}

async function claimJob(db,connection,settings) {
  return withLease(db,connection,async c=>{
    const job=(await c.query(`select o.* from assistant.calendar_sync_outbox o
      where family_id=$1 and connection_id=$2 and state in ('pending','sending','uncertain')
      and (lease_until is null or lease_until<now())
      and (next_attempt_at<=now() or o.operation='cancel' and o.state='uncertain'
        and exists(select 1 from assistant.calendar_sync_outbox restore
          where restore.family_id=o.family_id and restore.connection_id=o.connection_id
            and restore.target_kind=o.target_kind and restore.target_id=o.target_id
            and restore.state='pending' and restore.payload->'restoreVersion'=o.source_version))
      and (target_kind<>'occurrence' or exists(select 1 from assistant.calendar_event_links p
        where p.family_id=o.family_id and p.connection_id=o.connection_id and p.status='active'
        and p.anchor_key is null and p.google_event_id=o.payload->>'parentId'))
      and not exists(select 1 from assistant.calendar_sync_outbox older
        where older.family_id=o.family_id and older.connection_id=o.connection_id
        and older.target_kind=o.target_kind and older.target_id=o.target_id
        and older.state in ('sending','uncertain') and o.state='pending')
      order by case when state='pending' then 1 else 0 end,
      case target_kind when 'series' then 0 when 'task' then 1 else 2 end,next_attempt_at limit 1`,
    connectionArgs(connection))).rows[0];
    if (!job) return null;
    if (job.target_kind==='occurrence' && !job.payload.parentEtag) {
      const parent=await remoteLink(c,connection,job.payload.parentId);
      job.payload.parentEtag=parent?.agreed_etag;
    }
    const local=await loadLocal(c,connection,job.target_kind,job.target_id,job.payload);
    const current=(await c.query(`select state from assistant.calendar_sync_outbox ${receipt} for update`,argsFor(job))).rows[0];
    if (!current || current.state!==job.state) return {skip:true};
    if (job.operation==='cancel' && ['sending','uncertain'].includes(job.state) &&
        (await c.query(`select 1 from assistant.calendar_sync_outbox where family_id=$1 and connection_id=$2
          and target_kind=$3 and target_id=$4 and payload->'restoreVersion'=$5 and state='pending' limit 1`,
        argsFor(job).slice(0,5))).rowCount) {
      await markJob(c,job,'superseded');
      return {skip:true};
    }
    const googleId=job.google_event_id;
    const blocked=(await c.query(`select 1 from assistant.calendar_sync_conflicts where family_id=$1
      and connection_id=$2 and target_kind=$3 and target_id=$4 and state='open' union all
      select 1 from assistant.calendar_sync_inbox where family_id=$1 and connection_id=$2 and state in ('pending','held')
      and (google_event_id=$5 or google_event_id=$6) and coalesce(result_code,'') not in ('initial_review','await_receipt') limit 1`,
    [...connectionArgs(connection),job.target_kind,job.target_id,googleId,job.payload.parentId??null])).rowCount;
    if ((job.state==='pending' || job.payload.restoreVersion) &&
        (!local || job.payload.hash!==localHash(job.target_kind,local,zoneOf(connection)))) {
      await markJob(c,job,'superseded'); return {skip:true};
    }
    if (job.state==='pending' && (blocked || job.operation==='cancel' && !settings.allowDelete)) {
      await markJob(c,job,'held','policy_or_conflict'); return {skip:true};
    }
    await c.query(`update assistant.calendar_sync_outbox set state='sending',attempts=attempts+1,
      lease_owner=$7,lease_until=now()+interval '2 minutes' ${receipt}`,[...argsFor(job),connection.lease_owner]);
    return {...job,local,blocked,attempts:job.attempts+1};
  });
}

async function optionalGet(api,id) {
  try { return await api.get(id); }
  catch(error) { if (![404,410].includes(error.status)) throw error; return null; }
}

function matches(actual,expected) {
  return Object.entries(expected ?? {}).every(([key,value])=>{
    if (key==='start'||key==='end') return originalStartKey(actual[key])===originalStartKey(value) &&
      (value.timeZone===undefined || value.timeZone===actual[key]?.timeZone);
    return JSON.stringify(actual[key])===JSON.stringify(value);
  });
}

async function restoreRemote(db,connection,api,job,id,remote) {
  const projection=job.payload.event;
  const newId=job.payload.restoreEventId;
  if (remote && remote.status!=='cancelled' && newId && job.attempts>1) {
    const replacement=await optionalGet(api,newId);
    if (replacement && replacement.status!=='cancelled') {
      throw Object.assign(new Error('Both the original and replacement calendar event exist'),{status:412});
    }
  }
  if (remote && remote.status!=='cancelled' && matches(remote,projection)) return remote;
  if (job.blocked) throw Object.assign(new Error('Restore blocked by conflict'),{status:412});
  if (job.target_kind==='occurrence') {
    if (!remote?.etag || remote.recurringEventId!==job.payload.parentId ||
        originalStartKey(remote.originalStartTime)!==job.payload.original ||
        (remote.status!=='cancelled' && remote.etag!==job.expected_etag)) {
      throw Object.assign(new Error('Unverified occurrence restore'),{status:412});
    }
    return api.patch(id,{...projection,status:'confirmed'},remote.etag);
  }
  if (remote && remote.status!=='cancelled') {
    if (!job.expected_etag || remote.etag!==job.expected_etag) {
      throw Object.assign(new Error('Calendar event changed before restore'),{status:412});
    }
    return api.patch(id,projection,job.expected_etag);
  }
  if (!newId) throw Object.assign(new Error('Restore ID is missing'),{status:412});
  const oldLink=await withLease(db,connection,c=>remoteLink(c,connection,id));
  if (!oldLink) throw Object.assign(new Error('Original calendar link is missing'),{status:412});
  let event=projection;
  if (job.payload.protectedTitle) {
    const saved=oldLink.protected_payload && unseal(connection.key,Buffer.from(oldLink.protected_payload).toString());
    if (!saved?.summary) throw Object.assign(new Error('Protected calendar title cannot be restored'),{status:412});
    event={...projection,summary:saved.summary,...(saved.visibility && {visibility:saved.visibility})};
  }
  let created=await optionalGet(api,newId);
  if (!created) {
    try { return await api.create({...event,id:newId,extendedProperties:{private:{tpaEventId:newId}}}); }
    catch(error) {
      if (error.status!==409) throw error;
      created=await optionalGet(api,newId);
    }
  }
  if (!created || created.status==='cancelled' || created.extendedProperties?.private?.tpaEventId!==newId || !matches(created,event)) {
    throw Object.assign(new Error('Restore ID conflict'),{status:412});
  }
  return created;
}

async function send(db,connection,settings,api,job) {
  let id=job.google_event_id, event, deleted=false, restoredFrom;
  try {
    if (!id && job.target_kind==='occurrence') {
      const original=job.payload.original;
      if (!original || !job.payload.parentId)
        throw Object.assign(new Error('Occurrence requires lookup'),{code:'occurrence_lookup'});
      const parent=await api.get(job.payload.parentId);
      if (!job.payload.parentEtag || parent.etag!==job.payload.parentEtag)
        throw Object.assign(new Error('Parent changed'),{status:412});
      const instances=await api.instances(job.payload.parentId,original);
      const matchesOriginal=(instances.items??[]).filter(item=>originalStartKey(item.originalStartTime)===original);
      if (matchesOriginal.length!==1 || instances.nextPageToken || !matchesOriginal[0].etag)
        throw Object.assign(new Error('Ambiguous occurrence'),{code:'occurrence_lookup'});
      event=matchesOriginal[0];
      id=event.id;
      job.expected_etag=event.etag;
      await withLease(db,connection,c=>c.query(`update assistant.calendar_sync_outbox
        set google_event_id=$7,expected_etag=$8 ${receipt}`,[...argsFor(job),id,event.etag]));
    }
    if (!id) throw Object.assign(new Error('No linked event'),{code:'missing_link'});
    const remote=event??await optionalGet(api,id);
    if (job.payload.restoreVersion) {
      restoredFrom=id;
      event=await restoreRemote(db,connection,api,job,id,remote);
      const validId=event?.id && (event.id===id || event.id===job.payload.restoreEventId);
      if (!validId || event.status==='cancelled' || !matches(event,job.payload.event)) {
        throw Object.assign(new Error('Restore was not confirmed'),{status:412});
      }
      id=event.id;
    } else if (job.operation==='create') {
      if (remote) {
        if (remote.status==='cancelled' || remote.extendedProperties?.private?.tpaEventId!==id ||
          !matches(remote,job.payload.event)) throw Object.assign(new Error('Event ID conflict'),{status:412});
        event=remote;
      } else {
        if (job.blocked) throw Object.assign(new Error('Blocked creation'),{code:'blocked'});
        event=await api.create({...job.payload.event,id,extendedProperties:{private:{tpaEventId:id}}});
      }
    } else if (job.operation==='cancel') {
      if (!remote || remote.status==='cancelled') {
        if (job.state==='pending' && !remote) throw Object.assign(new Error('Unconfirmed deletion'),{status:412});
        deleted=true;
      } else {
        if (job.blocked || !settings.allowDelete || !job.expected_etag || remote.etag!==job.expected_etag)
          throw Object.assign(new Error('Unverified cancellation'),{status:412});
        if (job.target_kind==='occurrence') event=await api.patch(id,{status:'cancelled'},job.expected_etag);
        else { await api.remove(id,job.expected_etag); deleted=true; }
      }
    } else if (remote && remote.status!=='cancelled' && matches(remote,job.payload.event)) event=remote;
    else {
      if (job.blocked || !remote || remote.status==='cancelled' || !job.expected_etag || remote.etag!==job.expected_etag)
        throw Object.assign(new Error('Calendar event changed'),{status:412});
      if (job.target_kind==='series' && ['start','recurrence'].some(key=>Object.hasOwn(job.payload.event,key) &&
        !matches(remote,{[key]:job.payload.event[key]}))) {
        throw Object.assign(new Error('Series rule change requires review'),{code:'series_review'});
      }
      event=await api.patch(id,job.payload.event,job.expected_etag);
    }
    await withLease(db,connection,async c=>{
      const link=await remoteLink(c,connection,id);
      const result=deleted?{id,status:'cancelled',...(job.target_kind==='occurrence' && {recurringEventId:job.payload.parentId})}:event;
      if (!job.local || !result?.id || result.id!==id) throw new Error('Calendar write confirmation missing');
      if (job.payload.hash!==localHash(job.target_kind,job.local,zoneOf(connection))) {
        await conflict(c,connection,job.target_kind,job.target_id,link,job.local,result,'local_changed_after_send');
        await markJob(c,job,'held','local_changed_after_send');
        return;
      }
      const old=(await c.query(`select google_event_id from assistant.calendar_event_links where family_id=$1 and connection_id=$2
        and status='deleted' and (task_id=$3 or (series_id=$4 and anchor_key is null)) order by deleted_at desc limit 1`,
      [...connectionArgs(connection),job.target_kind==='task'?job.target_id:null,job.target_kind==='series'?job.target_id:null])).rows[0];
      const previous=restoredFrom && restoredFrom!==id ? await remoteLink(c,connection,restoredFrom) : null;
      await recordLink(c,connection,job.target_kind,job.local,result,{original:job.payload.original,
        previous:previous?.google_event_id??old?.google_event_id??null,source:previous?.agreed_fields?.source,
        protectedTitle:job.payload.protectedTitle||link?.visibility_policy==='protected'});
      if (restoredFrom) await c.query(`update assistant.calendar_sync_inbox set state='applied',result_code=null
        where family_id=$1 and connection_id=$2 and google_event_id=$3 and state='held'
          and result_code='await_receipt' and resource_kind in ('deleted','cancelled_occurrence')`,
      [...connectionArgs(connection),restoredFrom]);
      await c.query(`update assistant.calendar_sync_inbox set state='pending',result_code=null
        where family_id=$1 and connection_id=$2 and google_event_id=$3 and state='held'
        and result_code='await_receipt' and etag is distinct from $4`,
      [...connectionArgs(connection),id,result.etag??null]);
      await c.query(`update assistant.calendar_sync_inbox set state='applied',result_code=null
        where family_id=$1 and connection_id=$2 and google_event_id=$3 and state='held' and result_code='await_receipt'`,
      [...connectionArgs(connection),id]);
      await markJob(c,job,'done');
    });
  } catch(error) {
    if ((error.status===401 || error.status===403 && !error.rateLimit) || error.code==='lease_lost') throw error;
    await withLease(db,connection,async c=>{
      const review=[409,412].includes(error.status) || ['series_review','occurrence_lookup','missing_link','blocked'].includes(error.code);
      if (review) {
        await conflict(c,connection,job.target_kind,job.target_id,id&&await remoteLink(c,connection,id),
          job.local,null,String(statusCode(error)));
      }
      await markJob(c,job,review?'held':error.status===400?'failed':'uncertain',String(statusCode(error)));
    });
  }
}

async function refreshGoogleInstances(db,connection,api,signal) {
  const links=await withLease(db,connection,async c=>(await c.query(`select google_event_id,visibility_policy,remote_timing->'googleInstances' as snapshot
    from assistant.calendar_event_links where family_id=$1 and connection_id=$2 and status='active'
    and remote_timing ? 'googleInstances'
    and coalesce((remote_timing->'googleInstances'->>'refreshAfter')::timestamptz,'-infinity')<=now()
    order by (remote_timing->'googleInstances'->>'refreshAfter')::timestamptz nulls first limit 3`,
  connectionArgs(connection))).rows);
  for (const link of links) {
    signal.throwIfAborted();
    const id=link.google_event_id;
    let snapshot;
    try {
      const event=await api.get(id);
      if (event.id!==id || event.status==='cancelled' || !event.recurrence?.length) throw new Error('No active Google series');
      const window=instanceWindow();
      const {complete,occurrences}=await readRemoteInstances(api,id,{...window,signal});
      if (!complete) throw new Error('Google occurrence snapshot incomplete');
      snapshot=googleInstanceSnapshot(event,window,occurrences);
      if (link.visibility_policy==='protected') snapshot.hideTitle=true;
    } catch (error) {
      if (signal.aborted || error.status===401 || error.status===403 && !error.rateLimit) throw error;
      // Retain the last complete set during an outage and defer subsequent retries.
      snapshot={...link.snapshot,refreshAfter:new Date(Date.now()+300000).toISOString(),
        refreshError:String(statusCode(error))};
    }
    await withLease(db,connection,c=>saveGoogleInstances(c,connection,id,snapshot));
  }
}

export async function syncCalendarOnce(pool,settings,api,signal,{force=false}={}) {
  const connection=await claim(pool,settings,force);
  if (!connection) return false;
  connection.key=settings.key;
  const db=calendarStore(pool,connection.family_id);
  let errorCode=null,success=false,pause=false;
  try {
    if (!connection.run_id && !await applyPending(db,connection,settings,signal)) return false;
    if (!await receive(db,connection,api,signal) || !await applyPending(db,connection,settings,signal)) return false;
    if (connection.mode!=='preview') await refreshGoogleInstances(db,connection,api,signal);
    if (connection.mode==='bidirectional') {
      for (let i=0;i<10&&!signal.aborted;i++) {
        const job=await claimJob(db,connection,settings);
        if (!job) break;
        if (!job.skip) await send(db,connection,settings,api,job);
      }
    }
    success=!signal.aborted;
    return success;
  } catch(error) {
    errorCode=String(statusCode(error));
    pause=error.status===401 || error.status===403 && !error.rateLimit;
    return false;
  } finally {
    await pool.query(`update assistant.calendar_sync_state set lease_owner=null,lease_until=null,last_error_code=$4,
      last_success_at=case when $5 then now() else last_success_at end,
      next_poll_at=now()+case when $4::text is null and not $5 then interval '5 seconds' else interval '2 minutes' end,
      mode=case when $6 then 'paused' else mode end
      where family_id=$1 and id=$2 and lease_owner=$3`,
    [...connectionArgs(connection),connection.lease_owner,errorCode,success,pause]);
  }
}

export async function runCalendarSync(pool,settings,signal) {
  if (!settings) return;
  const api=calendarClient(settings,signal);
  let force=true;
  while (!signal.aborted) {
    try { await syncCalendarOnce(pool,settings,api,signal,{force}); }
    catch { if (!signal.aborted) console.error('Google Calendar 동기화 DB 연결을 확인하세요.'); }
    force=false;
    await sleep(5000,undefined,{signal}).catch(()=>{});
  }
}
