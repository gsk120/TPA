import {createHash, randomUUID} from 'node:crypto';
import {nextConversation, quickCommand} from './context.js';
import {planTaskCreation} from './tasks.js';
import {kst, validDay} from './time.js';

const weekdays = '일월화수목금토';
const dayPattern = /(?<!\d)(?:\d{4}-\d{2}-\d{2}|(?:\d{4}\s*년\s*)?\d{1,2}\s*월\s*\d{1,2}\s*일|\d{1,2}\/\d{1,2}|(?:이번|다음)\s*(?:주|달)(?:\s*말)?|오늘|내일|모레)/gu;
const weekdayPattern = /([일월화수목금토])\s*요일/gu;
const weekdaySlot = /([일월화수목금토])\s*요일(?:에(?=\s|$))?|주말|평일|(?<!\S)[일월화수목금토](?=\s*(?:이나|나|또는|혹은|[,·/]))|(?<=[,·/])\s*[일월화수목금토](?=\s|$)/gu;
const clockPattern = /(?<!\d)(?:(오전|오후)\s*)?(\d{1,2})(?::(\d{1,3})|\s*시(?:\s*(반|\d{1,2}\s*분))?)(?!\d)/gu;
const clockSlot = new RegExp(clockPattern.source + '(?:\\s*(쯤|경|이후|이전|\\d+\\s*초|\\d+(?=\\s*$)))?(?:에(?=\\s|$))?', 'gu');
const addEnding = /\s*(?:일정\s*)?(?:추가|등록)(?:\s*(?:해\s*(?:줘(?:요)?|주세요)|부탁해(?:요)?|할래))?[.!]*$/u;
const recurrence = /(?<!\S)매\s*주(?:마다)?(?=\s|$)/gu;
const edgeConnector = /^(?:이나|나|또는|혹은|과|와|및|그리고|[,·/~～])\s+|\s+(?:이나|나|또는|혹은|과|와|및|그리고|[,·/~～])$/gu;
const alternatives = /(?:^|\s)(?:또는|혹은)(?:\s|$)|(?:이나|거나)\s|[?？]/u;
const labels = {start:'시작일', end:'종료일', weekday:'요일', title:'제목', time:'시각'};
const required = ['end', 'weekday', 'title', 'time'];
const dayMs = 86400000;
const pad = n => String(n).padStart(2, '0');
const utcDay = date => new Date(date).toISOString().slice(0, 10);
const midnight = day => Date.parse(day + 'T00:00:00Z');

function readDay(value, today) {
  const offset = ['오늘', '내일', '모레'].indexOf(value);
  if (offset !== -1) return utcDay(midnight(today) + offset * dayMs);
  const korean = /^(\d{4})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일$/u.exec(value);
  const day = korean ? [korean[1], pad(+korean[2]), pad(+korean[3])].join('-') : value;
  return validDay(day) ? day : null;
}

function readClock(match) {
  const [, period, rawHour, colonMinute, koreanMinute] = match;
  const hour = Number(rawHour);
  const minute = colonMinute ? Number(colonMinute) : koreanMinute === '반' ? 30 : parseInt(koreanMinute, 10) || 0;
  if ((colonMinute && colonMinute.length !== 2) || minute > 59 || hour > 23 || (period && (hour < 1 || hour > 12))) return null;
  if (!period && !colonMinute && hour >= 1 && hour <= 11 && !rawHour.startsWith('0')) return null;
  const hour24 = period ? hour % 12 + (period === '오후' ? 12 : 0) : hour;
  return pad(hour24) + ':' + pad(minute);
}

function readTitle(value) {
  const title = value.trim().replace(/^["“](.+)["”]$/u, '$1');
  return title.length <= 300 && /[\p{L}\p{N}]/u.test(title) && !/^(?:일정|제목|제목\s*미정|미정)$/u.test(title)
    ? title : null;
}

