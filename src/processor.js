import {retrieveTasks} from './retrieval.js';
import {formatList,formatReceipt,formatDetail,groupTasks} from './format.js';
import { listTasks, briefing } from './briefing.js';
import { addDays, dueBriefs, kst, today } from './time.js';
import {defaults,settingsText} from './settings.js';
import {quickCommand,nextConversation,detailQuery,detailCandidates,selectedDetail,followup,searchTerms,liveCalendarState,calendarStateKey} from './context.js';
import { calendarContextChanged, finishCalendarPending, inspectCalendarEntry, isCalendarQuestionReply, isUsableCalendarReply, loadReplyReference, pendingConfirmationAction } from './calendar-entry.js';

import { buttonFor } from './buttons.js';
import { directCompletionTarget, requestedCompletionTitle, planNatural, planWithoutTarget } from './natural.js';
import { PendingCheckpointError, runNaturalWorkflow } from './assistant/workflow.js';
import { errorFields, jobDebug, jobTrace } from './diagnostics.js';

async function isPendingAnswer(job, text, previous, reference, button, now, loadTasks) {
  if (!previous?.pending || previous.actor !== String(job.payload.actor)
      || (previous.workflow && previous.workflow.chatId !== String(job.payload.chatId))
      || Date.parse(previous.expiresAt) <= +now) return false;
  if (button) return true;
  if (/추가|새로|등록/u.test(text) && !(previous.request?.seriesDraft && job.payload.replyTo)) return false;
  if (job.payload.replyTo) {
    return reference?.pending && reference.requestId === previous.requestId
      && (!previous.workflow || reference.workflowToken === previous.workflow.token)
      && reference.ownerActor === String(job.payload.actor) && reference.chatId === String(job.payload.chatId)
      && Date.parse(reference.expiresAt) > +now;
  }
  const namedCommand = /완료|변경|바꿔|미뤄|취소|삭제|수정|조회|보여|알려/u.test(text) && searchTerms(text).length;
  if (previous.request?.dateCompletion && !namedCommand) {
    return !previous.request.dateCompletion.targets && text.length <= 80
      || /^(?:응|네|예|맞아|승인|좋아|모두|전부|아니|아니요|아니오|거절|취소|안\s*할래)(?:요)?[.!\s]*$/u.test(text.trim());
  }
  return (!namedCommand && (followup(text) || previous.request?.seriesDraft && text.length <= 80
    || previous.request?.seriesCancellation && /^(?:전체|시리즈|회차)/u.test(text))) || (previous.taskIds.length > 0
    && (await loadTasks()).some(t => previous.taskIds.includes(t.id)
      && t.title === text.replace(/(?:만|이요|야|요)[.!\s]*$/u, '')));
}

export const supportedCommands = ['today','week','list','settings','help'];
export const help = `📋 토비 사용법
/today 오늘 일정·할 일과 점검
/week 앞으로 7일
/list 남은 전체 목록
/settings 현재 일일·주간 알림 설정
/help 사용법

명령어 조회는 AI 사용량을 쓰지 않아요.
추가·변경·완료·상세 조회·과거 분석·알림 변경은 자연어로 말씀해주세요.

!스냅 예약 완료했어
!불소도포 자세히 알려줘
!돌잔치 장소랑 스냅 예약 내일로 미뤄줘
!매일 알림 오전 7시 반으로 바꿔줘
!주간 알림은 잠시 꺼줘
!지난달 어떤 일을 많이 미뤘어?

!로 시작하거나 토비를 멘션·답장하면 돼요.
자연어 해석에는 AI 사용량이 발생하며 명확한 고정 조회는 AI 없이 처리해요.`;

