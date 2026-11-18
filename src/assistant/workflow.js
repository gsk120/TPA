import { randomUUID } from 'node:crypto';
import { serialize, deserialize } from 'node:v8';
import { Annotation, Command, END, MemorySaver, START, StateGraph, interrupt } from '@langchain/langgraph';
import { validateIntent } from './schema.js';

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

export async function runNaturalWorkflow({ai, input, signal, planWithoutTarget, planWithContext, previous, resume, direct}) {
  const pending = resume ? previous?.workflow : null;
  const saver = new PausedRequestSaver(pending?.snapshot);
  const threadId = pending?.threadId ?? randomUUID();
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
      result = await plan(turnClassification, pending ? intent : null);
      return {question:result.conversation?.pending ? result.conversation.request.question : null};
    });
    graph.addConditionalEdges(node, ({question}) => question ? 'confirm' : END, ['confirm', END]);
  }

  const execution = graph.compile({checkpointer:saver});
  const config = {configurable:{thread_id:threadId}, signal};
  const state = await execution.invoke(pending ? new Command({resume:input.message.text}) : {}, config);
  if (!result) throw new Error('확인 요청을 이어서 처리하지 못했어요. 다시 요청해주세요.');
  if (state.__interrupt__?.length) {
    result.conversation.workflow = {
      threadId, snapshot:saver.snapshot(), token:randomUUID(), chatId:String(input.message.chatId),
      versions:Object.fromEntries((result.refs || []).map(t => [t.id, t.version]))
    };
    if (result.button?.action.kind === 'select') {
      result.button.action.workflowToken = result.conversation.workflow.token;
    }
  }
  if (pending) result.resumeToken = pending.token;
  return result;
}
