import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {randomUUID} from 'node:crypto';
import {Store} from '../src/storage.js';
import {processJob,supportedCommands,help} from '../src/processor.js';
import {historyRequest} from '../src/history-search.js';
import {listTasks} from '../src/briefing.js';
import {defaults} from '../src/settings.js';
const now=new Date('2026-11-02T00:00:00Z');
let db,pool;
before(async()=>{db=new PGlite();await db.exec('create role anon;create role authenticated;');await db.exec(await readFile(new URL('../sql/schema.sql',import.meta.url),'utf8'));const query=async(s,p=[])=>{const r=await db.query(s,p);return {...r,rowCount:r.rows.length||r.affectedRows||0};};pool={query,connect:async()=>({query,release(){}})};});
after(async()=>db.close());
async function fixture(){const id=randomUUID();await pool.query('insert into assistant.families(id,chat_id,user_ids) values($1,$2,$3)',[id,'-'+Math.random(),['1']]);return new Store(pool,id);}
test('help exposes exactly five daily commands; removed commands and settings args cannot write',async()=>{
 assert.deepEqual(supportedCommands,['today','week','list','settings','help']);assert.deepEqual([...help.matchAll(/^\/(\w+)/gm)].map(m=>m[1]),supportedCommands);
 let writes;const store={tasks:async()=>[],finish:async(_j,c,r,s)=>{writes={c,r,s};}};const ai={answer:()=>{throw Error('AI should not run');}};
 for(const command of ['/ids','/detail abc','/done abc','/history','/status','/brief','/settings dailyTime 07:30']){await processJob({payload:{text:command,actor:'1'}},store,ai,now);assert.equal(writes.c.length,0);assert.equal(writes.s,null);assert.ok(writes.r.includes('자연어'));}
 await processJob({payload:{text:'/settings',actor:'1'}},store,ai,now);assert.ok(writes.r.includes('08:00'));assert.ok(!writes.r.includes('dailyTime'));
 await processJob({payload:{text:'/start',actor:'1'}},store,ai,now);assert.ok(writes.r.includes('토비'));assert.ok(!writes.r.includes('/today'));
});
test('today includes tomorrow preparation and overdue; week is exactly seven calendar days',async()=>{
 const tasks=[{id:'1',title:'지난 일',kind:'task',status:'open',dueDate:'2026-11-01'},{id:'2',title:'내일 치과',kind:'appointment',status:'open',dueDate:'2026-11-03',time:'09:00'},{id:'3',title:'7일째',kind:'task',status:'open',dueDate:'2026-11-08'},{id:'4',title:'8일째',kind:'task',status:'open',dueDate:'2026-11-09'}];
 let reply;await processJob({payload:{text:'/today'}},{tasks:async()=>tasks,finish:async(_j,_c,r)=>{reply=r;}},null,now);assert.ok(reply.includes('내일 준비'));assert.ok(reply.includes('내일 치과'));assert.ok(reply.includes('지난 일'));assert.ok(!listTasks(tasks,'week',now).some(t=>t.title==='8일째'));assert.ok(listTasks(tasks,'week',now).some(t=>t.title==='7일째'));
});
test('history search uses family-local month boundaries, complete delay counts, and isolates other families',async()=>{
 const store=await fixture(),other=await fixture(),id=randomUUID();
 for(const at of ['2026-09-30T14:59:00Z','2026-09-30T15:00:00Z','2026-10-15T00:00:00Z','2026-10-31T15:00:00Z'])await pool.query('insert into assistant.history(family_id,actor,task_id,before_data,after_data,at) values($1,$2,$3,$4,$5,$6)',[store.familyId,'1',id,{title:'보험',dueDate:'2026-10-01'},{title:'보험',dueDate:'2026-10-02'},at]);
 await pool.query('insert into assistant.history(family_id,actor,task_id,after_data,at) values($1,$2,$3,$4,$5)',[other.familyId,'1',id,{title:'보험'},'2026-10-15T00:00:00Z']);
 const scope=historyRequest('지난달 어떤 일을 많이 미뤘어?',now);assert.equal(scope.from,'2026-10-01');assert.equal(scope.to,'2026-11-01');assert.deepEqual(scope.terms,[]);
 const result=await store.searchHistory({...scope,limit:1});assert.equal(result.total,2);assert.equal(result.events.length,1);assert.equal(result.truncated,true);assert.equal(result.delayRanking[0].times,2);
 assert.equal(historyRequest('지난달 치과 내일로 바꿔줘',now),null);
});
test('past analysis receives bounded real search results and cannot write; natural alarm changes preserve other settings',async()=>{
 let input,saved;const store={tasks:async()=>[],searchHistory:async()=>({events:[],total:99,truncated:true,delayRanking:[{title:'보험',times:7}]}),finish:async(_j,c,r,s)=>{saved={c,r,s};}};
 await processJob({payload:{text:'지난달 어떤 일을 많이 미뤘어?',actor:'1'}},store,{answer:async i=>{input=i;return {reply:'검색 범위에서 보험 연기 7건이에요.',actions:[]};}},now);assert.equal(input.coverage.historyTotal,99);assert.equal(input.coverage.historyTruncated,true);assert.equal(input.coverage.delayRanking[0].times,7);assert.equal(saved.c.length,0);
 await processJob({payload:{text:'주간 알림은 잠시 꺼줘',actor:'1'}},store,{answer:async i=>({reply:'',actions:[],settings:{...i.settings,weeklyEnabled:false}})},now);assert.equal(saved.s.after.weeklyEnabled,false);assert.equal(saved.s.after.dailyTime,defaults.dailyTime);
});
