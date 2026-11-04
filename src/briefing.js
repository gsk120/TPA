import { today, addDays } from './time.js';
import { isActive } from './tasks.js';
import {groupTasks,dateLabel} from './format.js';

export function listTasks(tasks, mode = 'all', now = new Date(), timeZone = 'Asia/Seoul') {
  const day = today(now,timeZone), until = addDays(day, 6);
  return tasks.filter(t => mode === 'history' ? !isActive(t) : isActive(t))
    .filter(t => mode === 'today' ? t.dueDate === day : mode === 'week' ? t.dueDate && t.dueDate >= day && t.dueDate <= until : true)
    .sort((a, b) => (a.dueDate || '9999').localeCompare(b.dueDate || '9999') || (a.time || '99:99').localeCompare(b.time || '99:99'));
}
export function briefing(tasks, type, now = new Date(), history = [], timeZone = 'Asia/Seoul') {
  const day = today(now,timeZone), tomorrow = addDays(day, 1), end = addDays(day, type === 'weekly' ? 14 : 1);
  const active = listTasks(tasks, 'all', now,timeZone);
  const overdue = active.filter(t => t.dueDate && (t.endDate || t.dueDate) < day);
  const upcoming = active.filter(t => t.dueDate && ((t.dueDate >= day && t.dueDate <= end) || (t.endDate && t.dueDate < day && t.endDate >= day)));
  const show = entries => entries.length ? groupTasks(entries,{now,timeZone,showOverdue:false}) : '없어요.';
  let text = `📅 ${type === 'weekly' ? '주간' : '일일'}점검 · ${dateLabel(day)}\n기준 시간대: ${timeZone}\n\n`;
  if (type === 'daily') {
    text += '오늘\n' + show(upcoming.filter(t => t.dueDate === day || t.kind === 'event' && t.dueDate < day)) + '\n\n내일 준비\n' + show(upcoming.filter(t => t.dueDate === tomorrow));
  } else {
    const since = new Date(now.getTime() - 7 * 86400000).toISOString();
    const done = history.filter(e => e.at >= since && e.after?.status === 'done' && e.before?.status !== 'done');
    text += '지난 7일 완료 기록\n' + (done.length ? done.map(e => e.after.title).join('\n') : '기록이 없어요.') + '\n\n앞으로 14일\n' + show(upcoming);
  }
  text += '\n\n기한 경과 / 지난 일정 결과 미확인\n' + show(overdue);
  const awaiting = active.filter(t => t.status === 'waiting' || !t.dueDate);
  if (type === 'weekly' && awaiting.length) text += '\n\n대기·날짜 미정\n' + show(awaiting);
  return text + '\n\n완료·변경 사항이 있으면 봇에 답장해주세요. 미응답은 완료로 처리하지 않아요.';
}
