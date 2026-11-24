import {randomUUID} from 'node:crypto';
import {Store} from '../storage.js';
import {calendarClient,calendarSettings} from './google.js';
import {applyInbox,calendarStore,connectionArgs,detachmentOf,googleInstanceSnapshot,importGoogleInstances,loadLocal,readInboxEvent,remoteLink,zoneOf} from './store.js';
import {digest,equivalentRecurrence,localEvent,originalStartKey,previewDateScope,remoteSeries,remoteTiming,resourceKind} from './mapping.js';
import {manageDetachment,reconnectApproval,retireInbox} from './management.js';
import {validDay} from '../time.js';
import {isCalendarTargetDetached,queueCalendarChange} from './outbox.js';
import {instanceWindow,readRemoteInstances} from './remote-instances.js';

const [command,...args]=process.argv.slice(2);
const settings=calendarSettings();
const fingerprint=(row,event)=>digest([row.run_id,event.id,event.etag??null]);

async function connection(c,lock=false) {
  const row=(await c.query(`select s.*,f.settings from assistant.calendar_sync_state s
    join assistant.families f on f.id=s.family_id where s.family_id=$1 and s.calendar_id=$2 and f.active
    ${lock?'for update of s':''}`,[settings.familyId,settings.calendarId])).rows[0];
  if (!row) throw new Error('Configure the calendar connection first');
  if (lock && row.lease_until && +new Date(row.lease_until)>Date.now()) throw new Error('Sync is running. Retry after the current cycle');
  return {...row,key:settings.key};
}

const candidatesSql=`select * from assistant.calendar_sync_inbox
  where family_id=$1 and connection_id=$2 and state='held' and result_code='initial_review'`;

function equivalent(event,projection,zone) {
  return projection && event.summary===projection.summary &&
    originalStartKey(event.start)===originalStartKey(projection.start) &&
    originalStartKey(event.end)===originalStartKey(projection.end) &&
    equivalentRecurrence(event,projection,zone);
}

function previewItem(event,kind,zone,since,exceptions,approval,candidates) {
  const dateScope=since?previewDateScope(event,since,zone,exceptions):null;
  if (dateScope==='excluded') return null;
  const timing=remoteTiming(event,zone);
  const standard=!event.locked && (!event.eventType || event.eventType==='default') && timing &&
    (kind!=='series' || remoteSeries(event,timing,'Preview'));
  return {id:event.id,kind,when:timing,importMode:standard?'import':'review_required',approval,candidates,
    ...(dateScope==='review' && {dateScope:'review_required'}),
    ...(args.includes('--private') && {title:event.summary})};
}

