import { randomUUID } from 'node:crypto';
import { Store } from './storage.js';
import { validateSettings } from './settings.js';
export const memberActive=m=>['creator','administrator','member'].includes(m?.status)||(m?.status==='restricted'&&m.is_member===true);
export async function verifyMember(tg,chatId,userId){const m=await tg.call('getChatMember',{chat_id:chatId,user_id:Number(userId)});if(!memberActive(m))throw new Error('권한 확인: 현재 그룹 구성원이 아니에요.');return m;}
export async function verifyBot(tg,bot,chatId){const chat=await tg.call('getChat',{chat_id:chatId});if(chat.username||!['group','supergroup'].includes(chat.type))throw new Error('권한 확인: 비공개 그룹에서 사용해주세요.');const m=await tg.call('getChatMember',{chat_id:chatId,user_id:bot.id});if(m.status!=='administrator')throw new Error('권한 확인: 토비를 그룹 관리자로 지정해주세요.');}
export class Families {
 constructor(pool,botId){this.pool=pool;this.botId=String(botId);}
 async init(){await this.pool.query('insert into assistant.bot_runtime(bot_id) values($1) on conflict do nothing',[this.botId]);}
 async cursor(){return Number((await this.pool.query('select offset_id from assistant.bot_runtime where bot_id=$1',[this.botId])).rows[0].offset_id);}
 async ack(id){await this.pool.query('update assistant.bot_runtime set offset_id=greatest(offset_id,$2) where bot_id=$1',[this.botId,id+1]);}
 async family(chatId){return (await this.pool.query('select * from assistant.families where chat_id=$1',[String(chatId)])).rows[0];}
 async list(){return (await this.pool.query('select * from assistant.families order by created_at,id')).rows;}
 store(f){return new Store(this.pool,f.id);}
 async setup(chatId,actor){
  const id=randomUUID();
  await this.pool.query("insert into assistant.families(id,chat_id,user_ids,active,setup_actor) values($1,$2,$3,true,$4) on conflict(chat_id) do update set active=true,setup_actor=coalesce(assistant.families.setup_actor,excluded.setup_actor)",[id,String(chatId),[String(actor)],String(actor)]);
  return this.family(chatId);
 }
 async member(f,userId,active,eventId=-1){
  await this.pool.query('insert into assistant.members(family_id,user_id,active,event_id) values($1,$2,$3,$4) on conflict(family_id,user_id) do update set active=excluded.active,event_id=greatest(assistant.members.event_id,excluded.event_id),checked_at=now() where excluded.event_id=-1 or excluded.event_id>=assistant.members.event_id',[f.id,String(userId),active,eventId]);
 }
 async state(f,active,eventId){await this.pool.query('update assistant.families set active=$2,bot_event=$3 where id=$1 and bot_event<=$3',[f.id,active,eventId]);}
 async move(oldId,newId){await this.pool.query('update assistant.families set chat_id=$2 where chat_id=$1',[String(oldId),String(newId)]);}
 async settings(f){const row=(await this.pool.query('select settings,settings_version from assistant.families where id=$1',[f.id])).rows[0];return {...row,settings:validateSettings(row.settings)};}
 async lock(){
  this.lockClient=await this.pool.connect();const r=await this.lockClient.query('select pg_try_advisory_lock(hashtextextended($1,0)) as locked',['tobi:bot:'+this.botId]);
  if(!r.rows[0].locked){this.lockClient.release();this.lockClient=null;throw Object.assign(new Error('동일한 토비 봇이 이미 실행 중입니다.'), {code:'BOT_ALREADY_RUNNING'});}
  this.lockClient.on('error',()=>{console.error('Supabase 운영 잠금 연결이 끊겨 토비를 종료합니다.');process.exit(1);});
  await this.pool.query("update assistant.deliveries set status='uncertain' where status='sending'");
 }
 async close(){if(this.lockClient){await this.lockClient.query('select pg_advisory_unlock_all()').catch(()=>{});this.lockClient.release();}await this.pool.end();}
}
