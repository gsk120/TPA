import {randomUUID} from 'node:crypto';
import {today,addDays,validDay} from './time.js';
const compact=s=>String(s||'').normalize('NFKC').toLowerCase().replace(/[\s?!.,~]/g,'');
export function quickCommand(text){
 const s=compact(text).replace(/^!/,'');
 if(/^(?:전체|전부|모든|남은)(?:일정|목록|할일|과업)(?:을|를)?(?:전부|전체|모두)?(?:알려줘|보여줘|띄워줘|알려주세요|보여주세요|조회해줘)?$/.test(s))return '/list';
 const map={list:['전체목록','전체목록알려줘','전체일정알려줘','남은일정알려줘','남은목록알려줘'],today:['오늘일정','오늘일정알려줘','오늘할일알려줘','오늘뭐해야해'],week:['이번주일정','이번주일정알려줘','이번주할일알려줘'],help:['명령어알려줘','사용법알려줘','도움말']};
 for(const [command,phrases] of Object.entries(map))if(phrases.includes(s))return '/'+command;
 return null;
}
export function followup(text){if(/추가|새로/.test(text))return false;if(/(?:일정|목록|할\s*일|과업)/.test(text)&&/(?:알려|보여|띄워|조회)/.test(text)&&!/(?:바꿔|변경|미뤄|완료|취소|수정)/.test(text))return false;return /^(?:그거|그건|그걸|그것|\d+(?:번|번째)?(?:[야요!.\s]|$)|둘\s*다|두\s*개|전부|모두|첫\s*번째|두\s*번째|마지막|응|네|예|맞아|완료|끝|했어|했음|내일로|모레로|다음\s*주(?:로|\s)|이번\s*주\s|[월화수목금토일]요일(?:로|\s|$)|미뤄|취소|오전|오후|\d{1,2}[.:월시일])/u.test(text.trim());}
export const settingsIntent=text=>/(?:점검|알림|시간대|타임존)/.test(text)&&/(?:매일|매주|주간|일일|중지|재개|설정|시간대|타임존)/.test(text);
const stops=new Set(['일정','과업','할일','목록','오늘','내일','모레','이번주','다음주','지난주','전체','모두','관련','언제','왜','뭐','뭐야','그거','그건','그걸','그것','알려줘','보여줘','조회','찾아줘','해주세요','해줘','추가','추가해줘','등록','등록해줘','예약','변경','변경해줘','미뤄줘','바꿔줘','완료','완료했어','완료해줘','취소','취소해줘','끝','했어','지난','작년','올해','다음','현재','준비','오전','오후','까지','결정','날짜','시간']);
export function searchTerms(text){return [...new Set((text.match(/[가-힣A-Za-z0-9_-]+/gu)||[]).map(t=>t.replace(/(?:했는데|했어|해줘|까지|으로|한테|에게|에서|은|는|을|를|이|가|도|에|로)$/u,'')).filter(t=>t.length>=2&&!/^\d+$/.test(t)&&!stops.has(t)&&!/[월일시분]$/.test(t)))].slice(0,12);}
export function selectContext(tasks,message,state,reference,now=new Date(),timeZone='Asia/Seoul'){
 const text=message.text.trim(),validState=state&&String(state.actor)===String(message.actor)&&Date.parse(state.expiresAt)>now.getTime()?state:null;
 const hasReply=!!message.replyTo;let candidates=[],reason='keyword',blocked=null,continuation=false;
 const selectionOnly=/(?:만|만\s*빼고|제외)[야요!.\s]*$/.test(text)||/^(?:둘\s*다|두\s*개|전부|모두|첫\s*번째|두\s*번째|마지막|응|네|예|맞아)[야요!.\s]*$/.test(text);
 const shortSelection=text.length<=120&&(/둘\s*다|두\s*개|전부|모두|첫\s*번째|두\s*번째|마지막|만|빼고|제외/.test(text)||followup(text));
 const ordered=ids=>(ids||[]).map(id=>tasks.find(t=>t.id===id)).filter(Boolean);
 if(hasReply){
  if(!reference||reference.chatId!==String(message.chatId)||Date.parse(reference.expiresAt)<=now.getTime())blocked='답장한 메시지의 일정 연결을 확인하지 못했어요. 일정 제목을 함께 알려주세요.';
  else if(reference.pending&&reference.requestId&&(!validState?.pending||validState.requestId!==reference.requestId))blocked='이 확인 질문은 이미 처리됐거나 다른 요청으로 바뀌었어요. 새 요청을 알려주세요.';
  else{
   continuation=!!(reference.pending&&reference.ownerActor===String(message.actor)&&validState?.pending);
   candidates=ordered(continuation?validState.taskIds:reference.taskIds);reason='reply';
   if(!candidates.length&&!continuation)blocked='답장한 메시지에 연결된 일정이 없어요. 일정 제목을 함께 알려주세요.';
  }
 }
 const terms=searchTerms(text),normalized=compact(text);
 const exact=tasks.filter(t=>(compact(t.title).length>=2&&normalized.includes(compact(t.title)))||(t.id&&text.includes(t.id)));
 const scored=tasks.map(t=>({task:t,score:terms.reduce((n,q)=>n+(compact(t.title+' '+(t.person||'')).includes(compact(q))?1:0),0)}));
 const max=scored.reduce((n,t)=>Math.max(n,t.score),0);
 const multiple=/(이랑|하고|그리고|\s및\s|[와과]\s)/.test(text);
 const matches=multiple?[...new Map([...exact,...scored.filter(t=>t.score>0).map(t=>t.task)].map(t=>[t.id,t])).values()]:exact.length?exact:scored.filter(t=>t.score===max&&max>0).map(t=>t.task);
 if(!blocked){
  if(!hasReply&&validState?.pending&&shortSelection&&!/추가|새로/.test(text)&&!exact.some(t=>!(validState.taskIds||[]).includes(t.id))){
   continuation=true;reason='followup';candidates=ordered(validState.taskIds);
  }else if(hasReply&&!continuation&&matches.length){
   const ids=new Set(candidates.map(t=>t.id));const scoped=matches.filter(t=>ids.has(t.id));
   if(scoped.length)candidates=scoped;else blocked='답장 대상과 입력한 일정이 달라요. 어느 일정을 변경할지 다시 알려주세요.';
  }else if(!hasReply&&matches.length)candidates=matches;
  else if(!hasReply&&followup(text)){
   reason='followup';candidates=ordered(validState?.taskIds);
   if(selectionOnly&&!validState?.pending)blocked='진행 중인 확인 질문이 없어요. 변경할 내용과 날짜를 함께 알려주세요.';
   else if(!candidates.length&&!validState?.pending)blocked='이어지는 일정 대상을 확인하지 못했어요. 일정 제목을 함께 알려주세요.';
  }
 }
 if(!hasReply&&!continuation&&!matches.length&&!followup(text)&&!settingsIntent(text)){
  const day=today(now,timeZone);if(/이번\s*주|다음\s*주|오늘|내일/.test(text)&&!/(변경|미뤄|바꿔|완료|취소|추가|등록)/.test(text)){const from=/다음\s*주/.test(text)?addDays(day,7):/내일/.test(text)?addDays(day,1):day;const until=/주/.test(text)?addDays(from,7):from;candidates=tasks.filter(t=>t.dueDate&&t.dueDate>=from&&t.dueDate<=until&&!['done','cancelled'].includes(t.status));reason='date-range';}
 }
 if(candidates.length>12)blocked='관련 일정이 많아요. 제목이나 날짜를 더 구체적으로 알려주세요.';
 if(JSON.stringify(candidates).length>18000)blocked='관련 자료가 길어요. 일정 제목이나 날짜로 요청 범위를 좁혀주세요.';
 const context=validState&&(reason==='followup'||continuation)?(validState.turns||[]).slice(-4):[];
 return {candidates,context,blocked,terms,continuation,request:continuation?validState.request:null,coverage:{familyTaskCount:tasks.length,matchingTaskCount:candidates.length,providedTaskCount:blocked?0:candidates.length,scope:reason,completeFamilySnapshot:false,truncated:!!blocked,searchTerms:terms}};
}
export function nextConversation(actor,text,reply,taskIds,previous,now=new Date(),requestInfo={}){
 const old=previous&&Date.parse(previous.expiresAt)>now.getTime()?previous.turns||[]:[];
 const pending=!!requestInfo.clarification||/[?？]|알려주세요|어느|몇\s*시|어떤/.test(reply);
 const request=previous?.pending&&requestInfo.continuation?{...(previous.request||{originalText:previous.turns?.find(t=>t.actor!=='assistant')?.text||'',startedAt:null,timeZone:requestInfo.timeZone||'Asia/Seoul'})}: {originalText:text,startedAt:now.toISOString(),timeZone:requestInfo.timeZone||'Asia/Seoul'};
 request.operation=requestInfo.clarification?.operation||request.operation||'unknown';
 request.proposedChanges=requestInfo.clarification?.proposedChanges||request.proposedChanges||[];
 request.unresolved=requestInfo.clarification?.unresolved||'';
 request.question=pending?reply.slice(0,2000):null;
 request.candidateOrder=[...new Set(taskIds)];
 return {actor:String(actor),requestId:previous?.pending&&requestInfo.continuation?previous.requestId:randomUUID(),pending,request,taskIds:[...new Set(taskIds)],expiresAt:new Date(now.getTime()+2*3600000).toISOString(),turns:[...old,{actor:String(actor),text:text.slice(0,1600)},{actor:'assistant',text:reply.slice(0,1600)}].slice(-4)};
}
export function messageReferences(parts,refs){return parts.map(part=>[...new Set(refs.filter(t=>part.includes(t.title.replace(/[\r\n]+/g,' ').trim())).map(t=>t.id))]);}
export function summarizeHistory(events){return events.map(e=>({actor:e.actor,task_id:e.task_id,at:e.at,reason:(e.reason||'').slice(0,250),reasonTruncated:(e.reason||'').length>250,before:summary(e.before),after:summary(e.after)}));}
function summary(t){if(!t)return null;return Object.fromEntries(['id','title','kind','status','dueDate','time','endDate','timeNote','person','assignee','actualDeadline'].filter(k=>k in t).map(k=>[k,t[k]]));}

