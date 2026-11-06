import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';

export class Store {
  constructor(pool, familyId) { this.pool = pool; this.familyId = familyId; }
  static async openPool(cfg) {
    const url = new URL(cfg.databaseUrl);
    // Do not allow connection-string SSL options to disable certificate verification.
    for (const key of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert']) url.searchParams.delete(key);
    if (!/^assistant_app(?:\.|$)/.test(decodeURIComponent(url.username))) throw new Error('DB 실행 계정은 assistant_app 전용 역할을 사용하세요.');
    const ssl = { rejectUnauthorized: true };
    if (cfg.caFile) ssl.ca = await readFile(cfg.caFile, 'utf8');
    const pool = new pg.Pool({ connectionString: url.toString(), ssl, max: 4, connectionTimeoutMillis: 10000, idleTimeoutMillis: 20000, statement_timeout: 15000 });
    pool.on('error', () => console.error('DB 유휴 연결 오류. 다음 작업에서 연결을 다시 확인합니다.'));
    return pool;
  }
  static async connect(cfg) {
    const pool = await Store.openPool(cfg);
    if(!cfg.familyId || !cfg.chatId || !cfg.userIds?.length){await pool.end();throw new Error('설정: 기존 자료 도구에는 FAMILY_ID, TELEGRAM_CHAT_ID, TELEGRAM_USER_IDS가 필요합니다.');}
    const store = new Store(pool, cfg.familyId);
    try {
      await pool.query('insert into assistant.families(id,chat_id,user_ids) values($1,$2,$3) on conflict(id) do nothing', [cfg.familyId, cfg.chatId, cfg.userIds]);
      const { rows } = await pool.query('select chat_id,user_ids from assistant.families where id=$1', [cfg.familyId]);
      if (!rows[0] || rows[0].chat_id !== cfg.chatId || [...rows[0].user_ids].sort().join() !== [...cfg.userIds].sort().join()) throw new Error('기존 DB의 가족 그룹·사용자와 설정이 다릅니다. 기존 등록을 확인하세요.');
      return store;
    } catch(error) { await pool.end(); throw error; }
  }
  async tx(fn) {
    const client = await this.pool.connect();
    try { await client.query('begin'); const result = await fn(client); await client.query('commit'); return result; }
    catch(error) { await client.query('rollback').catch(() => {}); throw error; }
    finally { client.release(); }
  }
  async lockRuntime() {
    const client = await this.pool.connect();
    const key = this.familyId + ':personal-assistant-v1';
    const { rows } = await client.query('select pg_try_advisory_lock(hashtextextended($1,0)) as locked', [key]);
    if (!rows[0].locked) { client.release(); throw new Error('같은 가족의 비서가 이미 실행 중입니다.'); }
    // A dead lock connection must stop the process, otherwise two consumers could run.
    client.on('error', () => { console.error('실행 잠금 연결이 끊겨 안전하게 종료합니다.'); process.exit(1); });
    this.lock = client;
    await this.pool.query("update assistant.deliveries set status='uncertain' where family_id=$1 and status='sending'", [this.familyId]);
  }
  async close() { if (this.lock) { await this.lock.query('select pg_advisory_unlock_all()').catch(() => {}); this.lock.release(); } await this.pool.end(); }
  async tasks() { return (await this.pool.query('select data from assistant.tasks where family_id=$1 order by id', [this.familyId])).rows.map(r => r.data); }
  async history(search = '') {
    return (await this.pool.query("select actor,task_id,before_data as before,after_data as after,reason,at from assistant.history where family_id=$1 and ($2='' or position(lower($2) in lower(coalesce(after_data->>'title','') || ' ' || reason || ' ' || to_char(at at time zone 'Asia/Seoul','YYYY-MM-DD')))>0) order by at desc limit 500", [this.familyId, search.slice(0,300)])).rows.map(r => ({ ...r, at: r.at.toISOString() }));
  }
  async searchHistory({from=null,to=null,terms=[],timeZone='Asia/Seoul',limit=24}){
    const predicate="family_id=$1 and ($2::text is null or at>=($2::date::timestamp at time zone $5)) and ($3::text is null or at<($3::date::timestamp at time zone $5)) and (cardinality($4::text[])=0 or exists(select 1 from unnest($4::text[]) term where position(lower(term) in lower(coalesce(after_data->>'title','') || ' ' || reason))>0))";
    return this.tx(async c=>{
      await c.query('set transaction isolation level repeatable read');
      const params=[this.familyId,from,to,terms,timeZone];
      const rows=(await c.query('select actor,task_id,before_data as before,after_data as after,reason,at,count(*) over()::int as total from assistant.history where '+predicate+' order by at desc,id desc limit $6',[...params,Math.min(24,limit)])).rows;
      const delays=(await c.query("select task_id,max(after_data->>'title') as title,count(*)::int as times from assistant.history where "+predicate+" and before_data->>'dueDate' is not null and after_data->>'dueDate'>before_data->>'dueDate' group by task_id order by times desc,task_id limit 10",params)).rows;
      return {events:rows.map(e=>({...e,at:e.at.toISOString()})),total:rows[0]?.total||0,truncated:(rows[0]?.total||0)>rows.length,delayRanking:delays};
    });
  }
  async context() { return (await this.pool.query('select actor,text,reply_to,at from assistant.context where family_id=$1 order by id desc limit 20', [this.familyId])).rows.reverse(); }
  async runtimeValue(key){return (await this.pool.query('select value from assistant.runtime where family_id=$1 and key=$2',[this.familyId,key])).rows[0]?.value||null;}
  async conversation(actor){return this.runtimeValue('conversation:'+String(actor));}
  async replyReference(id){if(!Number.isSafeInteger(Number(id)))return null;const value=await this.runtimeValue('message:'+(Number(id)%1000));return value?.messageId===Number(id)?value:null;}
  async referencesForDelivery(d){return d.result?.context||null;}
  async relatedHistory(ids,limit=8){
    if(!ids.length)return {events:[],total:0,truncated:false};
    const rows=(await this.pool.query('select actor,task_id,before_data as before,after_data as after,reason,at,count(*) over()::int as total from assistant.history where family_id=$1 and task_id=any($2::uuid[]) order by at desc,id desc limit $3',[this.familyId,ids,Math.min(limit,12)])).rows;
    return {events:rows.map(e=>({...e,at:e.at.toISOString()})),total:rows[0]?.total||0,truncated:(rows[0]?.total||0)>rows.length};
  }
  async cursor() { return (await this.pool.query("select value from assistant.runtime where family_id=$1 and key='telegram_offset'", [this.familyId])).rows[0]?.value || 0; }
  async ingest(updateId, payload) {
    return this.tx(async c => {
      let queued;
      if (payload?.button?.messageId) {
        queued = await c.query(
          "insert into assistant.jobs(family_id,id,payload) values($1,$2,$3) on conflict(family_id,id) do update set payload=excluded.payload,status='pending',error=null,finished_at=null where assistant.jobs.status='failed'",
          [this.familyId, 'button:' + payload.button.token, payload]
        );
        if (queued.rowCount) {
          await this.enqueue(c, 'accepted:button:' + payload.button.token,
            '요청을 접수했어요. 순서대로 처리한 뒤 결과를 알려드릴게요.');
        }
      } else if (payload) {
        queued = await c.query('insert into assistant.jobs(family_id,id,payload) values($1,$2,$3) on conflict do nothing', [this.familyId, 'tg:' + updateId, payload]);
      }
      await c.query("insert into assistant.runtime(family_id,key,value) values($1,'telegram_offset',to_jsonb($2::bigint)) on conflict(family_id,key) do update set value=to_jsonb(greatest((assistant.runtime.value::text)::bigint,$2::bigint))", [this.familyId, updateId + 1]);
      return !!queued?.rowCount;
    });
  }
  async claim(id = null) {
    return this.tx(async c => {
      const { rows } = await c.query("select * from assistant.jobs where family_id=$1 and ($2::text is null or id=$2) and (status='pending' or status='running' and lease_until<now()) order by created_at,id for update skip locked limit 1", [this.familyId,id]);
      const job = rows[0]; if (!job) return null;
      job.lease = randomUUID();
      await c.query("update assistant.jobs set status='running',lease=$3,lease_until=now()+interval '90 seconds',attempts=attempts+1 where family_id=$1 and id=$2", [this.familyId, job.id, job.lease]);
      return job;
    });
  }
  async heartbeat(job) {
    const r = await this.pool.query("update assistant.jobs set lease_until=now()+interval '90 seconds' where family_id=$1 and id=$2 and lease=$3 and status='running'", [this.familyId, job.id, job.lease]);
    if (!r.rowCount) throw new Error('작업 실행 권한이 만료됐습니다.');
  }
  async finish(job, changes, reply, settingsChange = null, memory = null) {
    return this.tx(async c => {
      const r = await c.query("select id from assistant.jobs where family_id=$1 and id=$2 and lease=$3 and status='running' and lease_until>now() for update", [this.familyId, job.id, job.lease]);
      if (!r.rowCount) throw new Error('작업 실행 권한이 만료됐습니다.');
      if (memory?.consumeButton) {
        const consumed = await c.query(
          "update assistant.runtime set value='null'::jsonb where family_id=$1 and key=$2 and value->>'actor'=$3 and value->>'chatId'=$4 and value->>'expiresAt'> $5",
          [this.familyId, 'button:' + memory.consumeButton, String(job.payload.actor), String(job.payload.chatId), new Date().toISOString()]
        );
        if (!consumed.rowCount) throw new Error('버튼이 이미 처리됐거나 만료됐어요.');
      }
      if(settingsChange){
        const {before,after,version}=settingsChange;
        const changed=await c.query('update assistant.families set settings=$2,settings_version=settings_version+1 where id=$1 and settings_version=$3',[this.familyId,after,version]);
        if(!changed.rowCount)throw new Error('다른 작업에서 알림 설정이 변경됐어요. 다시 요청해주세요.');
        await c.query('insert into assistant.settings_history(family_id,actor,before_data,after_data) values($1,$2,$3,$4)',[this.familyId,String(job.payload.actor),before,after]);
        await c.query("update assistant.deliveries set status='cancelled' where family_id=$1 and status='pending' and (id like 'daily:%' or id like 'weekly:%')",[this.familyId]);
      }
      for (const change of changes) {
        const { before, after } = change;
        if (before) {
          const update = await c.query('update assistant.tasks set version=$4,data=$5 where family_id=$1 and id=$2 and version=$3', [this.familyId, after.id, before.version, after.version, after]);
          if (!update.rowCount) throw new Error('다른 작업에서 목록이 변경됐습니다. 다시 요청해주세요.');
          await c.query("update assistant.deliveries set status='cancelled' where family_id=$1 and task_id=$2 and status='pending'", [this.familyId, after.id]);
        } else await c.query('insert into assistant.tasks(family_id,id,version,data) values($1,$2,$3,$4)', [this.familyId, after.id, after.version, after]);
        await c.query('insert into assistant.history(family_id,actor,task_id,before_data,after_data,reason) values($1,$2,$3,$4,$5,$6)', [this.familyId, String(job.payload.actor), after.id, before, after, change.reason]);
      }
      await c.query('insert into assistant.context(family_id,actor,text,reply_to) values($1,$2,$3,$4),($1,$5,$6,null)', [this.familyId, String(job.payload.actor), job.payload.text.slice(0, 8000), job.payload.replyTo || null, 'assistant', reply.slice(0, 16000)]);
      await c.query('delete from assistant.context where family_id=$1 and id not in (select id from assistant.context where family_id=$1 order by id desc limit 40)', [this.familyId]);
      await this.enqueue(c, 'reply:' + job.id, reply);
      if(memory){
        if (memory.button) {
          await c.query('insert into assistant.runtime(family_id,key,value) values($1,$2,$3)',
            [this.familyId, 'button:' + memory.button.token, memory.button.action]);
        }
        await c.query('update assistant.deliveries set result=$3 where family_id=$1 and id=$2',[this.familyId,'reply:'+job.id,{context:{refs:memory.refs||[],ownerActor:String(job.payload.actor),pending:memory.conversation?.pending||false,requestId:memory.conversation?.requestId||null,expiresAt:memory.expiresAt,replyMarkup:memory.button?.markup}}]);
        if(memory.conversation)await c.query('insert into assistant.runtime(family_id,key,value) values($1,$2,$3) on conflict(family_id,key) do update set value=excluded.value',[this.familyId,'conversation:'+String(job.payload.actor),memory.conversation]);
      }
      await c.query("update assistant.jobs set status='done',finished_at=now() where family_id=$1 and id=$2", [this.familyId, job.id]);
    });
  }
  async fail(job, text, {silent = false} = {}) {
    await this.tx(async c => {
      const r = await c.query("update assistant.jobs set status='failed',error=$4,finished_at=now() where family_id=$1 and id=$2 and lease=$3 and status='running'", [this.familyId, job.id, job.lease, text]);
      if (r.rowCount && !silent) await this.enqueue(c, 'error:' + job.id, '⚠️ 처리를 완료하지 못했어요\n\n' + (/Codex|CLI|doctor/.test(text)?'AI 연결이나 응답에 문제가 있어요. 잠시 후 다시 요청해주세요.':text) + '\n\n문제를 해결한 뒤 같은 내용을 다시 보내주세요.');
    });
  }
  async enqueue(c, id, text, task = null) {
    return c.query(`insert into assistant.deliveries(family_id,id,text,task_id,task_version) values($1,$2,$3,$4,$5) on conflict(family_id,id) do update set text=excluded.text,status='pending',next_attempt=now() where assistant.deliveries.status='cancelled' and (excluded.id like 'daily:%' or excluded.id like 'weekly:%')`, [this.familyId, id, text, task?.id || null, task?.version || null]);
  }
  async schedule(id, text, task = null) { await this.tx(c => this.enqueue(c, id, text, task)); }
  async scheduleBrief(id,text,version){
    await this.tx(async c=>{
      const r=await c.query('select settings_version,active from assistant.families where id=$1 for update',[this.familyId]);
      if(r.rows[0]?.active && r.rows[0].settings_version===version)await this.enqueue(c,id,text);
    });
  }
  async missed(entries) {
    await this.tx(async c => {
      const fresh = [];
      for (const e of entries) {
        const sent = await c.query('select status from assistant.deliveries where family_id=$1 and id=$2', [this.familyId, 'reminder:' + e.key]);
        if (sent.rows[0]?.status === 'sent') continue;
        const result = await c.query('insert into assistant.runtime(family_id,key,value) values($1,$2,$3) on conflict do nothing', [this.familyId, 'missed:' + e.key, { at: new Date().toISOString() }]);
        if (result.rowCount) fresh.push(e);
      }
      if (fresh.length) await this.enqueue(c, 'missed:' + createHash('sha256').update(fresh.map(e=>e.key).sort().join('|')).digest('hex'), '놓친 개별 알림이 있어요. 이미 지난 알림은 각각 재전송하지 않아요.\n' + fresh.slice(0,30).map(e=>e.text).join('\n'));
    });
  }
  async claimDelivery() {
    return this.tx(async c => {
      const { rows } = await c.query("select * from assistant.deliveries where family_id=$1 and status='pending' and next_attempt<=now() order by created_at for update skip locked limit 1", [this.familyId]);
      const d = rows[0]; if (!d) return null;
      if (d.task_id) {
        const task = (await c.query('select data from assistant.tasks where family_id=$1 and id=$2', [this.familyId, d.task_id])).rows[0]?.data;
        if (!task || task.version !== d.task_version || ['done', 'cancelled'].includes(task.status)) {
          await c.query("update assistant.deliveries set status='cancelled' where family_id=$1 and id=$2", [this.familyId, d.id]); return null;
        }
      }
      await c.query("update assistant.deliveries set status='sending',attempts=attempts+1 where family_id=$1 and id=$2", [this.familyId, d.id]); return d;
    });
  }
  async deliveryResult(d, status, result, retryAfter = 0) {
    if(status==='pending'&&d.result?.context)result={...result,context:d.result.context};
    await this.tx(async c=>{
      const changed=await c.query("update assistant.deliveries set status=$3,result=$4,next_attempt=now()+($5::int * interval '1 second') where family_id=$1 and id=$2 and status='sending'", [this.familyId, d.id, status, result, retryAfter]);
      if(!changed.rowCount)return;
      if(status==='sent' && result.messageRefs){
        for(let i=0;i<result.messageIds.length;i++){
          const value={messageId:Number(result.messageIds[i]),chatId:String(result.chatId),ownerActor:result.replyOwner||null,pending:result.replyPending||false,requestId:result.requestId||null,taskIds:result.messageRefs[i]||[],expiresAt:new Date(Date.now()+30*86400000).toISOString()};
          await c.query('insert into assistant.runtime(family_id,key,value) values($1,$2,$3) on conflict(family_id,key) do update set value=excluded.value',[this.familyId,'message:'+(Number(result.messageIds[i])%1000),value]);
        }
      }
      await c.query("update assistant.runtime set value='null'::jsonb where family_id=$1 and (key like 'message:%' or key like 'conversation:%' or key like 'button:%') and value->>'expiresAt' < $2",[this.familyId,new Date().toISOString()]);
    });
  }
  async issues() { return (await this.pool.query("select id,status,created_at from assistant.deliveries where family_id=$1 and status in ('uncertain','failed') order by created_at desc limit 20", [this.familyId])).rows; }
  async backup() {
    return this.tx(async c => {
      // Snapshot of all app tables; connection transaction isolation is upgraded before reads.
      await c.query('set transaction isolation level repeatable read');
      const result = { exportedAt: new Date().toISOString(), familyId: this.familyId };
      for (const table of ['families','tasks','history','jobs','deliveries','context','runtime',...( (await c.query("select to_regclass('assistant.members') as name")).rows[0].name ? ['members','settings_history'] : [])]) result[table] = (await c.query(`select * from assistant.${table} where ${table === 'families' ? 'id' : 'family_id'}=$1`, [this.familyId])).rows;
      return result;
    });
  }
}
