import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { calendarDay, expandSeries, isDateAnchored, occurrenceDay, occurrenceId, occurrenceWindow, validateSeries, wallInstants, wallTime, withinOccurrenceWindow } from './recurrence.js';
import { validDay } from './time.js';

const seriesFields = 'id,version,title,kind,status,timezone,all_day,start_date::text,end_date_exclusive::text,start_at,end_at,recurrence_raw,edit_mode,created_at,time_type,time_note';
const selectSeries = 'select ' + seriesFields + ' from assistant.schedule_series where family_id=$1';
const selectOccurrences = 'select o.*,e.status as exception_status,e.overrides from assistant.schedule_occurrences o left join assistant.schedule_exceptions e using(family_id,series_id,anchor_key) where o.family_id=$1';
const changed = () => new Error('다른 작업에서 반복 일정이 변경됐습니다. 다시 요청해주세요.');
const dayOf = anchor => anchor.slice(0,10);
const dateString = value => new Date(value).toISOString();

export async function hasScheduleSchema(client) {
  return Boolean((await client.query("select to_regclass('assistant.schedule_series') as name")).rows[0].name);
}

function normalizeSeries(row) {
  return {...row, start_at:row.start_at == null ? null : dateString(row.start_at), end_at:row.end_at == null ? null : dateString(row.end_at)};
}

// The caller holds the request-key row lock until its result is replaced.
export async function lockRegistrationSeries(c, familyId, saved) {
  let id = saved?.seriesId;
  if (id !== undefined) {
    if (typeof id !== 'string' || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/iu.test(id)) return null;
  } else {
    // Legacy keys only have virtual occurrence UUIDs, often without saved rows.
    // Match every reference cryptographically; a title or an empty list is not proof.
    const refs = saved?.refs;
    if (!Array.isArray(refs) || !refs.length || refs.some(ref => !occurrenceDay(ref?.id))) return null;
    const matchesRefs = series => {
      try {
        return refs.every(ref => {
          const day = occurrenceDay(ref.id);
          // Temporarily expand cancelled rules for identity verification only.
          return [...expandSeries({...series,status:'active'},day,day)]
            .some(item => occurrenceId(familyId,series.id,item.anchor) === ref.id);
        });
      } catch { return false; }
    };
    const candidates = (await c.query(selectSeries + " and edit_mode='supported'",[familyId])).rows
      .map(normalizeSeries).filter(matchesRefs);
    if (candidates.length !== 1) return null;
    id = candidates[0].id;
    const row = (await c.query(selectSeries + ' and id=$2 for update',[familyId,id])).rows[0];
    if (!row) return null;
    const locked = normalizeSeries(row);
    return locked.edit_mode === 'supported' && matchesRefs(locked) ? locked : null;
  }
  const row = (await c.query(selectSeries + ' and id=$2 for update',[familyId,id])).rows[0];
  return row?.edit_mode === 'supported' ? normalizeSeries(row) : null;
}

export async function readActiveScheduleSeries(c, familyId) {
  const {rows} = await c.query(selectSeries + " and status='active' and edit_mode='supported' order by id", [familyId]);
  return rows.map(row => ({
    id:row.id, version:row.version, title:row.title,
    start:row.start_date ?? wallTime(Date.parse(row.start_at),row.timezone).slice(0,19)
  }));
}

function originalOccurrence(series, anchor) {
  return [...expandSeries(series, dayOf(anchor), dayOf(anchor))].find(item => item.anchor === anchor);
}

function datesForDisplay(timing, timeZone, timeType) {
  if (validDay(timing.start)) {
    const last = calendarDay(timing.end, -1);
    return {dueDate:timing.start, time:null, endDate:last === timing.start ? null : last};
  }
  const start = wallTime(Date.parse(timing.start), timeZone);
  if (timeType === 'range' && timing.end != null) {
    const end = wallTime(Date.parse(timing.end), timeZone);
    return {dueDate:start.slice(0,10),time:start.slice(11,16),endTime:end.slice(11,16),
      endDate:end.slice(0,10) === start.slice(0,10) ? null : end.slice(0,10)};
  }
  const last = timing.end == null ? start.slice(0,10) : wallTime(Date.parse(timing.end) - 1, timeZone).slice(0,10);
  return {dueDate:start.slice(0,10), time:start.slice(11,16), endDate:last === start.slice(0,10) ? null : last};
}

