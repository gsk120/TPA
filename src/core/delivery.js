import { setTimeout as sleep } from 'node:timers/promises';
import { headingEntities } from '../format.js';
import { splitMessage } from '../telegram.js';

const media = {
  image:['sendPhoto', 'photo'],
  video:['sendVideo', 'video'],
  voice:['sendVoice', 'voice'],
  document:['sendDocument', 'document']
};

export async function deliverSkillContent(tg, store, delivery, chatId, pause = () => sleep(3100)) {
  const { content, replyMarkup, chatId:originalChat } = delivery.result.delivery;
  if (String(chatId) !== originalChat) throw new Error('텔레그램 응답 채팅이 변경됐어요.');
  const steps = content.flatMap(item => {
    if (item.type === 'text') return splitMessage(item.text).map(text => ({
      method:'sendMessage', body:{ text, entities:headingEntities(text), link_preview_options:{ is_disabled:true } }
    }));
    if (item.type === 'location') return [{ method:'sendLocation', body:{ latitude:item.latitude, longitude:item.longitude } }];
    const [method, field] = media[item.type];
    return [{ method, body:{ [field]:item.fileId } }];
  });
  let { messageIds, inFlight } = delivery.result.progress;
  if (inFlight || messageIds.length > steps.length) {
    throw Object.assign(new Error('텔레그램 이전 발송 결과를 확인할 수 없어요.'), { uncertain:true });
  }
  for (let index = messageIds.length; index < steps.length; index++) {
    const { method, body } = steps[index];
    await store.saveDeliveryProgress(delivery, { messageIds, inFlight:true });
    let sent;
    try {
      sent = await tg.call(method, {
        ...body, chat_id:chatId, ...(index === steps.length - 1 && replyMarkup && { reply_markup:replyMarkup })
      });
    } catch (error) {
      if (!error.uncertain) await store.saveDeliveryProgress(delivery, { messageIds, inFlight:false });
      throw error;
    }
    if (!Number.isSafeInteger(sent?.message_id) || sent.message_id <= 0) {
      throw Object.assign(new Error('텔레그램 전송 응답을 확인할 수 없어요.'), { uncertain:true });
    }
    messageIds = [...messageIds, sent.message_id];
    await store.saveDeliveryProgress(delivery, { messageIds, inFlight:false });
    if (index < steps.length - 1) await pause();
  }
  return messageIds;
}
