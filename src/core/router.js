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
