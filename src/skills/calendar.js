import { planCalendarJob } from '../processor.js';
export { inspectCalendarEntry } from '../calendar-entry.js';

/** @param {typeof planCalendarJob} [plan] */
export function createCalendarSkill(plan = planCalendarJob) {
  /** @type {import('../core/skill.js').Skill} */
  const skill = {
    id: 'calendar',
    handle({ job, store, ai, now, signal, options }) {
      return plan(job, store, ai, now, signal, options);
    }
  };
  return skill;
}
