import {headingEntities} from './format.js';
import { setTimeout as sleep } from 'node:timers/promises';
export class Telegram {
  constructor(token, fetcher = fetch, signal) { this.token = token; this.fetcher = fetcher; this.signal=signal; }
  async call(method, body = {}, timeout = 45000) {
    let response;
    try { response = await this.fetcher(`https://api.telegram.org/bot${this.token}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: this.signal?AbortSignal.any([this.signal,AbortSignal.timeout(timeout)]):AbortSignal.timeout(timeout) }); }
    catch (cause) { throw Object.assign(new Error('텔레그램 연결 결과 불확실', {cause}), { uncertain: true }); }
    let data; try { data = await response.json(); } catch { throw Object.assign(new Error('텔레그램 응답 확인 실패'), { uncertain: true }); }
    if (!data.ok) throw Object.assign(new Error('텔레그램 요청 거부 (' + (data.error_code || response.status) + ')'), { retryAfter: data.parameters?.retry_after, uncertain: response.status >= 500, httpStatus: response.status });
    return data.result;
  }
  async send(chatId, text, replyMarkup) {
    const parts = splitMessage(text);
    const ids = [];
    for (let i = 0; i < parts.length; i++) {
      try { ids.push((await this.call('sendMessage', { chat_id: chatId, text: parts[i], entities:headingEntities(parts[i]), reply_markup: i === parts.length - 1 ? replyMarkup : undefined, link_preview_options: { is_disabled: true } })).message_id); }
      catch (error) { if (ids.length) error.uncertain = true; throw error; }
      if (i < parts.length - 1) await sleep(3100);
    }
    return ids;
  }
}
export function splitMessage(text, limit = 3500) {
  if(!Number.isInteger(limit)||limit<2)throw new Error('메시지 분할 길이를 확인하세요.');
  let remaining=text||'처리 결과가 없습니다.';const parts=[];
  while(remaining.length>limit){
    let end=limit;
    const line=remaining.lastIndexOf('\n',limit-1);
    if(line>=Math.floor(limit/2))end=line+1;
    if(/[\uD800-\uDBFF]/.test(remaining[end-1])&&/[\uDC00-\uDFFF]/.test(remaining[end]))end--;
    parts.push(remaining.slice(0,end));remaining=remaining.slice(end);
  }
  if(remaining)parts.push(remaining);return parts;
}
export function allowed(message, cfg) { return String(message.chat?.id) === cfg.chatId && cfg.userIds.includes(String(message.from?.id)) && !message.from?.is_bot && ['group', 'supergroup'].includes(message.chat?.type); }
export function addressed(message, bot, mode) {
  if (!message.text) return false;
  if (/^\s*!\S|^\s*!\s+\S/.test(message.text)) return true;
  const command = message.text.match(/^\/([a-z_]+)(?:@([a-z0-9_]+))?/i);
  if (command) return !command[2] || command[2].toLowerCase() === bot.username.toLowerCase();
  return message.reply_to_message?.from?.id === bot.id || new RegExp('(^|[^a-z0-9_])@' + bot.username + '(?![a-z0-9_])','i').test(message.text);
}
export function requestText(message, bot) { return message.text.replace(new RegExp('@' + bot.username + '(?![a-z0-9_])', 'ig'), '').trim().replace(/^!\s*/, '').trim(); }
