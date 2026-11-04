import test from 'node:test';
import assert from 'node:assert/strict';
import {quickCommand,selectContext,nextConversation,messageReferences} from '../src/context.js';
import {processJob,help,supportedCommands} from '../src/processor.js';
const now=new Date('2026-11-02T00:00:00Z');
const t=(id,title,extra={})=>({id,title,version:1,kind:'task',status:'open',dueDate:'2026-11-03',time:null,endDate:null,timeNote:null,person:null,assignee:null,notes:'keep',followUpDate:null,actualDeadline:null,remindAt:[],...extra});
const a=t('11111111-1111-4111-8111-111111111111','서아 불소도포'),b=t('22222222-2222-4222-8222-222222222222','기석 치과'),old=t('33333333-3333-4333-8333-333333333333','자동차보험 연장',{status:'done',dueDate:'2020-01-01'});
const message=(text,extra={})=>({actor:'1',chatId:'-10',text,...extra});
const select=(text,state=null,ref=null,extra={})=>selectContext([a,b,old],message(text,extra),state,ref,now);
function store(tasks=[a,b,old]){return {tasks:async()=>tasks,finish:async()=>{},conversation:async()=>null,relatedHistory:async()=>({events:[],total:0,truncated:false})};}
test('exact read shortcuts bypass AI while mixed requests never become reads',async()=>{
 const ai={answer:()=>{throw Error('AI called');}};
 for(const text of ['전체 목록 알려줘','오늘 일정 알려줘','이번 주 일정 알려줘','명령어 알려줘'])await processJob({payload:message(text)},store(),ai,now);
 for(const text of ['오늘 일정 중 치과를 내일로 바꿔줘','전체 목록 알려줘 그리고 치과 완료','오늘 일정 알려주지 마'])assert.equal(quickCommand(text),null);
 for(const cmd of supportedCommands)assert.ok(help.includes('/'+cmd));assert.ok(!help.includes('/commands'));
});
test('targeted extraction excludes unrelated and includes old completed records',()=>{
 assert.deepEqual(select('서아 불소도포 내일로 변경해줘').candidates.map(t=>t.id),[a.id]);assert.deepEqual(select('자동차보험 언제 연장했지?').candidates.map(t=>t.id),[old.id]);
});
test('same actor context persists but cross-user and expired context cannot resolve pronouns',()=>{
 const state=nextConversation('1','서아 불소도포','언제로 변경할까요?',[a.id],null,now);
 assert.deepEqual(select('그거 내일로',state).candidates.map(t=>t.id),[a.id]);assert.ok(select('그거 내일로',state,null,{actor:'2'}).blocked);assert.ok(select('그거 내일로',{...state,expiresAt:'2026-01-01T00:00:00Z'}).blocked);
});
test('reply mapping uses current task, rejects wrong group and ambiguous list replies',()=>{
 const ref={chatId:'-10',taskIds:[a.id],expiresAt:'2026-12-01T00:00:00Z'};
 assert.equal(select('완료했어',null,ref,{replyTo:'{}'}).candidates[0].version,1);
 assert.ok(select('완료했어',null,{...ref,chatId:'-20'},{replyTo:'{}'}).blocked);
 assert.equal(select('완료했어',null,{...ref,taskIds:[a.id,b.id]},{replyTo:'{}'}).blocked,null);
 assert.ok(select('완료했어',null,null,{replyTo:'{}'}).blocked);
});
test('new task clarification can continue without an existing task, only for same user',()=>{
 const state=nextConversation('1','서빈 병원 금요일 추가','몇 시인가요?',[],null,now);
 assert.equal(select('오전 11시',state).blocked,null);assert.equal(select('오전 11시',state).context.length,2);
 assert.ok(select('오전 11시',state,null,{actor:'2'}).blocked);
 const ref={chatId:'-10',taskIds:[],ownerActor:'1',pending:true,expiresAt:'2026-12-01T00:00:00Z'};assert.equal(select('오전 11시',state,ref,{replyTo:'{}'}).blocked,null);
});
test('candidate and input limits request clarification rather than silently truncate',()=>{
 const many=Array.from({length:20},(_,i)=>t(String(i),'보험 '+i));const s=selectContext(many,message('보험 변경해줘'),null,null,now);assert.ok(s.blocked);assert.equal(s.coverage.truncated,true);
 assert.ok(selectContext([t(a.id,a.title,{notes:'x'.repeat(19000)})],message('서아 불소도포'),null,null,now).blocked);
});
test('split message references only contain titles actually present in each part',()=>{
 assert.deepEqual(messageReferences(['서아 불소도포','기석 치과','접수했어요'],[a,b]),[[a.id],[b.id],[]]);
});
test('AI receives selected full fields and summary history, cannot edit unseen task',async()=>{
 let input,finished;const s=store();s.finish=async(...args)=>{finished=args;};s.relatedHistory=async()=>({events:[{actor:'1',at:now.toISOString(),before:{...a,notes:'HUGE'},after:a}],total:50,truncated:true});
 const ai={answer:async i=>{input=i;return {reply:'어느 날로 바꿀까요?',actions:[]};}};
 await processJob({payload:message('서아 불소도포 변경해줘')},s,ai,now);
 assert.deepEqual(input.tasks.map(t=>t.id),[a.id]);assert.equal(input.tasks[0].notes,'keep');assert.equal(input.history[0].before.notes,undefined);assert.equal(input.coverage.historyTruncated,true);assert.equal(input.coverage.familyTaskCount,3);assert.ok(finished[4].conversation);
 const bad={answer:async()=>({reply:'',actions:[{operation:'update',id:b.id,expectedVersion:1,task:{...b,status:'done'},reason:'wrong'}]})};
 await assert.rejects(processJob({payload:message('서아 불소도포 완료')},s,bad,now),/후보 범위/);
});

test('read-only questions cannot mutate and missing edit targets cannot become new tasks',async()=>{
 const create={operation:'create',id:null,expectedVersion:null,task:a,reason:'wrong'};
 await assert.rejects(processJob({payload:message('서아 불소도포 언제야 알려줘')},store(),{answer:async()=>({reply:'',actions:[create]})},now),/조회 요청/);
 await assert.rejects(processJob({payload:message('없는일정 내일로 변경해줘')},store(),{answer:async()=>({reply:'',actions:[create]})},now),/신규 추가/);
});

test('reply to a task clarification without repeating title retains same-user candidate',()=>{
 const state=nextConversation('1','서아 불소도포 변경해줘','언제로 바꿀까요?',[a.id],null,now);
 const ref={chatId:'-10',taskIds:[],ownerActor:'1',pending:true,expiresAt:'2026-12-01T00:00:00Z'};
 const result=select('내일로',state,ref,{replyTo:'{}'});assert.equal(result.blocked,null);assert.deepEqual(result.candidates.map(t=>t.id),[a.id]);
});
