/**
 * A leased queue job and the existing worker dependencies for handling it.
 * The payload, including sentAt and replyTo, belongs to the receiving Skill.
 * @typedef {object} JobContext
 * @property {{ id: string, family_id: string, lease: string, payload: object }} job
 * @property {import('../storage.js').Store} store
 * @property {Pick<import('../assistant/codex.js').Codex, 'classify' | 'answer'>} ai
 * @property {Date} now Worker processing time.
 * @property {AbortSignal} [signal]
 * @property {{ value: string }} [selection] A verified choice from a previous result.
 * @property {object} options
 * @property {ReturnType<typeof import('../settings.js').validateSettings>} options.settings
 * @property {number} options.settingsVersion
 * @property {() => Promise<void>} options.authorize
 */

/**
 * @typedef {{ type: 'text', text: string }
 * | { type: 'image' | 'video' | 'voice' | 'document', fileId: string }
 * | { type: 'location', latitude: number, longitude: number }} SkillContent
 * @typedef {{ label: string, url: string } | { label: string, value: string }} SkillButton
 * @typedef {object} SkillResult
 * @property {'success' | 'failed' | 'waiting'} status
 * @property {SkillContent[]} content Ordered content. Media uses an authorized, bot-scoped Telegram file ID.
 * @property {SkillButton[]} [buttons] Link buttons or one-time follow-up choices attached to the last message.
 */

/**
 * The Skill owns its business logic and returns a result for Core to commit.
 * @typedef {object} Skill
 * @property {string} id
 * @property {(input: JobContext) => Promise<SkillResult>} handle
 */

export function textResult(text, status = 'success') {
  return { status, content:[{ type:'text', text }] };
}

const invalid = () => new Error('작업 실행 결과 형식이 올바르지 않아요.');
const mediaTypes = new Set(['image', 'video', 'voice', 'document']);
const statuses = new Set(['success', 'failed', 'waiting']);

export function validateSkillResult(result) {
  if (!statuses.has(result?.status) || !Array.isArray(result.content)
      || !result.content.length || result.content.length > 30) throw invalid();
  const content = Array.from(result.content, item => {
    if (item?.type === 'text' && typeof item.text === 'string' && item.text.trim() && item.text.length <= 50000) {
      return { type:item.type, text:item.text };
    }
    if (mediaTypes.has(item?.type) && typeof item.fileId === 'string' && /^[A-Za-z0-9_-]{1,1024}$/.test(item.fileId)) {
      return { type:item.type, fileId:item.fileId };
    }
    if (item?.type === 'location' && Number.isFinite(item.latitude) && Math.abs(item.latitude) <= 90
        && Number.isFinite(item.longitude) && Math.abs(item.longitude) <= 180) {
      return { type:item.type, latitude:item.latitude, longitude:item.longitude };
    }
    throw invalid();
  });
  if (content.reduce((length, item) => length + (item.text?.length ?? 0), 0) > 50000) throw invalid();
  let buttons = [];
  if (result.buttons !== undefined) {
    if (!Array.isArray(result.buttons) || result.buttons.length > 20) throw invalid();
    buttons = Array.from(result.buttons, button => {
      if (typeof button?.label !== 'string' || !button.label.trim() || button.label.length > 64) throw invalid();
      if (typeof button.url === 'string' && button.value === undefined && button.url.length <= 2048) {
        const url = URL.parse(button.url);
        if (url?.protocol === 'https:' && !url.username && !url.password) return { label:button.label, url:url.href };
      }
      if (result.status === 'waiting' && button.url === undefined && typeof button.value === 'string'
          && button.value.trim() && button.value.length <= 512) return { label:button.label, value:button.value };
      throw invalid();
    });
  }
  return { status:result.status, content, buttons };
}
