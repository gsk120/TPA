import { retrieveTasks } from './retrieval.js';
import { historyRequest } from './history-search.js';
import { isActive, planChanges } from './tasks.js';
import { addDays, today } from './time.js';
import { settingsText, validateSettings } from './settings.js';
import { nextConversation, selectContext, searchTerms, settingsIntent, summarizeHistory, validateClarification } from './context.js';
import { buttonFor } from './buttons.js';

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


function targetHints(text, now, timeZone) {
  const iso = text.match(/(?<!\d)(\d{4}-\d{2}-\d{2})(?!\d)/u);
  const date = text.match(/(?:(\d{4})\s*년\s*)?(\d{1,2})\s*월\s*(\d{1,2})\s*일|(?<!\d)(\d{1,2})\/(\d{1,2})(?!\d)/u);
  const relative = text.match(/오늘|내일|모레/u)?.[0];
  const clock = text.match(/(?:(오전|오후)\s*)?(\d{1,2})(?::(\d{2})|\s*시(?:\s*(반|\d{1,2}\s*분))?)/u);
  const day = iso?.[1] || (relative && addDays(today(now, timeZone), ['오늘','내일','모레'].indexOf(relative)));
  const pad = value => String(Number(value)).padStart(2, '0');
  const monthDay = date && pad(date[2] || date[4]) + '-' + pad(date[3] || date[5]);
  const hour = clock && (clock[1] ? Number(clock[2]) % 12 + (clock[1] === '오후' ? 12 : 0) : Number(clock[2]));
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

function duplicateTargets(text, tasks, completion, now, timeZone) {
  if (!completion && (!/(?:변경|수정|바꿔|미뤄|취소)/u.test(text)
      || /추가|등록|새로|알려|보여|조회/u.test(text))) return null;
  const names = [...new Set(tasks.map(t => t.title).filter(title => title && text.includes(title)))];
  const named = names.filter(title => !names.some(other => other !== title && other.includes(title)));
  if (named.length !== 1 || /(?:빼고|제외)/u.test(text)) return null;
  const [title] = named;
  const matches = tasks.filter(t => t.title === title);
  // For rescheduling, a date followed by 로/으로 is the destination.
  const qualifiers = text.replace(title, ' ').replace(
    completion ? /$^/u : /(?:오늘|내일|모레|\d{4}-\d{2}-\d{2}|(?:\d{1,2}\s*월\s*)?\d{1,2}\s*일|\d{1,2}\/\d{1,2}|\d{1,2}:\d{2}|(?:오전|오후)?\s*\d{1,2}\s*시)\s*(?:으?로|까지)/gu, ' '
  );
  const hint = targetHints(qualifiers, now, timeZone);
  if (matches.length < 2 && !hint) return null;
  return {
    candidates: hint ? matches.filter(hint) : matches,
    all: /(?:전부|모두|둘\s*다|전건|전체)/u.test(text.replace(title, ' '))
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
    message:job.payload, now, settings:current, tasks:[], history:[], context:previous.turns,
    pendingRequest:previous.request, intent
  }, signal);
  verifyIntent(intent, answer);
  const clarification = validateClarification(answer.clarification, []);
  if (clarification && (answer.actions.length || answer.settings || answer.retrieval)) {
    throw new Error('AI 응답에 확인 질문과 실행 요청이 섞였어요. 다시 말씀해주세요.');
  }
  const changes = planChanges(answer.actions, [], now);
  const retrieval = answer.retrieval ? retrieveTasks(await loadTasks(), answer.retrieval, now, current.timeZone) : null;
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

export async function planNatural({job, store, ai, now, signal, options, current, tasks, originalText,
  previous, reference, buttonInput, classification, resumedIntent, resumed}) {
  let reply, changes = [], settingsChange = null, refs = [], conversation = null, retrievalReply = null, button = null;
  const intent = classification?.intent ?? resumedIntent;
  const existingTarget = ['update','complete','cancel','mixed'].includes(intent);
  const completion = resumed ? false : intent && intent !== 'existing'
    ? intent === 'complete' : isCompletionRequest(originalText);
  const activeTasks = completion ? tasks.filter(isActive) : tasks;
  const hasIndependentIntent = classification && !resumed && !['unknown','mixed'].includes(intent);
  const freshState = hasIndependentIntent ? null : previous;
  const selection = buttonInput ? {
    candidates:[buttonInput.task], context:[], request:buttonInput.action.request,
    continuation:true, coverage:{scope:'button', providedTaskCount:1}
  } : classification?.intent === 'history'
    ? {candidates:[], context:[], continuation:false, request:null, coverage:{scope:'history', familyTaskCount:tasks.length, providedTaskCount:0}}
    : selectContext(activeTasks,job.payload,freshState,reference,now,current.timeZone,classification?.targets);
  if (resumed && !buttonInput && !selection.continuation) {
    Object.assign(selection, {
      candidates: tasks.filter(t => previous.taskIds.includes(t.id)),
      continuation:true, request:previous.request, blocked:null,
      context:previous.turns || [], coverage:{scope:'followup', familyTaskCount:tasks.length}
    });
  }
  if (selection.request?.operation === 'weekly') {
    const reply = selection.request.question;
    return {reply};
  }
  const awaitingTarget = previous?.pending && previous.actor === String(job.payload.actor)
    && Date.parse(previous.expiresAt) > +now && previous.request?.chooseByDate
    && (!job.payload.replyTo || (reference?.requestId === previous.requestId
      && reference.ownerActor === String(job.payload.actor) && reference.chatId === String(job.payload.chatId)));
  const dateReply = !buttonInput && awaitingTarget
    && /^(?:(?:오늘|내일|모레)|(?:\d{4}-\d{2}-\d{2})|(?:\d{1,2}\/\d{1,2})|(?:(?:\d{4}\s*년\s*)?\d{1,2}\s*월\s*\d{1,2}\s*일)|(?:(?:오전|오후)\s*)?\d{1,2}(?::\d{2}|\s*시(?:\s*(?:반|\d{1,2}\s*분))?))(?:\s*(?:거|것|건|일정))?(?:이요|요)?[.!\s]*$/u.test(originalText);
  const exactScope = (!intent || intent === 'existing' || existingTarget) && !resumed && !buttonInput && !job.payload.replyTo && !dateReply
    ? duplicateTargets(originalText, activeTasks, completion, now, current.timeZone) : null;
  if (dateReply) {
    const filter = targetHints(originalText, now, current.timeZone);
    const candidates = tasks.filter(t => previous.taskIds.includes(t.id)
      && (!isCompletionRequest(previous.request.originalText) || isActive(t)));
    Object.assign(selection, {
      candidates: candidates.filter(filter), continuation:true, request:previous.request, blocked:null, context:[],
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
  if (completing && selection.candidates.some(t => !isActive(t))) {
    if (buttonInput) throw new Error('선택한 일정이 이미 완료됐거나 취소됐어요.');
    selection.blocked = '이전 후보에 이미 완료됐거나 취소된 일정이 있어요. 완료할 일정 제목을 다시 알려주세요.';
    selection.candidates = selection.candidates.filter(isActive);
  }
  if (completing && !dateReply && !selection.candidates.length && !selection.blocked) {
    selection.blocked = '완료할 미완료 일정을 찾지 못했어요. 일정 제목이나 날짜를 확인해주세요.';
  }
  let clarification=null;
  refs=selection.candidates;
  const requestedTitle = !resumed && requestedCompletionTitle(originalText);
  const directCompletion = requestedTitle && refs.length === 1 && isActive(refs[0])
    && refs[0].title.normalize('NFKC') === requestedTitle.normalize('NFKC');
  let chooseByDate = false;
  if ((exactScope && !exactScope.all && refs.length > 1) || (dateReply && refs.length !== 1)) {
    if (dateReply && !refs.length) {
      refs = tasks.filter(t => previous.taskIds.includes(t.id) && (!completing || isActive(t)));
      reply = '❓ 그 날짜나 시각에 해당하는 일정을 찾지 못했어요. 원래 일정의 날짜나 시각을 다시 알려주세요.';
    } else if (refs.length <= 3 && new Set(refs.map(choiceLabel)).size === refs.length) {
      refs = [...refs].sort((a,b) => choiceLabel(a).localeCompare(choiceLabel(b)));
      reply = '❓ 어느 일정을 처리할까요?';
      clarification = {operation:'update', candidateIds:refs.map(t => t.id)};
    } else {
      reply = `❓ 후보가 ${refs.length}건 있어요. 원래 일정의 날짜나 시각을 알려주세요.`;
    }
    chooseByDate = true;
  } else if (exactScope && !refs.length && !selection.blocked) {
    reply = '❓ 지정한 날짜나 시각에 해당하는 일정을 찾지 못했어요.';
  } else if (exactScope?.all && refs.length > 20) {
    reply = '한 번에 최대 20건을 변경할 수 있어요. 기간을 좁혀 알려주세요.';
  } else if(selection.blocked){
    reply='❓ 대상을 확인해주세요\n\n'+selection.blocked+(refs.length?'\n\n'+refs.slice(0,10).map(t=>`${t.title} · ${t.dueDate||'날짜 미정'}`).join('\n'):'');
  } else if (directCompletion) {
    const [task] = refs;
    changes = planChanges([{
      operation:'update', id:task.id, expectedVersion:task.version,
      task:{...task, status:'done', remindAt:[]}, reason:'사용자의 완료 요청'
    }], tasks, now);
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
    if (exactScope && !exactScope.all && refs.length === 1) input.selectedTaskId = refs[0].id;
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
      if(answer.retrieval){
        if(answer.clarification)throw new Error('조회 범위와 확인 질문이 충돌해요. 저장하지 않았습니다.');
        const result=retrieveTasks(tasks,answer.retrieval,now,current.timeZone);
        refs=result.tasks;retrievalReply=result.reply;
      }
      clarification=validateClarification(answer.clarification,selectedIds);
      if(clarification&&(answer.actions.length||answer.settings))throw new Error('AI 응답에 확인 질문과 저장 요청이 섞였어요. 저장하지 않았습니다.');
      const intentText=selection.continuation?(selection.request?.originalText||'')+' '+originalText:originalText;
      const explicitChange=/(추가|새로|바꿔|변경|미뤄|완료|취소|수정|끝|했어|했음|켜줘|꺼줘|중지해|재개해)/.test(intentText.replace(/완료(?:한|된|했던|됐던)/gu, ''));
      if(answer.retrieval&&explicitChange&&!answer.actions.length&&!answer.settings)throw new Error('AI 응답에서 함께 요청한 변경이 빠졌어요. 저장하지 않았습니다. 변경할 일정과 내용을 다시 말씀해주세요.');
      const readOnly=!!historyQuery||(selection.request?.operation==='detail'||/^\/detail\b/.test(selection.request?.originalText||'')||/(알려|보여|띄워|조회|언제|왜|어때|뭐|있어\??)/.test(intentText))&&!explicitChange;
      if(readOnly&&(answer.actions.length||answer.settings))throw new Error('AI 응답이 조회 요청을 변경으로 해석했어요. 저장하지 않았습니다.');
      if(/(바꿔|변경|미뤄|완료|취소|수정|끝)/.test(intentText)&&!/추가|새로/.test(intentText)&&answer.actions.some(a=>a.operation==='create'))throw new Error('AI 응답이 기존 일정 변경을 신규 추가로 해석했어요. 제목을 확인해주세요.');
      if(answer.actions.some(a=>a.operation==='update'&&!selectedIds.includes(a.id)))throw new Error('AI 응답의 변경 대상이 검증된 후보 범위 밖이에요. 제목을 지정해 다시 요청해주세요.');
      if(settingsIntent(intentText)&&answer.actions.length)throw new Error('AI 응답이 알림 설정과 일정 변경을 혼동했어요. 원하시는 알림 시각을 다시 말씀해주세요.');
      if(answer.settings){const after=validateSettings(answer.settings);settingsChange={before:current,after,version:options.settingsVersion||1};}
      if ((buttonInput || dateReply) && (answer.actions.length !== 1 || answer.actions[0].operation !== 'update'
          || answer.actions[0].id !== selectedIds[0] || answer.settings || answer.retrieval
          || (completing && answer.actions[0].task.status !== 'done'))) {
        throw new Error('선택한 일정에 원래 요청을 적용하지 못했어요. 제목과 변경 내용을 다시 알려주세요.');
      }
      const named = activeTasks.filter(t => t.title && intentText.includes(t.title));
      const distinctNames = named.filter(t => !named.some(other => other.title !== t.title && other.title.includes(t.title)));
      const scopes = buttonInput ? [] : completionScopes(intentText, activeTasks);
      const completionCount = scopes.length;
      if (!buttonInput && explicitChange && !/추가|새로|빼고|제외/u.test(intentText)
          && new Set(distinctNames.map(t => t.title)).size > 1) {
        for (const title of new Set(distinctNames.map(t => t.title))) {
          scopes.push(distinctNames.filter(t => t.title === title).map(t => t.id));
        }
      }
      const changedIds = new Set(answer.actions.filter(a => a.operation === 'update').map(a => a.id));
      if (exactScope?.all && (changedIds.size !== selectedIds.length
          || selectedIds.some(id => !changedIds.has(id)) || (completing && answer.actions.some(a => a.task.status !== 'done')))) {
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
      if (resumed && answer.actions.some(a => a.operation === 'update'
          && previous.workflow.versions?.[a.id] !== a.expectedVersion)) {
        throw new Error('확인하는 동안 일정이 바뀌었어요. 현재 일정으로 다시 요청해주세요.');
      }
      changes=planChanges(answer.actions,tasks,now);
      if(answer.retrieval&&changes.length){
        const projected=new Map(tasks.map(t=>[t.id,t]));for(const c of changes)projected.set(c.after.id,c.after);
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
  if (chooseByDate) conversation.request.chooseByDate = true;
  if (conversation.pending && intent && intent !== 'existing' && conversation.request.operation === 'unknown') {
    conversation.request.operation = intent;
  }
  if (!buttonInput && clarification?.operation === 'update' && refs.length >= 2 && refs.length <= 3
      && (chooseByDate || (!/(둘\s*다|모두|전부|각각)/u.test(originalText)
        && searchTerms(originalText).some(term => refs.every(t => t.title.includes(term)))
        && new Set(refs.filter(t => originalText.includes(t.title)).map(t => t.title)).size < 2))) {
    const labels = refs.map(choiceLabel);
    if (new Set(labels).size === labels.length) {
      button = buttonFor(job, now, {
        kind:'select', requestId:conversation.requestId, text:conversation.request.originalText, request:conversation.request,
        targets:refs.map(({id, version}) => ({id, version}))
      }, labels);
    }
  }
  return {reply, changes, settingsChange, refs, conversation, retrievalReply, button};
}

function verifyIntent(intent, {actions, retrieval, settings}) {
  if (!intent || ['existing','mixed'].includes(intent)) return;
  const expectedOperation = intent === 'create' ? 'create'
    : ['update','complete','cancel'].includes(intent) ? 'update' : null;
  const expectedStatus = {complete:'done', cancel:'cancelled'}[intent];
  if (actions.some(a => a.operation !== expectedOperation || (expectedStatus && a.task?.status !== expectedStatus))
      || (retrieval && intent !== 'retrieve') || (settings && intent !== 'settings')) {
    throw new Error('AI 응답이 요청한 작업 종류와 일치하지 않아요. 다시 말씀해주세요.');
  }
}