function parseRequest(text, today) {
  const fields = {};
  const dates = {start:[], end:[]};
  const body = text.replace(addEnding, '').replace(recurrence, ' ');
  const leftovers = body
    .replace(new RegExp('(' + dayPattern.source + ')\\s*(부터|까지)', 'gu'), (_, day, suffix) => {
      dates[suffix === '부터' ? 'start' : 'end'].push(readDay(day, today));
      return ' ';
    });
  if (dates.start.length || /부터/u.test(leftovers)) fields.start = dates.start.length === 1 ? dates.start[0] : null;
  fields.end = dates.end.length === 1 ? dates.end[0] : null;

  const days = [...leftovers.matchAll(weekdaySlot)];
  const clocks = [...leftovers.matchAll(clockSlot)];
  fields.weekday = days.length === 1 && days[0][1] ? weekdays.indexOf(days[0][1]) : null;
  fields.time = clocks.length === 1 && !clocks[0][5] ? readClock(clocks[0]) : null;

  const vagueTime = /(?:오전|오후|저녁|아침)(?:\s|$)|쯤|(?:이후|이전)(?:\s|$)|(?<!\d)\d+\s*(?:분|초)/u
    .test(leftovers.replace(clockSlot, ' '));
  let title = leftovers.replace(weekdaySlot, ' ').replace(clockSlot, ' ').trim();
  if (days.length > 1 || clocks.length > 1 || dates.start.length > 1 || dates.end.length > 1) {
    title = title.replace(edgeConnector, '').trim();
  }
  title = title.replace(/^에\s+|\s+(?:을|를)$/gu, '').trim();
  const strayDate = [...title.matchAll(dayPattern)].length || /(?:부터|까지|종료일|시작일)/u.test(title);
  if (strayDate) {
    if (dates.start.length && !dates.end.length && !/까지/u.test(title)) fields.start = null;
    else fields.end = null;
  }
  if (vagueTime) fields.time = null;
  if (/[·,/~～]\s*[월화수목금토]\s*$/u.test(title)) fields.weekday = null;
  fields.title = strayDate || vagueTime || alternatives.test(title) || /^(?:에|부터|까지|이나|나)$/u.test(title)
    ? null : readTitle(title);
  return fields;
}

function missingFields(fields) {
  return [...(fields.start === null ? ['start'] : []), ...required.filter(key => fields[key] == null)];
}

function parseField(key, value, today) {
  if (key === 'title') return readTitle(value);
  if (key === 'start' || key === 'end') return readDay(value.replace(/\s*(?:부터|까지)$/u, ''), today);
  const matches = [...value.matchAll(key === 'weekday' ? weekdayPattern : clockPattern)];
  if (matches.length !== 1 || matches[0][0] !== value) return null;
  return key === 'weekday' ? weekdays.indexOf(matches[0][1]) : readClock(matches[0]);
}

function clarificationFields(text, fields, today, isReply) {
  const entries = [...text.matchAll(/(?:^|[\s,;])\s*(시작일|종료일|요일|제목|시각|시간)\s*[:：]\s*/gu)];
  if (!entries.length) {
    const [key, ...others] = missingFields(fields);
    if (!key || others.length) return isReply ? fields : null;
    if (key === 'title' && (!isReply || /^(?:그거|네|응|맞아요)$|(?:해줘|해주세요|알려줘|보여줘|했어)[.!]*$/u.test(text))) {
      return isReply ? fields : null;
    }
    const value = parseField(key, key === 'title' ? text : text.replace(/(?:이요|요)$/u, '').trim(), today);
    return value == null && !isReply ? null : {...fields, [key]:value};
  }
  const keys = {...Object.fromEntries(Object.entries(labels).map(([key, label]) => [label, key])), 시간:'time'};
  const updated = {...fields};
  const seen = new Set();
  for (const [index, entry] of entries.entries()) {
    const key = keys[entry[1]];
    const value = text.slice(entry.index + entry[0].length, entries[index + 1]?.index).replace(/[,;\s]+$/u, '').trim();
    updated[key] = seen.has(key) ? null : parseField(key, value, today);
    seen.add(key);
  }
  return updated;
}

async function weeklyReplyState(job, store, state, now) {
  if (!state?.pending || state.request?.operation !== 'weekly' || state.actor !== String(job.payload.actor)
      || Date.parse(state.expiresAt) <= +now) return null;
  if (!job.payload.replyTo) return state;
  let message;
  try { message = JSON.parse(job.payload.replyTo); } catch { return null; }
  const ref = await store.replyReference?.(message.id);
  return ref?.pending && ref.requestId === state.requestId && ref.ownerActor === String(job.payload.actor)
    && ref.chatId === String(job.payload.chatId) && Date.parse(ref.expiresAt) > +now ? state : null;
}

