import { randomUUID } from 'node:crypto';
import { serialize, deserialize } from 'node:v8';
import { Annotation, Command, END, INTERRUPT, MemorySaver, START, StateGraph, interrupt } from '@langchain/langgraph';
import { validateIntent } from './schema.js';
import { jobDebug } from '../diagnostics.js';

const State = Annotation.Root({
  intent: Annotation(),
  question: Annotation()
});

const routes = {
  create:'createSchedule', update:'updateSchedule', complete:'completeSchedule',
  cancel:'updateSchedule', retrieve:'retrieveSchedules', detail:'retrieveSchedules',
  history:'retrieveHistory', settings:'changeSettings', mixed:'handleMixed',
  unknown:'respond', existing:'continueExisting'
};

// Persist only paused executions, in the same transaction as the question and its Telegram delivery.
class PausedRequestSaver extends MemorySaver {
  constructor(snapshot) {
    super();
    if (snapshot) Object.assign(this, deserialize(Buffer.from(snapshot, 'base64')));
  }
  snapshot() {
    return serialize({storage:this.storage, writes:this.writes}).toString('base64');
  }
}

export class PendingCheckpointError extends Error {}

export async function runNaturalWorkflow({ai, input, signal, planWithoutTarget, planWithContext, previous, resume, direct}) {
  const pending = resume ? previous?.workflow : null;
  const threadId = pending?.threadId ?? randomUUID();
  const config = {configurable:{thread_id:threadId}, signal};
  let saver;
  if (pending) jobDebug('calendar.checkpoint.restore.start');
  try {
    saver = new PausedRequestSaver(pending?.snapshot);
    if (pending) {
      const saved = pending.threadId && pending.token && pending.snapshot ? await saver.getTuple(config) : null;
      if (!saved?.pendingWrites?.some(([, channel, interrupts]) => channel === INTERRUPT
          && Array.isArray(interrupts) && interrupts.length > 0)) {
        throw new PendingCheckpointError('저장된 확인 상태를 찾지 못했어요.');
      }
    }
  } catch (cause) {
    if (!pending || cause instanceof PendingCheckpointError) throw cause;
    throw new PendingCheckpointError('저장된 확인 상태를 복원하지 못했어요.', { cause });
  }
  if (pending) jobDebug('calendar.checkpoint.restore.done');
  let result;
  let classification;

  const graph = new StateGraph(State)
    .addNode('classify', async () => {
      classification = !direct && ai.classify
        ? validateIntent(await ai.classify(input, signal))
        : null;
      return {intent:classification?.intent ?? 'existing'};
    })
    .addNode('confirm', ({question}) => {
      interrupt(question);
      return {question:null};
    })
    .addEdge(START, 'classify')
    .addConditionalEdges('classify', ({intent}) => routes[intent], [...new Set(Object.values(routes))])
    .addConditionalEdges('confirm', ({intent}) => routes[intent], [...new Set(Object.values(routes))]);

  for (const node of new Set(Object.values(routes))) {
    graph.addNode(node, async ({intent}) => {
      const withoutTarget = ['create','retrieve','settings','unknown'].includes(intent);
      const plan = withoutTarget ? planWithoutTarget : planWithContext;
      const request = pending ? previous.request : null;
      const turnClassification = request?.seriesCancellation || request?.dateCompletion && !request.dateCompletion.targets
        ? validateIntent(await ai.classify({
          ...input, now:new Date(request.startedAt),
          settings:{...input.settings,timeZone:request.timeZone}, pendingRequest:request
        }, signal))
        : classification;
      jobDebug('calendar.plan.start', { intent });
      result = await plan(turnClassification, pending ? intent : null);
      return {question:result.conversation?.pending ? result.conversation.request.question : null};
    });
    graph.addConditionalEdges(node, ({question}) => question ? 'confirm' : END, ['confirm', END]);
  }

  const execution = graph.compile({checkpointer:saver});
  jobDebug('calendar.workflow.start', { resume:!!pending, direct:!!direct });
  const state = await execution.invoke(pending ? new Command({resume:input.message.text}) : {}, config);
  if (!result) {
    const message = '확인 요청을 이어서 처리하지 못했어요. 다시 요청해주세요.';
    throw pending ? new PendingCheckpointError(message) : new Error(message);
  }
  if (state.__interrupt__?.length) {
    jobDebug('calendar.checkpoint.prepare');
    result.conversation.workflow = {
      threadId, snapshot:saver.snapshot(), token:randomUUID(), chatId:String(input.message.chatId),
      versions:Object.fromEntries((result.refs || []).map(t => [t.id, t.version]))
    };
    if (result.button?.action.kind === 'select') {
      result.button.action.workflowToken = result.conversation.workflow.token;
    }
  }
  jobDebug('calendar.workflow.done', { interrupted:!!state.__interrupt__?.length });
  if (pending) result.resumeToken = pending.token;
  return result;
}
