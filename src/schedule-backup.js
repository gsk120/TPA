import { hasScheduleSchema } from './schedule-store.js';

const baseTables = {
  tasks:'family_id,id,version,data',
  history:'family_id,actor,task_id,before_data,after_data,reason,at',
  jobs:'family_id,id,payload,status,attempts,lease,lease_until,error,created_at,finished_at',
  deliveries:'family_id,id,text,status,attempts,next_attempt,task_id,task_version,result,created_at',
  context:'family_id,actor,text,reply_to,at',
  runtime:'family_id,key,value',
  members:'family_id,user_id,active,event_id,checked_at',
  settings_history:'family_id,actor,before_data,after_data,at'
};

const calendarTables = {
  schedule_series:'family_id,id,version,title,kind,status,timezone,all_day,start_date,end_date_exclusive,start_at,end_at,recurrence_raw,edit_mode,created_at,updated_at,time_type,time_note',
  schedule_occurrences:'family_id,series_id,anchor_key,occurrence_id,task_id,original_timezone,original_offset,original_start_at,series_version,projection_state',
  schedule_exceptions:'family_id,series_id,anchor_key,version,status,overrides,updated_at',
  schedule_series_history:'family_id,series_id,anchor_key,actor,origin,before_data,after_data,reason,at',
  calendar_sync_state:'family_id,id,calendar_id,mode,sync_token,query_version,sync_epoch,run_id,next_page_token,lease_owner,lease_until,last_success_at,next_poll_at,last_error_code',
  calendar_event_links:'family_id,connection_id,google_event_id,task_id,series_id,anchor_key,google_parent_id,original_start_key,ical_uid,last_seen_etag,agreed_etag,agreed_local_version,agreed_fields,remote_timing,visibility_policy,protected_payload,status,previous_google_event_id,deleted_at',
  calendar_sync_inbox:'family_id,connection_id,run_id,google_event_id,resource_kind,etag,payload,state,result_code',
  calendar_sync_outbox:'family_id,connection_id,target_kind,target_id,source_version,operation,google_event_id,expected_etag,payload,state,attempts,next_attempt_at,lease_owner,lease_until,last_error_code',
  calendar_sync_conflicts:'family_id,connection_id,id,target_kind,target_id,base_data,local_data,remote_data,local_version,remote_etag,reason,state,resolved_by,resolved_at'
};
const identities = new Set(['history','context','settings_history','schedule_series_history']);

export async function addScheduleBackup(c, familyId, result) {
  if (!await hasScheduleSchema(c)) return;
  result.calendar = {version:1};
  for (const table of Object.keys(calendarTables)) {
    const {rows} = await c.query('select * from assistant.' + table + ' where family_id=$1', [familyId]);
    if (table === 'calendar_event_links') {
      result.calendar[table] = rows.map(row => ({...row, protected_payload:row.protected_payload == null
        ? null : '\\x' + Buffer.from(row.protected_payload).toString('hex')}));
    } else result.calendar[table] = rows;
  }
}

function pauseForRestore(table, row) {
  if (table === 'jobs' && ['pending','running'].includes(row.status)) {
    return {...row,status:'failed',lease:null,lease_until:null,error:'복원된 미확정 작업'};
  }
  if (table === 'deliveries' && ['pending','sending'].includes(row.status)) {
    return {...row,status:'uncertain'};
  }
  if (table === 'calendar_sync_state') {
    return {...row,mode:'paused',sync_token:null,run_id:null,next_page_token:null,lease_owner:null,lease_until:null};
  }
  if (table === 'calendar_sync_outbox') {
    return {...row,state:row.state === 'sending' ? 'uncertain' : row.state,lease_owner:null,lease_until:null};
  }
  return row;
}

// Restore into an empty, inactive family. This is separate from the legacy
// initial-task import, which validates and inserts new tasks with new UUIDs.
export async function restoreFamilyBackup(c, familyId, snapshot) {
  const family = snapshot?.families?.[0];
  if (snapshot?.familyId !== familyId || snapshot.families?.length !== 1 || family?.id !== familyId
      || !Array.isArray(snapshot.tasks) || !Array.isArray(snapshot.history)
      || (snapshot.calendar && snapshot.calendar.version !== 1)) {
    throw new Error('백업 형식 또는 가족을 확인하세요.');
  }
  const calendarInstalled = await hasScheduleSchema(c);
  if (snapshot.calendar && !calendarInstalled) throw new Error('반복 일정 스키마를 먼저 준비하세요.');
  const tables = {...baseTables,...(calendarInstalled ? calendarTables : {})};
  await c.query(
    "insert into assistant.families(id,chat_id,user_ids,created_at,settings,settings_version,active,setup_actor,bot_event) values($1,$2,$3,$4,$5,$6,false,$7,$8) on conflict(id) do nothing",
    [familyId,family.chat_id,family.user_ids,family.created_at,family.settings ?? {},family.settings_version ?? 1,family.setup_actor ?? null,family.bot_event ?? -1]
  );
  const target = (await c.query('select chat_id,active from assistant.families where id=$1 for update',[familyId])).rows[0];
  if (target?.active || target?.chat_id !== family.chat_id) throw new Error('비활성 복원 대상 가족을 확인하세요.');
  for (const table of Object.keys(tables)) {
    const found = await c.query('select 1 from assistant.' + table + ' where family_id=$1 limit 1',[familyId]);
    if (found.rows.length) throw new Error('복원 대상 가족에 기존 데이터가 있습니다.');
  }
  await c.query('update assistant.families set user_ids=$2,settings=$3,settings_version=$4,setup_actor=$5,bot_event=$6 where id=$1',
    [familyId,family.user_ids,family.settings ?? {},family.settings_version ?? 1,family.setup_actor ?? null,family.bot_event ?? -1]);
  for (const [table,columns] of Object.entries(tables)) {
    const rows = Object.hasOwn(baseTables,table) ? snapshot[table] ?? [] : snapshot.calendar?.[table] ?? [];
    if (!Array.isArray(rows) || rows.some(row => row?.family_id !== familyId)) throw new Error('백업의 가족 범위가 일치하지 않습니다.');
    if (!rows.length) continue;
    // Identity values are database-wide and are not referenced by task or
    // occurrence IDs. Let PostgreSQL allocate them in original order.
    const order = identities.has(table) ? ' order by id' : '';
    await c.query('insert into assistant.' + table + '(' + columns + ') select ' + columns
      + ' from jsonb_populate_recordset(null::assistant.' + table + ',$1::jsonb)' + order,
    [JSON.stringify(rows.map(row => pauseForRestore(table,row)))]);
  }
}
