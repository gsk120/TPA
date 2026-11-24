import { isDeepStrictEqual } from 'node:util';
import { retrieveTasks } from './retrieval.js';
import { historyRequest } from './history-search.js';
import { isActive, planChanges } from './tasks.js';
import { addDays, today, validDay } from './time.js';
import { settingsText, validateSettings } from './settings.js';
import { allCandidateDecision, matchTarget, nextConversation, selectContext, searchTerms, selectedDetail, settingsIntent, summarizeHistory, validateClarification } from './context.js';
import { buttonFor } from './buttons.js';
import { missingSeriesFields, planSeriesRegistration, readSeriesDraft } from './weekly.js';

// A request with separately stated completion clauses must cover each clause.
function completionScopes(text, tasks) {
  const clauses = text.split(/완료(?:했(?:어|고|음)|하고)|(?:도\s*)했(?:어|고|음)/u)
    .map(searchTerms).filter(terms => terms.length);
  if (clauses.length < 2 || !/완료/u.test(text) || !/했어|했음|완료해/u.test(text)) return [];
  return clauses.map(terms => tasks.filter(t => terms.some(term =>
    t.title.normalize('NFKC').toLowerCase().includes(term.toLowerCase()))).map(t => t.id));
}

function isCompletionRequest(text) {
  return /(?:완료\s*(?:해\s*줘|해\s*주세요|처리해\s*줘|처리해\s*주세요|처리|했어|했음|했어요|했고|하고)?|끝냈어|끝났어|끝|다\s*했어|했어|했음)[.!?\s]*$/u.test(text)
    && !/(?:추가|등록|완료\s*(?:취소|해제)|되돌려|되돌리기)/u.test(text);
}

function isUpdateRequest(text) {
  return /(?:변경|수정|연기)(?:\s*(?:해|하|할|부탁)|[.!?\s]*$)|바꿔|바꾸|미뤄|미루|옮겨|옮기|앞당겨|앞당기|메모\s*(?:추가|남겨)/u.test(text);
}

function isCancellationRequest(text) {
  return /(?:취소|삭제)(?:\s*(?:해|하|할|부탁)|[.!?\s]*$)/u.test(text)
    && !/완료\s*(?:취소|해제)|되돌려|되돌리기/u.test(text);
}

const targetDatePattern = /(?<!\d)(\d{4}-\d{2}-\d{2})(?!\d)|(?:(\d{4})\s*년\s*)?(\d{1,2})\s*월\s*(\d{1,2})\s*일|(?<![\d/])(\d{1,2})\/(\d{1,2})(?![\d/])|그제|어제|오늘|내일|모레/gu;
const targetClockPattern = /(?:(오전|오후|밤|새벽|낮)\s*)?(\d{1,2})(?::(\d{2})|\s*시(?:\s*(반|\d{1,2}\s*분))?)/u;
const padDatePart = value => String(Number(value)).padStart(2,'0');
const destinationPattern = new RegExp(
  '(?:'+targetDatePattern.source+')(?:\\s*(?:'+targetClockPattern.source+'))?\\s*'+
  '(?:으?로|까지|에(?=\\s*(?:옮|미루|미뤄|연기|변경|바꿔|바꾸|앞당)))|(?:'+targetClockPattern.source+')\\s*(?:으?로|까지)','gu');

function withoutDestination(text) {
  return text.replace(destinationPattern,' ');
}

function explicitTargetDay(text,now,timeZone,completion,tasks,titles) {
  const qualifiers=titles.reduce((rest,title)=>rest.replaceAll(title,' '),text);
  const source=completion ? qualifiers : withoutDestination(qualifiers);
  const dates=[...source.matchAll(targetDatePattern)];
  if (dates.length!==1 || /^\s*(?:부터|까지|~|～|사이)/u.test(source.slice(dates[0].index+dates[0][0].length))) return null;
  const [[token,iso,year,month,day,slashMonth,slashDay]]=dates;
  const localToday=today(now,timeZone);
  const relative=['그제','어제','오늘','내일','모레'].indexOf(token);
  if (relative>=0) return addDays(localToday,relative-2);
  const monthDay=padDatePart(month ?? slashMonth)+'-'+padDatePart(day ?? slashDay);
  const nearbyDays=year || iso ? [] : [...new Set(tasks.filter(task=>
    isActive(task) && task.dueDate?.endsWith('-'+monthDay) &&
    titles.some(title=>task.title===title)).map(task=>task.dueDate))];
  const result=iso ?? nearbyDays[0] ?? ((year ?? localToday.slice(0,4))+'-'+monthDay);
  return nearbyDays.length<=1 && validDay(result) ? result : null;
}

function targetHints(text, now, timeZone) {
  const iso = text.match(/(?<!\d)(\d{4}-\d{2}-\d{2})(?!\d)/u);
  const date = text.match(/(?:(\d{4})\s*년\s*)?(\d{1,2})\s*월\s*(\d{1,2})\s*일|(?<!\d)(\d{1,2})\/(\d{1,2})(?!\d)/u);
  const relative = text.match(/오늘|내일|모레/u)?.[0];
  const clock = text.match(targetClockPattern);
  const day = iso?.[1] || (relative && addDays(today(now, timeZone), ['오늘','내일','모레'].indexOf(relative)));
  const pad = value => String(Number(value)).padStart(2, '0');
  const monthDay = date && pad(date[2] || date[4]) + '-' + pad(date[3] || date[5]);
  const hour = clock && (clock[1] ? Number(clock[2]) % 12 + (['오후','밤','낮'].includes(clock[1]) ? 12 : 0) : Number(clock[2]));
  const minute = clock && (clock[3] || (clock[4] === '반' ? 30 : parseInt(clock[4], 10) || 0));
  if (!(day || monthDay || clock)) return null;
  return task => (!day || task.dueDate === day)
    && (!monthDay || (date[1] ? task.dueDate === date[1] + '-' + monthDay : task.dueDate?.endsWith('-' + monthDay)))
    && (!clock || task.time === pad(hour) + ':' + pad(minute));
}

