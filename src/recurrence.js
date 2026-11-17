import { createHash } from 'node:crypto';
import { timeTypes, validDay, validInstant } from './time.js';

const DAY = 86400000;
const weekdays = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const formatters = new Map();

export function calendarDay(day, days) {
  return new Date(Date.parse(day + 'T00:00:00Z') + days * DAY).toISOString().slice(0, 10);
}

export function wallTime(instant, timeZone) {
  if (!formatters.has(timeZone)) {
    formatters.set(timeZone, new Intl.DateTimeFormat('sv-SE', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
    }));
  }
  return formatters.get(timeZone).format(instant).replace(' ', 'T');
}

// Verify candidate offsets by round-tripping the local clock. Gaps have no
// candidates, and a repeated clock has two candidates in chronological order.
const dayOffsets = new Map();
export function wallInstants(local, zone) {
  const wall = Date.parse(local + 'Z');
  const key = zone + ':' + local.slice(0, 10);
  let offsets = dayOffsets.get(key);
  if (!offsets) {
    offsets = new Set([-36, -12, 0, 12, 36].map(hours => {
      const sample = Math.floor(wall / DAY) * DAY + hours * 3600000;
      return Date.parse(wallTime(sample, zone) + 'Z') - sample;
    }));
    if (dayOffsets.size >= 1024) dayOffsets.clear();
    dayOffsets.set(key, offsets);
  }
  return [...offsets].map(offset => wall - offset)
    .filter(instant => wallTime(instant, zone) === local).sort((a, b) => a - b);
}

function failRule() {
  throw new RangeError('지원하지 않거나 유효하지 않은 반복 규칙입니다.');
}

function integer(value, max) {
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > max) failRule();
  return Number(value);
}

export function parseRule(lines, allDay) {
  if (!Array.isArray(lines) || lines.length !== 1 || typeof lines[0] !== 'string' || !lines[0].startsWith('RRULE:')) failRule();
  const fields = new Map();
  for (const field of lines[0].slice(6).split(';')) {
    const [name, value, extra] = field.split('=');
    if (extra !== undefined || !value || fields.has(name)
      || !['FREQ','INTERVAL','COUNT','UNTIL','BYDAY','BYMONTHDAY','WKST'].includes(name)) failRule();
    fields.set(name, value);
  }
  const frequency = fields.get('FREQ');
  if (!['DAILY','WEEKLY','MONTHLY'].includes(frequency)) failRule();
  const interval = fields.has('INTERVAL') ? integer(fields.get('INTERVAL'), 1000000) : 1;
  const count = fields.has('COUNT') ? integer(fields.get('COUNT'), 2147483647) : null;
  const rawUntil = fields.get('UNTIL');
  let until = null;
  if (rawUntil) {
    if (count || !(allDay ? /^\d{8}$/ : /^\d{8}T\d{6}Z$/).test(rawUntil)) failRule();
    until = rawUntil.slice(0,4) + '-' + rawUntil.slice(4,6) + '-' + rawUntil.slice(6,8);
    if (allDay ? !validDay(until) : !validInstant(until += 'T' + rawUntil.slice(9,11) + ':' + rawUntil.slice(11,13) + ':' + rawUntil.slice(13))) failRule();
  }
  const byDay = fields.get('BYDAY')?.split(',').map(day => weekdays.indexOf(day));
  const weekStart = weekdays.indexOf(fields.get('WKST') ?? 'MO');
  if (weekStart < 0 || (byDay && (frequency !== 'WEEKLY' || byDay.includes(-1)))) failRule();
  const byMonthDay = fields.get('BYMONTHDAY')?.split(',').map(day => {
    if (!/^-?\d{1,2}$/.test(day) || !Number(day) || Math.abs(Number(day)) > 31) failRule();
    return Number(day);
  });
  if (byMonthDay && frequency !== 'MONTHLY') failRule();
  return {frequency, interval, count, until, byDay, byMonthDay, weekStart};
}

