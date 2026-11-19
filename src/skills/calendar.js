import { processJob } from '../processor.js';
export { inspectCalendarEntry } from '../calendar-entry.js';

/** @param {typeof processJob} [processCalendarJob] */
export function createCalendarSkill(processCalendarJob = processJob) {
  /** @type {import('../core/skill.js').Skill} */
  const skill = {
    id: 'calendar',
    handle({ job, store, ai, now, signal, options }) {
      return processCalendarJob(job, store, ai, now, signal, options);
    }
  };
  return skill;
}
