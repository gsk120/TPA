import { calendarStateKey, conversationLifetimeMs, liveCalendarState, quickCommand, selectedDetail } from './context.js';
import { directCompletionTarget, requestedCompletionTitle } from './natural.js';
import { isActive } from './tasks.js';
import { defaults } from './settings.js';

export const calendarPendingNotice = '먼저 진행 중인 일정 확인 질문에 답해주세요. 확인이 끝나면 이 요청 전체를 다시 보내주세요.';
const unclearReply = '이어갈 일정 확인 질문을 찾지 못했어요. 원래 질문에 필요한 답이나 새 요청 전체를 보내주세요.';
export const calendarContextChanged = '확인 요청이 이미 처리됐거나 다른 요청으로 바뀌었어요. 새 요청을 알려주세요.';

const day = '(?:오늘|어제|그제|내일|모레|(?:지난|이번|다음)\\s*주\\s*[월화수목금토일]요일|[월화수목금토일]요일|\\d{4}-\\d{2}-\\d{2}|\\d{1,2}/\\d{1,2}|(?:\\d{4}\\s*년\\s*)?(?:\\d{1,2}\\s*월\\s*)?\\d{1,2}\\s*일|말일)';
const clock = '(?:(?:오전|오후|저녁|아침|밤)\\s*)?(?:\\d{1,2}:\\d{2}(?:분)?|(?:\\d{1,2}|한|두|세|네|다섯|여섯|일곱|여덟|아홉|열(?:한|두)?)\\s*시(?:\\s*(?:반|\\d{1,2}\\s*분))?|정오|자정)';
const dateAnswer = new RegExp(`^${day}(?:\\s*(?:하루|날|거|것|건|일정))?(?:으?로)?$`, 'u');
const timeAnswer = new RegExp(`^(?:${clock}(?:\\s*(?:부터|에서|~|–|-)\\s*${clock}(?:\\s*까지)?)?(?:\\s*(?:이후|이전))?|종일|하루\\s*종일|시간\\s*미정|미정)(?:으?로)?$`, 'u');
const dateAndTime = new RegExp(`^${day}\\s+${clock}(?:으?로)?$`, 'u');
const seriesScope = /^(?:(?:\d{1,2}\s*월(?:\s*\d{1,2}\s*일)?\s*(?:에\s*)?(?:이후\s*|이전\s*|부터\s*|시작(?:한|하는)\s*)?)?(?:(?:반복\s*)?(?:시리즈\s*)?전체(?:\s*시리즈|\s*반복)?|시리즈|(?:한\s*|해당\s*|그\s*)?회차)(?:\s*만)?|전체\s*취소)$/u;
const seriesFrequency = /^(?:매일|매주(?:\s*[월화수목금토일]요일)?|매월(?:\s*(?:말일|\d{1,2}\s*일))?|[월화수목금토일]요일마다)(?:\s*반복)?$/u;
const acknowledgement = /^(?:응|네|예|맞아|승인|좋아|모두|전부|아니|아니요|아니오|거절|취소|안\s*할래)(?:요)?[.!\s]*$/u;
const selection = /^(?:\d+\s*(?:번|번째)?|(?:첫|두|세|네)\s*번째|마지막|둘\s*다|두\s*개|모두|전부)(?:이야|이요|야|요)?[.!\s]*$/u;
const combinedSelection = /^(?:응|네|예|맞아|승인|좋아|아니요?|\d+\s*(?:번|번째)|(?:첫|두|세)\s*번째|둘\s*다)(?:요)?(?:\s*[,，.!]\s*|\s+(?:그리고|또)\s+).+$/u;
const subject = '(?:(?:그거|그건|그걸|그것|이거|이건|이걸|해당\\s*일정)(?:을|를|은)?\\s*)?';
const recentChange = new RegExp(`^${subject}(?:(?:${day}(?:\\s+${clock})?|${clock})(?:으?로)\\s*(?:미뤄|변경|바꿔|옮겨)|완료(?:했어|해|\\s*처리)?|끝냈어|취소(?:해)?)(?:\\s*(?:줘|주세요|해줘|해주세요))?[.!?\\s]*$`, 'u');
const recentRead = new RegExp(`^${subject}(?:(?:자세히|상세히|메모|날짜|시각|시간|장소|상태|담당자|기한)(?:을|를|은)?\\s*(?:알려|보여)(?:줘|주세요)?|상세\\s*(?:내용|조회)(?:해줘|해주세요)?)[.!?\\s]*$`, 'u');
const dependent = /^(?:그거|그건|그걸|그것|이거|이건|이걸|해당\s*일정)(?:\s|을|를|은|$)/u;

export async function loadReplyReference(job, store) {
  if (!job.payload.replyTo) return null;
  let reply;
  try { reply = JSON.parse(job.payload.replyTo); } catch { return null; }
  return await store.replyReference?.(reply?.id) || null;
}

export function isUsableCalendarReply(reference, { actor, chatId }, now) {
  return reference?.chatId === String(chatId) && Date.parse(reference.expiresAt) > +now
    && (reference.ownerActor == null || reference.ownerActor === String(actor));
}

export function isCalendarQuestionReply(reference, pending, actor) {
  return !!pending && reference.pending && reference.ownerActor === String(actor)
    && reference.requestId === pending.requestId
    && (!pending.workflow || reference.workflowToken === pending.workflow.token);
}

