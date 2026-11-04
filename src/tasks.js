import { randomUUID } from 'node:crypto';
import { validDay, validInstant } from './time.js';

export const kinds = ['task', 'decision', 'appointment', 'registration', 'event'];
export const statuses = ['open', 'in_progress', 'waiting', 'done', 'cancelled'];
const fields = ['title', 'kind', 'status', 'dueDate', 'time', 'endDate', 'timeNote', 'person', 'assignee', 'notes', 'followUpDate', 'actualDeadline', 'remindAt'];
export const isActive = task => !['done', 'cancelled'].includes(task.status);
export function validateTask(input, now = new Date()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('과업 형식을 확인하세요.');
  const task = {};
  for (const key of fields) {
    const value = input[key];
    if (key === 'remindAt') {
      if (!Array.isArray(value) || value.length > 10 || value.some(v => !validInstant(v))) throw new Error('알림 시각에는 시간대까지 필요합니다.');
      task[key] = [...new Set(value.map(v => new Date(v).toISOString()))];
    } else if (value === null) task[key] = null;
    else if (typeof value === 'string' && value.length <= (key === 'notes' ? 4000 : 300)) task[key] = value.trim();
    else throw new Error('필드 형식 또는 길이를 확인하세요: ' + key);
  }
  if (!task.title || !kinds.includes(task.kind) || !statuses.includes(task.status)) throw new Error('제목·종류·상태를 확인하세요.');
  for (const key of ['dueDate', 'endDate', 'followUpDate', 'actualDeadline']) if (task[key] !== null && !validDay(task[key])) throw new Error('날짜를 확인하세요: ' + key);
  if (task.time !== null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(task.time)) throw new Error('시각을 확인하세요.');
  if (task.time && !task.dueDate) throw new Error('시각에는 날짜도 필요합니다.');
  if (task.endDate && (!task.dueDate || task.endDate < task.dueDate)) throw new Error('종료 날짜를 확인하세요.');
  if (!isActive(task)) task.remindAt = [];
  if (task.remindAt.some(v => Date.parse(v) <= now.getTime())) throw new Error('이미 지난 시각을 새 알림으로 설정할 수 없습니다.');
  return task;
}
export function planChanges(actions, currentTasks, now = new Date()) {
  if (!Array.isArray(actions) || actions.length > 20) throw new Error('한 번에 최대 20개를 변경할 수 있습니다.');
  const map = new Map(currentTasks.map(t => [t.id, structuredClone(t)]));
  const changes = [], seen = new Set();
  for (const action of actions) {
    if (!['create', 'update'].includes(action.operation)) throw new Error('지원하지 않는 변경입니다.');
    const previous = action.operation === 'update' ? map.get(action.id) : null;
    const proposed = { ...action.task };
    if (previous && Array.isArray(proposed.remindAt)) {
      const timingChanged = ['dueDate','time','endDate','timeNote'].some(k=>proposed[k]!==previous[k]);
      if (timingChanged && JSON.stringify(proposed.remindAt) === JSON.stringify(previous.remindAt)) proposed.remindAt = [];
      else proposed.remindAt = proposed.remindAt.filter(v=>!(previous.remindAt.includes(v) && Date.parse(v)<=now.getTime()));
    }
    const data = validateTask(proposed, now);
    if (action.operation === 'create') {
      if (action.id !== null || action.expectedVersion !== null) throw new Error('신규 과업 식별자를 확인하세요.');
      const next = { ...data, id: randomUUID(), version: 1, completedAt: data.status === 'done' ? now.toISOString() : null, createdAt: now.toISOString(), updatedAt: now.toISOString() };
      changes.push({ before: null, after: next, reason: action.reason || '' }); map.set(next.id, next);
    } else {
      const old = map.get(action.id);
      if (!old || old.version !== action.expectedVersion || seen.has(action.id)) throw new Error('목록이 변경됐거나 대상을 찾지 못했습니다. 다시 요청해주세요.');
      seen.add(action.id);
      const next = { ...old, ...data, version: old.version + 1, completedAt: data.status === 'done' ? old.completedAt || now.toISOString() : null, updatedAt: now.toISOString() };
      changes.push({ before: old, after: next, reason: action.reason || '' }); map.set(next.id, next);
    }
  }
  return changes;
}
export function taskLine(t) {
  const state = { open: '미완료', in_progress: '진행 중', waiting: '대기', done: '완료', cancelled: '취소' }[t.status];
  return `${t.id.slice(0, 8)} | ${t.dueDate || '날짜 미정'}${t.endDate ? '~' + t.endDate : ''}${t.time ? ' ' + t.time : ''}${t.timeNote ? ' (' + t.timeNote + ')' : ''} | ${t.title} | ${state}${t.actualDeadline ? ' | 실제 만기 ' + t.actualDeadline : ''}`;
}
export function changeReceipt(changes) { return changes.map(c => `${c.before ? '변경' : '추가'}: ${taskLine(c.after)}`).join('\n'); }