function choiceLabel(task) {
  return Array.from((task.dueDate || '날짜 미정') + (task.time ? ' ' + task.time : '') + ' · ' + task.title)
    .slice(0, 64).join('');
}

function choiceLabels(tasks) {
  const labels=tasks.map(choiceLabel);
  return labels.map((label,index)=> {
    if (labels.indexOf(label)===labels.lastIndexOf(label)) return label;
    const {person,assignee,timeNote}=tasks[index];
    const detail=[person,assignee,timeNote].filter(Boolean).join(' · ').replace(/[\r\n]+/gu,' ');
    return detail ? Array.from(label).slice(0,32).join('')+' · '+Array.from(detail).slice(0,29).join('') : label;
  });
}

function duplicateTargets(text, tasks, completion, now, timeZone, knownTasks=tasks) {
  if (!completion && (!(isUpdateRequest(text) || isCancellationRequest(text))
      || /추가|등록|새로|알려|보여|조회/u.test(text))) return null;
  const names = [...new Set(knownTasks.map(t => t.title).filter(title => title && text.includes(title)))];
  const named = names.filter(title => !names.some(other => other !== title && other.includes(title)));
  if (named.length !== 1 || /(?:빼고|제외)/u.test(text)) return null;
  const [title] = named;
  const matches = tasks.filter(t => t.title === title);
  // For rescheduling, a date followed by 로/으로 is the destination.
  const targetText = text.replace(title,' ');
  const qualifiers = completion ? targetText : withoutDestination(targetText);
  const hint = targetHints(qualifiers, now, timeZone);
  const all = /(?:전부|모두|둘\s*다|전건|전체)/u.test(text.replace(title, ' '));
  if (matches.length === 1 && !hint && !all) return null;
  return {
    candidates: hint ? matches.filter(hint) : matches,
    all
  };
}

export function directCompletionTarget(text, tasks) {
  const title = requestedCompletionTitle(text);
  return title && tasks.filter(t => isActive(t) && t.title.normalize('NFKC') === title.normalize('NFKC')).length === 1;
}
export function requestedCompletionTitle(text) {
  return text.match(/^(.+?)\s+완료(?:\s*처리)?(?:\s*해\s*(?:줘|주세요)|했어요|했어|했음)?[.!]*$/u)?.[1];
}

export async function planWithoutTarget({job, ai, signal, now, options, current, loadTasks, originalText,
  classification, previous, resumedIntent}) {
  const intent = classification?.intent ?? resumedIntent;
  const answer = classification?.answer ?? await ai.answer({
    message:job.payload, now, settings:current, tasks:[], history:[], context:previous?.turns ?? [],
    pendingRequest:resumedIntent ? previous?.request : null, intent
  }, signal);
  verifyIntent(intent, answer);
  let clarification = validateClarification(answer.clarification, []);
  const previousDraft = resumedIntent === 'create' ? previous?.request.seriesDraft : null;
  const rawDraft = answer.series ?? previousDraft;
  const draft = rawDraft == null ? null : readSeriesDraft(rawDraft);
  const explicitLunar=/음력|윤달/u.test(originalText) && !/양력/u.test(originalText);
  if (draft?.calendarSystem==='lunar' ||
      previousDraft?.calendarSystem==='lunar' && !/양력/u.test(originalText) ||
      explicitLunar && (draft?.frequency==='YEARLY' || /매년|해마다|연간\s*반복/u.test(originalText))) {
    return {reply:'음력 반복의 등록은 Google Calendar에서 해주세요. TPA에서는 Google의 실제 회차를 읽기 전용으로 조회할 수 있어요.'};
  }
  if (draft && (answer.actions.length || answer.settings || answer.retrieval)) {
    throw new Error('반복 일정과 개별 일정 변경이 함께 반환되어 저장을 보류했어요.');
  }
  if (clarification && (answer.actions.length || answer.settings || answer.retrieval)) {
    throw new Error('AI 응답에 확인 질문과 실행 요청이 섞였어요. 다시 말씀해주세요.');
  }
  if (draft) {
    const sentAt = Number.isSafeInteger(job.payload.sentAt) ? new Date(job.payload.sentAt * 1000) : now;
    const requestedAt = resumedIntent ? new Date(previous.request.startedAt) : sentAt;
    const timeZone = resumedIntent ? previous.request.timeZone : current.timeZone;
    const missing = missingSeriesFields(draft);
    if (!clarification && (missing.length || answer.series == null)) {
      clarification = {operation:'create',candidateIds:[],proposedChanges:[],
        question:missing.length ? '반복 등록할 일정의 ' + missing.join(', ') + '을 알려주세요.'
          : '반복 일정에 적용할 내용을 다시 알려주세요.',unresolved:missing.join(', ')};
    }
    const plan = clarification ? {reply:'❓ 확인이 필요해요\n\n' + clarification.question}
      : planSeriesRegistration(draft,requestedAt,timeZone,job.payload.actor);
    const conversation = nextConversation(job.payload.actor,originalText,plan.reply,[],
      resumedIntent ? previous : null,now,{continuation:!!resumedIntent,timeZone,clarification});
    conversation.request.startedAt = requestedAt.toISOString();
    if (clarification) {
      conversation.request.operation = 'create';
      conversation.request.seriesDraft = draft;
    } else {
      conversation.pending = false;
      conversation.request.question = null;
      delete conversation.request.seriesDraft;
    }
    return {...plan,conversation};
  }
  const changes = planChanges(answer.actions, [], now);
  const retrieval = answer.retrieval ? retrieveTasks(await loadTasks(answer.retrieval), answer.retrieval, now, current.timeZone) : null;
  const refs = retrieval?.tasks ?? [];
  const settingsChange = answer.settings ? {
    before:current, after:validateSettings(answer.settings), version:options.settingsVersion || 1
  } : null;
  const reply = clarification ? '❓ 확인이 필요해요\n\n' + clarification.question
    : retrieval?.reply ?? (settingsChange ? '✅ 알림 설정 저장 완료\n\n' + settingsText(settingsChange.after)
      : changes.length ? '' : '📋 안내\n\n' + answer.reply);
  const conversation = nextConversation(job.payload.actor, originalText, reply,
    changes.length ? changes.map(({after}) => after.id) : refs.map(t => t.id),
    resumedIntent ? previous : null, now, {continuation:!!resumedIntent, timeZone:current.timeZone, clarification});
  if (conversation.pending && conversation.request.operation === 'unknown') conversation.request.operation = intent;
  return {reply, changes, refs, settingsChange, conversation};
}

