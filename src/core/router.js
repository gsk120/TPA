import { createHash } from 'node:crypto';
import { validateSkillRouting } from '../assistant/skill-routing.js';
import { quickCommand } from '../context.js';
import { skillCatalog, skillRoutingVersion } from './skill-catalog.js';

/**
 * @param {import('./skill.js').Skill[]} skills
 * @param {string} defaultSkillId
 */
export function createJobDispatcher(skills, defaultSkillId) {
  const byId = new Map(skills.map(skill => [skill.id, skill]));

  /** @param {import('./skill.js').JobContext} input */
  return function dispatchJob(input, skillId = defaultSkillId) {
    const skill = byId.get(skillId);
    if (!skill) return Promise.reject(new Error(`Unknown Skill: ${skillId}`));
    return skill.handle(input);
  };
}

const skillNames = { calendar: '일정 관리', finance: '가계부', mail: '메일', photo: '사진' };
const classificationError = '요청을 담당할 기능을 확인하지 못했어요. 잠시 후 요청 전체를 다시 보내주세요.';
const pendingNotice = '먼저 진행 중인 일정 확인 질문에 답해주세요. 확인이 끝나면 이 요청 전체를 다시 보내주세요.';

/**
 * Opt-in entry point. The caller supplies Calendar's trusted entry decision,
 * separately from the Telegram payload. With inspectCalendar, the decision
 * also determines the context the Calendar handler is allowed to use.
 */
export function createSkillRouter({ skills, classifySkill, authorizeSkill, inspectCalendar }) {
  const registered = new Set();
  for (const skill of skills) {
    if (!Object.hasOwn(skillCatalog, skill.id) || registered.has(skill.id) || typeof skill.handle !== 'function') {
      throw new Error('Invalid or duplicate Skill registration');
    }
    registered.add(skill.id);
  }
  const dispatch = createJobDispatcher(skills);

  return async function routeSkillJob(input, calendarEntry) {
    const { job, store, signal, options } = input;
    const text = job.payload.text;
    signal?.throwIfAborted();
    const entry = inspectCalendar ? await inspectCalendar(input) : calendarEntry;

    const finish = async (message, failed = false) => {
      signal?.throwIfAborted();
      await options.authorize();
      signal?.throwIfAborted();
      return store.finishSkillRouting(job, message, { failed });
    };
    const execute = async (skillId, calendar = entry) => {
      if (!registered.has(skillId)) {
        const unsupported = `${skillNames[skillId]} 기능은 아직 지원하지 않아요.`;
        return finish(entry?.contextKey ? `${pendingNotice}\n\n${unsupported}` : unsupported);
      }
      await options.authorize();
      if (skillId !== 'calendar' && !await authorizeSkill?.(skillId, input)) {
        return finish('이 기능을 사용할 권한을 확인하지 못했어요.');
      }
      signal?.throwIfAborted();
      return dispatch(inspectCalendar && skillId === 'calendar'
        ? { ...input, options:{ ...options, calendarEntry:calendar } } : input, skillId);
    };

    if (entry?.kind === 'blocked') return finish(entry.notice);
    if (job.payload.button || /^\/\w+(?:@[\w]+)?(?:\s+[\s\S]+)?$/.test(text.trim()) || quickCommand(text)) return execute('calendar');
    const bypass = ['verified-followup', 'recent', 'direct-completion'].includes(entry?.kind);
    if (bypass && !inspectCalendar) return execute('calendar');
    const pending = entry?.kind === 'pending';
    if (!(bypass || entry?.kind === 'fresh' || pending && typeof entry.contextKey === 'string' && entry.contextKey)) {
      throw new Error('Trusted Calendar entry decision is required');
    }
    await options.authorize();
    signal?.throwIfAborted();
    const key = createHash('sha256')
      .update(JSON.stringify(bypass
        ? [text, entry.kind, entry.contextKey ?? null, entry.recentKey ?? null, entry.replyId ?? null, entry.targetIds ?? null, entry.target ?? null]
        : [text, entry.contextKey ?? null]))
      .digest('hex');
    const existing = await store.skillRoutingDecision(job);
    let saved = existing;
    if (existing === null && bypass) {
      saved = await store.saveSkillRoutingDecision(job, { version: skillRoutingVersion, key, bypass:true });
    } else if (existing === null) {
      let decision;
      try {
        decision = validateSkillRouting(await classifySkill(text, signal));
      } catch {
        return finish(classificationError, true);
      }
      signal?.throwIfAborted();
      saved = await store.saveSkillRoutingDecision(job, { version: skillRoutingVersion, key, decision });
    }
    if (saved?.version !== skillRoutingVersion || saved.key !== key || Boolean(saved.bypass) !== bypass) {
      return finish('요청을 접수한 뒤 처리 상태가 바뀌었어요. 요청 전체를 다시 보내주세요.');
    }
    if (bypass) return execute('calendar');
    let decision;
    try {
      decision = validateSkillRouting(saved.decision);
    } catch {
      return finish(classificationError, true);
    }
    const [skillId] = decision.skills;
    if (decision.kind === 'single') {
      if (pending && registered.has(skillId) && (!inspectCalendar || skillId !== 'calendar')) return finish(pendingNotice);
      return execute(skillId, { ...entry, kind:'fresh' });
    }
    if (decision.kind === 'multiple') {
      return finish('여러 기능이 필요한 요청이에요. 요청을 나눠서 하나씩 다시 보내주세요.'
        + (pending ? '\n\n' + pendingNotice : ''));
    }
    return finish(pending ? pendingNotice : '원하시는 작업과 찾을 대상을 조금 더 구체적으로 다시 보내주세요.');
  };
}