export function validateClarification(value,allowedIds){
 if(!value)return null;
 if(!['update','create','settings','unknown'].includes(value.operation)||!Array.isArray(value.candidateIds)||value.candidateIds.some(id=>!allowedIds.includes(id))||new Set(value.candidateIds).size!==value.candidateIds.length||typeof value.question!=='string'||!value.question.trim()||value.question.length>2000||typeof value.unresolved!=='string'||value.unresolved.length>1000||!Array.isArray(value.proposedChanges)||value.proposedChanges.length>20)throw new Error('AI 응답의 확인 질문 형식이 올바르지 않아요.');
 const fields=['title','kind','status','dueDate','time','endDate','timeNote','person','assignee','notes','followUpDate','actualDeadline','timeZone','dailyTime','weeklyTime','weeklyDay','dailyEnabled','weeklyEnabled'];
 for(const p of value.proposedChanges){if(!fields.includes(p.field)||!['string','number','boolean'].includes(typeof p.value)&&p.value!==null||typeof p.value==='string'&&p.value.length>4000)throw new Error('AI 응답의 제안된 변경값을 확인하지 못했어요.');if(['dueDate','endDate','followUpDate','actualDeadline'].includes(p.field)&&p.value!==null&&!validDay(p.value))throw new Error('AI 응답의 제안된 날짜를 확인하지 못했어요.');}
 return value;
}

