import test from 'node:test';
import assert from 'node:assert/strict';
import {processJob} from '../src/processor.js';
import {detailQuery} from '../src/context.js';
const now=new Date('2026-11-02T00:00:00Z');
const tasks=[{id:'11111111-1111-4111-8111-111111111111',title:'서아 불소도포',kind:'appointment',status:'open',dueDate:'2026-12-05',time:'09:30',notes:'준비물 확인'},{id:'22222222-2222-4222-8222-222222222222',title:'기석 치과',kind:'appointment',status:'open',dueDate:'2026-12-06',time:'10:00'}];
function harness(){let memory=null,reply;return {get reply(){return reply;},get memory(){return memory;},store:{tasks:async()=>tasks,conversation:async()=>memory,issues:async()=>[],finish:async(_j,_c,r,_s,m)=>{reply=r;if(m?.conversation)memory=m.conversation;}}};}
const ai={answer:async()=>{throw Error('must not call AI');}};
const send=(h,text,extra={})=>processJob({payload:{actor:'1',chatId:'-10',text,...extra}},h.store,ai,now);
test('normal lists, details, settings and unknown commands omit command hints; help contains supported commands only',async()=>{
 const h=harness();for(const text of ['/today','/week','/list','/detail 불소도포','불소도포 자세히 알려줘','/settings','/nonsense']){await send(h,text);assert.ok(!/\/(ids|detail|done|help|settings)/.test(h.reply),text);assert.ok(!h.reply.includes(tasks[0].id));}
 await send(h,'/help');assert.ok(h.reply.includes('/today'));assert.ok(!h.reply.includes('/ids'));await send(h,'/ids');assert.ok(!h.reply.includes(tasks[0].id));
});
test('reply to an outdated detail question never selects from a newer question',async()=>{
 const h=harness();h.store.tasks=async()=>tasks.map(t=>({...t,title:'치과 '+t.title}));await send(h,'치과 자세히 알려줘');
 h.store.replyReference=async()=>({requestId:'old-question',ownerActor:'1',chatId:'-10',pending:true,taskIds:tasks.map(t=>t.id),expiresAt:'2026-12-01T00:00:00Z'});
 await send(h,'1번',{replyTo:JSON.stringify({id:100})});assert.ok(!h.reply.includes('🔎 일정 상세'));assert.ok(h.reply.includes('질문'));
});
test('ambiguous natural detail asks numbered question then accepts same-user number',async()=>{
 const both=tasks.map((t,i)=>({...t,title:i?'기석 불소도포':'서아 불소도포'}));
 for(const choice of ['1','1번','첫 번째','서아 불소도포']){
  const h=harness();h.store.tasks=async()=>both;await send(h,'불소도포 자세히 알려줘');assert.ok(h.reply.includes('1. 서아 불소도포'));assert.ok(!h.reply.includes(both[0].id));assert.equal(h.memory.request.operation,'detail');
  await send(h,choice);assert.ok(h.reply.includes('🔎 일정 상세'));assert.ok(h.reply.includes('서아 불소도포'));assert.ok(!h.reply.includes('/done'));
 }
});
test('detail lookups never swallow mixed modification requests',()=>{
 assert.equal(detailQuery('불소도포 자세히 알려줘'),'불소도포');assert.equal(detailQuery('불소도포 변경하고 자세히 알려줘'),null);
});
