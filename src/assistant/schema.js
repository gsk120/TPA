const nullable = { type: ['string', 'null'] };
const taskProperties = {
  title: { type: 'string' }, kind: { type: 'string', enum: ['task','decision','appointment','registration','event'] },
  status: { type: 'string', enum: ['open','in_progress','waiting','done','cancelled'] },
  dueDate: nullable, time: nullable, endDate: nullable, timeNote: nullable, person: nullable, assignee: nullable,
  notes: { type: 'string' }, followUpDate: nullable, actualDeadline: nullable,
  remindAt: { type: 'array', items: { type: 'string' } }
};
export const schema = {
  type: 'object', additionalProperties: false, required: ['reply','actions','settings','clarification','retrieval'], properties: {
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
export function parseAnswer(text) {
  const value = JSON.parse(text);
  if (!value || typeof value.reply !== 'string' || value.reply.length > 20000 || !Array.isArray(value.actions)) throw new Error('AI 응답 형식을 확인하지 못했어요.');
  return value;
}
