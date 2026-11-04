import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {Families} from '../src/families.js';
import {routeUpdate} from '../src/router.js';
import {addressed,requestText} from '../src/telegram.js';
import {defaults,validateSettings,settingsCommand} from '../src/settings.js';
import {dueBriefs} from '../src/time.js';
import {listTasks} from '../src/briefing.js';
import {processJob} from '../src/processor.js';
const settingsAI={answer:async input=>({reply:'',actions:[],settings:{...input.settings,dailyTime:input.message.text.includes('6시')?'06:00':'07:30'}})};
let db,pool,families;const bot={id:99,username:'tobi_bot'};
before(async()=>{db=new PGlite();await db.exec('create role anon;create role authenticated;');await db.exec(await readFile(new URL('../sql/schema.sql',import.meta.url),'utf8'));const query=async(s,p=[])=>{const r=await db.query(s,p);return {...r,rowCount:r.rows.length||r.affectedRows||0};};pool={query,connect:async()=>({query,release(){}})};families=new Families(pool,99);await families.init();});
after(async()=>await db.close());
function telegram({actor='member',botRole='administrator',publicGroup=false}={}){const calls=[];return {calls,call:async(method,args)=>{calls.push({method,args});if(method==='getChat')return {type:'supergroup',...(publicGroup?{username:'public_group'}:{})};return {status:args.user_id===99?botRole:actor};},send:async(chat,text)=>calls.push({chat,text})};}
let next=1000;const msg=(chat,text,user=1)=>({update_id:next++,message:{message_id:next,chat:{id:chat,type:'supergroup'},from:{id:user,is_bot:false},text}});
test('private group setup is admin-only, idempotent and preserves records',async()=>{
 const tg=telegram();await routeUpdate(msg(-10,'/setup'),families,tg,bot);assert.equal(await families.family(-10),undefined);
 const admin=telegram({actor:'administrator'});await routeUpdate(msg(-10,'/setup'),families,admin,bot);const f=await families.family(-10);assert.equal(f.active,true);
 await routeUpdate(msg(-10,'/setup'),families,admin,bot);assert.equal((await families.family(-10)).id,f.id);
 const pub=telegram({actor:'administrator',publicGroup:true});await routeUpdate(msg(-11,'/setup'),families,pub,bot);assert.equal(await families.family(-11),undefined);
});
test('ordinary conversation is never queued; existing members register on first command',async()=>{
 const tg=telegram();await routeUpdate(msg(-10,'가족 일반 대화',12),families,tg,bot);const f=await families.family(-10);
 assert.equal((await pool.query('select * from assistant.members where family_id=$1 and user_id=$2',[f.id,'12'])).rows.length,0);
 await routeUpdate(msg(-10,'!내일 일정',12),families,tg,bot);
 assert.equal((await pool.query('select active from assistant.members where family_id=$1 and user_id=$2',[f.id,'12'])).rows[0].active,true);
 const jobs=(await pool.query('select payload from assistant.jobs where family_id=$1',[f.id])).rows;assert.equal(jobs.length,1);assert.equal(jobs[0].payload.text,'내일 일정');
});
test('leave before registration, stale event, rejoin and bot demotion',async()=>{
 const f=await families.family(-10);await families.member(f,88,false,100);await families.member(f,88,true,99);
 assert.equal((await pool.query('select active from assistant.members where family_id=$1 and user_id=$2',[f.id,'88'])).rows[0].active,false);
 await families.member(f,88,true,101);assert.equal((await pool.query('select active from assistant.members where family_id=$1 and user_id=$2',[f.id,'88'])).rows[0].active,true);
 await routeUpdate({update_id:2000,my_chat_member:{chat:{id:-10},new_chat_member:{status:'member',user:bot}}},families,telegram(),bot);assert.equal((await families.family(-10)).active,false);
 await families.state(f,true,2001);
});
test('families and migrated chat IDs retain isolation',async()=>{
 const f=await families.setup(-20,2);const old=await families.family(-10);await families.move(-20,-200);assert.equal(await families.family(-20),undefined);assert.equal((await families.family(-200)).id,f.id);
 await families.store(f).ingest(9,{actor:'2',text:'/list'});assert.equal((await pool.query('select * from assistant.jobs where family_id=$1',[old.id])).rows.every(j=>j.payload.actor!=='2'),true);
});
test('settings and receipt commit atomically, stale settings rollback and preserve other family',async()=>{
 const f=await families.setup(-30,3),store=families.store(f);await store.ingest(1,{actor:'3',text:'매일 점검을 오전 7시 반으로 바꿔줘'});let job=await store.claim();const state=await families.settings(f);
 await processJob(job,store,settingsAI,new Date(),null,{settings:state.settings,settingsVersion:state.settings_version});assert.equal((await families.settings(f)).settings.dailyTime,'07:30');
 assert.equal((await pool.query('select * from assistant.settings_history where family_id=$1',[f.id])).rows.length,1);
 assert.equal((await families.settings(await families.family(-10))).settings.dailyTime,'08:00');
 await store.ingest(2,{actor:'3',text:'매일 점검을 오전 6시로 바꿔줘'});job=await store.claim();await assert.rejects(processJob(job,store,settingsAI,new Date(),null,{settings:state.settings,settingsVersion:1}));assert.equal((await families.settings(f)).settings.dailyTime,'07:30');
});
test('authorization lost while AI runs prevents task and settings writes',async()=>{
 const f=await families.setup(-40,4),store=families.store(f);await store.ingest(1,{actor:'4',text:'매일 7시에 알려줘'});const job=await store.claim();
 const ai={answer:async()=>({reply:'ok',actions:[],settings:{...defaults,dailyTime:'07:00'}})};
 await assert.rejects(processJob(job,store,ai,new Date(),null,{settings:defaults,settingsVersion:1,authorize:async()=>{throw Error('left');}}));
 assert.equal((await families.settings(f)).settings.dailyTime,'08:00');assert.equal((await store.context()).length,0);
});
test('duplicate update is one job; cursor is durable and monotonic',async()=>{
 const f=await families.family(-10),tg=telegram(),update=msg(-10,'/list',5);await routeUpdate(update,families,tg,bot);await routeUpdate(update,families,tg,bot);await families.ack(update.update_id);await families.ack(1);
 assert.equal((await pool.query('select * from assistant.jobs where family_id=$1 and id=$2',[f.id,'tg:'+update.update_id])).rows.length,1);assert.equal(await families.cursor(),update.update_id+1);
});
test('left members and bot permission failures do not enqueue requests',async()=>{
 const f=await families.family(-10);const n=(await pool.query('select count(*)::int as n from assistant.jobs where family_id=$1',[f.id])).rows[0].n;
 await routeUpdate(msg(-10,'/list',7),families,telegram({actor:'left'}),bot);await routeUpdate(msg(-10,'!수정',7),families,telegram({botRole:'member'}),bot);
 assert.equal((await pool.query('select count(*)::int as n from assistant.jobs where family_id=$1',[f.id])).rows[0].n,n);
});
test('pending briefing is rescheduled on settings change but sent report is not repeated',async()=>{
 const f=await families.setup(-50,5),store=families.store(f);await store.schedule('daily:2026-11-02','old');await store.ingest(1,{actor:'5',text:'매일 점검을 오전 7시 반으로 바꿔줘'});const job=await store.claim();await processJob(job,store,settingsAI,new Date(),null,{settings:defaults,settingsVersion:1});
 await store.schedule('daily:2026-11-02','new');assert.equal((await store.claimDelivery()).text,'new');await pool.query("update assistant.deliveries set status='sent' where family_id=$1 and id='daily:2026-11-02'",[f.id]);await store.schedule('daily:2026-11-02','again');assert.equal((await pool.query("select text from assistant.deliveries where family_id=$1 and id='daily:2026-11-02'",[f.id])).rows[0].text,'new');
});
test('calls, family timezone, settings validation and disabled reminders',()=>{
 const m=text=>({text,from:{id:1}});assert.equal(addressed(m('!내일 일정'),bot),true);assert.equal(requestText(m(' ! 내일 일정 '),bot),'내일 일정');assert.equal(addressed(m('일반대화'),bot),false);assert.equal(addressed(m('@tobi_bot_other'),bot),false);
 assert.throws(()=>validateSettings({timeZone:'Invalid/Zone'}));assert.throws(()=>settingsCommand('dailyEnabled maybe',defaults));assert.throws(()=>settingsCommand('weeklyDay 7',defaults));
 assert.deepEqual(dueBriefs(new Date('2026-11-02T00:00:00Z'),{...defaults,dailyEnabled:false}),[]);
 assert.equal(dueBriefs(new Date('2026-11-02T00:00:00Z'),{...defaults,timeZone:'America/New_York',dailyTime:'07:00'})[0].day,'2026-11-01');
 assert.equal(listTasks([{status:'open',dueDate:'2026-11-01'}],'today',new Date('2026-11-02T00:00:00Z'),'America/New_York').length,1);
});