async function processButton(job, store, loadTasks, now, options) {
  const {token, index} = job.payload.button;
  const action = await store.runtimeValue('button:' + token);
  if (!action || action.actor !== String(job.payload.actor) || action.chatId !== String(job.payload.chatId)
      || Date.parse(action.expiresAt) <= +now) throw new Error('버튼이 이미 처리됐거나 만료됐어요.');
  if (action.kind === 'select') {
    const state = await store.conversation(job.payload.actor);
    if (!state?.pending || state.requestId !== action.requestId || state.workflow?.token !== action.workflowToken
        || (options.calendarEntry && (!liveCalendarState(state, job.payload.actor, now)
          || state.workflow?.chatId !== String(job.payload.chatId)))) {
      throw new Error('버튼이 이미 처리됐거나 만료됐어요.');
    }
    const target = action.targets[index];
    const tasks = await loadTasks(target ? [target.id] : []);
    const task = target && tasks.find(t => t.id === target.id && t.version === target.version);
    if (!task) throw new Error('선택한 일정이 바뀌었어요. 현재 일정으로 다시 요청해주세요.');
    return {action, task, state};
  }
  if (action.kind !== 'undo' || index !== 0) throw new Error('버튼을 확인하지 못했어요.');
  const tasks = await loadTasks(action.changes.map(({after}) => after.id));
  const changes = action.changes.map(({before, after}) => {
    const current = tasks.find(t => t.id === after.id && t.version === after.version);
    if (!current) throw new Error('되돌릴 수 없어요. 요청에 포함된 일정이 그사이 다시 변경됐어요.');
    const restored = before || {...current, status:'cancelled', completedAt:null, remindAt:[]};
    return {before:current, after:{...restored, version:current.version + 1, updatedAt:now.toISOString()}, reason:'변경 되돌리기',
      ...(current.recurrence ? {restoreTiming:restored.recurrence?.timing} : {})};
  });
  const settings = action.settings && {
    before:action.settings.after, after:action.settings.before, version:action.settings.version + 1
  };
  const reply = '↩️ 변경을 되돌렸어요.\n\n' + changes.map(c => '• ' + c.after.title).join('\n');
  await options.authorize?.();
  await store.finish(job, changes, reply, settings, {consumeButton:token, refs:changes.map(c => c.after)});
  return {reply};
}

