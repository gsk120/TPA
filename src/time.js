export const TIME_ZONE = 'Asia/Seoul';
export function kst(now = new Date(), timeZone = TIME_ZONE) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(now).replace(' ', 'T');
}
export const today = (now = new Date(), timeZone = TIME_ZONE) => kst(now,timeZone).slice(0, 10);
export function addDays(day, n) { return today(new Date(Date.parse(day + 'T00:00:00+09:00') + n * 86400000)); }
export function validDay(day) {
  return typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(Date.parse(day + 'T00:00:00Z')) && new Date(day + 'T00:00:00Z').toISOString().slice(0, 10) === day;
}
export function validInstant(value) { return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && validDay(value.slice(0, 10)) && Number.isFinite(Date.parse(value)); }
export function dueBriefs(now = new Date(), settings = {}) {
 const {timeZone='Asia/Seoul',dailyTime='08:00',weeklyTime='20:00',weeklyDay=0,dailyEnabled=true,weeklyEnabled=true}=settings;
 const day=today(now,timeZone),clock=kst(now,timeZone).slice(11,16),entries=[];
 if(dailyEnabled&&clock>=dailyTime)entries.push({key:'daily:'+day,type:'daily',day});
 if(weeklyEnabled&&new Date(day+'T12:00:00Z').getUTCDay()===weeklyDay&&clock>=weeklyTime)entries.push({key:'weekly:'+day,type:'weekly',day});
 return entries;
}
