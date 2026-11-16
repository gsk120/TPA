import { randomUUID } from 'node:crypto';

export function buttonFor(job, now, action, labels) {
  const token = randomUUID();
  return {
    token,
    action: {
      ...action, actor: String(job.payload.actor), chatId: String(job.payload.chatId),
      expiresAt: new Date(+now + (action.kind === 'undo' ? 86400000 : 7200000)).toISOString()
    },
    markup: {inline_keyboard: labels.map((text, index) => [{text, callback_data: `tpa:${token}:${index}`}])}
  };
}

