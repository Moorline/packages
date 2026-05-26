import manifest from './manifest.json' with { type: 'json' };

function makeSourceRef(guildId, channelId, threadId, at) {
  return `discord:g${guildId}:c${channelId}:t${threadId ?? 'root'}:${at.replace(/[^0-9]/g, '').slice(0, 14)}`;
}
function summarizeSessions(sessions) {
  if (sessions.length === 0) return 'No sessions yet.';
  return sessions.map((session) => {
    const summary = session.summary ? ` | ${session.summary}` : '';
    return `- ${session.sessionId} (${session.lifecycleStatus}, ${session.runtimeMode})${summary}`;
  }).join('\n');
}
function trimSummary(text) {
  return text.replace(/\s+/g, ' ').trim().slice(0, 240);
}
function formatAuthorLine(input) {
  return `${input.actorLabel} (id ${input.actorId})`;
}
function formatRetrievedMemory(items) {
  if (items.length === 0) return ['Retrieved memory: none'];
  return ['Retrieved memory:', ...items.map((item, index) => {
    const preview = item.content.replace(/\s+/g, ' ').trim().slice(0, 260);
    return `${index + 1}. [${item.strategy}] ${preview} (refs: ${item.sourceRefs.join(', ')})`;
  })];
}
function extractFacts(reply) {
  return reply.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0).filter((line) => !line.startsWith('```')).map((line) => line.replace(/^[-*]\s+/, '')).filter((line) => !/^(todo|next steps?)[:\s]/i.test(line) && !/^\[[ xX]\]/.test(line)).slice(0, 6);
}
function extractTasks(reply) {
  return reply.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^[-*]\s+\[[ xX]?\]/.test(line) || /^(todo|next steps?)[:\s]/i.test(line)).map((line) => line.replace(/^[-*]\s+/, '')).slice(0, 6);
}
export default {
  id: manifest.id,
  manifest,
  async beforeAgentPrompt(input, context) {
    const scopeId = context.config.transport.scopeId;
    const retrieval = await context.retrieveMemory({
      query: input.text,
      scopeId,
      spaceId: input.surface === 'session' ? input.spaceId : undefined,
      threadId: input.session?.threadId ?? null,
      maxResults: input.surface === 'session' ? 5 : 4,
      enableRerank: true
    });
    if (input.surface === 'main_chat') {
      return ['Memory context:', summarizeSessions(context.listSessions()), ...formatRetrievedMemory(retrieval)];
    }
    return [`Current session summary: ${input.session?.summary ?? 'No prior summary recorded yet.'}`, ...formatRetrievedMemory(retrieval)];
  },
  async afterAgentResponse(input, context) {
    if (input.surface !== 'session' || !input.session) return;
    const summary = trimSummary(input.replyMessage);
    const nowIso = context.nowIso();
    const sourceRef = makeSourceRef(context.config.transport.scopeId, input.spaceId, input.session.threadId, nowIso);
    const facts = extractFacts(input.replyMessage);
    const tasks = extractTasks(input.replyMessage);
    const authorLine = formatAuthorLine(input);
    await context.updateSessionSummary(input.spaceId, summary, nowIso);
    await context.writeSessionMemory({
      scopeId: context.config.transport.scopeId,
      spaceId: input.spaceId,
      threadId: input.session.threadId,
      kind: 'log',
      content: `${authorLine}: ${input.text}\n\nMoorline: ${input.replyMessage}`,
      sourceRefs: [sourceRef]
    });
    await context.writeSessionMemory({
      scopeId: context.config.transport.scopeId,
      spaceId: input.spaceId,
      threadId: input.session.threadId,
      kind: 'summary',
      content: summary,
      sourceRefs: [sourceRef]
    });
    if (facts.length > 0) {
      const factsBody = facts.map((fact) => `- ${fact}`).join('\n');
      await context.writeSessionMemory({
        scopeId: context.config.transport.scopeId,
        spaceId: input.spaceId,
        threadId: input.session.threadId,
        kind: 'facts',
        content: factsBody,
        sourceRefs: [sourceRef]
      });
      await context.writeServerMemory({ scopeId: context.config.transport.scopeId, kind: 'facts', content: factsBody, sourceRefs: [sourceRef] });
      await context.writeProjectMemory({ projectKey: 'default', kind: 'facts', content: factsBody, sourceRefs: [sourceRef] });
    }
    if (tasks.length > 0) {
      const tasksBody = tasks.map((task) => `- ${task}`).join('\n');
      await context.writeSessionMemory({
        scopeId: context.config.transport.scopeId,
        spaceId: input.spaceId,
        threadId: input.session.threadId,
        kind: 'tasks',
        content: tasksBody,
        sourceRefs: [sourceRef]
      });
      await context.writeServerMemory({ scopeId: context.config.transport.scopeId, kind: 'tasks', content: tasksBody, sourceRefs: [sourceRef] });
      await context.writeProjectMemory({ projectKey: 'default', kind: 'tasks', content: tasksBody, sourceRefs: [sourceRef] });
    }
  }
};