async function preview(db,api) {
  const sinceIndex=args.indexOf('--since');
  const since=sinceIndex<0?null:args[sinceIndex+1];
  if (sinceIndex>=0 && !validDay(since)) throw new Error('Use --since YYYY-MM-DD for the preview start date');
  const {remote,local,detached,allLocal,connectionState}=await db.tx(async c=>{
    const state=await connection(c);
    const rows=await c.query(candidatesSql+' order by google_event_id',connectionArgs(state));
    const tasks=await c.query('select id,version,data from assistant.tasks where family_id=$1 and not exists(select 1 from assistant.schedule_occurrences o where o.family_id=$1 and o.task_id=tasks.id)',[state.family_id]);
    const series=await c.query('select *,start_date::text as start_date,end_date_exclusive::text as end_date_exclusive from assistant.schedule_series where family_id=$1',[state.family_id]);
    const links=(await c.query(`select google_event_id,task_id,series_id,anchor_key,status,
      agreed_fields->'detachment' as detachment from assistant.calendar_event_links where family_id=$1 and connection_id=$2`,
      connectionArgs(state))).rows;
    const zone=zoneOf(state);
    const liveLocal=[...tasks.rows.map(x=>({kind:'task',row:x.data})),...series.rows.map(row=>({kind:'series',row}))]
      .filter(({row})=>row.status!=='cancelled');
    const allLocal=liveLocal
      .filter(({row})=>!links.some(link=>!link.anchor_key&&!link.detachment&&(link.task_id===row.id||link.series_id===row.id)))
      .map(item=>({...item,event:localEvent(item.kind,item.row,zone)})).filter(item=>item.event);
    const detached=links.filter(link=>!link.anchor_key&&link.detachment)
      .map(link=>({link:{...link,agreed_fields:{detachment:link.detachment}},
        retained:liveLocal.find(({row})=>row.id===(link.task_id??link.series_id))?.row}));
    const local=allLocal.filter(item=>!detached.some(({retained})=>retained?.id===item.row.id) &&
      (!since || previewDateScope(item.event,since,zone)!=='excluded'));
    const events=rows.rows.map(row=>({row,event:readInboxEvent(state,row)}));
    const exceptions=new Map();
    if (since) for (const {event} of events) {
      if (!event.recurringEventId) continue;
      if (!exceptions.has(event.recurringEventId)) exceptions.set(event.recurringEventId,[]);
      exceptions.get(event.recurringEventId).push(event);
    }
    const remote=events.flatMap(({row,event})=>{
      if (links.some(link=>link.google_event_id===event.id) || event.status==='cancelled' ||
          row.resource_kind.endsWith('_occurrence')) return [];
      const matches=allLocal.filter(item=>equivalent(event,item.event,zone));
      const item=previewItem(event,row.resource_kind,zone,since,exceptions.get(event.id),fingerprint(row,event),
        matches.map(x=>({id:x.row.id,version:x.row.version})));
      return item?[item]:[];
    });
    return {remote,detached,allLocal,connectionState:state,local:local.map(x=>({kind:x.kind,id:x.row.id,
      version:x.row.version,start:x.event.start,end:x.event.end,...(args.includes('--private') && {title:x.row.title})}))};
  });
  for (const {link,retained} of detached) {
    const id=link.google_event_id;
    const syncState=detachmentOf(link).state;
    let event;
    try { event=await api.get(id); }
    catch(error) {
      remote.push({id,syncState,reviewReason:Number.isInteger(error.status)?'google_http_'+error.status:'google_lookup_failed'});
      continue;
    }
    const kind=resourceKind(event);
    if (event.id!==id || !event.etag || !['single','series'].includes(kind)) {
      remote.push({id,syncState,reviewReason:'no_active_google_event'});
      continue;
    }
    const zone=zoneOf(connectionState);
    const candidates=allLocal.filter(({row,event:localEvent})=>row.id!==retained?.id && equivalent(event,localEvent,zone))
      .map(({row})=>({id:row.id,version:row.version}));
    if (retained) candidates.unshift({id:retained.id,version:retained.version,retained:true});
    const verifyOccurrences=since && kind==='series';
    const item=previewItem(event,kind,zone,verifyOccurrences?null:since,undefined,
      reconnectApproval(connectionState,link,event,retained?.version),candidates);
    if (item) remote.push({...item,syncState,...(retained&&{importMode:'link'}),
      ...(verifyOccurrences&&{dateScope:'review_required'})});
  }
  const included=[];
  for (const item of remote) {
    if (since && item.kind==='series' && item.dateScope==='review_required') {
      try {
        const result=await readRemoteInstances(api,item.id,{since,firstOnly:true});
        if (!result.occurrences.length && result.complete) continue;
        if (result.occurrences.length) {
          delete item.dateScope;
          item.firstMatchingOccurrence=result.occurrences[0].start;
        } else item.reviewReason='google_occurrence_pages_incomplete';
      } catch(error) {
        item.reviewReason=Number.isInteger(error.status)?'google_http_'+error.status:'google_occurrence_lookup_failed';
      }
    }
    included.push(item);
  }
  const matched=new Set(included.flatMap(item=>item.candidates.map(candidate=>candidate.id)));
  return {...(since && {since,timeZone:'Asia/Seoul'}),remote:included,local:local.filter(x=>!matched.has(x.id))};
}

