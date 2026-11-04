import {settingsText} from './settings.js';
import {addressed,requestText} from './telegram.js';
import {verifyBot,verifyMember,memberActive} from './families.js';
export async function routeUpdate(u,families,tg,bot){
 const event=u.chat_member||u.my_chat_member;
 if(event){const f=await families.family(event.chat.id);if(!f)return;
   if(u.my_chat_member){await families.state(f,event.new_chat_member.status==='administrator',u.update_id);}
   else if(!event.new_chat_member.user.is_bot)await families.member(f,event.new_chat_member.user.id,memberActive(event.new_chat_member),u.update_id);
   return;
 }
 const m=u.message;if(!m)return;
 if(m.migrate_to_chat_id){await families.move(m.chat.id,m.migrate_to_chat_id);return;}
 if(m.migrate_from_chat_id){await families.move(m.migrate_from_chat_id,m.chat.id);return;}
 if(m.chat?.type==='private'&&!m.from?.is_bot&&/^\/start(?:@[a-z0-9_]+)?(?:\s|$)/i.test(m.text||'')){await tg.send(m.chat.id,'안녕하세요, 토비예요. 개인 대화에서는 가족 자료를 조회하지 않아요. 비공개 가족방에 초대해서 이용해주세요.');return;}
 if(!['group','supergroup'].includes(m.chat?.type)||!m.from||m.from.is_bot||m.sender_chat)return;
 let f=await families.family(m.chat.id);
 for(const user of m.new_chat_members||[])if(f&&!user.is_bot)await families.member(f,user.id,true,u.update_id);
 if(m.left_chat_member&&f&&!m.left_chat_member.is_bot)await families.member(f,m.left_chat_member.id,false,u.update_id);
 if(!addressed(m,bot,'addressed'))return;
 const text=requestText(m,bot);if(!text)return;
 if(/^\/setup\s*$/i.test(text)){
   const actor=await verifyMember(tg,m.chat.id,m.from.id);
   if(!['creator','administrator'].includes(actor.status)){await tg.send(m.chat.id,'초기 /setup은 텔레그램 그룹 관리자만 실행할 수 있어요.');return;}
   try{await verifyBot(tg,bot,m.chat.id);}catch{await tg.send(m.chat.id,'비공개 가족방에서 토비를 관리자로 지정한 뒤 /setup을 다시 보내주세요.');return;}
   f=await families.setup(m.chat.id,m.from.id);await families.member(f,m.from.id,true,u.update_id);
   const state=await families.settings(f);await families.store(f).schedule('setup:'+u.update_id,'가족방 연결 완료. 이 그룹 구성원은 모두 사용 가능해요.\n토비에게 부탁할 땐 !로 시작하거나 제 메시지에 답장해주세요.\n\n'+settingsText(state.settings));return;
 }
 if(!f){await tg.send(m.chat.id,'그룹 관리자가 토비를 관리자로 지정하고 /setup을 보내면 시작해요.');return;}
 try{await verifyBot(tg,bot,m.chat.id);await verifyMember(tg,m.chat.id,m.from.id);}catch{await tg.send(m.chat.id,'그룹 소속·토비 관리자 권한 확인에 실패해 처리를 보류했어요. 권한을 확인하고 다시 요청해주세요.');return;}
 if(!f.active){await tg.send(m.chat.id,'가족방 연결이 보류 중이에요. 그룹 관리자가 /setup으로 다시 확인해주세요.');return;}
 await families.member(f,m.from.id,true,u.update_id);
 const reply=m.reply_to_message;
 // Only retain bot reply context, never unrelated family conversation.
 const replyTo=reply?.from?.id===bot.id?JSON.stringify({id:reply.message_id,chatId:String(m.chat.id),actor:String(bot.id),text:reply.text?.slice(0,2000)}):null;
 await families.store(f).ingest(u.update_id,{actor:String(m.from.id),text:text.slice(0,8000),messageId:m.message_id,chatId:String(m.chat.id),replyTo});
}
