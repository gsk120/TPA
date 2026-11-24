import {createHash} from 'node:crypto';
import {calendarDay,expandSeries,validateSeries,wallInstants,wallTime} from './recurrence.js';
import {timeTypes,validClock,validDay,validTimeZone} from './time.js';

const weekdays = '일월화수목금토';
const dateWeekday = day => new Date(day + 'T00:00:00Z').getUTCDay();
const formatError = () => new Error('AI 응답의 반복 일정 규칙을 확인하지 못했어요. 다시 말씀해주세요.');
const seriesDraftFields = ['title','frequency','weekday','monthDay','yearMonth','calendarSystem','start','end','time','allDay',
  'timeType','endTime','endDayOffset','timeNote','timeZone'];
const annualDate=(year,month,day)=>String(year).padStart(4,'0')+'-'+String(month).padStart(2,'0')+'-'+String(day).padStart(2,'0');

export function readSeriesDraft(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw formatError();
  const {title=null,frequency=null,weekday=null,monthDay=null,yearMonth=null,calendarSystem=null,start=null,end=null,time=null,allDay=null,
    timeType=allDay === true ? 'all_day' : allDay === false ? 'timed' : null,
    endTime=null,endDayOffset=null,timeNote=null,timeZone=null} = input;
  if (Object.keys(input).some(key => !seriesDraftFields.includes(key))
      || title !== null && (typeof title !== 'string' || !title.trim() || title.length > 300)
      || frequency !== null && !['DAILY','WEEKLY','MONTHLY','YEARLY'].includes(frequency)
      || weekday !== null && (frequency !== 'WEEKLY' || !Number.isInteger(weekday) || weekday < 0 || weekday > 6)
      || monthDay !== null && (!['MONTHLY','YEARLY'].includes(frequency) || !Number.isInteger(monthDay)
        || monthDay < (frequency==='YEARLY'?1:-1) || monthDay === 0 || monthDay > 31)
      || yearMonth !== null && (frequency!=='YEARLY' || !Number.isInteger(yearMonth) || yearMonth<1 || yearMonth>12)
      || calendarSystem !== null && (frequency!=='YEARLY' || !['solar','lunar'].includes(calendarSystem))
      || calendarSystem==='solar' && yearMonth!==null && monthDay!==null && !validDay(annualDate(2000,yearMonth,monthDay))
      || start !== null && !validDay(start) || end !== null && !validDay(end)
      || time !== null && !validClock(time)
      || allDay !== null && typeof allDay !== 'boolean'
      || timeType !== null && !timeTypes.includes(timeType)
      || allDay !== null && timeType !== null && allDay !== (timeType === 'all_day')
      || ['all_day','unknown','condition','date_only'].includes(timeType) && time !== null
      || endTime !== null && (!validClock(endTime) || timeType !== 'range')
      || endDayOffset !== null && (timeType !== 'range' || !Number.isSafeInteger(endDayOffset)
        || endDayOffset < 0 || endDayOffset > 3652058)
      || timeType === 'range' && !endDayOffset && time && endTime && endTime <= time
      || timeNote !== null && (typeof timeNote !== 'string' || timeNote.length > 300)
      || timeZone !== null && !validTimeZone(timeZone)) throw formatError();
  return {title:title?.trim() ?? null,frequency,weekday,monthDay,...(frequency==='YEARLY'&&{yearMonth,calendarSystem}),
    start,end,time,timeType,endTime,endDayOffset,
    timeNote:timeNote?.trim() || null,timeZone};
}

export function missingSeriesFields(fields) {
  const missing = [];
  if (!fields.title) missing.push('제목');
  if (!fields.frequency) missing.push('반복 주기');
  if (fields.frequency === 'WEEKLY' && fields.weekday === null) missing.push('요일');
  if (fields.frequency === 'MONTHLY' && fields.monthDay === null) missing.push('매월 날짜');
  if (fields.frequency==='YEARLY' && (!fields.yearMonth || !fields.monthDay)) missing.push('매년 반복할 월·일');
  if (fields.frequency==='YEARLY' && !fields.calendarSystem) missing.push('양력·음력 구분');
  if (fields.timeType === null || ['timed','range'].includes(fields.timeType) && !fields.time) {
    missing.push('시각 또는 종일 여부');
  }
  if (fields.timeType === 'range' && !fields.endTime) missing.push('범위의 종료 시각');
  if (fields.timeType === 'condition' && !fields.timeNote) missing.push('시간 조건');
  return missing;
}

function nextAnnualDay(fields,from) {
  if (!validDay(from)) return null;
  for (let year=Number(from.slice(0,4));year<=9999;year++) {
    const day=annualDate(year,fields.yearMonth,fields.monthDay);
    if (day>=from && validDay(day)) return day;
  }
  return null;
}