async function planSeriesCancellation({job, store, now, current, originalText, previous, classification}) {
  const pending = previous?.request.seriesCancellation;
  const cancellation = classification?.intent === 'cancel' ? classification.cancellation : null;
  const targets = classification?.intent === 'cancel' && classification.targets.length
    ? classification.targets : pending?.targets ?? [];
  const series = targets.length === 1 ? matchTarget(await store.activeScheduleSeries(), targets[0]) : [];
  const candidates = cancellation?.date ? series.filter(item => item.start.startsWith(cancellation.date)) : series;
  const versions = Object.keys(pending?.versions ?? {}).length ? pending.versions
    : Object.fromEntries(series.map(({id, version}) => [id, version]));
  if (cancellation?.scope === 'series' && targets.length === 1 && !candidates.length) {
    const reply = pending ? '확인하는 동안 대상 반복 일정이 바뀌었어요.' : '취소할 활성 반복 일정이 없어요.';
    const conversation = nextConversation(job.payload.actor,originalText,reply,[],previous,now,
      {continuation:!!pending,timeZone:current.timeZone});
    return {reply,conversation};
  }
  if (cancellation?.scope === 'series' && candidates.length === 1) {
    const [{id, version, title}] = candidates;
    if (Object.keys(versions).length && versions[id] !== version) {
      throw new Error('확인하는 동안 반복 일정이 바뀌었어요. 현재 일정으로 다시 요청해주세요.');
    }
    const reply = '✅ 반복일정 전체 취소 완료\n\n' + title;
    const conversation = nextConversation(job.payload.actor, originalText, reply, [], previous, now,
      {continuation:!!pending,timeZone:current.timeZone});
    conversation.pending = false;
    conversation.request.question = null;
    delete conversation.request.seriesCancellation;
    return {reply, conversation, seriesCancellation:{id, version}};
  }
  const question = cancellation?.question ?? (!cancellation ? previous?.request.question : null)
    ?? (candidates.length > 1 ? '어느 반복일정 전체를 취소할까요? 시작 날짜와 제목을 알려주세요.'
      : '취소할 반복일정 하나의 제목과 시작 날짜를 알려주세요.');
  const list = candidates.length > 1 && !cancellation?.question
    ? '\n\n' + candidates.slice(0, 10).map(item => '• ' + item.title + ' · 시작 ' + item.start.replace('T', ' ').slice(0,16)).join('\n')
    : '';
  const reply = !cancellation && previous?.request.question ? question : '❓ 확인이 필요해요\n\n' + question + list;
  const conversation = nextConversation(job.payload.actor, originalText, reply, [], previous, now,
    {continuation:!!pending,timeZone:current.timeZone,clarification:{operation:'cancel'}});
  conversation.request.seriesCancellation = {targets, versions};
  return {reply, conversation};
}

// Both exact-title and date-selected completion use the existing multi-action validator/store.
function completionChanges(tasks, now) {
  return planChanges(tasks.map(task => ({
    operation:'update', id:task.id, expectedVersion:task.version,
    task:{...task, status:'done', remindAt:[]}, reason:'사용자의 완료 요청'
  })), tasks, now).map(change=>({...change,requireActive:true}));
}

