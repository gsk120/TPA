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

export const intentSchema = {
  type: 'object', additionalProperties: false,
  required: ['intent', 'targets', 'answer', 'cancellation'],
  properties: {
    intent: {type:'string', enum:['create','update','complete','cancel','retrieve','detail','history','settings','mixed','unknown']},
    targets: {type:'array', items:{type:'string'}},
    answer: {anyOf:[{type:'null'}, schema]},
    cancellation: {anyOf:[{type:'null'},{type:'object',additionalProperties:false,
      required:['scope','date','question'],properties:{
        scope:{type:['string','null'],enum:['series','occurrence',null]}, date:nullable, question:nullable
      }}]}
  }
};

export function validateIntent(value) {
  if (!value || !intentSchema.properties.intent.enum.includes(value.intent)
      || !Array.isArray(value.targets) || value.targets.length > 20
      || value.targets.some(t => typeof t !== 'string' || !t.trim() || t.length > 400)) {
    throw new Error('AI가 요청 종류를 확인하지 못했어요. 원하는 작업을 다시 말씀해주세요.');
  }
  const resolvesDirectly = ['create','retrieve','settings','unknown'].includes(value.intent);
  if (resolvesDirectly !== !!value.answer) {
    throw new Error('AI가 요청에 필요한 정보를 확인하지 못했어요. 요청을 다시 말씀해주세요.');
  }
  const {cancellation} = value;
  if (cancellation != null) {
    const {scope, date, question} = cancellation;
    const validDate = date === null || (scope === 'series' && typeof date === 'string' && /^\d{4}-\d{2}$/.test(date)
      ? validDay(date + '-01') : validDay(date));
    const validScope = scope === null
      ? date === null && typeof question === 'string' && !!question.trim() && question.length <= 1000
      : ['series','occurrence'].includes(scope) && question === null && validDate;
    if (value.intent !== 'cancel' || !validScope) throw new Error('반복 일정의 취소 범위를 확인하지 못했어요.');
  }
  if (value.answer) parseAnswer(JSON.stringify(value.answer));
  return value;
}
export function parseAnswer(text) {
  const value = JSON.parse(text);
  if (!value || typeof value.reply !== 'string' || value.reply.length > 20000 || !Array.isArray(value.actions)) throw new Error('AI 응답 형식을 확인하지 못했어요.');
  return value;
}