function taskProjection(familyId, series, original, row, task, timeZone) {
  const timing = row?.overrides?.timing ?? original;
  const title = row?.overrides?.title ?? task?.title ?? series.title;
  const timeType = task?.timeType ?? series.time_type;
  const dates = datesForDisplay(timing,timeZone,timeType);
  const id = row?.task_id ?? occurrenceId(familyId, series.id, original.anchor);
  const stamp = dateString(series.created_at);
  const base = task ?? {id, version:series.version, kind:series.kind, status:'open', title, timeNote:series.time_note ?? null,
    notes:'', person:null, assignee:null, followUpDate:null, actualDeadline:null, remindAt:[],
    completedAt:null, createdAt:stamp, updatedAt:stamp};
  return {...base, ...dates, title, ...(timeType ? {timeType} : {}), recurrence:{
    seriesId:series.id, seriesVersion:series.version, anchor:original.anchor,
    occurrenceId:row?.occurrence_id ?? id, virtual:!task,
    allDay:timeType ? timeType === 'all_day' : series.all_day, timing, timeZone
  }};
}

export async function readCalendarTasks(c, familyId, tasks, {now, timeZone, from, to, includeIds = [], listOnly = false}) {
  const seriesList = (await c.query(selectSeries + ' order by id', [familyId])).rows.map(normalizeSeries);
  if (!seriesList.length) return tasks;
  const rows = (await c.query(selectOccurrences, [familyId])).rows;
  const linked = new Map(rows.filter(row => row.task_id).map(row => [row.task_id, row]));
  const known = new Map(rows.map(row => [row.series_id + ':' + row.anchor_key, row]));
  const seriesById = new Map(seriesList.map(series => [series.id, series]));
  const currentDay = wallTime(+now, timeZone).slice(0,10);
  const window = occurrenceWindow(currentDay,from,to);
  const {first,last} = window;
  const exactIds = new Set(includeIds);
  const exactDays = [...new Set(includeIds.map(occurrenceDay).filter(Boolean))];
  // Lists are bounded. Existing linked rows still serve exact edits and scheduled reminders.
  const projections = tasks.flatMap(task => {
    const row = linked.get(task.id);
    if (!row) return [task];
    const series = seriesById.get(row.series_id);
    const original = originalOccurrence(series, row.anchor_key);
    if (!original || row.projection_state === 'excluded' || series.status === 'cancelled') {
      return ['done','cancelled'].includes(task.status) && (!listOnly || withinOccurrenceWindow(task,window)) ? [task] : [];
    }
    const projection = taskProjection(familyId, series, original, row, task, timeZone);
    return !listOnly || withinOccurrenceWindow(projection,window) ? [projection] : [];
  });
  for (const series of seriesList) {
    if (series.status !== 'active' || series.edit_mode !== 'supported') continue;
    const length = isDateAnchored(series)
      ? Math.ceil((Date.parse(series.end_date_exclusive) - Date.parse(series.start_date)) / 86400000)
      : series.end_at == null ? 1 : Math.ceil((Date.parse(series.end_at) - Date.parse(series.start_at)) / 86400000) + 1;
    // Cross-time-zone displays and multi-day spans can overlap the requested
    // dates even when the anchor falls outside the family's date range.
    const anchors = new Map();
    for (const candidate of expandSeries(series,calendarDay(first,-length-1),calendarDay(last,2))) anchors.set(candidate.anchor,candidate);
    for (const day of exactDays) {
      for (const candidate of expandSeries(series,day,day)) anchors.set(candidate.anchor,candidate);
    }
    for (const row of rows) {
      if (row.series_id !== series.id || row.task_id || !row.overrides?.timing) continue;
      const original = originalOccurrence(series,row.anchor_key);
      if (original) anchors.set(original.anchor,original);
    }
    for (const original of anchors.values()) {
      const row = known.get(series.id + ':' + original.anchor);
      if (row?.task_id || row?.projection_state === 'excluded' || row?.exception_status === 'cancelled') continue;
      const task = taskProjection(familyId,series,original,row,null,timeZone);
      if (exactIds.has(task.id) || withinOccurrenceWindow(task,window)) projections.push(task);
    }
  }
  return projections;
}

function writeSeriesHistory(c, familyId, seriesId, anchor, actor, before, after, reason) {
  return c.query(
    "insert into assistant.schedule_series_history(family_id,series_id,anchor_key,actor,origin,before_data,after_data,reason) values($1,$2,$3,$4,'local',$5,$6,$7)",
    [familyId,seriesId,anchor,String(actor),before,after,reason]
  );
}