function candidateAnswer(text, state, tasks) {
  const order = state.request?.candidateOrder ?? state.taskIds ?? [];
  if (!order.length) return false;
  if (selectedDetail(text, { candidateOrder: order })) return true;
  if (/^(?:마지막|둘\s*다|두\s*개|모두|전부)(?:야|요|이요)?[.!\s]*$/u.test(text)) {
    return state.request?.operation !== 'detail';
  }
  const normalized = text.replace(/[.!\s]+$/u, '').replace(/(?:이요|야|요)$/u, '');
  const query = normalized.replace(/(?:만\s*빼고|만|\s*제외)$/u, '').trim();
  if (!query || state.request?.operation === 'detail' && query !== normalized) return false;
  const matches = tasks.filter(task => order.includes(task.id) && task.title === query);
  return matches.length === 1 || matches.length === 0 && query !== normalized
    && tasks.filter(task => order.includes(task.id) && task.title.startsWith(query)).length === 1;
}

function pendingAnswer(text, state, tasks) {
  const request = state.request ?? {};
  const answer = text.replace(/[.!?\s]+$/u, '').replace(/(?:이요|요)$/u, '');
  if (request.dateCompletion) return acknowledgement.test(text)
    || (!request.dateCompletion.targets && dateAnswer.test(answer));
  if (request.seriesCancellation) return seriesScope.test(answer) || dateAnswer.test(answer);
  if (candidateAnswer(text, state, tasks)) return true;
  if (request.chooseByDate) return dateAnswer.test(answer) || timeAnswer.test(answer);
  const expected = `${request.unresolved ?? ''} ${request.question ?? ''}`;
  return (acknowledgement.test(text) && /맞(?:나요|습니까)|할까요|괜찮(?:나요|을까요)|해도\s*될까요/u.test(expected)
      && !/어느|어떤|언제|몇|며칠/u.test(expected))
    || (timeAnswer.test(answer) && (request.seriesDraft || /시각|몇\s*시|시간|종일/u.test(expected)))
    || (dateAnswer.test(answer) && (request.seriesDraft || /날짜|며칠|언제|어느\s*날|요일/u.test(expected)))
    || (dateAndTime.test(answer) && /시각|몇\s*시|시간|날짜|언제/u.test(expected))
    || (seriesFrequency.test(answer) && !!request.seriesDraft);
}

export async function inspectCalendarEntry({ job, store, now, options = {} }) {
  const { actor, chatId, replyTo, sentAt } = job.payload;
  const text = job.payload.text.trim();
  const state = liveCalendarState(await store.conversation(actor), actor, now);
  const pending = state?.pending ? state : null;
  const stateChat = state?.workflow?.chatId ?? state?.chatId;
  const sameChat = stateChat == null || stateChat === String(chatId);
  const entry = pending ? { kind:'pending', contextKey:calendarStateKey(pending) } : { kind:'fresh' };
  if (job.payload.button) return { ...entry, kind:'button' };
  if (/^\/\w+(?:@[\w]+)?(?:\s+[\s\S]+)?$/.test(text) || quickCommand(text)) return { ...entry, kind:'command' };
  const reference = await loadReplyReference(job, store);
  const validRef = isUsableCalendarReply(reference, job.payload, now);
  // A queued bare answer sent before the current question must not approve it on re-lease.
  const questionSecond = Math.floor((Date.parse(pending?.expiresAt) - conversationLifetimeMs) / 1000);
  const sentAfterQuestion = !Number.isFinite(sentAt) || sentAt >= questionSecond;
  const linked = pending && sameChat && sentAfterQuestion
    && (!replyTo || validRef && isCalendarQuestionReply(reference, pending, actor));
  const readTasks = includeIds => store.calendarTasks?.({ now, timeZone:(options.settings ?? defaults).timeZone, includeIds }) ?? store.tasks();
  if (pending && combinedSelection.test(text)) return { kind:'blocked', notice:calendarPendingNotice };
  if (linked) {
    const ids = pending.taskIds ?? [];
    const fixedKind = pending.request?.dateCompletion || pending.request?.seriesCancellation;
    if (pendingAnswer(text, pending, ids.length && !fixedKind ? await readTasks(ids) : [])) {
      return { ...entry, kind:'verified-followup', replyId:replyTo ? reference.messageId : null };
    }
  }
  const answer = text.replace(/[.!?\s]+$/u, '').replace(/(?:이요|요)$/u, '');
  const read = recentRead.test(text);
  const change = recentChange.test(text);
  const targetIds = replyTo ? validRef && !reference.pending && reference.taskIds
    : !pending && sameChat && (dependent.test(text) || change) && state?.taskIds;
  if (targetIds?.length && (read || change && targetIds.length === 1 && !(pending && acknowledgement.test(text)))) {
    return { ...entry, kind:'recent', recentKey:replyTo ? null : calendarStateKey(state),
      replyId:replyTo ? reference.messageId : null, targetIds, read };
  }
  if (acknowledgement.test(text) || selection.test(text) || dateAnswer.test(answer) || timeAnswer.test(answer)
      || dateAndTime.test(answer) || seriesScope.test(answer)) {
    return { kind:'blocked', notice:linked ? calendarPendingNotice : reference?.pending ? calendarContextChanged : unclearReply };
  }
  if ((read || change) && (dependent.test(text) || replyTo)) {
    return { kind:'blocked', notice:unclearReply };
  }
  if (!replyTo && !combinedSelection.test(text) && requestedCompletionTitle(text)) {
    const tasks = await readTasks([]);
    if (directCompletionTarget(text, tasks)) {
      const title = requestedCompletionTitle(text).normalize('NFKC');
      const task = tasks.find(task => isActive(task) && task.title.normalize('NFKC') === title);
      return { ...entry, kind:'direct-completion', target:{ id:task.id, version:task.version } };
    }
  }
  return entry;
}