function buildSeries(fields, requestedAt, timeZone) {
  const today = wallTime(+requestedAt,timeZone).slice(0,10);
  const dateAnchored = !['timed','range'].includes(fields.timeType);
  let day = fields.start && fields.start > today ? fields.start : today;
  if (fields.frequency === 'WEEKLY') {
    day = calendarDay(day,(fields.weekday - dateWeekday(day) + 7) % 7);
  }
  const yearly=fields.frequency==='YEARLY';
  if (yearly) {
    if (fields.calendarSystem!=='solar' || !fields.yearMonth || !fields.monthDay) throw formatError();
    day=nextAnnualDay(fields,day);
  }
  const step = fields.frequency === 'WEEKLY' ? 7 : 1;
  while (validDay(day) && (!fields.end || day <= fields.end)) {
    const matchesMonth = fields.frequency !== 'MONTHLY' || (fields.monthDay === -1
      ? calendarDay(day,1).endsWith('-01') : fields.monthDay === Number(day.slice(8)));
    const start = dateAnchored ? null : wallInstants(day + 'T' + fields.time + ':00',timeZone)
      .find(instant => instant >= +requestedAt);
    if (matchesMonth && (dateAnchored || start !== undefined)) {
      let rule = 'RRULE:FREQ=' + fields.frequency;
      if (fields.frequency === 'MONTHLY' && fields.monthDay === -1) rule += ';BYMONTHDAY=-1';
      if (fields.end) {
        let endDay = fields.end;
        let until = dateAnchored ? endDay : null;
        while (!until) {
          const last = wallInstants(endDay + 'T' + fields.time + ':00',timeZone).at(-1);
          if (last !== undefined) until = new Date(last).toISOString().replace(/\.\d{3}Z$/u,'Z');
          else endDay = calendarDay(endDay,-1);
        }
        rule += ';UNTIL=' + until.replace(/[-:]/gu,'');
      }
      let endInstant = null;
      if (fields.timeType === 'range') {
        const endDay = calendarDay(day,fields.endDayOffset ?? 0);
        if (!validDay(endDay)) throw formatError();
        endInstant = wallInstants(endDay + 'T' + fields.endTime + ':00',timeZone).find(instant => instant > start);
        if (endInstant === undefined) throw new Error('반복 일정의 종료 시각이 해당 날짜와 시간대에 유효한지 확인해주세요.');
      }
      const timing = dateAnchored ? {start_date:day,end_date_exclusive:calendarDay(day,1)}
        : {start_at:new Date(start).toISOString(),end_at:endInstant === null ? null : new Date(endInstant).toISOString()};
      const series = {title:fields.title,kind:fields.timeType === 'date_only' ? 'task' : 'appointment',
        timezone:timeZone,all_day:fields.timeType === 'all_day',time_type:fields.timeType,time_note:fields.timeNote,
        recurrence_raw:[rule],...timing};
      validateSeries(series);
      return {series,first:day};
    }
    const next=calendarDay(day,step);
    day = yearly ? nextAnnualDay(fields,next) : next;
  }
  return null;
}

export function planSeriesRegistration(fields, requestedAt, familyTimeZone, actor) {
  const timeZone = fields.timeZone ?? familyTimeZone;
  const result = buildSeries(fields,requestedAt,timeZone);
  if (!result) return {reply:'등록 0건이에요. 지정 기간에 아직 지나지 않은 해당 날짜와 시각이 없어요.'};
  const {series,first} = result;
  const preview = [];
  const limit = 12;
  for (const {anchor} of expandSeries(series,first,fields.end ?? first)) {
    preview.push(anchor);
    if (preview.length > limit) break;
  }
  const more = preview.length > limit;
  if (more) preview.pop();
  const timeLabel = {
    all_day:'종일',unknown:fields.timeNote || '시간 미정',condition:fields.timeNote,date_only:'마감',
    timed:fields.time,range:fields.time
  }[fields.timeType];
  const reply = '✅ 반복 일정 시리즈 등록 · ' + series.title + '\n\n'
    + preview.map(anchor => {
      const day = anchor.slice(0,10);
      const lastDayOffset = (fields.endDayOffset ?? 0) - (fields.endTime === '00:00' ? 1 : 0);
      const period = lastDayOffset > 0 ? ' · ' + day + '~' + calendarDay(day,lastDayOffset) : '';
      return '• ' + day + ' (' + weekdays[dateWeekday(day)] + ') ' + timeLabel + period;
    }).join('\n')
    + (!fields.end ? '\n\n종료일 없이 반복해요. 위에는 첫 회차를 표시했어요.'
      : more ? '\n\n앞의 ' + limit + '개 회차를 표시했어요.' : '\n\n회차 ' + preview.length + '건');

  // Keep existing request keys so repeating an old request preserves its saved result.
  const weekly = fields.frequency === 'WEEKLY';
  const identity = [String(actor),timeZone,fields.start,fields.end,
    weekly ? fields.weekday : fields.frequency,fields.title,fields.timeType === 'all_day' ? '종일' : fields.time];
  if (!weekly) identity.push(fields.monthDay);
  if (fields.frequency==='YEARLY') identity.push(fields.yearMonth);
  if (!['all_day','timed'].includes(fields.timeType) || fields.timeNote) {
    identity.push(fields.timeType,fields.endTime,fields.endDayOffset || null,fields.timeNote);
  }
  const weeklyKey = 'weekly-request:' + createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  return {reply,seriesRegistration:{series,occurrenceAnchors:preview,weeklyKey}};
}