export async function createScheduleSeries(c, familyId, input, actor) {
  validateSeries(input);
  const id = randomUUID();
  const dateAnchored = isDateAnchored(input);
  const row = (await c.query(
    'insert into assistant.schedule_series(family_id,id,title,kind,timezone,all_day,start_date,end_date_exclusive,start_at,end_at,recurrence_raw,time_type,time_note) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning ' + seriesFields,
    [familyId,id,input.title.trim(),input.kind,input.timezone,input.all_day,
      dateAnchored ? input.start_date : null,dateAnchored ? input.end_date_exclusive : null,
      dateAnchored ? null : input.start_at,dateAnchored ? null : input.end_at,input.recurrence_raw,
      input.time_type ?? null,input.time_note ?? null]
  )).rows[0];
  await writeSeriesHistory(c,familyId,id,null,actor,null,normalizeSeries(row),'반복 일정 등록');
  return normalizeSeries(row);
}

export async function updateScheduleSeries(c, familyId, id, expectedVersion, patch, actor) {
  const row = (await c.query(selectSeries + ' and id=$2 for update',[familyId,id])).rows[0];
  if (!row || row.version !== expectedVersion || row.edit_mode !== 'supported') throw changed();
  const allowed = ['title','status','timezone','all_day','start_date','end_date_exclusive','start_at','end_at','recurrence_raw','time_type','time_note'];
  if (Object.keys(patch).some(key => !allowed.includes(key))) throw new Error('반복 일정 변경 필드를 확인하세요.');
  const old = normalizeSeries(row);
  const next = {...old,...patch,version:old.version+1};
  validateSeries(next);
  if (!['active','cancelled'].includes(next.status)) throw new Error('반복 일정 상태를 확인하세요.');
  const dateAnchored = isDateAnchored(next);
  const result = await c.query(
    'update assistant.schedule_series set version=$3,title=$4,status=$5,timezone=$6,all_day=$7,start_date=$8,end_date_exclusive=$9,start_at=$10,end_at=$11,recurrence_raw=$12,time_type=$13,time_note=$14,updated_at=now() where family_id=$1 and id=$2 returning ' + seriesFields,
    [familyId,id,next.version,next.title.trim(),next.status,next.timezone,next.all_day,
      dateAnchored ? next.start_date : null,dateAnchored ? next.end_date_exclusive : null,
      dateAnchored ? null : next.start_at,dateAnchored ? null : next.end_at,next.recurrence_raw,next.time_type,next.time_note]
  );
  const series = normalizeSeries(result.rows[0]);
  const rows = (await c.query(selectOccurrences + ' and o.series_id=$2 order by o.anchor_key for update of o',[familyId,id])).rows;
  const timeZone = (await c.query('select settings from assistant.families where id=$1',[familyId])).rows[0]?.settings?.timeZone ?? 'Asia/Seoul';
  const reason = '반복 일정 규칙 변경';
  for (const occurrence of rows) {
    const anchor = occurrence.anchor_key;
    const original = originalOccurrence(series,anchor);
    if ((!original || old.timezone !== series.timezone) && series.status === 'active' &&
        (occurrence.exception_status === 'cancelled' || Object.keys(occurrence.overrides ?? {}).length)) {
      throw new Error('반복 규칙 변경 전에 기존 회차 예외의 처리 범위를 확인하세요.');
    }
    const projection = original ? 'active' : 'excluded';
    await c.query('update assistant.schedule_occurrences set series_version=$4,projection_state=$5 where family_id=$1 and series_id=$2 and anchor_key=$3',
      [familyId,id,anchor,series.version,projection]);
    if (!occurrence.task_id) continue;
    const task = (await c.query('select data from assistant.tasks where family_id=$1 and id=$2 for update',
      [familyId,occurrence.task_id])).rows[0].data;
    const timeType = (task.timeType ?? null) === old.time_type ? series.time_type : task.timeType;
    const timeNote = (task.timeNote ?? null) === old.time_note ? series.time_note : task.timeNote;
    const fields = original ? datesForDisplay(occurrence.overrides?.timing ?? original,timeZone,timeType) : {};
    const after = {...task,...fields,title:original ? (occurrence.overrides?.title ?? series.title) : task.title,
      version:task.version+1,updatedAt:new Date().toISOString()};
    if (original) {
      after.timeNote = timeNote ?? null;
      if (timeType) after.timeType = timeType;
      else delete after.timeType;
      if (!fields.endTime) delete after.endTime;
    }
    if (original && !sameDates(task,after)) after.remindAt = [];
    await c.query('update assistant.tasks set version=$3,data=$4 where family_id=$1 and id=$2',
      [familyId,task.id,after.version,after]);
    await c.query("update assistant.deliveries set status='cancelled' where family_id=$1 and task_id=$2 and status='pending'",[familyId,task.id]);
    await c.query('insert into assistant.history(family_id,actor,task_id,before_data,after_data,reason) values($1,$2,$3,$4,$5,$6)',
      [familyId,String(actor),task.id,task,after,reason]);
  }
  await writeSeriesHistory(c,familyId,id,null,actor,old,series,reason);
  return series;
}

