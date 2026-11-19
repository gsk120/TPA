import { buttonFor } from '../buttons.js';
import { errorFields, jobDebug, jobTrace } from '../diagnostics.js';
import { textResult, validateSkillResult } from './skill.js';

const calendarCommit = Symbol('Calendar commit');
const calendarPending = Symbol('Calendar pending update');

export function calendarResult(reply, changes, settingsChange, memory) {
  return {
    ...textResult(reply, memory.conversation?.pending && !memory.calendarGuard?.preserve ? 'waiting' : 'success'),
    [calendarCommit]:{ changes, settingsChange, memory }
  };
}

export function calendarPendingResult(reply, update) {
  return { ...textResult(reply), [calendarPending]:update };
}

export async function completeSkillResult({ job, store, now, signal, options }, result, skillId, choice) {
  const { status, content, buttons } = validateSkillResult(result);
  const reply = content.filter(item => item.type === 'text').map(item => item.text).join('\n\n');
  signal?.throwIfAborted();
  await options?.authorize?.();
  signal?.throwIfAborted();

  const commit = skillId === 'calendar' && result[calendarCommit];
  if (commit) {
    const { changes, settingsChange, memory } = commit;
    const waiting = status === 'waiting';
    try {
      jobDebug('calendar.save.start', { changes:changes.length, pending:waiting });
      const storedReply = await store.finish(job, changes, reply, settingsChange, memory, status);
      jobDebug('calendar.save.done', { changes:changes.length, pending:waiting,
        question:waiting && memory.conversation?.requestId
          ? jobTrace('calendar-question', memory.conversation.requestId) : undefined });
      return storedReply ?? reply;
    } catch (cause) {
      jobDebug('calendar.save.error', errorFields(cause));
      if (!memory.series || cause.message.startsWith('확인 요청이 이미')) throw cause;
      throw new Error('반복 일정 저장 오류', { cause });
    }
  }

  const choiceButtons = buttons.filter(button => button.value !== undefined);
  const button = choiceButtons.length
    ? buttonFor(job, now, { kind:'skill-choice', skillId, choices:choiceButtons.map(button => button.value) },
      choiceButtons.map(button => button.label))
    : null;
  let index = 0;
  const replyMarkup = buttons.length ? { inline_keyboard:buttons.map(item => item.url
    ? [{ text:item.label, url:item.url }] : button.markup.inline_keyboard[index++]) } : undefined;
  const needsStructuredDelivery = (skillId && skillId !== 'calendar') || content.length !== 1
    || content[0].type !== 'text' || replyMarkup;
  const delivery = needsStructuredDelivery
    ? { chatId:String(job.payload.chatId), actor:String(job.payload.actor), content, replyMarkup } : undefined;
  const pending = skillId === 'calendar' ? result[calendarPending] : undefined;
  return store.finishSkillRouting(job, reply, {
    failed:status === 'failed',
    ...(status === 'waiting' && { waiting:true }),
    ...(pending && { calendarPending:pending }),
    ...(delivery && { delivery }),
    ...(button && { button }),
    ...(choice && { choice })
  });
}

export function recordSkillFailure(store, job, error, userMessage) {
  return store.fail(job, userMessage, {
    silent:!!job.payload.button && error.message === '버튼이 이미 처리됐거나 만료됐어요.',
    weeklySave:error.message === '반복 일정 저장 오류'
  });
}
