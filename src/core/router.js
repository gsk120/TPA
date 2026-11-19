import { createHash } from 'node:crypto';
import { validateSkillRouting } from '../assistant/skill-routing.js';
import { calendarPendingNotice, finishCalendarPending } from '../calendar-entry.js';
import { quickCommand } from '../context.js';
import { errorFields, jobDebug } from '../diagnostics.js';
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
// Trusted Calendar entries started using version 2 and do not depend on the AI prompt.
const calendarBypassVersion = 2;

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
    jobDebug('router.entry.start');
    const entry = inspectCalendar ? await inspectCalendar(input) : calendarEntry;
    jobDebug('router.entry.result', { kind:entry?.kind, pending:!!entry?.contextKey });

    const finish = async (message, failed = false, reason) => {
      signal?.throwIfAborted();
      await options.authorize();
      signal?.throwIfAborted();
      jobDebug('router.save.start', { reason, failed });
      const reply = await store.finishSkillRouting(job, message, { failed });
      jobDebug('router.save.done', { reason, failed });
      return reply;
    };
    const pendingConflict = ({ before = '', after = '', reason = 'pending' } = {}) => {
      if (inspectCalendar && entry?.contextKey) {
        return finishCalendarPending(input, entry, { before, after });
      }
      return finish([before, calendarPendingNotice, after].filter(Boolean).join('\n\n'), false, reason);
    };
    const execute = async (skillId, calendar = entry) => {
      if (!registered.has(skillId)) {
        const unsupported = `${skillNames[skillId]} 기능은 아직 지원하지 않아요.`;
        return entry?.contextKey ? pendingConflict({ after:unsupported, reason:'skill-unregistered' })
          : finish(unsupported, false, 'skill-unregistered');
      }
      await options.authorize();
      if (skillId !== 'calendar' && !await authorizeSkill?.(skillId, input)) {
        return finish('이 기능을 사용할 권한을 확인하지 못했어요.', false, 'skill-denied');
      }
      signal?.throwIfAborted();
      jobDebug('router.dispatch', { skill:skillId, entry:calendar?.kind });
      return dispatch(inspectCalendar && skillId === 'calendar'
        ? { ...input, options:{ ...options, calendarEntry:calendar } } : input, skillId);
    };

    if (entry?.kind === 'blocked') return entry.showPending ? pendingConflict({ reason:'entry-blocked' })
      : finish(entry.notice, false, 'entry-blocked');
    if (job.payload.button || /^\/\w+(?:@[\w]+)?(?:\s+[\s\S]+)?$/.test(text.trim()) || quickCommand(text)) return execute('calendar');
    const bypass = ['verified-followup', 'recent', 'direct-completion', 'pending-show', 'pending-cancel'].includes(entry?.kind);
    if (bypass && !inspectCalendar) return execute('calendar');
    const version = bypass ? calendarBypassVersion : skillRoutingVersion;
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
    jobDebug('router.cache.read', { version, bypass });
    const existing = await store.skillRoutingDecision(job);
    jobDebug('router.cache.result', { hit:existing !== null, version, bypass });
    let saved = existing;
    if (existing === null && bypass) {
      jobDebug('router.cache.write', { version, bypass });
      saved = await store.saveSkillRoutingDecision(job, { version, key, bypass:true });
    } else if (existing === null) {
      let decision;
      try {
        jobDebug('router.classify.start');
        decision = validateSkillRouting(await classifySkill(text, signal));
        jobDebug('router.classify.done', decision);
      } catch (error) {
        jobDebug('router.classify.error', errorFields(error));
        return finish(classificationError, true, 'classify-error');
      }
      signal?.throwIfAborted();
      jobDebug('router.cache.write', { version, bypass });
      saved = await store.saveSkillRoutingDecision(job, { version, key, decision });
    }
    if (saved?.version !== version || saved.key !== key || Boolean(saved.bypass) !== bypass) {
      jobDebug('router.cache.rejected', { versionMismatch:saved?.version !== version,
        contextMismatch:saved?.key !== key, bypassMismatch:Boolean(saved?.bypass) !== bypass });
      return finish('요청을 접수한 뒤 처리 상태가 바뀌었어요. 요청 전체를 다시 보내주세요.', false, 'cache-mismatch');
    }
    if (bypass) return execute('calendar');
    let decision;
    try {
      decision = validateSkillRouting(saved.decision);
    } catch (error) {
      jobDebug('router.cache.invalid', errorFields(error));
      return finish(classificationError, true, 'cache-invalid');
    }
    jobDebug('router.decision', decision);
    const [skillId] = decision.skills;
    if (decision.kind === 'single') {
      if (pending && registered.has(skillId) && (!inspectCalendar || skillId !== 'calendar')) return pendingConflict();
      return execute(skillId, { ...entry, kind:'fresh' });
    }
    if (decision.kind === 'multiple') {
      const notice = '여러 기능이 필요한 요청이에요. 요청을 나눠서 하나씩 다시 보내주세요.';
      return pending ? pendingConflict({ before:notice, reason:'multiple' }) : finish(notice, false, 'multiple');
    }
    return pending ? pendingConflict()
      : finish('원하시는 작업과 찾을 대상을 조금 더 구체적으로 다시 보내주세요.', false, decision.kind);
  };
}
