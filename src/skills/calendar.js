import { processJob } from '../processor.js';

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