function sameDates(before, after) {
  return ['dueDate','time','endDate','endTime'].every(field => (before[field] ?? null) === (after[field] ?? null));
}

function movedTiming(series, currentTiming, after, zone) {
  if (!validDay(after.dueDate) || !after.timeType && isDateAnchored(series) !== (after.time === null)) {
    throw new Error('반복 회차의 종일 여부와 날짜를 확인하세요.');
  }
  if (after.time === null) return {start:after.dueDate,end:calendarDay(after.endDate ?? after.dueDate,1)};
  const dateAnchored = validDay(currentTiming.start);
  const seconds = dateAnchored ? ':00' : wallTime(Date.parse(currentTiming.start),zone).slice(16);
  const local = after.dueDate + 'T' + after.time + seconds;
  const candidates = wallInstants(local,zone);
  if (!candidates.length) throw new Error('시간대 변경으로 존재하지 않는 시각입니다.');
  // During a repeated clock hour retain the old instant when the start is unchanged.
  const start = candidates.includes(Date.parse(currentTiming.start)) ? Date.parse(currentTiming.start) : candidates[0];
  if (after.timeType === 'range') {
    const endLocal = (after.endDate ?? after.dueDate) + 'T' + after.endTime + ':00';
    const endCandidates = wallInstants(endLocal,zone).filter(instant => instant > start);
    const previousEnd = Date.parse(currentTiming.end);
    const end = endCandidates.includes(previousEnd) ? previousEnd : endCandidates[0];
    if (end === undefined) throw new Error('반복 회차의 종료 시각을 확인하세요.');
    return {start:dateString(start),end:dateString(end)};
  }
  if (dateAnchored || currentTiming.end == null || after.timeType === 'timed' && series.time_type === 'range') {
    if (after.endDate && after.endDate !== after.dueDate) throw new Error('반복 회차의 종료 시각을 확인하세요.');
    return {start:dateString(start),end:null};
  }
  const oldEnd = wallTime(Date.parse(currentTiming.end),zone);
  const durationEnd = start + Date.parse(currentTiming.end) - Date.parse(currentTiming.start);
  const projectedLast = wallTime(durationEnd - 1,zone).slice(0,10);
  if (!after.endDate || after.endDate === projectedLast) return {start:dateString(start),end:dateString(durationEnd)};
  const endDay = oldEnd.endsWith('T00:00:00') ? calendarDay(after.endDate,1) : after.endDate;
  const end = wallInstants(endDay + oldEnd.slice(10),zone).find(instant => instant > start);
  if (end === undefined) throw new Error('반복 회차의 종료 시각을 확인하세요.');
  return {start:dateString(start),end:dateString(end)};
}

async function lockOccurrence(c, familyId, seriesId, anchor) {
  const row = (await c.query(selectSeries + ' and id=$2 for update', [familyId,seriesId])).rows[0];
  if (!row) throw changed();
  const series = normalizeSeries(row);
  if (series.status !== 'active' || series.edit_mode !== 'supported') throw changed();
  const original = originalOccurrence(series,anchor);
  if (!original) throw changed();
  const saved = (await c.query(selectOccurrences + ' and o.series_id=$2 and o.anchor_key=$3 for update of o',
    [familyId,seriesId,anchor])).rows[0];
  if (saved?.projection_state === 'excluded') throw changed();
  return {series,original,saved};
}

async function saveOccurrence(c, familyId, series, original, taskId) {
  const id = occurrenceId(familyId,series.id,original.anchor);
  await c.query(
    'insert into assistant.schedule_occurrences(family_id,series_id,anchor_key,occurrence_id,task_id,original_timezone,original_offset,original_start_at,series_version) values($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict(family_id,series_id,anchor_key) do update set task_id=excluded.task_id,series_version=excluded.series_version',
    [familyId,series.id,original.anchor,id,taskId,series.timezone,original.offset,original.offset === null ? null : original.start,series.version]
  );
}

async function saveException(c, familyId, seriesId, anchor, actor, saved, status, overrides, reason) {
  const before = saved?.exception_status ? {status:saved.exception_status,overrides:saved.overrides} : null;
  const after = {status,overrides};
  if (isDeepStrictEqual(before,after) || !before && status === 'modified' && !Object.keys(overrides).length) return;
  await c.query(
    'insert into assistant.schedule_exceptions(family_id,series_id,anchor_key,version,status,overrides) values($1,$2,$3,1,$4,$5) on conflict(family_id,series_id,anchor_key) do update set version=assistant.schedule_exceptions.version+1,status=excluded.status,overrides=excluded.overrides,updated_at=now()',
    [familyId,seriesId,anchor,status,overrides]
  );
  await writeSeriesHistory(c,familyId,seriesId,anchor,actor,before,after,reason);
}

