import {randomUUID} from 'node:crypto';
import {persistTaskChange} from '../storage.js';
import {cancelImportedScheduleSeries} from '../schedule-store.js';
import {digest} from './mapping.js';
import {connectionArgs,detachmentOf,loadLocal,readInboxEvent,remoteLink} from './store.js';

const actor='calendar-management';
const jobScope=`where o.family_id=$1 and o.connection_id=$2 and
  (o.google_event_id=$3 or o.payload->>'parentId'=$3 or
    (o.target_kind=$4 and o.target_id=$5) or
    (o.target_kind='occurrence' and o.payload->>'seriesId'=$6::text))`;

async function describe(c,connection,command,eventId) {
  const link=await remoteLink(c,connection,eventId);
  if (!link || link.anchor_key || link.status==='replaced' && !detachmentOf(link)) return {state:'not_linked'};
  if (detachmentOf(link)) return {state:detachmentOf(link).state};
  const kind=link.series_id?'series':'task';
  const id=link.series_id??link.task_id;
  const local=await loadLocal(c,connection,kind,id);
  const args=[...connectionArgs(connection),eventId,kind,id,link.series_id];
  const {rows:[history]}=await c.query(kind==='series'? `
    select min(id) filter(where before_data is null and anchor_key is null and origin='google')::text as imported,
      count(*) filter(where before_data is null and anchor_key is null and origin='local')::text as local_creations,
      count(*) filter(where before_data is not null or anchor_key is not null)::text as changes,
      (select count(*) from assistant.schedule_occurrences where family_id=$1 and series_id=$2)::text as occurrences
    from assistant.schedule_series_history where family_id=$1 and series_id=$2`: `
    select min(id) filter(where before_data is null and actor='google-calendar')::text as imported,
      count(*) filter(where before_data is null and actor<>'google-calendar')::text as local_creations,
      count(*) filter(where before_data is not null)::text as changes, '0' as occurrences
    from assistant.history where family_id=$1 and task_id=$2`,[connection.family_id,id]);
  const otherLinks=(await c.query(`select status
    from assistant.calendar_event_links where family_id=$1 and connection_id=$2 and google_event_id<>$3
    and anchor_key is null and (task_id=$4 or series_id=$4)`,[...connectionArgs(connection),eventId,id])).rows;
  const source=link.agreed_fields?.source??(history.imported&&!otherLinks.length?'import':history.local_creations==='1'?'link':'unknown');
  const awaitingReceipt=(await c.query(`select 1 from assistant.calendar_sync_outbox o ${jobScope}
    and o.state in ('sending','uncertain') limit 1`,args)).rowCount>0;
  const blocked=otherLinks.some(row=>row.status==='active')?'local_linked_elsewhere':awaitingReceipt?'await_receipt':null;
  const hasChanges=history.changes!=='0'||history.occurrences!=='0';
  const approval=digest([command,eventId,connection.id,link.status,link.agreed_etag,link.last_seen_etag,id,local?.version??null,
    link.agreed_fields?.managementHistory??null,link.remote_timing?.googleInstances??null,source,history.changes,history.occurrences]);
  return {state:'linked',link,local,args,kind,id,source,blocked,hasChanges,approval,occurrences:Number(history.occurrences)};
}

