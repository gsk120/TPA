import {timeTypes, validDay} from '../time.js';

const nullable = { type: ['string', 'null'] };
const timeType = {type:['string','null'],enum:[...timeTypes,null]};
const seriesProperties = {
  title: nullable,
  frequency: {type:['string','null'],enum:['DAILY','WEEKLY','MONTHLY',null]},
  weekday: {type:['integer','null']},
  monthDay: {type:['integer','null']},
  start: nullable,
  end: nullable,
  time: nullable,
  timeType,
  endTime: nullable,
  endDayOffset: {type:['integer','null']},
  timeNote: nullable,
  timeZone: nullable
};
const taskProperties = {
  title: { type: 'string' }, kind: { type: 'string', enum: ['task','decision','appointment','registration','event'] },
  status: { type: 'string', enum: ['open','in_progress','waiting','done','cancelled'] },
  dueDate: nullable, time: nullable, endDate: nullable, timeNote: nullable, person: nullable, assignee: nullable,
  timeType, endTime: nullable, sourceTimeZone: nullable,
  notes: { type: 'string' }, followUpDate: nullable, actualDeadline: nullable,
  remindAt: { type: 'array', items: { type: 'string' } }
};
export const schema = {
  type: 'object', additionalProperties: false, required: ['reply','actions','settings','clarification','retrieval','series'], properties: {
    series: {anyOf:[{type:'null'},{type:'object',additionalProperties:false,required:Object.keys(seriesProperties),properties:seriesProperties}]},
    retrieval: {anyOf:[{type:'null'},{type:'object',additionalProperties:false,required:['kind','status','from','to','person','search'],properties:{kind:{type:'string',enum:['task_list']},status:{type:'string',enum:['active','done','cancelled','all']},from:nullable,to:nullable,person:nullable,search:nullable}}]},
    clarification: {anyOf:[{type:'null'},{type:'object',additionalProperties:false,required:['operation','candidateIds','proposedChanges','question','unresolved'],properties:{operation:{type:'string',enum:['update','create','settings','unknown']},candidateIds:{type:'array',items:{type:'string'}},proposedChanges:{type:'array',items:{type:'object',additionalProperties:false,required:['field','value'],properties:{field:{type:'string'},value:{type:['string','integer','boolean','null']}}}},question:{type:'string'},unresolved:{type:'string'}}}]},
    settings: {anyOf:[{type:'null'},{type:'object',additionalProperties:false,required:['timeZone','dailyTime','weeklyTime','weeklyDay','dailyEnabled','weeklyEnabled'],properties:{timeZone:{type:'string'},dailyTime:{type:'string'},weeklyTime:{type:'string'},weeklyDay:{type:'integer'},dailyEnabled:{type:'boolean'},weeklyEnabled:{type:'boolean'}}}]},
    reply: { type: 'string' }, actions: { type: 'array', items: {
      type: 'object', additionalProperties: false, required: ['operation','id','expectedVersion','task','reason'], properties: {
        operation: { type: 'string', enum: ['create','update'] }, id: nullable,
        expectedVersion: { type: ['integer','null'] }, reason: { type: 'string' },
        task: { type: 'object', additionalProperties: false, required: Object.keys(taskProperties), properties: taskProperties }
      }
    } }
  }
};

export const calendarAnswerIntents = Object.freeze(['create', 'retrieve', 'settings', 'unknown']);
export const calendarDeferredIntents = Object.freeze(['update', 'complete', 'cancel', 'detail', 'history', 'mixed']);

const scopeProperties = {
  cancellation: {anyOf:[{type:'null'},{type:'object',additionalProperties:false,
    required:['scope','date','question'],properties:{
      scope:{type:['string','null'],enum:['series','occurrence',null]}, date:nullable, question:nullable
    }}]},
  completion: {anyOf:[{type:'null'},{type:'object',additionalProperties:false,
    required:['scope','date','question'],properties:{
      scope:{type:['string','null'],enum:['named','date_all',null]}, date:nullable, question:nullable
    }}]}
};

function intentBranch(intents, answer) {
  return {
    type:'object', additionalProperties:false,
    required:['intent','targets','answer','cancellation','completion'],
    properties:{ intent:{type:'string', enum:intents}, targets:{type:'array', items:{type:'string'}},
      answer, ...scopeProperties }
  };
}

// Structured Outputs permits anyOf below the root object.
export const intentSchema = {
  type:'object', additionalProperties:false, required:['classification'],
  properties:{ classification:{anyOf:[
    intentBranch(calendarAnswerIntents, schema),
    intentBranch(calendarDeferredIntents, {type:'null'})
  ]} }
};

export class CalendarOutputValidationError extends Error {
  constructor(message, field, reason) {
    super(message);
    this.field = field;
    this.reason = reason;
  }
}

