/**
 * A leased queue job and the existing worker dependencies for handling it.
 * The payload, including sentAt and replyTo, belongs to the receiving Skill.
 * @typedef {object} JobContext
 * @property {{ id: string, family_id: string, lease: string, payload: object }} job
 * @property {import('../storage.js').Store} store
 * @property {Pick<import('../assistant/codex.js').Codex, 'classify' | 'answer'>} ai
 * @property {Date} now Worker processing time.
 * @property {AbortSignal} [signal]
 * @property {object} options
 * @property {ReturnType<typeof import('../settings.js').validateSettings>} options.settings
 * @property {number} options.settingsVersion
 * @property {() => Promise<void>} options.authorize
 */

/**
 * The Skill owns its context and job completion. Rejections reach the worker.
 * @typedef {object} Skill
 * @property {string} id
 * @property {(input: JobContext) => Promise<string>} handle
 */

export {};