export async function manageDetachment(c,connection,command,eventId,approval,confirmChanges) {
  const target=await describe(c,connection,command,eventId);
  if (target.state!=='linked') return {state:target.state};
  const {link,local,args,kind,id,source,blocked,hasChanges}=target;
  const undo=command==='undo-import';
  if (!approval) return {state:'preview',id:eventId,localId:id,version:local?.version,kind,source,approval:target.approval,
    removesLocalCopy:undo&&source==='import',requiresChangeConfirmation:undo&&source==='import'&&hasChanges,
    ...(kind==='series'&&{recordedOccurrences:target.occurrences,
      cachedGoogleOccurrences:link.remote_timing?.googleInstances?.occurrences?.length??0}),
    ...(blocked?{blocked}:undo&&source==='unknown'?{blocked:'unknown_import_origin'}:{})};
  if (target.approval!==approval) return {state:'held',code:'approval_stale'};
  if (blocked) return {state:'held',code:blocked};
  if (!local) return {state:'held',code:'local_missing'};
  if (undo && source==='unknown') return {state:'held',code:'unknown_import_origin'};
  const remove=undo&&source==='import';
  if (remove && hasChanges && !confirmChanges) return {state:'held',code:'local_changes_require_confirmation'};
  if (remove && local.status!=='cancelled') {
    if (kind==='series') await cancelImportedScheduleSeries(c,connection.family_id,local,actor);
    else await persistTaskChange(c,connection.family_id,actor,{before:local,after:{
      ...local,status:'cancelled',version:local.version+1,updatedAt:new Date().toISOString(),completedAt:null,remindAt:[]
    },reason:'Google Calendar import undone'},{origin:actor});
  }

  const state=remove?'import_undone':'unlinked';
  const detachment={state,token:randomUUID(),localId:id,readOnly:local.edit_mode==='read_only',
    protectedTitle:link.visibility_policy==='protected'};
  const historyEntry={action:command,state,localId:id,version:local.version,at:new Date().toISOString()};
  await c.query(`update assistant.calendar_event_links set status='replaced',deleted_at=now(),
    agreed_fields=coalesce(agreed_fields,'{}'::jsonb) || jsonb_build_object('source',$4::text,
      'detachment',$5::jsonb,'managementHistory',coalesce(agreed_fields->'managementHistory','[]'::jsonb)||$6::jsonb)
    where family_id=$1 and connection_id=$2 and google_event_id=$3`,
  [...connectionArgs(connection),eventId,source,detachment,JSON.stringify([historyEntry])]);
  const childIds=(await c.query(`update assistant.calendar_event_links set status='replaced',deleted_at=now(),
    agreed_fields=coalesce(agreed_fields,'{}'::jsonb)||'{"detachment":{"state":"child"}}'::jsonb
    where family_id=$1 and connection_id=$2 and google_parent_id=$3 returning google_event_id`,
  [...connectionArgs(connection),eventId])).rows.map(row=>row.google_event_id);
  await c.query(`update assistant.calendar_sync_outbox o set state='superseded',last_error_code='link_detached',
    lease_owner=null,lease_until=null ${jobScope} and o.state in ('pending','held','failed')`,args);
  await c.query(`update assistant.calendar_sync_conflicts set state='resolved',resolved_by=$5,resolved_at=now()
    where family_id=$1 and connection_id=$2 and state='open' and
    ((target_kind=$3 and target_id=$4) or (target_kind='occurrence' and target_id in
      (select occurrence_id from assistant.schedule_occurrences where family_id=$1 and series_id=$6)))`,
  [...connectionArgs(connection),kind,id,actor,link.series_id]);
  await retireInbox(c,connection,eventId,childIds);
  return {state,localId:id,removedLocalCopy:remove};
}

export async function retireInbox(c,connection,eventId,childIds=[]) {
  const rows=(await c.query(`select * from assistant.calendar_sync_inbox where family_id=$1 and connection_id=$2
    and state in ('held','pending') and resource_kind in ('modified_occurrence','cancelled_occurrence')`,
  connectionArgs(connection))).rows;
  const ids=new Set([eventId,...childIds]);
  for (const row of rows) {
    if (readInboxEvent(connection,row).recurringEventId===eventId) ids.add(row.google_event_id);
  }
  await c.query(`update assistant.calendar_sync_inbox set state='ignored',result_code='link_detached'
    where family_id=$1 and connection_id=$2 and google_event_id=any($3::text[]) and state in ('held','pending')`,
  [...connectionArgs(connection),[...ids]]);
}

export function reconnectApproval(connection,link,event,localVersion) {
  return digest([connection.id,detachmentOf(link).token,event.id,event.etag,localVersion??null]);
}