function datesFor(fields, local, now) {
  const today = local.slice(0, 10);
  const todayMs = midnight(today);
  const start = fields.start && fields.start > today ? midnight(fields.start) : todayMs;
  const end = midnight(fields.end);
  const daysUntil = (fields.weekday - new Date(start).getUTCDay() + 7) % 7;
  let first = start + daysUntil * dayMs;
  const localClock = local.slice(11);
  const requestedClock = fields.time + ':00';
  if (first === todayMs && (localClock > requestedClock || (localClock === requestedClock && now.getUTCMilliseconds()))) {
    first += 7 * dayMs;
  }
  const dates = [];
  for (let date = first; date <= end; date += 7 * dayMs) dates.push(utcDay(date));
  return dates;
}

export async function processWeekly(job, store, now, options, actorState) {
  const text = job.payload.text.trim().replace(/^!\s*/u, '');
  if (text.startsWith('/') || quickCommand(text)) return null;
  const fresh = [...text.matchAll(recurrence)].length > 0 && addEnding.test(text);
  const previous = fresh ? null : await weeklyReplyState(job, store, actorState, now);
  if (!fresh && !previous) return null;

  const sentAt = Number.isSafeInteger(job.payload.sentAt) ? new Date(job.payload.sentAt * 1000) : now;
  const requestedAt = previous ? new Date(previous.request.startedAt) : sentAt;
  const timeZone = previous?.request.timeZone ?? options.settings?.timeZone ?? 'Asia/Seoul';
  const local = kst(requestedAt, timeZone);
  const today = local.slice(0, 10);
  const fields = fresh ? parseRequest(text, today) : clarificationFields(text, previous.request.weekly, today, !!job.payload.replyTo);
  if (!fields) return null;

  const missing = missingFields(fields);
  let reply, changes = [], weeklyKey = null;
  if (missing.length) {
    const examples = {start:'2026-11-12', end:'2026-11-30', weekday:'월요일', title:'서빈이 문센', time:'12:20'};
    reply = '❓ 매주 등록할 일정의 ' + missing.map(key => labels[key]).join(', ') + '을 알려주세요.\n'
      + '입력 예시: ' + missing.map(key => labels[key] + ': ' + examples[key]).join(', ');
  } else {
    const dates = datesFor(fields, local, requestedAt);
    changes = dates.map(dueDate => planTaskCreation({
      title:fields.title, kind:'appointment', status:'open', dueDate, time:fields.time,
      endDate:null, timeNote:null, person:null, assignee:null, notes:'',
      followUpDate:null, actualDeadline:null, remindAt:[]
    }, '매주 반복 일정 일괄 등록', now));
    reply = changes.length
      ? '✅ 일정 ' + changes.length + '건 등록 · ' + fields.title + '\n\n'
        + dates.map(day => '• ' + day + ' (' + weekdays[fields.weekday] + ') ' + fields.time).join('\n')
      : '등록 0건이에요. 종료일까지 아직 지나지 않은 해당 요일과 시각이 없어요.';
    // Use the requested range rather than dates relative to the worker's clock.
    weeklyKey = 'weekly-request:' + createHash('sha256').update(JSON.stringify([
      String(job.payload.actor), timeZone, fields.start ?? null, fields.end, fields.weekday, fields.title, fields.time
    ])).digest('hex');
  }

  const refs = changes.map(({after:{id, title}}) => ({id, title}));
  const conversation = nextConversation(job.payload.actor, text, reply, refs.map(t => t.id), previous, now,
    {timeZone, continuation:!!previous});
  conversation.pending = !!missing.length;
  conversation.request.startedAt = requestedAt.toISOString();
  if (missing.length) {
    conversation.request.operation = 'weekly';
    conversation.request.weekly = fields;
    conversation.requestId = randomUUID();
  }

  await options.authorize?.();
  try {
    return await store.finish(job, changes, reply, null, {
      refs, conversation, weeklyKey, weeklyConfirmation:previous?.requestId,
      expiresAt:new Date(+now + 30 * dayMs).toISOString()
    }) ?? reply;
  } catch (cause) {
    if (!changes.length || cause.message.startsWith('반복 일정 확인 요청')) throw cause;
    throw new Error('반복 일정 저장 오류', {cause});
  }
}