const iso = value => new Date(value).toISOString();
const ordinal = day => Date.parse(day + 'T00:00:00Z') / DAY;
const weekday = day => new Date(day + 'T00:00:00Z').getUTCDay();
const relativeWeekday = (day, weekStart) => (day - weekStart + 7) % 7;
const monthNumber = day => Number(day.slice(0, 4)) * 12 + Number(day.slice(5, 7)) - 1;

function monthDays(month, selected) {
  const year = Math.floor(month / 12);
  const m = month % 12 + 1;
  if (year < 1 || year > 9999) return [];
  const prefix = String(year).padStart(4, '0') + '-' + String(m).padStart(2, '0') + '-';
  const last = new Date(ordinal(prefix + '28') * DAY + 4 * DAY);
  const length = 32 - last.getUTCDate();
  return [...new Set(selected.map(d => d > 0 ? d : length + d + 1))]
    .filter(d => d >= 1 && d <= length).sort((a,b) => a-b)
    .map(d => prefix + String(d).padStart(2, '0'));
}

const ALL_OCCURRENCES_DAYS = 30;

export function occurrenceWindow(today, from, to) {
  const first = validDay(from) ? from : validDay(to) && to < today ? calendarDay(to,1 - ALL_OCCURRENCES_DAYS) : today;
  return {first,last:validDay(to) ? to : calendarDay(first,ALL_OCCURRENCES_DAYS - 1)};
}

export function withinOccurrenceWindow(task, {first,last}) {
  const end = task.timeType === 'range' && task.endTime === '00:00' && task.endDate > task.dueDate
    ? calendarDay(task.endDate,-1) : task.endDate ?? task.dueDate;
  return Boolean(task.dueDate && task.dueDate <= last && end >= first);
}

export const isDateAnchored = series => series.all_day || ['unknown','condition','date_only'].includes(series.time_type);

export function validateSeries(series) {
  const {time_type,time_note} = series;
  const validKind = ['appointment','event'].includes(series.kind) || series.kind === 'task' && time_type === 'date_only';
  if (!validKind || typeof series.title !== 'string'
      || !series.title.trim() || series.title.trim().length > 300
      || typeof series.timezone !== 'string' || !series.timezone
      || typeof series.all_day !== 'boolean'
      || time_type != null && (!timeTypes.includes(time_type) || series.all_day !== (time_type === 'all_day'))
      || time_note != null && (typeof time_note !== 'string' || time_note.length > 300)
      || time_type === 'condition' && !time_note?.trim()
      || time_type === 'range' && series.end_at == null) throw new RangeError('반복 일정 필드를 확인하세요.');
  wallTime(0, series.timezone);
  const {start_date, end_date_exclusive, start_at, end_at} = series;
  const dateAnchored = isDateAnchored(series);
  if (dateAnchored ? !validDay(start_date) || !validDay(end_date_exclusive) || end_date_exclusive <= start_date
      : !validInstant(start_at) || (end_at != null && (!validInstant(end_at) || Date.parse(end_at) <= Date.parse(start_at)))
        || Date.parse(start_at) % 1000 !== 0) throw new RangeError('반복 일정의 시작·종료를 확인하세요.');
  const rule = parseRule(series.recurrence_raw, dateAnchored);
  const anchor = dateAnchored ? start_date : wallTime(Date.parse(start_at), series.timezone).slice(0, 10);
  if ((rule.byDay && !rule.byDay.includes(weekday(anchor)))
    || (rule.byMonthDay && !monthDays(monthNumber(anchor), rule.byMonthDay).includes(anchor))
    || (rule.until && (dateAnchored ? rule.until < anchor : Date.parse(rule.until) < Date.parse(start_at)))) failRule();
}