export async function processJob(job, store, ai, now = new Date(), signal, options = {}) {
  const input = { job, store, now, signal, options };
  const standalonePendingAction = !options.calendarEntry && !job.payload.button && pendingConfirmationAction(job.payload.text);
  const entry = options.calendarEntry ?? (standalonePendingAction ? await inspectCalendarEntry(input) : null);
  jobDebug('calendar.enter', { entry:entry?.kind });
  if (entry?.kind === 'pending-show' || entry?.kind === 'pending-cancel') {
    return finishCalendarPending(input, entry, { mode:entry.kind });
  }
  if (standalonePendingAction && entry?.kind === 'blocked') {
    await options.authorize?.();
    signal?.throwIfAborted();
    return store.finishSkillRouting(job, entry.notice);
  }
  const savedState=await store.conversation?.(job.payload.actor)||null;
  const liveState = liveCalendarState(savedState, job.payload.actor, now);
  const pendingState = liveState?.pending ? liveState : null;
  const verified = entry?.kind === 'verified-followup';
  const recent = entry?.kind === 'recent';
  const scopedReply = !!entry && (verified || recent) && !!job.payload.replyTo;
  const routedReference = scopedReply ? await loadReplyReference(job, store) : null;
  const validReference = !scopedReply || (
    isUsableCalendarReply(routedReference, job.payload, now) && routedReference.messageId === entry.replyId
    && (verified ? isCalendarQuestionReply(routedReference, pendingState, job.payload.actor)
      : !routedReference.pending && JSON.stringify(routedReference.taskIds) === JSON.stringify(entry.targetIds))
  );
  if (entry && (calendarStateKey(pendingState) !== (entry.contextKey ?? null)
      || (entry.recentKey && calendarStateKey(liveState) !== entry.recentKey)
      || !validReference)) {
    throw new Error(calendarContextChanged);
  }
  const guard = entry && {
    expected:entry.recentKey ?? entry.contextKey ?? null,
    includeRecent:!!entry.recentKey,
    preserve:!!pendingState && !verified && entry.kind !== 'button',
    reference:routedReference
  };
  const actorState = !entry || entry.kind === 'button' || verified || (recent && !pendingState) ? savedState : null;
  // The stored job keeps its original payload. A fresh Calendar plan cannot use reply context.
  const planningJob = entry && !scopedReply && entry.kind !== 'button' && job.payload.replyTo
    ? { ...job, payload:{ ...job.payload, replyTo:null } } : job;
  let tasks;
  const current=options.settings||defaults;
  const actorIds = actorState?.actor === String(job.payload.actor) && Date.parse(actorState.expiresAt) > +now
    ? actorState.taskIds ?? [] : [];
  const readTasks = extra => store.calendarTasks?.({now,timeZone:current.timeZone,includeIds:actorIds,...extra}) ?? store.tasks();
  const loadTasks = range => range
    ? readTasks({from:range.from,to:range.to,timeZone:range.timeZone ?? current.timeZone,includeIds:[],listOnly:true}) : tasks ??= readTasks();
  const buttonInput = job.payload.button ? await processButton(job, store, includeIds => readTasks({includeIds}), now, options) : null;
  if (buttonInput?.reply) return buttonInput.reply;
  const originalText = buttonInput?.action.text ?? job.payload.text.trim();
  if (entry?.target) {
    const currentTasks = await loadTasks();
    if (!directCompletionTarget(originalText, currentTasks)
        || !currentTasks.some(task => task.id === entry.target.id && task.version === entry.target.version
          && task.title.normalize('NFKC') === requestedCompletionTitle(originalText).normalize('NFKC'))) {
      throw new Error('선택한 일정이 바뀌었어요. 현재 일정으로 다시 요청해주세요.');
    }
  }
  const naturalDetail=recent ? null : detailQuery(originalText);
  let detailReplyAllowed=entry ? verified : !job.payload.replyTo;
  if(!entry&&job.payload.replyTo&&actorState?.pending){try{const r=await loadReplyReference(job,store);detailReplyAllowed=r?.requestId===actorState.requestId&&r?.ownerActor===String(job.payload.actor)&&r?.chatId===String(job.payload.chatId)&&Date.parse(r?.expiresAt)>now.getTime();}catch{}}
  const validDetailState=detailReplyAllowed&&actorState?.pending&&!actorState.workflow&&actorState.request?.operation==='detail'&&Date.parse(actorState.expiresAt)>now.getTime();
  const selectedId=validDetailState?selectedDetail(originalText,actorState.request)||(!/(완료|변경|바꿔|미뤄|취소|추가|등록)/.test(originalText)?detailCandidates((await loadTasks()).filter(t=>actorState.taskIds.includes(t.id)),originalText.replace(/(?:만|이요|야|요|보여줘|알려줘|볼래|선택할게)[.!\s]*$/u,'')).filter((t,i,list)=>list.length===1)[0]?.id:null):null;
  const text = quickCommand(originalText)||(selectedId?'/detail '+selectedId:naturalDetail?'/detail '+naturalDetail:originalText);
  const command = text.match(/^\/(\w+)(?:@[\w]+)?(?:\s+([\s\S]+))?$/);
  let reply, changes = [], settingsChange=null, refs=[], conversation=null, retrievalReply=null, button=null, resumeToken, seriesRegistration, seriesCancellation;
  if (command) {
    const name = command[1].toLowerCase(), arg = command[2]?.trim();
    const internalDetail=name==='detail'&&(!!selectedId||!!naturalDetail);
    if(['ids','detail','done','history','brief','status'].includes(name)&&!internalDetail)reply='자연어로 말씀해주세요. 예: 스냅 예약 완료했어 / 보험 언제 갱신했지?';
    else if(name==='settings')reply=arg?'알림 변경은 자연어로 말씀해주세요. 예: 매일 알림을 오전 7시 반으로 바꿔줘':'⚙️ 알림 설정\n\n'+settingsText(current);
    else if(name==='start')reply='안녕하세요, 토비예요. 비공개 가족방에서 !로 시작하거나 제 메시지에 답장해 부탁해주세요.';
    else if(name==='help')reply=help;
    else if (['today','week','list'].includes(name)) {
      const day = today(now,current.timeZone);
      const range = name === 'list' ? {} : {from:day,to:name === 'today' ? day : addDays(day,6)};
      const tasks = await loadTasks(range);
      const mode = name === 'list' ? 'all' : name;
      const selected = listTasks(tasks, mode, now,current.timeZone); refs=mode==='today'?tasks.filter(t=>!['done','cancelled'].includes(t.status)):selected; reply = mode==='today'?briefing(tasks,'daily',now,[],current.timeZone):mode==='all'?retrieveTasks(tasks,{kind:'task_list',status:'active',from:null,to:null,person:null,search:null},now,current.timeZone).reply:formatList(selected,mode,now,current.timeZone);
    } else if(name==='detail'){
      const matches=arg?detailCandidates(await loadTasks(),arg):[];refs=matches;
      reply=matches.length===1?formatDetail(matches[0]):matches.length?'❓ 어떤 일정인가요?\n\n'+matches.map((t,i)=>`${i+1}. ${t.title} · ${t.dueDate||'날짜 미정'}`).join('\n')+'\n\n번호나 제목으로 답해주세요.':'❓ 항목을 찾지 못했어요\n\n일정 제목이나 날짜를 조금 더 자세히 알려주세요.';
      if(matches.length>1){conversation=nextConversation(job.payload.actor,originalText,reply,matches.map(t=>t.id),null,now);conversation.pending=true;conversation.request.operation='detail';}
    } else reply = '❓ 요청을 확인하지 못했어요\n\n일정 제목과 원하시는 작업을 말씀해주세요.';
  } else {
    const previous = buttonInput?.state || actorState;
    const reference = entry && entry.kind !== 'button' ? (routedReference && { ...routedReference }) : await loadReplyReference(job, store);
    if (store.calendarTasks) {
      const replyIds = reference?.chatId === String(job.payload.chatId) && Date.parse(reference.expiresAt) > +now
        ? reference.taskIds ?? [] : [];
      if (replyIds.length) {
        tasks = readTasks({includeIds:[...replyIds,...actorIds]});
        const aliases = new Map((await tasks).filter(t => t.recurrence).map(t => [t.recurrence.occurrenceId,t.id]));
        reference.taskIds = replyIds.map(id => aliases.get(id) ?? id);
      }
    }
    const pendingAnswer = entry && entry.kind !== 'button'
      ? verified : await isPendingAnswer(job, originalText, previous, reference, buttonInput, now, loadTasks);
    const resume = pendingAnswer && !!previous.workflow;
    if (!resume && reference?.workflowToken && reference.pending && !/추가|새로|등록/u.test(originalText)) {
      reply = '❓ 이 확인 질문은 이미 처리됐거나 다른 요청으로 바뀌었어요. 새 요청을 알려주세요.';
    } else {
      const direct = pendingAnswer || recent || !!buttonInput || (requestedCompletionTitle(originalText)
        && directCompletionTarget(originalText, await loadTasks()));
      const result = await runNaturalWorkflow({
        ai, input:{message:{...planningJob.payload, text:originalText}, now, settings:current}, signal, previous, resume, direct,
        planWithoutTarget:(classification, resumedIntent) => planWithoutTarget({
          job:planningJob, ai, signal, now, options, current, loadTasks, originalText, classification, previous, resumedIntent
        }),
        planWithContext:async (classification, resumedIntent) => planNatural({
          job:planningJob, store, ai, now, signal, options, current,
          tasks:classification?.cancellation && classification.cancellation.scope !== 'occurrence' ? [] : await loadTasks(),
          loadTasks, originalText,
          previous, reference, buttonInput, classification, resumedIntent, resumed:resume, verified,
          recentScope:recent ? entry : null
        })
      }).catch(error => {
        if (!(error instanceof PendingCheckpointError)) throw error;
        jobDebug('calendar.checkpoint.restore.error', errorFields(error.cause ?? error));
        return null;
      });
      if (!result) {
        return finishCalendarPending(input, { contextKey:calendarStateKey(previous),
          replyId:scopedReply ? routedReference.messageId : null }, { mode:'checkpoint-unavailable' });
      }
      ({reply, changes = [], settingsChange = null, refs = [], conversation = null, retrievalReply = null, button = null} = result);
      resumeToken = result.resumeToken;
      ({seriesRegistration, seriesCancellation} = result);
    }
  }
  if (guard?.preserve && conversation?.pending && (conversation.workflow || !changes.length && !settingsChange)) {
    jobDebug('calendar.save.start', { outcome:'preserve-pending' });
    const reply = await finishCalendarPending(input, entry);
    jobDebug('calendar.save.done', { outcome:'preserve-pending' });
    return reply;
  }
  if (retrievalReply&&settingsChange&&!changes.length)reply+='\n\n✅ 알림 설정 저장 완료\n\n'+settingsText(settingsChange.after);
  if (changes.length) reply = (retrievalReply?retrievalReply+'\n\n':'')+formatReceipt(changes)+(settingsChange?'\n알림 설정\n'+settingsText(settingsChange.after):'');
  if(changes.length)refs=[...new Map([...refs,...changes.map(c=>c.after)].map(t=>[t.id,t])).values()];
  if(conversation&&(changes.length||settingsChange)){conversation.pending=false;conversation.request.question=null;}
  if(conversation)conversation.turns[conversation.turns.length-1].text=(reply||'').slice(0,1600);
  if(!conversation&&refs.length)conversation=nextConversation(job.payload.actor,originalText,reply,refs.map(t=>t.id),null,now);
  if (entry && conversation) conversation.chatId = String(job.payload.chatId);
  if (!reply?.trim()) reply = '❓ 확인이 필요해요\n\n변경할 과업과 날짜를 알려주세요.';
  if (reply.length > 50000) reply = reply.slice(0, 49000) + '\n표시 한도를 넘었어요. 날짜·대상을 좁혀 다시 조회해주세요.';
  if (changes.some(c => c.before)) {
    button = buttonFor(job, now, {kind:'undo', changes, settings:settingsChange}, ['↩️ 방금 변경 되돌리기']);
  }
  await options.authorize?.();
  if (entry) signal?.throwIfAborted();
  try {
    jobDebug('calendar.save.start', { changes:changes.length, pending:!!conversation?.pending,
      preservePending:!!guard?.preserve });
    const storedReply = await store.finish(job, changes, reply,settingsChange,{button,consumeButton:job.payload.button?.token,resumeToken,refs:refs.map(t=>({id:t.id,title:t.title})),conversation,expiresAt:new Date(now.getTime()+30*86400000).toISOString(),seriesCancellation,...seriesRegistration,...(guard && {calendarGuard:guard})});
    const openedQuestion = !guard?.preserve && !!conversation?.pending;
    jobDebug('calendar.save.done', { changes:changes.length, pending:openedQuestion,
      question:openedQuestion && conversation.requestId ? jobTrace('calendar-question', conversation.requestId) : undefined });
    return seriesRegistration ? storedReply ?? reply : reply;
  } catch (cause) {
    jobDebug('calendar.save.error', errorFields(cause));
    if (!seriesRegistration || cause.message.startsWith('확인 요청이 이미')) throw cause;
    throw new Error('반복 일정 저장 오류',{cause});
  }
}

