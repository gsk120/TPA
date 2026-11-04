import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function config(env = process.env, mode = 'run') {
  const required = mode === 'discover' ? ['TELEGRAM_BOT_TOKEN'] : ['DATABASE_URL', 'TELEGRAM_BOT_TOKEN'];
  const missing = required.filter(k => !env[k]?.trim());
  if (missing.length) throw new Error('설정이 비어 있어요: ' + missing.join(', ') + '. npm run setup으로 입력 순서를 확인하세요.');
  const users = (env.TELEGRAM_USER_IDS || '').split(',').map(v => v.trim()).filter(Boolean);
  if (mode !== 'discover') {
    if ((env.TELEGRAM_CHAT_ID && !/^-\d+$/.test(env.TELEGRAM_CHAT_ID)) || users.some(v => !/^\d+$/.test(v)) || new Set(users).size !== users.length) throw new Error('가족 그룹 ID와 서로 다른 사용자 ID를 1개 이상 입력하세요.');
    if (env.FAMILY_ID && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(env.FAMILY_ID)) throw new Error('FAMILY_ID UUID를 확인하세요.');
    if (!['addressed'].includes(env.MESSAGE_MODE || 'addressed')) throw new Error('MESSAGE_MODE는 addressed만 지원합니다. 일반 대화 전체 처리는 허용하지 않습니다.');
  }
  const timeout = Number(env.CODEX_TIMEOUT_SECONDS || 180);
  if (!Number.isInteger(timeout) || timeout < 10 || timeout > 600) throw new Error('CODEX_TIMEOUT_SECONDS는 10~600초입니다.');
  return { databaseUrl: env.DATABASE_URL, caFile: env.DATABASE_CA_FILE, token: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID, userIds: users, familyId: env.FAMILY_ID, messageMode: env.MESSAGE_MODE || 'addressed', scheduler: env.SCHEDULER_ENABLED !== 'false', codexExecutable: env.CODEX_EXECUTABLE || 'codex', codexJs: env.CODEX_JS, model: env.CODEX_MODEL, codexTimeout: timeout * 1000 };
}