async function approve(db,api) {
  const [eventId,approval,arg,version]=args;
  const linking=command==='link';
  if (!eventId || !approval || (linking
    ? args.length!==4 || !arg || !/^\d+$/.test(version??'')
    : args.length>3 || arg!==undefined && arg!=='--private-title')) {
    throw new Error(linking ? 'Use link EVENT_ID APPROVAL TPA_ID VERSION' : `Use ${command} EVENT_ID APPROVAL [--private-title]`);
  }
  const localId=linking?arg:undefined;
  const options={localId,version:Number(version),privateTitle:arg==='--private-title'};
  const live=await api.get(eventId);
  let instances;
  const detachedLink=linking?await db.tx(async c=>remoteLink(c,await connection(c),eventId)):null;
  if (command==='import-read-only' || detachmentOf(detachedLink)?.readOnly && detachedLink.series_id===localId) {
    if (live.id!==eventId || !live.etag || !live.recurrence?.length || live.status==='cancelled') {
      throw new Error('An active recurring Google event is required');
    }
    const window=instanceWindow();
    const result=await readRemoteInstances(api,eventId,window);
    if (!result.complete || !result.occurrences.length) throw new Error('No complete occurrence snapshot to import');
    if ((await api.get(eventId)).etag!==live.etag) throw new Error('Google series changed. Run preview again');
    instances=googleInstanceSnapshot(live,window,result.occurrences);
  }
  return db.tx(async c=>{
    const state=await connection(c,true);
    if (!['inbound','bidirectional'].includes(state.mode)) throw new Error('Inbound or bidirectional mode is required');
    if (state.run_id || !state.sync_token) throw new Error('Wait for the current Google snapshot before approval');
    const link=await remoteLink(c,state,eventId);
    if (detachmentOf(link)) {
      const kind=resourceKind(live);
      const retained=await loadLocal(c,state,link.series_id?'series':'task',link.series_id??link.task_id);
      const existing=retained?.status!=='cancelled'?retained:null;
      if (live.id!==eventId || !live.etag || !['single','series'].includes(kind) || link.anchor_key ||
          reconnectApproval(state,link,live,existing?.version)!==approval) throw new Error('Preview changed. Run preview again');
      if (existing && (!linking || localId!==existing.id)) {
        return {state:'held',code:'relink_existing_schedule'};
      }
      if (existing && ((existing.edit_mode==='read_only'&&!instances) || Boolean(link.series_id)!==(kind==='series'))) {
        return {state:'held',code:'resource_kind_changed'};
      }
      const row={resource_kind:kind};
      const reconnect={...options,reconnect:true};
      const result=instances?await importGoogleInstances(c,state,row,live,instances,reconnect):
        await applyInbox(c,state,row,live,{allowDelete:false,approval:reconnect});
      if (result.state==='applied') {
        await retireInbox(c,state,eventId);
        if (kind==='series' && !instances) await c.query(`update assistant.calendar_sync_state
          set sync_token=null,next_poll_at=null where family_id=$1 and id=$2`,connectionArgs(state));
      }
      return result;
    }
    if (detachedLink && instances && linking) throw new Error('Preview changed. Run preview again');
    const rows=(await c.query(candidatesSql+' and google_event_id=$3',[...connectionArgs(state),eventId])).rows;
    const row=rows.find(candidate=>fingerprint(candidate,readInboxEvent(state,candidate))===approval);
    if (!row || !live.etag || live.etag!==row.etag) throw new Error('Preview changed. Run preview again');
    if (!['single','series'].includes(row.resource_kind)) throw new Error('Approve the parent event first');
    const result=instances ? await importGoogleInstances(c,state,row,live,instances,options)
      : await applyInbox(c,state,row,live,{allowDelete:false,approval:options});
    if (result.state!=='applied') return result;
    const exceptions=(await c.query(candidatesSql+" and resource_kind in ('modified_occurrence','cancelled_occurrence')",
      connectionArgs(state))).rows;
    for (const exception of exceptions) {
      if (readInboxEvent(state,exception).recurringEventId!==eventId) continue;
      await c.query(`update assistant.calendar_sync_inbox set state=$5,result_code='approved_parent'
        where family_id=$1 and connection_id=$2 and run_id=$3 and google_event_id=$4`,
      [...connectionArgs(state),exception.run_id,exception.google_event_id,instances?'applied':'pending']);
    }
    await c.query(`update assistant.calendar_sync_inbox set state='applied',result_code=null
      where family_id=$1 and connection_id=$2 and run_id=$3 and google_event_id=$4`,
    [...connectionArgs(state),row.run_id,eventId]);
    return result;
  });
}

