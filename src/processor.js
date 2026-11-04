import {retrieveTasks} from './retrieval.js';
import {historyRequest} from './history-search.js';
import { planChanges } from './tasks.js';
import {formatList,formatReceipt,formatDetail,groupTasks} from './format.js';
import { listTasks, briefing } from './briefing.js';
import { dueBriefs, kst } from './time.js';
import {defaults,validateSettings,settingsText} from './settings.js';
import {quickCommand,selectContext,nextConversation,summarizeHistory,settingsIntent,validateClarification,detailQuery,detailCandidates,selectedDetail} from './context.js';

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

export async function processJob(job, store, ai, now = new Date(), signal, options = {}) {
  const tasks = await store.tasks();
  const originalText = job.payload.text.trim();
  const naturalDetail=detailQuery(originalText);
  const actorState=await store.conversation?.(job.payload.actor)||null;
  let detailReplyAllowed=!job.payload.replyTo;
  if(job.payload.replyTo&&actorState?.pending){try{const r=await store.replyReference?.(JSON.parse(job.payload.replyTo).id);detailReplyAllowed=r?.requestId===actorState.requestId&&r?.ownerActor===String(job.payload.actor)&&r?.chatId===String(job.payload.chatId)&&Date.parse(r?.expiresAt)>now.getTime();}catch{}}
  const validDetailState=detailReplyAllowed&&actorState?.pending&&actorState.request?.operation==='detail'&&Date.parse(actorState.expiresAt)>now.getTime();
  const selectedId=validDetailState?selectedDetail(originalText,actorState.request)||(!/(완료|변경|바꿔|미뤄|취소|추가|등록)/.test(originalText)?detailCandidates(tasks.filter(t=>actorState.taskIds.includes(t.id)),originalText.replace(/(?:만|이요|야|요|보여줘|알려줘|볼래|선택할게)[.!\s]*$/u,'')).filter((t,i,list)=>list.length===1)[0]?.id:null):null;
  const text = quickCommand(originalText)||(selectedId?'/detail '+selectedId:naturalDetail?'/detail '+naturalDetail:originalText);
  const command = text.match(/^\/(\w+)(?:@[\w]+)?(?:\s+([\s\S]+))?$/);
  let reply, changes = [], settingsChange=null, refs=[], conversation=null, retrievalReply=null;
  const current=options.settings||defaults;
  if (command) {
    const name = command[1].toLowerCase(), arg = command[2]?.trim();
    const internalDetail=name==='detail'&&(!!selectedId||!!naturalDetail);
    if(['ids','detail','done','history','brief','status'].includes(name)&&!internalDetail)reply='자연어로 말씀해주세요. 예: 스냅 예약 완료했어 / 보험 언제 갱신했지?';
    else if(name==='settings')reply=arg?'알림 변경은 자연어로 말씀해주세요. 예: 매일 알림을 오전 7시 반으로 바꿔줘':'⚙️ 알림 설정\n\n'+settingsText(current);
    else if(name==='start')reply='안녕하세요, 토비예요. 비공개 가족방에서 !로 시작하거나 제 메시지에 답장해 부탁해주세요.';
    else if(name==='help')reply=help;
    else if (['today','week','list'].includes(name)) {
      const mode = name === 'list' ? 'all' : name;
      const selected = listTasks(tasks, mode, now,current.timeZone); refs=mode==='today'?tasks.filter(t=>!['done','cancelled'].includes(t.status)):selected; reply = mode==='today'?briefing(tasks,'daily',now,[],current.timeZone):mode==='all'?retrieveTasks(tasks,{kind:'task_list',status:'active',from:null,to:null,person:null,search:null},now,current.timeZone).reply:formatList(selected,mode,now,current.timeZone);
    } else if(name==='detail'){
      const matches=arg?detailCandidates(tasks,arg):[];refs=matches;
      reply=matches.length===1?formatDetail(matches[0]):matches.length?'❓ 어떤 일정인가요?\n\n'+matches.map((t,i)=>`${i+1}. ${t.title} · ${t.dueDate||'날짜 미정'}`).join('\n')+'\n\n번호나 제목으로 답해주세요.':'❓ 항목을 찾지 못했어요\n\n일정 제목이나 날짜를 조금 더 자세히 알려주세요.';
      if(matches.length>1){conversation=nextConversation(job.payload.actor,originalText,reply,matches.map(t=>t.id),null,now);conversation.pending=true;conversation.request.operation='detail';}
    } else reply = '❓ 요청을 확인하지 못했어요\n\n일정 제목과 원하시는 작업을 말씀해주세요.';
  } else {
    const previous=actorState;
    let reference=null;
    if(job.payload.replyTo){try{const parsed=JSON.parse(job.payload.replyTo);reference=await store.replyReference?.(parsed.id)||null;}catch{}}
    const selection=selectContext(tasks,job.payload,previous,reference,now,current.timeZone);
    let clarification=null;
    refs=selection.candidates;
    if(selection.blocked){
      reply='❓ 대상을 확인해주세요\n\n'+selection.blocked+(refs.length?'\n\n'+refs.slice(0,10).map(t=>`${t.title} · ${t.dueDate||'날짜 미정'}`).join('\n'):'');
    }else{
      const selectedIds=selection.candidates.map(t=>t.id);
      const historyQuery=historyRequest(originalText,now,current.timeZone);
      const historyResult=historyQuery&&store.searchHistory?await store.searchHistory(historyQuery):store.relatedHistory?await store.relatedHistory(selectedIds):{events:[],total:0,truncated:false};
      const history=summarizeHistory(historyResult.events);
      const coverage={...selection.coverage,historyTotal:historyResult.total,historyProvided:history.length,historyTruncated:historyResult.truncated,historyIsSummary:true,historySearch:historyQuery,delayRanking:historyResult.delayRanking||[]};
      const input={tasks:selection.candidates,history,context:selection.context,message:job.payload,now,settings:current,coverage,pendingRequest:selection.request};
      if(JSON.stringify(input).length>26000){reply='❓ 자료 범위를 좁혀주세요\n\n일정 제목이나 날짜를 더 구체적으로 알려주세요.';}
      else{
        const answer=await ai.answer(input,signal);
        if(!Array.isArray(answer.actions))throw new Error('AI 응답 형식을 확인하지 못했어요.');
        if(answer.retrieval){
          if(answer.clarification)throw new Error('조회 범위와 확인 질문이 충돌해요. 저장하지 않았습니다.');
          const result=retrieveTasks(tasks,answer.retrieval,now,current.timeZone);
          refs=result.tasks;retrievalReply=result.reply;
        }
        clarification=validateClarification(answer.clarification,selectedIds);
        if(clarification&&(answer.actions.length||answer.settings))throw new Error('AI 응답에 확인 질문과 저장 요청이 섞였어요. 저장하지 않았습니다.');
        const intentText=selection.continuation?(selection.request?.originalText||'')+' '+originalText:originalText;
        const explicitChange=/(추가|새로|바꿔|변경|미뤄|완료|취소|수정|끝|했어|했음|켜줘|꺼줘|중지해|재개해)/.test(intentText);
        if(answer.retrieval&&explicitChange&&!answer.actions.length&&!answer.settings)throw new Error('AI 응답에서 함께 요청한 변경이 빠졌어요. 저장하지 않았습니다. 변경할 일정과 내용을 다시 말씀해주세요.');
        const readOnly=!!historyQuery||(selection.request?.operation==='detail'||/^\/detail\b/.test(selection.request?.originalText||'')||/(알려|보여|띄워|조회|언제|왜|어때|뭐|있어\??)/.test(intentText))&&!explicitChange;
        if(readOnly&&(answer.actions.length||answer.settings))throw new Error('AI 응답이 조회 요청을 변경으로 해석했어요. 저장하지 않았습니다.');
        if(/(바꿔|변경|미뤄|완료|취소|수정|끝)/.test(intentText)&&!/추가|새로/.test(intentText)&&answer.actions.some(a=>a.operation==='create'))throw new Error('AI 응답이 기존 일정 변경을 신규 추가로 해석했어요. 제목을 확인해주세요.');
        if(answer.actions.some(a=>a.operation==='update'&&!selectedIds.includes(a.id)))throw new Error('AI 응답의 변경 대상이 검증된 후보 범위 밖이에요. 제목을 지정해 다시 요청해주세요.');
        if(settingsIntent(intentText)&&answer.actions.length)throw new Error('AI 응답이 알림 설정과 일정 변경을 혼동했어요. 원하시는 알림 시각을 다시 말씀해주세요.');
        if(answer.settings){const after=validateSettings(answer.settings);settingsChange={before:current,after,version:options.settingsVersion||1};}
        changes=planChanges(answer.actions,tasks,now);
        if(answer.retrieval&&changes.length){
          const projected=new Map(tasks.map(t=>[t.id,t]));for(const c of changes)projected.set(c.after.id,c.after);
          const result=retrieveTasks([...projected.values()],answer.retrieval,now,current.timeZone);refs=result.tasks;retrievalReply=result.reply;
        }
        if(clarification){refs=clarification.candidateIds.map(id=>tasks.find(t=>t.id===id));reply='❓ 확인이 필요해요\n\n'+clarification.question+(refs.length?'\n\n'+refs.map((t,i)=>`${i+1}. ${t.title} · ${t.dueDate||'날짜 미정'}`).join('\n'):'');}
        else reply=retrievalReply|| (settingsChange?'✅ 알림 설정 저장 완료\n\n'+settingsText(settingsChange.after):changes.length?'':'📋 안내\n\n'+answer.reply);
      }
    }
    conversation=nextConversation(job.payload.actor,originalText,reply||'',changes.length?changes.map(c=>c.after.id):refs.map(t=>t.id),selection.continuation?previous:null,now,{continuation:selection.continuation,timeZone:current.timeZone,clarification});
  }
  if (retrievalReply&&settingsChange&&!changes.length)reply+='\n\n✅ 알림 설정 저장 완료\n\n'+settingsText(settingsChange.after);
  if (changes.length) reply = (retrievalReply?retrievalReply+'\n\n':'')+formatReceipt(changes)+(settingsChange?'\n알림 설정\n'+settingsText(settingsChange.after):'');
  if(changes.length)refs=[...new Map([...refs,...changes.map(c=>c.after)].map(t=>[t.id,t])).values()];
  if(conversation&&(changes.length||settingsChange)){conversation.pending=false;conversation.request.question=null;}
  if(conversation)conversation.turns[conversation.turns.length-1].text=(reply||'').slice(0,1600);
  if(!conversation&&refs.length)conversation=nextConversation(job.payload.actor,originalText,reply,refs.map(t=>t.id),null,now);
  if (!reply?.trim()) reply = '❓ 확인이 필요해요\n\n변경할 과업과 날짜를 알려주세요.';
  if (reply.length > 50000) reply = reply.slice(0, 49000) + '\n표시 한도를 넘었어요. 날짜·대상을 좁혀 다시 조회해주세요.';
  await options.authorize?.();
  await store.finish(job, changes, reply,settingsChange,{refs:refs.map(t=>({id:t.id,title:t.title})),conversation,expiresAt:new Date(now.getTime()+30*86400000).toISOString()});
  return reply;
}

export async function schedule(store, now = new Date(), settings = defaults, settingsVersion = null) {
  const tasks = await store.tasks();
  for (const item of dueBriefs(now,settings)) {
    // Deterministic factual summary still works if the CLI is offline.
    const history = item.type === 'weekly' ? await store.history() : [];
    const text=briefing(tasks, item.type, now, history,settings.timeZone);
    if(settingsVersion!==null)await store.scheduleBrief(item.key,text,settingsVersion);
    else await store.schedule(item.key,text);
  }
  const missed = [];
  for (const t of tasks) {
    if (['done','cancelled'].includes(t.status)) continue;
    for (const instant of t.remindAt || []) {
      const age = now.getTime() - Date.parse(instant);
      if (age < 0) continue;
      if (age <= 3600000) await store.schedule(`reminder:${t.id}:${t.version}:${instant}`, '🔔 예약 알림\n\n' + groupTasks([t],{now,timeZone:settings.timeZone}), t);
      else missed.push({key:`${t.id}:${t.version}:${instant}`,text:`${t.title} — 예약 시각 ${kst(new Date(instant),settings.timeZone)} (${settings.timeZone})`});
    }
  }
  if (missed.length) await store.missed(missed);
}
