import test from 'node:test';
import assert from 'node:assert/strict';
import {processJob} from '../src/processor.js';
import {selectContext,nextConversation,validateClarification} from '../src/context.js';
import {buildPrompt} from '../src/assistant/codex.js';
const now=new Date('2026-11-02T14:30:00Z');
const make=(id,title)=>({id,title,version:1,kind:'task',status:'open',dueDate:'2026-11-02',time:null,endDate:null,timeNote:null,person:null,assignee:null,notes:'preserve',followUpDate:null,actualDeadline:null,remindAt:[]});
const snap=make('11111111-1111-4111-8111-111111111111','돌잔치 스냅 예약'),place=make('22222222-2222-4222-8222-222222222222','돌잔치 장소 예약');
const root='돌잔치 스냅 예약이랑 돌잔치 장소 예약 일정 내일로 변경해줘';
const payload=(text,actor='1',extra={})=>({text,actor,chatId:'-10',...extra});
const clarification={operation:'update',candidateIds:[snap.id,place.id],proposedChanges:[{field:'dueDate',value:'2026-11-03'}],question:'두 항목 모두 변경할까요?',unresolved:'대상 범위'};
function harness(){let state=null;let tasks=structuredClone([snap,place]);const saved=[];return {saved,get state(){return state;},store:{tasks:async()=>tasks,conversation:async actor=>state?.actor===actor?state:null,relatedHistory:async()=>({events:[],total:0,truncated:false}),finish:async(job,changes,reply,_settings,memory)=>{for(const c of changes)tasks=tasks.map(t=>t.id===c.after.id?c.after:t);if(memory.conversation)state=memory.conversation;saved.push({changes,reply,state:structuredClone(state)});}}};}
const update=t=>({operation:'update',id:t.id,expectedVersion:t.version,task:{...t,dueDate:'2026-11-03'},reason:'요청한 연기'});
test('explicit two-title request reaches AI with both complete candidates and commits both atomically',async()=>{
 const h=harness();let calls=0;const ai={answer:async input=>{calls++;assert.deepEqual(input.tasks.map(t=>t.id).sort(),[snap.id,place.id].sort());return {reply:'',actions:input.tasks.map(update),clarification:null};}};
 await processJob({payload:payload(root)},h.store,ai,now);assert.equal(calls,1);assert.equal(h.saved[0].changes.length,2);assert.ok(h.saved[0].changes.every(c=>c.after.dueDate==='2026-11-03'&&c.after.notes==='preserve'));assert.equal(h.state.pending,false);
});
test('two-turn clarification preserves original date past midnight and resolves both',async()=>{
 const h=harness();await processJob({payload:payload(root)},h.store,{answer:async()=>({reply:'',actions:[],clarification})},now);
 assert.equal(h.state.pending,true);assert.equal(h.state.request.originalText,root);assert.equal(h.state.request.startedAt,now.toISOString());assert.equal(h.state.request.proposedChanges[0].value,'2026-11-03');assert.ok(h.saved[0].reply.includes('1. 돌잔치 스냅 예약'));
 const later=new Date('2026-11-02T15:10:00Z');let input;
 await processJob({payload:payload('둘다야')},h.store,{answer:async i=>{input=i;return {reply:'',actions:i.tasks.map(update),clarification:null};}},later);
 assert.equal(input.pendingRequest.startedAt,now.toISOString());assert.equal(input.pendingRequest.originalText,root);assert.equal(input.pendingRequest.proposedChanges[0].value,'2026-11-03');assert.equal(h.saved[1].changes.length,2);assert.equal(h.state.pending,false);
 assert.ok(buildPrompt(input).includes('pendingRequest'));
});
for(const [text,index] of [['첫 번째',0],['스냅만',0],['스냅만 빼고',1]])test('selection meaning remains available to AI: '+text,async()=>{
 const h=harness();await processJob({payload:payload(root)},h.store,{answer:async()=>({reply:'',actions:[],clarification})},now);
 await processJob({payload:payload(text)},h.store,{answer:async input=>{assert.equal(input.tasks.length,2);assert.deepEqual(input.pendingRequest.candidateOrder,[snap.id,place.id]);assert.equal(input.message.text,text);return {reply:'',actions:[update(input.tasks[index])],clarification:null};}},new Date(now.getTime()+60000));assert.equal(h.saved[1].changes.length,1);assert.equal(h.saved[1].changes[0].after.id,[snap.id,place.id][index]);
});
test('other actor, expiration and already resolved question do not reuse old modification',async()=>{
 const h=harness();await processJob({payload:payload(root)},h.store,{answer:async()=>({reply:'',actions:[],clarification})},now);const pending=structuredClone(h.state);
 const wrong=selectContext([snap,place],payload('둘다야','2'),pending,null,now);assert.ok(wrong.blocked);const expired=selectContext([snap,place],payload('둘다야'),pending,null,new Date(now.getTime()+3*3600000));assert.ok(expired.blocked);
 const finished={...pending,pending:false};const ref={requestId:pending.requestId,ownerActor:'1',pending:true,taskIds:pending.taskIds,chatId:'-10',expiresAt:new Date(now.getTime()+86400000).toISOString()};assert.ok(selectContext([snap,place],payload('둘다야','1',{replyTo:'{}'}),finished,ref,now).blocked);
});
test('new independent target does not inherit pending wedding changes',()=>{
 const state=nextConversation('1',root,'두 항목 모두 변경할까요?',[snap.id,place.id],null,now,{clarification});const dental=make('33333333-3333-4333-8333-333333333333','기석 치과');
 const s=selectContext([snap,place,dental],payload('기석 치과만 내일로 변경해줘'),state,null,now);assert.equal(s.continuation,false);assert.deepEqual(s.candidates.map(t=>t.id),[dental.id]);assert.equal(s.request,null);
});
test('invalid proposal date and IDs fail before storage',()=>{
 assert.throws(()=>validateClarification({...clarification,candidateIds:['other']},[snap.id,place.id]));assert.throws(()=>validateClarification({...clarification,proposedChanges:[{field:'dueDate',value:'2026-02-30'}]},[snap.id,place.id]));
});