async function run(pool) {
  const db=calendarStore(pool,settings.familyId);
  if (command==='configure') {
    await pool.query(`insert into assistant.calendar_sync_state(family_id,id,calendar_id,mode)
      values($1,$2,$3,'paused') on conflict(family_id) do nothing`,[settings.familyId,randomUUID(),settings.calendarId]);
    return {mode:(await connection(pool)).mode};
  }
  if (command==='mode') return db.tx(async c=>{
    const state=await connection(c,true);
    const mode=args[0];
    if (!['paused','preview','inbound','bidirectional'].includes(mode)) throw new Error('Invalid sync mode');
    if (mode!=='paused' && mode!=='preview' && (!state.sync_token || state.run_id ||
      (await c.query(`select 1 from assistant.calendar_sync_inbox where family_id=$1 and connection_id=$2
        and state='pending' limit 1`,connectionArgs(state))).rowCount)) throw new Error('Finish the preview before changing modes');
    await c.query('update assistant.calendar_sync_state set mode=$3,next_poll_at=null where family_id=$1 and id=$2',[...connectionArgs(state),mode]);
    return {mode};
  });
  if (command==='status') {
    const state=await connection(pool);
    const [inbox,outbox,conflicts]=await Promise.all([
      pool.query(`select state,result_code,count(*)::int from assistant.calendar_sync_inbox
        where family_id=$1 and connection_id=$2 and state in ('held','pending') group by state,result_code`,connectionArgs(state)),
      pool.query(`select state,last_error_code,count(*)::int from assistant.calendar_sync_outbox
        where family_id=$1 and connection_id=$2 and state not in ('done','superseded') group by state,last_error_code`,connectionArgs(state)),
      pool.query(`select id,target_kind,target_id,reason from assistant.calendar_sync_conflicts
        where family_id=$1 and connection_id=$2 and state='open'`,connectionArgs(state))
    ]);
    return {mode:state.mode,lastSuccess:state.last_success_at,error:state.last_error_code,
      inbox:inbox.rows,outbox:outbox.rows,conflicts:conflicts.rows};
  }
  if (command==='review') {
    const state=await connection(pool);
    const rows=(await pool.query(`select * from assistant.calendar_sync_inbox where family_id=$1 and connection_id=$2
      and (state='held' or state='applied' and google_event_id=$3) and ($3::text is null or google_event_id=$3)
      limit 100`,[...connectionArgs(state),args.find(arg=>arg!=='--private')??null])).rows;
    return rows.map(row=>{
      const event=readInboxEvent(state,row);
      return {id:event.id,reason:row.result_code,approval:fingerprint(row,event),
        ...(args.includes('--private') && {title:event.summary})};
    });
  }
  const api=()=>calendarClient(settings,new AbortController().signal);
  if (command==='preview') return preview(db,api());
  if (['unlink','undo-import'].includes(command)) {
    const [id,approval,confirmation]=args;
    if (!id || args.length>3 || confirmation && (command!=='undo-import' || confirmation!=='--confirm-local-changes'))
      throw new Error('Use unlink EVENT_ID [APPROVAL] or undo-import EVENT_ID [APPROVAL [--confirm-local-changes]]');
    return db.tx(async c=>manageDetachment(c,await connection(c,Boolean(approval)),command,id,approval,
      confirmation==='--confirm-local-changes'));
  }
  if (command==='instances') {
    const id=args[0],since=args[args.indexOf('--since')+1],until=args[args.indexOf('--until')+1];
    if (!id || !args.includes('--since') || !args.includes('--until') || !validDay(since) || !validDay(until) || until<=since) {
      throw new Error('Use instances EVENT_ID --since YYYY-MM-DD --until YYYY-MM-DD');
    }
    await connection(pool);
    const result=await readRemoteInstances(api(),id,{since,until});
    return {since,until,...result};
  }
  if (['import','import-read-only','link'].includes(command)) return approve(db,api());
  if (command==='export') return db.tx(async c=>{
    const state=await connection(c,true);
    const [kind,id,version]=args;
    if (state.mode!=='bidirectional' || !['task','series'].includes(kind)) throw new Error('Bidirectional mode and resource kind are required');
    const local=await loadLocal(c,state,kind,id);
    const projection=localEvent(kind,local,zoneOf(state));
    if (!local || String(local.version)!==version || !projection || local.status==='cancelled') throw new Error('Local preview changed');
    if (await isCalendarTargetDetached(c,state.family_id,state.id,kind==='task'?id:null,kind==='series'?id:null))
      throw new Error('Use preview to reconnect the detached event');
    const remote=(await c.query(candidatesSql,connectionArgs(state))).rows;
    if (remote.some(x=>equivalent(readInboxEvent(state,x),projection,zoneOf(state)))) throw new Error('A possible duplicate must be linked first');
    await queueCalendarChange(c,state.family_id,kind,null,local,{force:true});
    return {queued:true};
  });
  throw new Error('Use configure, mode, status, preview, instances, review, import, import-read-only, link, unlink, undo-import or export');
}

let pool;
try {
  if (!settings || !process.env.DATABASE_URL) throw new Error('Calendar and database configuration is required');
  pool=await Store.openPool({databaseUrl:process.env.DATABASE_URL,caFile:process.env.DATABASE_CA_FILE});
  console.log(JSON.stringify(await run(pool),null,2));
} catch(error) {
  const message=error.constructor===Error && error.stack?.split('\n')[1]?.includes('manage.js') ? error.message : 'Calendar operation failed';
  console.error(message);
  process.exitCode=1;
} finally {
  await pool?.end();
}
