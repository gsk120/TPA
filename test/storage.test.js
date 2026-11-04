import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { Store } from '../src/storage.js';
import { planChanges } from '../src/tasks.js';

let db, pool;
before(async()=>{
  db=new PGlite();
  await db.exec('create role anon; create role authenticated;');
  await db.exec(await readFile(new URL('../sql/schema.sql',import.meta.url),'utf8'));
  const query=async(sql,params=[])=>{const r=await db.query(sql,params);return {...r,rowCount:r.rows.length || r.affectedRows || 0};};
  pool={query,connect:async()=>({query,release(){}})};
});
after(async()=>{await db?.close();});
async function fixture(){
  const id=randomUUID();await pool.query('insert into assistant.families(id,chat_id,user_ids) values($1,$2,$3)',[id,'-'+Date.now()+Math.random(),['1','2']]);
  return new Store(pool,id);
}
const data={title:'가상 테스트',kind:'task',status:'open',dueDate:'2026-12-01',time:null,endDate:null,timeNote:null,person:null,assignee:null,notes:'',followUpDate:null,actualDeadline:null,remindAt:[]};
async function newTask(store,update=1){
  await store.ingest(update,{actor:'1',text:'테스트 추가'});const job=await store.claim();
  const changes=planChanges([{operation:'create',id:null,expectedVersion:null,task:data,reason:'테스트'}],[]);
  await store.finish(job,changes,'저장 완료');return changes[0].after;
}
test('초기화 SQL은 재실행 가능',async()=>{
  await db.exec(await readFile(new URL('../sql/schema.sql',import.meta.url),'utf8'));
});
test('수신 위치와 작업이 함께 저장되며 재수신 중복 없음',async()=>{
  const store=await fixture();await store.ingest(10,{actor:'1',text:'/list'});await store.ingest(10,{actor:'1',text:'/list'});
  assert.equal(Number(await store.cursor()),11);
  assert.equal((await pool.query('select * from assistant.jobs where family_id=$1',[store.familyId])).rows.length,1);
  await store.ingest(9,null);assert.equal(Number(await store.cursor()),11);
});
test('과업·이력·회신·작업 완료는 함께 저장, 같은 job 재완료 차단',async()=>{
  const store=await fixture();const t=await newTask(store);
  assert.equal((await store.tasks())[0].title,t.title);assert.equal((await store.history()).length,1);
  assert.equal((await store.context()).length,2);
  const row=(await pool.query('select * from assistant.jobs where family_id=$1',[store.familyId])).rows[0];
  assert.equal(row.status,'done');await assert.rejects(store.finish(row,[],'두번째 응답'));
  assert.equal((await pool.query('select * from assistant.deliveries where family_id=$1',[store.familyId])).rows.length,1);
});
test('동시 갱신 충돌 시 전체 트랜잭션 롤백·새 이력과 회신 없음',async()=>{
  const store=await fixture();const t=await newTask(store);
  await store.ingest(2,{actor:'2',text:'완료'});const job=await store.claim();
  const change=planChanges([{operation:'update',id:t.id,expectedVersion:1,task:{...data,status:'done'},reason:'완료'}],[t]);
  await pool.query('update assistant.tasks set version=2 where family_id=$1 and id=$2',[store.familyId,t.id]);
  await assert.rejects(store.finish(job,change,'완료'));
  assert.equal((await store.history()).length,1);
  assert.equal((await pool.query("select * from assistant.deliveries where family_id=$1 and id='reply:tg:2'",[store.familyId])).rows.length,0);
});
test('갱신 시 과거 대기 알림 취소, 오래된 버전 알림 전송 차단',async()=>{
  const store=await fixture();const t=await newTask(store);
  await store.schedule('reminder-old','old',t);
  await store.ingest(2,{actor:'1',text:'완료'});const job=await store.claim();
  await store.finish(job,planChanges([{operation:'update',id:t.id,expectedVersion:1,task:{...data,status:'done'},reason:'완료'}],[t]),'완료');
  assert.equal((await pool.query("select status from assistant.deliveries where family_id=$1 and id='reminder-old'",[store.familyId])).rows[0].status,'cancelled');
  await store.schedule('late-old','late',t);
  await pool.query("update assistant.deliveries set status='sent' where family_id=$1 and id like 'reply:%'",[store.familyId]);
  assert.equal(await store.claimDelivery(),null);
});
test('점검·놓친 알림은 재실행해도 한 번만 적재',async()=>{
  const store=await fixture();await store.schedule('daily:2026-10-28','보고');await store.schedule('daily:2026-10-28','보고');
  await store.missed([{key:'t1:1:date',text:'지난 알림'}]);await store.missed([{key:'t1:1:date',text:'지난 알림'}]);
  assert.equal((await pool.query('select * from assistant.deliveries where family_id=$1',[store.familyId])).rows.length,2);
});
test('실패·불확실 발송은 자동 재전송하지 않음',async()=>{
  const store=await fixture();await store.schedule('x','보고');const d=await store.claimDelivery();
  await store.deliveryResult(d,'uncertain',{reason:'network'});
  assert.equal(await store.claimDelivery(),null);assert.equal((await store.issues())[0].status,'uncertain');
});
test('이미 전송된 예약 알림을 지난 알림으로 다시 보고하지 않음',async()=>{
  const store=await fixture();await store.schedule('reminder:t1:1:date','예약');
  const d=await store.claimDelivery();await store.deliveryResult(d,'sent',{messageIds:[1]});
  await store.missed([{key:'t1:1:date',text:'지난 알림'}]);
  assert.equal((await pool.query('select * from assistant.deliveries where family_id=$1',[store.familyId])).rows.length,1);
});
test('재시작 후 실행 임대가 만료된 작업만 다시 수령',async()=>{
  const store=await fixture();await store.ingest(1,{actor:'1',text:'/list'});
  const first=await store.claim();assert.equal(await store.claim(),null);
  await pool.query("update assistant.jobs set lease_until=now()-interval '1 second' where family_id=$1",[store.familyId]);
  const second=await store.claim();assert.equal(first.id,second.id);assert.notEqual(first.lease,second.lease);
  await assert.rejects(store.finish(first,[],'늦은 응답'));await store.finish(second,[],'복구 완료');
});
test('서로 다른 가족의 현재 목록·이력·대화가 섞이지 않음',async()=>{
  const a=await fixture(),b=await fixture();await newTask(a);assert.deepEqual(await b.tasks(),[]);assert.deepEqual(await b.history(),[]);assert.deepEqual(await b.context(),[]);
});
test('비공개 스키마 접근은 일반 API 사용자에게 차단',async()=>{
  await db.exec('set role anon');
  try{await assert.rejects(db.query('select * from assistant.tasks'));}finally{await db.exec('reset role');}
  await db.exec('set role assistant_app');
  try{
    await db.query('select * from assistant.tasks');
    await assert.rejects(db.query('delete from assistant.history'));
    await assert.rejects(db.query('drop table assistant.tasks'));
  }finally{await db.exec('reset role');}
});
test('가족 범위 백업은 모든 업무 테이블의 일관된 스냅샷',async()=>{
  const store=await fixture();await newTask(store);const backup=await store.backup();
  assert.equal(backup.tasks.length,1);assert.equal(backup.history.length,1);assert.equal(backup.families[0].id,store.familyId);
});

test('member migration removes legacy two-user check without losing families',async()=>{
 const isolated=new PGlite();
 try{await isolated.exec('create schema assistant; create table assistant.families(id text primary key,user_ids text[] not null,check(cardinality(user_ids)=2)); insert into assistant.families values (\'old\',ARRAY[\'1\',\'2\']);');
 await isolated.exec(await readFile(new URL('../sql/allow-flexible-members.sql',import.meta.url),'utf8'));
 await isolated.exec(await readFile(new URL('../sql/allow-flexible-members.sql',import.meta.url),'utf8'));
 await isolated.query('insert into assistant.families values ($1,$2)',['one',['1']]);
 await isolated.query('insert into assistant.families values ($1,$2)',['many',['1','2','3']]);
 await assert.rejects(isolated.query('insert into assistant.families values ($1,$2)',['empty',[]]));
 assert.equal((await isolated.query('select count(*)::int as n from assistant.families')).rows[0].n,3);
 }finally{await isolated.close();}
});