function* candidateDays(start, from, to, rule) {
  const {frequency, interval, weekStart, byDay, byMonthDay} = rule;
  if (frequency === 'MONTHLY') {
    const beginning = monthNumber(start);
    const wanted = byMonthDay ?? [Number(start.slice(8))];
    for (let month = beginning + Math.floor((monthNumber(from) - beginning) / interval) * interval;
      month <= monthNumber(to); month += interval) {
      yield* monthDays(month, wanted).filter(day => day >= start && day <= to);
    }
    return;
  }
  const startDay = ordinal(start);
  const weekly = frequency === 'WEEKLY';
  const base = weekly ? startDay - relativeWeekday(weekday(start), weekStart) : startDay;
  const period = interval * (weekly ? 7 : 1);
  const offsets = weekly ? [...new Set((byDay ?? [weekday(start)]).map(d => relativeWeekday(d, weekStart)))].sort((a,b) => a-b) : [0];
  for (let day = base + Math.floor((ordinal(from) - base) / period) * period; day <= ordinal(to); day += period) {
    for (const offset of offsets) {
      const current = day + offset;
      if (current >= startDay && current <= ordinal(to)) yield new Date(current * DAY).toISOString().slice(0, 10);
    }
  }
}

export function* expandSeries(series, from, to) {
  const {timezone} = series;
  const dateAnchored = isDateAnchored(series);
  if (series.status === 'cancelled' || series.edit_mode === 'read_only') return;
  const rule = parseRule(series.recurrence_raw, dateAnchored);
  const first = dateAnchored ? series.start_date : wallTime(Date.parse(series.start_at), timezone);
  const startDay = first.slice(0,10);
  const duration = dateAnchored ? ordinal(series.end_date_exclusive) - ordinal(startDay)
    : series.end_at == null ? null : Date.parse(series.end_at) - Date.parse(series.start_at);
  const wallEnd = series.time_type === 'range' ? wallTime(Date.parse(series.end_at),timezone) : null;
  const endDayOffset = wallEnd ? ordinal(wallEnd.slice(0,10)) - ordinal(startDay) : null;
  if (to < startDay || from > to) return;
  let emitted = 0;
  const scanFrom = rule.count || from < startDay ? startDay : from;
  for (const day of candidateDays(startDay, scanFrom, to, rule)) {
    const local = day + first.slice(10);
    const instants = dateAnchored ? [] : wallInstants(local, timezone);
    const start = dateAnchored ? day : instants[day === startDay ? instants.indexOf(+new Date(series.start_at)) : 0];
    if (start === undefined) continue;
    if (rule.until && (dateAnchored ? start > rule.until : start > Date.parse(rule.until))) break;
    let end = dateAnchored ? calendarDay(day,duration) : duration == null ? null : iso(start + duration);
    if (wallEnd && day !== startDay) {
      const endDay = calendarDay(day,endDayOffset);
      if (!validDay(endDay)) break;
      const instant = wallInstants(endDay + wallEnd.slice(10),timezone).find(value => value > start);
      if (instant === undefined) continue;
      end = iso(instant);
    }
    if (++emitted > (rule.count ?? Infinity)) break;
    if (day < from) continue;
    yield {
      anchor: dateAnchored ? day : local + '#' + instants.indexOf(start),
      start: dateAnchored ? day : iso(start),
      end,
      offset: dateAnchored ? null : (Date.parse(local + 'Z') - start) / 1000
    };
  }
}

// UUID version 8 with a recoverable anchor day. The remaining bits distinguish
// family, series and anchor, and permit resolving a reply to a distant date
// without persisting projections or scanning the entire life of a series.
export function occurrenceId(familyId, seriesId, anchor) {
  const day = (ordinal(anchor.slice(0,10)) + 1000000).toString(16).padStart(8, '0');
  const hash = createHash('sha256').update(JSON.stringify([familyId, seriesId, anchor])).digest('hex');
  const variant = ((parseInt(hash[7],16) & 3) | 8).toString(16);
  return [day, hash.slice(0,4), '8' + hash.slice(4,7), variant + hash.slice(8,11), hash.slice(11,23)].join('-');
}

export function occurrenceDay(id) {
  if (!/^[\da-f]{8}-[\da-f]{4}-8[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(id)) return null;
  const day = parseInt(id.slice(0,8),16) - 1000000;
  return day >= ordinal('0001-01-01') && day <= ordinal('9999-12-31') ? new Date(day * DAY).toISOString().slice(0,10) : null;
}