export function detailQuery(text){
 const match=text.trim().match(/^(.+?)\s*(?:자세히|상세히|상세\s*내용|상세\s*정보)\s*(?:알려줘|보여줘|알려주세요|보여주세요|조회해줘)?[.!?]*$/u);
 if(!match||/(변경|미뤄|바꿔|완료|취소|추가|삭제|수정)/.test(match[1]))return null;
 return match[1].trim();
}
export function detailCandidates(tasks,query){
 const q=compact(query);const direct=tasks.filter(t=>t.id.startsWith(query)||compact(t.title).includes(q));if(direct.length)return direct;
 const terms=searchTerms(query);return terms.length?tasks.filter(t=>terms.every(term=>compact(t.title).includes(compact(term)))):[];
}
export function selectedDetail(text,request){
 const korean=text.trim().replace(/\s/g,'').match(/^(첫번째|두번째|세번째)(?:야|요|이요)?[.!]*$/);if(korean)return request.candidateOrder[['첫번째','두번째','세번째'].indexOf(korean[1])]||null;
 const number=text.trim().match(/^(\d+)(?:번|번째)?(?:이야|이요|야|요)?[.!\s]*$/);if(number){const index=Number(number[1])-1;return index>=0&&index<request.candidateOrder.length?request.candidateOrder[index]:null;}
 return null;
}
