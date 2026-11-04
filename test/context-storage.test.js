import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {Store} from '../src/storage.js';
import {processJob} from '../src/processor.js';
let db,pool;
before(async()=>{db=new PGlite();await db.exec('create role anon;create role authenticated;');await db.exec(await readFile(new URL('../sql/schema.sql',import.meta.url),'utf8'));const query=async(s,p=[])=>{const r=await db.query(s,p);return {...r,rowCount:r.rows.length||r.affectedRows||0};};pool={query,connect:async()=>({query,release(){}})};});
after(async()=>db.close());
async function fixture(){const id=randomUUID();await pool.query('insert into assistant.families(id,chat_id,user_ids) values($1,$2,$3)',[id,'-'+Math.random(),['1']]);return new Store(pool,id);}
test('actor memory and per-part reply references survive Store recreation and stay family scoped',async()=>{
 const store=await fixture(),other=await fixture();const id=randomUUID();const t={id,version:1,title:'불소도포',kind:'appointment',status:'open',dueDate:'2026-12-05',time:'09:30',notes:'keep',remindAt:[]};
 await pool.query('insert into assistant.tasks(family_id,id,version,data) values($1,$2,1,$3)',[store.familyId,id,t]);
 await store.ingest(1,{actor:'1',text:'불소도포 자세히 알려줘'});const job=await store.claim();await processJob(job,store,null);
 const restored=new Store(pool,store.familyId);assert.deepEqual((await restored.conversation('1')).taskIds,[id]);assert.equal(await restored.conversation('2'),null);assert.equal(await other.conversation('1'),null);
 const d=await store.claimDelivery();const memory=await store.referencesForDelivery(d);assert.equal(memory.refs[0].id,id);
 await store.deliveryResult(d,'sent',{messageIds:[123,124],messageRefs:[[id],[]],chatId:'-10',replyOwner:'1',replyPending:false});
 assert.deepEqual((await restored.replyReference(123)).taskIds,[id]);assert.deepEqual((await restored.replyReference(124)).taskIds,[]);assert.equal(await other.replyReference(123),null);
 // Ring slot reuse cannot attach an older message to a new task.
 await store.schedule('ring-reuse','확인');const next=await store.claimDelivery();await store.deliveryResult(next,'sent',{messageIds:[1123],messageRefs:[[]],chatId:'-10'});assert.equal(await restored.replyReference(123),null);assert.equal((await restored.replyReference(1123)).messageId,1123);
});
test('related history returns bounded complete counts; memory writes share job transaction',async()=>{
 const store=await fixture(),id=randomUUID();for(let i=0;i<10;i++)await pool.query('insert into assistant.history(family_id,actor,task_id,after_data) values($1,$2,$3,$4)',[store.familyId,'1',id,{title:'보험',status:'open'}]);
 const r=await store.relatedHistory([id],3);assert.equal(r.total,10);assert.equal(r.events.length,3);assert.equal(r.truncated,true);assert.deepEqual(await store.relatedHistory([]),{events:[],total:0,truncated:false});
 await store.ingest(5,{actor:'1',text:'test'});const job=await store.claim();await store.finish(job,[],'ok',null,{refs:[],conversation:{actor:'1',taskIds:[],expiresAt:new Date(Date.now()+60000).toISOString()},expiresAt:new Date(Date.now()+60000).toISOString()});
 await assert.rejects(store.finish(job,[],'bad',null,{refs:[],conversation:{actor:'1',bad:true}}));assert.equal((await store.conversation('1')).bad,undefined);
});
test('runtime cleanup and reference writes work under actual app-role grants',async()=>{
 const store=await fixture();await store.schedule('test','확인');const d=await store.claimDelivery();await db.exec('set role assistant_app');try{await store.deliveryResult(d,'sent',{messageIds:[5],messageRefs:[[]],chatId:'-10'});assert.equal((await store.replyReference(5)).chatId,'-10');}finally{await db.exec('reset role');}
});