async function planDateCompletion({job, now, current, loadTasks, originalText, previous, classification}) {
  const pending = previous?.request.dateCompletion;
  const completion = classification?.completion;
  const timeZone = previous?.request.timeZone ?? current.timeZone;
  const date = pending?.targets ? pending.date : completion?.date ?? null;
  const response = (reply, refs = [], waiting = false, selection = null, changes = []) => {
    const conversation = nextConversation(job.payload.actor, originalText, reply, refs.map(t => t.id),
      previous, now, {continuation:!!previous, timeZone});
    conversation.pending = waiting;
    conversation.request.operation = 'complete';
    conversation.request.question = waiting ? reply : null;
    if (waiting) conversation.request.dateCompletion = selection;
    else delete conversation.request.dateCompletion;
    return {reply, refs, conversation, changes};
  };
  const rejected = /^(?:아니|아니요|아니오|거절|취소|안\s*할래)(?:요)?[.!\s]*$/u.test(originalText.trim());
  if (pending && rejected) return response('완료 요청을 취소했어요. 일정은 변경하지 않았어요.');
  if (!date) {
    return response('❓ ' + (completion?.question ?? '완료할 하루의 날짜를 알려주세요.'), [], true,
      {date:null, targets:null});
  }
  if (pending?.targets) {
    const approved = /^(?:응|네|예|맞아|승인|좋아|모두|전부)(?:요)?[.!\s]*$/u.test(originalText.trim());
    if (!approved) return response(previous.request.question, pending.targets, true, pending);
  }
  // Explicit range reads include past/future virtual occurrences and apply existing overlap rules.
  const loaded = await loadTasks({from:date,to:date,timeZone});
  const fixedIds = pending?.targets && new Set(pending.targets.map(target => target.id));
  const result = retrieveTasks(fixedIds ? loaded.filter(task => fixedIds.has(task.id)) : loaded,
    {kind:'task_list',status:'active',from:date,to:date,person:null,search:null}, now, timeZone);
  if (pending?.targets) {
    const byId = new Map(result.tasks.map(task => [task.id,task]));
    const selected = pending.targets.map(target => byId.get(target.id));
    if (result.truncated || selected.some((task, i) => !task || task.version !== pending.targets[i].version
        || !isDeepStrictEqual(task.recurrence ?? null, pending.targets[i].recurrence))) {
      return response('확인하는 동안 일정이 바뀌었어요. 저장하지 않았어요. 현재 일정으로 다시 요청해주세요.');
    }
    return response('', selected, false, null, completionChanges(selected,now));
  }
  if (!result.total) return response(date + '에 완료할 미완료 일정이 없어요.');
  if (result.total > 20) {
    return response(date + ' 미완료 일정 ' + result.total + '건이 있어요. 기존 1회 변경 한도(20건)를 넘어 저장하지 않았어요. 날짜 전체 완료의 한도 초과 처리는 별도 결정이 필요해요.');
  }
  if (result.truncated) return response('대상 자료의 조회 한도를 넘어 저장하지 않았어요. 대상을 좁혀 다시 요청해주세요.');
  const refs = result.tasks;
  const reply = date + ' 미완료 일정 ' + refs.length + '건이 있습니다.\n\n'
    + refs.map((task,i) => `${i+1}. ${task.title.replace(/[\r\n]+/g,' ')} · ${task.dueDate}${task.time ? ' ' + task.time : ''}`).join('\n')
    + `\n\n${refs.length}건 모두 완료할까요? (네 / 아니요)`;
  // nextConversation historically truncates questions/turns; retain this complete approval list.
  if (reply.length > 16000) return response('대상 목록의 표시 한도를 넘어 저장하지 않았어요. 대상을 좁혀 다시 요청해주세요.');
  return response(reply, refs, true, {date, targets:refs.map(task => ({
    id:task.id, version:task.version, recurrence:task.recurrence ?? null,
    title:task.title, dueDate:task.dueDate, time:task.time
  }))});
}