export function validateIntent(value) {
  const intentError = 'AI가 요청 종류를 확인하지 못했어요. 원하는 작업을 다시 말씀해주세요.';
  if (!value) throw new CalendarOutputValidationError(intentError, '$', 'missing-object');
  const resolvesDirectly = calendarAnswerIntents.includes(value.intent);
  if (!resolvesDirectly && !calendarDeferredIntents.includes(value.intent)) {
    throw new CalendarOutputValidationError(intentError, 'intent', 'invalid-enum');
  }
  if (!Array.isArray(value.targets)) throw new CalendarOutputValidationError(intentError, 'targets', 'expected-array');
  if (value.targets.length > 20) throw new CalendarOutputValidationError(intentError, 'targets', 'too-many-items');
  value.targets.forEach((target, index) => {
    if (typeof target !== 'string' || !target.trim() || target.length > 400) {
      const reason = typeof target !== 'string' ? 'expected-string' : !target.trim() ? 'blank-string' : 'string-too-long';
      throw new CalendarOutputValidationError(intentError, `targets[${index}]`, reason);
    }
  });
  if (resolvesDirectly ? !value.answer : value.answer != null) {
    throw new CalendarOutputValidationError('AI가 요청에 필요한 정보를 확인하지 못했어요. 요청을 다시 말씀해주세요.',
      'answer', resolvesDirectly ? 'required-for-intent' : 'forbidden-for-intent');
  }
  const { completion, cancellation } = value;
  if (completion != null) {
    const message = '완료할 날짜와 대상 범위를 확인하지 못했어요.';
    const {scope, date, question} = completion;
    if (value.intent !== 'complete') throw new CalendarOutputValidationError(message, 'completion', 'intent-mismatch');
    if (scope !== null && scope !== 'named' && scope !== 'date_all') {
      throw new CalendarOutputValidationError(message, 'completion.scope', 'invalid-enum');
    }
    if (scope === null ? date !== null : !(scope === 'named' && date === null) && !validDay(date)) {
      throw new CalendarOutputValidationError(message, 'completion.date', scope === null ? 'expected-null' : 'invalid-calendar-date');
    }
    validateScopeQuestion(message, 'completion.question', scope, question);
    if (scope !== 'named' && value.targets.length) {
      throw new CalendarOutputValidationError(message, 'targets', 'expected-empty-for-completion-scope');
    }
  }
  if (cancellation != null) {
    const message = '반복 일정의 취소 범위를 확인하지 못했어요.';
    const {scope, date, question} = cancellation;
    if (value.intent !== 'cancel') throw new CalendarOutputValidationError(message, 'cancellation', 'intent-mismatch');
    if (scope !== null && scope !== 'series' && scope !== 'occurrence') {
      throw new CalendarOutputValidationError(message, 'cancellation.scope', 'invalid-enum');
    }
    const validDate = date === null || (scope === 'series' && typeof date === 'string' && /^\d{4}-\d{2}$/.test(date)
      ? validDay(date + '-01') : validDay(date));
    if (scope === null ? date !== null : !validDate) {
      throw new CalendarOutputValidationError(message, 'cancellation.date', scope === null ? 'expected-null' : 'invalid-calendar-date');
    }
    validateScopeQuestion(message, 'cancellation.question', scope, question);
  }
  if (value.answer) validateAnswer(JSON.parse(JSON.stringify(value.answer)), 'answer.');
  return value;
}

export function parseIntent(text) {
  const value = JSON.parse(text);
  // Keep valid flat classifications compatible with existing callers and fixtures.
  if (!value || !Object.hasOwn(value, 'classification')) return validateIntent(value);
  if (Object.keys(value).length !== 1) {
    throw new CalendarOutputValidationError('AI 응답 형식을 확인하지 못했어요.', '$', 'unexpected-properties');
  }
  const classification = validateIntent(value.classification);
  if (!Object.hasOwn(classification, 'answer')) {
    throw new CalendarOutputValidationError('AI 응답 형식을 확인하지 못했어요.', 'answer', 'missing-field');
  }
  return classification;
}

function validateScopeQuestion(message, field, scope, question) {
  if (scope !== null) {
    if (question !== null) throw new CalendarOutputValidationError(message, field, 'expected-null');
  } else if (typeof question !== 'string' || !question.trim() || question.length > 1000) {
    const reason = typeof question !== 'string' ? 'expected-string' : !question.trim() ? 'blank-string' : 'string-too-long';
    throw new CalendarOutputValidationError(message, field, reason);
  }
}

export function parseAnswer(text) {
  return validateAnswer(JSON.parse(text), '');
}

function validateAnswer(value, prefix) {
  const message = 'AI 응답 형식을 확인하지 못했어요.';
  if (!value || typeof value.reply !== 'string') {
    throw new CalendarOutputValidationError(message, prefix + 'reply', 'expected-string');
  }
  if (value.reply.length > 20000) throw new CalendarOutputValidationError(message, prefix + 'reply', 'string-too-long');
  if (!Array.isArray(value.actions)) throw new CalendarOutputValidationError(message, prefix + 'actions', 'expected-array');
  return value;
}