export async function applyOccurrenceChange(c, familyId, actor, change) {
  const {before,after,reason} = change;
  const token = before.recurrence;
  const {series,original,saved} = await lockOccurrence(c,familyId,token.seriesId,token.anchor);
  const taskId = saved?.task_id ?? occurrenceId(familyId,series.id,original.anchor);
  if (taskId !== before.id || after.id !== taskId || series.version !== token.seriesVersion
    || token.virtual === Boolean(saved?.task_id) || after.version !== before.version + 1) throw changed();

  const {recurrence:beforeToken,...oldTask} = before;
  const {recurrence:afterToken,...newTask} = after;
  const overrides = {...saved?.overrides};
  const currentTiming = overrides.timing ?? original;
  if (!sameDates(before,after) || change.restoreTiming) {
    const originalDates = datesForDisplay(original,token.timeZone,series.time_type);
    const target = change.restoreTiming ?? (sameDates(originalDates,after)
      ? original : movedTiming(series,currentTiming,after,token.timeZone));
    if (target.start === original.start && target.end === original.end) delete overrides.timing;
    else overrides.timing = target;
    Object.assign(newTask,datesForDisplay(target,token.timeZone,newTask.timeType ?? series.time_type));
  }
  if (oldTask.title !== newTask.title) overrides.title = newTask.title;
  if (overrides.title === series.title) delete overrides.title;
  if (saved?.task_id) {
    const updated = await c.query(
      'update assistant.tasks set version=$4,data=$5 where family_id=$1 and id=$2 and version=$3',
      [familyId,taskId,oldTask.version,newTask.version,newTask]
    );
    if (!updated.rowCount) throw changed();
    await c.query("update assistant.deliveries set status='cancelled' where family_id=$1 and task_id=$2 and status='pending'",[familyId,taskId]);
  } else {
    await c.query('insert into assistant.tasks(family_id,id,version,data) values($1,$2,$3,$4)',[familyId,taskId,newTask.version,newTask]);
  }
  await saveOccurrence(c,familyId,series,original,taskId);
  await saveException(c,familyId,series.id,original.anchor,actor,saved,newTask.status === 'cancelled' ? 'cancelled' : 'modified',overrides,reason);
  await c.query('insert into assistant.history(family_id,actor,task_id,before_data,after_data,reason) values($1,$2,$3,$4,$5,$6)',
    [familyId,String(actor),taskId,oldTask,newTask,reason]);
}

// Called by an approved local administrative action after matching the original slot.
export async function linkScheduleOccurrence(c, familyId, input) {
  const {seriesId, anchor, taskId, expectedVersion, expectedSeriesVersion, actor, timeZone} = input;
  const {series,original,saved} = await lockOccurrence(c,familyId,seriesId,anchor);
  const task = (await c.query('select data,version from assistant.tasks where family_id=$1 and id=$2 for update',[familyId,taskId])).rows[0];
  if (!task || task.version !== expectedVersion || series.version !== expectedSeriesVersion) throw changed();
  if (saved?.task_id === taskId) return taskId;
  if (saved?.task_id) throw changed();
  const {rows:[{independent}]} = await c.query(`
    select exists(select 1 from assistant.history
      where family_id=$1 and task_id=$2 and before_data is null and reason='매주 반복 일정 일괄 등록')
      or exists(select 1 from assistant.calendar_event_links
      where family_id=$1 and task_id=$2) as independent`,[familyId,taskId]);
  if (independent) throw new Error('기존 독립 일정은 시리즈에 연결할 수 없어요.');
  const overrides = {...saved?.overrides};
  const timing = overrides.timing ?? original;
  const base = datesForDisplay(timing,timeZone,series.time_type);
  if (!sameDates(base,task.data)) overrides.timing = movedTiming(series,timing,task.data,timeZone);
  if (task.data.title !== series.title) overrides.title = task.data.title;
  await saveOccurrence(c,familyId,series,original,taskId);
  await writeSeriesHistory(c,familyId,series.id,anchor,actor,null,{taskId},'기존 일정 회차 연결');
  await saveException(c,familyId,series.id,anchor,actor,saved,task.data.status === 'cancelled' ? 'cancelled' : 'modified',overrides,'기존 회차 예외 보존');
  return taskId;
}