export async function schedule(store, now = new Date(), settings = defaults, settingsVersion = null) {
  const tasks = await (store.calendarTasks?.({now,timeZone:settings.timeZone}) ?? store.tasks());
  for (const item of dueBriefs(now,settings)) {
    // Deterministic factual summary still works if the CLI is offline.
    const history = item.type === 'weekly' ? await store.history() : [];
    const text=briefing(tasks, item.type, now, history,settings.timeZone);
    if(settingsVersion!==null) {
      const refs = tasks.some(task => task.recurrence) ? tasks.map(({id,title}) => ({id,title})) : undefined;
      await store.scheduleBrief(item.key,text,settingsVersion,refs);
    }
    else await store.schedule(item.key,text);
  }
  const missed = [];
  for (const t of tasks) {
    if (['done','cancelled'].includes(t.status)) continue;
    for (const instant of t.remindAt || []) {
      const age = now.getTime() - Date.parse(instant);
      if (age < 0) continue;
      const key = t.recurrence ? `${t.id}:${instant}` : `${t.id}:${t.version}:${instant}`;
      const deliveryId = (t.recurrence ? 'series-reminder:' : 'reminder:') + key;
      if (age <= 3600000) await store.schedule(deliveryId, '🔔 예약 알림\n\n' + groupTasks([t],{now,timeZone:settings.timeZone}), t);
      else missed.push({key,deliveryId,...(t.recurrence ? {legacyTaskId:t.id,instant} : {}),
        text:`${t.title} — 예약 시각 ${kst(new Date(instant),settings.timeZone)} (${settings.timeZone})`});
    }
  }
  if (missed.length) await store.missed(missed);
}