export async function planNatural({job, store, ai, now, signal, options, current, tasks, loadTasks, originalText,
  previous, reference, buttonInput, classification, resumedIntent, resumed, verified, recentScope}) {
  let reply, changes = [], settingsChange = null, refs = [], conversation = null, retrievalReply = null, button = null;
  if (resumed && previous.request.dateCompletion
      || classification?.intent === 'complete' && classification.completion && classification.completion.scope !== 'named') {
    return planDateCompletion({job,now,current,loadTasks,originalText,
      previous:resumed ? previous : null,classification});
  }
  const pendingSeries = resumed && previous.request.seriesCancellation;
  const cancellation = classification?.intent === 'cancel' ? classification.cancellation : null;
  const occurrence = cancellation?.scope === 'occurrence' ? cancellation : null;
  if (!occurrence && (cancellation || pendingSeries)) {
    return planSeriesCancellation({job,store,now,current,originalText,previous:pendingSeries ? previous : null,classification});
  }
  const intent = classification?.intent ?? resumedIntent;
  const cancelOccurrence = !!occurrence || (resumed && previous.request.cancelOccurrence);
  if (occurrence?.date) {
    const datedTasks = await loadTasks({from:occurrence.date,to:occurrence.date});
    tasks = [...new Map([...tasks,...datedTasks].map(task => [task.id,task])).values()];
  }
  const existingTarget = ['update','complete','cancel','mixed'].includes(intent);
  const completion = resumed ? false : intent && intent !== 'existing'
    ? intent === 'complete' : isCompletionRequest(originalText);
  const requestText = (resumed || verified || buttonInput) ? previous?.request?.originalText ?? originalText : originalText;
  const activeOnly = !recentScope?.read && (existingTarget || cancelOccurrence || completion
    || (resumed || verified || buttonInput) && previous?.request?.activeTargets
    || (!intent || intent === 'existing') && !settingsIntent(requestText)
      && (isCompletionRequest(requestText) || isUpdateRequest(requestText) || isCancellationRequest(requestText)));
  const dateScopedMutation = !cancelOccurrence && !recentScope && !buttonInput && !resumed && !verified && !job.payload.replyTo
    && (completion || intent==='update' || (!intent || intent==='existing') &&
      !settingsIntent(requestText) && !isCancellationRequest(requestText) && isUpdateRequest(requestText));
  let targetDay = null, candidateTasks = tasks;
  if (dateScopedMutation && loadTasks) {
    const titles = classification?.targets?.length ? classification.targets
      : [...new Set(tasks.map(task=>task.title).filter(title=>title && requestText.includes(title)))];
    const named = titles.filter(title=>!titles.some(other=>other!==title && other.includes(title)));
    if (named.length<=1) targetDay = explicitTargetDay(requestText,now,current.timeZone,completion,tasks,named);
    if (targetDay) {
      const datedTasks = await loadTasks({from:targetDay,to:targetDay});
      candidateTasks = datedTasks.filter(task=>task.dueDate===targetDay);
      tasks = [...new Map([...tasks,...candidateTasks].map(task=>[task.id,task])).values()];
    }
  }
  let activeTasks = activeOnly ? candidateTasks.filter(isActive) : candidateTasks;
  if (occurrence) {
    const request = pendingSeries ? previous.request : null;
    const targetText = classification.targets.reduce((text, title) => text.replace(title, ' '), originalText);
    const hint = targetHints(targetText, request ? new Date(request.startedAt) : now, request?.timeZone ?? current.timeZone);
    const versions = pendingSeries && Object.keys(pendingSeries.versions).length ? pendingSeries.versions : null;
    activeTasks = activeTasks.filter(t => t.recurrence
      && (!versions || versions[t.recurrence.seriesId] === t.recurrence.seriesVersion)
      && (!occurrence.date || t.dueDate === occurrence.date) && (!hint || hint(t)));
  }
  const hasIndependentIntent = classification && !resumed && !['unknown','mixed'].includes(intent);
  const freshState = hasIndependentIntent ? null : previous;
  const selection = recentScope ? {
    candidates:recentScope.targetIds.map(id => activeTasks.find(task => task.id === id || task.recurrence?.occurrenceId === id)).filter(Boolean),
    context:[], continuation:false, request:null, blocked:null, coverage:{scope:'reply'}
  } : buttonInput ? {
    candidates:[buttonInput.task], context:[], request:buttonInput.action.request,
    continuation:true, coverage:{scope:'button', providedTaskCount:1}
  } : classification?.intent === 'history'
    ? {candidates:[], context:[], continuation:false, request:null, coverage:{scope:'history', familyTaskCount:tasks.length, providedTaskCount:0}}
    : selectContext(activeTasks,pendingSeries ? {...job.payload,replyTo:null} : job.payload,
      pendingSeries ? null : freshState,reference,now,current.timeZone,
      occurrence && !classification.targets.length && pendingSeries ? pendingSeries.targets : classification?.targets);
  if (pendingSeries) {
    selection.continuation = true;
    selection.request = previous.request;
    selection.context = previous.turns || [];
  } else if ((resumed || verified) && !buttonInput && !selection.continuation) {
    Object.assign(selection, {
      candidates: activeTasks.filter(t => previous.taskIds.includes(t.id)),
      continuation:true, request:previous.request, blocked:null,
      context:previous.turns || [], coverage:{scope:'followup', familyTaskCount:tasks.length}
    });
  }
  if (activeOnly) selection.coverage.familyTaskCount = tasks.length;
  if (recentScope) {
    if (new Set(selection.candidates.map(task => task.id)).size !== recentScope.targetIds.length) {
      return {reply:'❓ 이어갈 일정을 확인하지 못했어요. 일정 제목을 포함해 다시 요청해주세요.'};
    }
    selection.coverage.providedTaskCount = selection.candidates.length;
  }
  if (selection.request?.operation === 'weekly') {
    const reply = '이전 반복 일정 요청을 새 등록 방식으로 처리하려면 원래 요청과 답변을 함께 다시 보내주세요.';
    return {reply};
  }
  const awaitingTarget = previous?.pending && previous.actor === String(job.payload.actor)
    && Date.parse(previous.expiresAt) > +now && previous.request?.chooseByDate
    && (!job.payload.replyTo || (reference?.requestId === previous.requestId
      && reference.ownerActor === String(job.payload.actor) && reference.chatId === String(job.payload.chatId)));
  const dateReply = !buttonInput && awaitingTarget
    && /^(?:(?:오늘|내일|모레)|(?:\d{4}-\d{2}-\d{2})|(?:\d{1,2}\/\d{1,2})|(?:(?:\d{4}\s*년\s*)?\d{1,2}\s*월\s*\d{1,2}\s*일)|(?:(?:오전|오후)\s*)?\d{1,2}(?::\d{2}|\s*시(?:\s*(?:반|\d{1,2}\s*분))?))(?:\s*(?:거|것|건|일정))?(?:이요|요)?[.!\s]*$/u.test(originalText);
  const exactScope = !recentScope && !occurrence && (!intent || intent === 'existing' || existingTarget) && !resumed && !buttonInput && !job.payload.replyTo && !dateReply
    ? duplicateTargets(originalText, activeTasks, completion, now, current.timeZone, tasks) : null;
  const pendingTargets = activeOnly && previous?.pending && !buttonInput && !pendingSeries && (resumed || verified || dateReply);
  const confirmAll = pendingTargets && previous.request.confirmAllCandidates;
  const decision = confirmAll ? allCandidateDecision(originalText) : null;
  const endPending = reply => {
    const conversation=nextConversation(job.payload.actor,originalText,reply,[],previous,now,
      {continuation:true,timeZone:current.timeZone});
    conversation.pending=false;
    conversation.request.question=null;
    return {reply,conversation};
  };
  if (decision === 'reject') return endPending('확인을 취소했어요.');
  const pickedId = pendingTargets && !confirmAll ? selectedDetail(originalText,previous.request) : null;
  const dateFilter = dateReply && targetHints(originalText,now,current.timeZone);
  const dateIds = dateFilter && previous.request.activeCandidateDates?.filter(dateFilter).map(task=>task.id);
  if (pendingTargets) {
    const previousIds = previous.request.candidateOrder ?? previous.taskIds;
    const checkedIds = pickedId ? [pickedId] : dateIds || previousIds;
    const byId=new Map(activeTasks.map(task=>[task.id,task]));
    if (checkedIds.some(id=>!byId.has(id) || previous.workflow?.versions?.[id] != null &&
        byId.get(id).version !== previous.workflow.versions[id])) {
      return endPending('확인하는 동안 대상 일정이 바뀌었어요. 현재 일정으로 다시 요청해주세요.');
    }
    if (confirmAll && decision !== 'approve') {
      return {reply:previous.request.question,refs:checkedIds.map(id=>byId.get(id)),
        conversation:structuredClone(previous)};
    }
    if (confirmAll) {
      selection.candidates=checkedIds.map(id=>byId.get(id));
      selection.blocked=null;
      selection.coverage.providedTaskCount=selection.candidates.length;
    }
  }
  if (dateReply) {
    const candidates = activeTasks.filter(t => previous.taskIds.includes(t.id));
    Object.assign(selection, {
      candidates: candidates.filter(task=>dateIds ? dateIds.includes(task.id) : dateFilter(task)),
      continuation:true, request:previous.request, blocked:null, context:[],
      coverage:{scope:'target-date', familyTaskCount:tasks.length}
    });
  } else if (exactScope) {
    Object.assign(selection, {
      candidates:exactScope.candidates, continuation:false, request:null, blocked:null, context:[],
      coverage:{scope:'same-title', familyTaskCount:tasks.length}
    });
  }
  if (exactScope || dateReply) {
    selection.coverage.matchingTaskCount = selection.candidates.length;
    selection.coverage.providedTaskCount = selection.candidates.length;
  }
  const completing = completion || resumedIntent === 'complete'
    || (selection.continuation && isCompletionRequest(selection.request?.originalText || ''));
  const cancelling = intent === 'cancel' || cancelOccurrence
    || activeOnly && isCancellationRequest(selection.request?.originalText ?? requestText);
  if (activeOnly && buttonInput && !isActive(buttonInput.task)) {
    throw new Error('선택한 일정이 이미 완료됐거나 취소됐어요.');
  }
  if (activeOnly && !selection.candidates.length && !dateReply) {
    const reply=cancelling ? '취소할 미완료 일정이 없어요.'
      : completing ? '완료할 미완료 일정이 없어요.' : '변경할 미완료 일정이 없어요.';
    return resumed ? endPending(reply) : {reply};
  }
  let clarification=null;
  refs=selection.candidates;
  const requestedTitle = !resumed && requestedCompletionTitle(originalText);
  const directCompletion = requestedTitle && refs.length === 1 && isActive(refs[0])
    && refs[0].title.normalize('NFKC') === requestedTitle.normalize('NFKC');
  let chooseByDate = false, confirmAllCandidates = false;
  const allRequested = !!(exactScope?.all || confirmAll);
  const sameSchedule = activeOnly && refs.length > 1 && refs.every(task=>
    task.title===refs[0].title && task.dueDate===refs[0].dueDate && task.time===refs[0].time);
  if ((!allRequested && (occurrence && !selection.blocked || exactScope || targetDay && !selection.blocked || sameSchedule) && refs.length > 1)
      || (dateReply && refs.length !== 1)) {
    if (dateReply && !refs.length) {
      refs = activeTasks.filter(t => previous.taskIds.includes(t.id));
      reply = '❓ 그 날짜나 시각에 해당하는 일정을 찾지 못했어요. 원래 일정의 날짜나 시각을 다시 알려주세요.';
    } else if (refs.length <= 3 && new Set(choiceLabels(refs)).size === refs.length) {
      refs = [...refs].sort((a,b) => choiceLabel(a).localeCompare(choiceLabel(b)));
      reply = '❓ 어느 일정을 처리할까요?';
      clarification = {operation:'update', candidateIds:refs.map(t => t.id)};
    } else if (sameSchedule && new Set(choiceLabels(refs)).size < refs.length) {
      reply = `제목과 날짜·시각이 같은 활성 일정이 ${refs.length}건 있어요. 모두 적용할까요?`;
      clarification = {operation:'update', candidateIds:refs.map(t => t.id)};
      confirmAllCandidates = true;
    } else {
      reply = `❓ 후보가 ${refs.length}건 있어요. 원래 일정의 날짜나 시각을 알려주세요.`;
    }
    chooseByDate = true;
  } else if ((occurrence || exactScope) && !refs.length && !selection.blocked) {
    reply = '❓ 지정한 날짜나 시각에 해당하는 일정을 찾지 못했어요.';
  } else if (allRequested && refs.length > 20) {
    reply = '한 번에 최대 20건을 변경할 수 있어요. 기간을 좁혀 알려주세요.';
  } else if(selection.blocked){
    reply='❓ 대상을 확인해주세요\n\n'+selection.blocked+(refs.length?'\n\n'+refs.slice(0,10).map(t=>`${t.title} · ${t.dueDate||'날짜 미정'}`).join('\n'):'');
  } else if (directCompletion) {
    const [task] = refs;
    changes = completionChanges([task], now);
  } else {
    const selectedIds=selection.candidates.map(t=>t.id);
    const historyQuery=!classification || ['history','mixed'].includes(intent) ? historyRequest(originalText,now,current.timeZone) : null;
    const noHistory = {events:[], total:0, truncated:false};
    const historyResult = historyQuery && store.searchHistory ? await store.searchHistory(historyQuery)
      : selectedIds.length && store.relatedHistory ? await store.relatedHistory(selectedIds) : noHistory;
    const history=summarizeHistory(historyResult.events);
    const coverage={...selection.coverage,historyTotal:historyResult.total,historyProvided:history.length,historyTruncated:historyResult.truncated,historyIsSummary:true,historySearch:historyQuery,delayRanking:historyResult.delayRanking||[]};
    const input={tasks:selection.candidates,history,context:selection.context,message:job.payload,now,settings:current,coverage,pendingRequest:selection.request,intent};
    if (dateReply) {
      input.now = new Date(selection.request.startedAt);
      input.settings = {...current, timeZone:selection.request.timeZone};
      input.selectedTaskId = refs[0].id;
    }
    if ((occurrence || targetDay || (exactScope && !exactScope.all)) && refs.length === 1) input.selectedTaskId = refs[0].id;
    if (pickedId) input.selectedTaskId = pickedId;
    if (confirmAll) {
      input.now = new Date(previous.request.startedAt);
      input.settings = {...current,timeZone:previous.request.timeZone};
      input.message = {...job.payload,text:previous.request.originalText+'\n지금 제시된 활성 일정 모두에 적용해줘.'};
    }
    if (buttonInput) {
      input.now = new Date(buttonInput.action.request.startedAt);
      input.settings = {...current, timeZone:buttonInput.action.request.timeZone};
      input.message = {text:originalText, actor:job.payload.actor, chatId:job.payload.chatId};
      input.selectedTaskId = buttonInput.task.id;
    }
    if(JSON.stringify(input).length>26000){reply='❓ 자료 범위를 좁혀주세요\n\n일정 제목이나 날짜를 더 구체적으로 알려주세요.';}
    else{
      const answer=await ai.answer(input,signal);
      if(!Array.isArray(answer.actions))throw new Error('AI 응답 형식을 확인하지 못했어요.');
      verifyIntent(intent, answer);
      if (recentScope && (answer.settings || answer.retrieval
          || answer.actions.some(action => recentScope.read || action.operation !== 'update'))) {
        throw new Error('AI 응답이 답장에 연결된 일정 범위를 벗어났어요.');
      }
      if (cancelOccurrence && (!allRequested && answer.actions.length > 1 || answer.actions.some(a =>
        a.operation !== 'update' || a.task?.status !== 'cancelled' || !tasks.find(t => t.id === a.id)?.recurrence))) {
        throw new Error('선택한 반복 회차 한 건의 취소를 확인하지 못했어요.');
      }
      if(answer.retrieval){
        if(answer.clarification)throw new Error('조회 범위와 확인 질문이 충돌해요. 저장하지 않았습니다.');
        const result=retrieveTasks(loadTasks ? await loadTasks(answer.retrieval) : tasks,answer.retrieval,now,current.timeZone);
        refs=result.tasks;retrievalReply=result.reply;
      }
      clarification=validateClarification(answer.clarification,selectedIds);
      if(clarification&&(answer.actions.length||answer.settings))throw new Error('AI 응답에 확인 질문과 저장 요청이 섞였어요. 저장하지 않았습니다.');
      const intentText=selection.continuation?(selection.request?.originalText||'')+' '+originalText:originalText;
      const explicitChange=/(추가|새로|바꿔|변경|미뤄|완료|취소|수정|끝|했어|했음|켜줘|꺼줘|중지해|재개해)/.test(intentText.replace(/완료(?:한|된|했던|됐던)/gu, ''));
      if(answer.retrieval&&explicitChange&&!answer.actions.length&&!answer.settings)throw new Error('AI 응답에서 함께 요청한 변경이 빠졌어요. 저장하지 않았습니다. 변경할 일정과 내용을 다시 말씀해주세요.');
      const readOnly=!!historyQuery||(selection.request?.operation==='detail'||/^\/detail\b/.test(selection.request?.originalText||'')||/(알려|보여|띄워|조회|언제|왜|어때|뭐|있어\??)/.test(intentText))&&!explicitChange;
      if(readOnly&&(answer.actions.length||answer.settings))throw new Error('AI 응답이 조회 요청을 변경으로 해석했어요. 저장하지 않았습니다.');
      if(/(바꿔|변경|미뤄|완료|취소|삭제|수정|끝)/.test(intentText)&&!/추가|새로/.test(intentText)&&answer.actions.some(a=>a.operation==='create'))throw new Error('AI 응답이 기존 일정 변경을 신규 추가로 해석했어요. 제목을 확인해주세요.');
      if(answer.actions.some(a=>a.operation==='update'&&!selectedIds.includes(a.id)))throw new Error('AI 응답의 변경 대상이 검증된 후보 범위 밖이에요. 제목을 지정해 다시 요청해주세요.');
      if(settingsIntent(intentText)&&answer.actions.length)throw new Error('AI 응답이 알림 설정과 일정 변경을 혼동했어요. 원하시는 알림 시각을 다시 말씀해주세요.');
      if(answer.settings){const after=validateSettings(answer.settings);settingsChange={before:current,after,version:options.settingsVersion||1};}
      if ((buttonInput || dateReply || pickedId) && (answer.actions.length !== 1 || answer.actions[0].operation !== 'update'
          || answer.actions[0].id !== (pickedId ?? selectedIds[0]) || answer.settings || answer.retrieval
          || (completing && answer.actions[0].task.status !== 'done'))) {
        throw new Error('선택한 일정에 원래 요청을 적용하지 못했어요. 제목과 변경 내용을 다시 알려주세요.');
      }
      const named = tasks.filter(t => t.title && intentText.includes(t.title));
      const distinctNames = named.filter(t => !named.some(other => other.title !== t.title && other.title.includes(t.title)));
      const scopes = buttonInput ? [] : completionScopes(intentText, activeTasks);
      const completionCount = scopes.length;
      if (!buttonInput && explicitChange && !/추가|새로|빼고|제외/u.test(intentText)
          && new Set(distinctNames.map(t => t.title)).size > 1) {
        for (const title of new Set(distinctNames.map(t => t.title))) {
          scopes.push(distinctNames.filter(t => t.title === title && isActive(t)).map(t => t.id));
        }
      }
      const changedIds = new Set(answer.actions.filter(a => a.operation === 'update').map(a => a.id));
      if (allRequested && (changedIds.size !== selectedIds.length || answer.actions.length !== selectedIds.length
          || selectedIds.some(id => !changedIds.has(id)) || (completing && answer.actions.some(a => a.task.status !== 'done'))
          || (cancelling && answer.actions.some(a => a.task.status !== 'cancelled')))) {
        const message = '❓ 요청 범위의 모든 일정을 변경할 수 없어 저장을 보류했어요. 변경할 기간이나 날짜를 알려주세요.';
        return {reply:message};
      }
      const incomplete = scopes.length && (
        scopes.some(ids => !ids.some(id => selectedIds.includes(id))) ||
        (changedIds.size && (completionCount > changedIds.size || scopes.some(ids => !ids.some(id => changedIds.has(id)))))
      );
      if (incomplete && (!selection.continuation || /^(응|네|예|맞아|둘\s*다|모두|전부)[야요!.\s]*$/u.test(originalText))) {
        const reply = '❓ 요청한 일정 중 일부를 확인하지 못했어요. 변경할 일정 제목을 각각 알려주세요.';
        return {reply, conversation:nextConversation(job.payload.actor, originalText, '', [], null, now)};
      }
      if (resumed && !pendingSeries && answer.actions.some(a => a.operation === 'update'
          && previous.workflow.versions?.[a.id] !== a.expectedVersion)) {
        throw new Error('확인하는 동안 일정이 바뀌었어요. 현재 일정으로 다시 요청해주세요.');
      }
      changes=planChanges(answer.actions,tasks,now,input.settings.timeZone).map(change=>{
        if (!change.before) return change;
        if (!isActive(change.before)) throw new Error('선택한 일정이 이미 완료됐거나 취소됐어요.');
        return {...change,requireActive:true};
      });
      if(answer.retrieval&&changes.length){
        const base=loadTasks ? await loadTasks(answer.retrieval) : tasks;
        const projected=new Map(base.map(t=>[t.id,t]));for(const c of changes)projected.set(c.after.id,c.after);
        const result=retrieveTasks([...projected.values()],answer.retrieval,now,current.timeZone);refs=result.tasks;retrievalReply=result.reply;
      }
      if(clarification?.operation === 'update' && clarification.candidateIds.length > 3) {
        refs = clarification.candidateIds.map(id => tasks.find(t => t.id === id));
        chooseByDate = true;
        reply = `❓ 후보가 ${refs.length}건 있어요. 원래 일정의 날짜나 시각을 알려주세요.`;
      } else if(clarification){refs=clarification.candidateIds.map(id=>tasks.find(t=>t.id===id));reply='❓ 확인이 필요해요\n\n'+clarification.question+(refs.length?'\n\n'+refs.map((t,i)=>`${i+1}. ${t.title} · ${t.dueDate||'날짜 미정'}`).join('\n'):'');}
      else reply=retrievalReply|| (settingsChange?'✅ 알림 설정 저장 완료\n\n'+settingsText(settingsChange.after):changes.length?'':'📋 안내\n\n'+answer.reply);
    }
  }
  conversation=nextConversation(job.payload.actor,originalText,reply||'',changes.length?changes.map(c=>c.after.id):refs.map(t=>t.id),selection.continuation?previous:null,now,{continuation:selection.continuation,timeZone:current.timeZone,clarification});
  if (cancelOccurrence) {
    delete conversation.request.seriesCancellation;
    conversation.request.cancelOccurrence = true;
  }
  if (chooseByDate) conversation.request.chooseByDate = true;
  if (conversation.pending && activeOnly) {
    conversation.request.activeTargets = true;
    conversation.request.activeCandidateDates = refs.map(({id,dueDate,time})=>({id,dueDate,time}));
  }
  if (confirmAllCandidates) {
    conversation.request.confirmAllCandidates = true;
    delete conversation.request.chooseByDate;
  }
  if (conversation.pending && intent && intent !== 'existing' && conversation.request.operation === 'unknown') {
    conversation.request.operation = intent;
  }
  if (!buttonInput && !confirmAllCandidates && clarification?.operation === 'update' && refs.length >= 2 && refs.length <= 3
      && (chooseByDate || (!/(둘\s*다|모두|전부|각각)/u.test(originalText)
        && searchTerms(originalText).some(term => refs.every(t => t.title.includes(term)))
        && new Set(refs.filter(t => originalText.includes(t.title)).map(t => t.title)).size < 2))) {
    const labels = choiceLabels(refs);
    if (new Set(labels).size === labels.length) {
      button = buttonFor(job, now, {
        kind:'select', requestId:conversation.requestId, text:conversation.request.originalText, request:conversation.request,
        targets:refs.map(({id, version}) => ({id, version}))
      }, labels);
    }
  }
  return {reply, changes, settingsChange, refs, conversation, retrievalReply, button};
}

function verifyIntent(intent, {actions, retrieval, settings, series}) {
  if (series != null && intent !== 'create') throw new Error('반복 일정 신규 등록 의도를 확인하지 못했어요.');
  if (!intent || ['existing','mixed'].includes(intent)) return;
  const expectedOperation = intent === 'create' ? 'create'
    : ['update','complete','cancel'].includes(intent) ? 'update' : null;
  const expectedStatus = {complete:'done', cancel:'cancelled'}[intent];
  if (actions.some(a => a.operation !== expectedOperation || (expectedStatus && a.task?.status !== expectedStatus))
      || (retrieval && intent !== 'retrieve') || (settings && intent !== 'settings')) {
    throw new Error('AI 응답이 요청한 작업 종류와 일치하지 않아요. 다시 말씀해주세요.');
  }
}
