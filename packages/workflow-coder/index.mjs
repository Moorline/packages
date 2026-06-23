import manifest from './manifest.json' with { type: 'json' };
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const MAX_LOOPS = 4;

function textOf(payload) {
  if (!payload) return '';
  const text = typeof payload.text === 'string' ? payload.text : '';
  const blocks = Array.isArray(payload.blocks)
    ? payload.blocks.map((block) => [block.title, block.text, Array.isArray(block.fields) ? block.fields.map((field) => `${field.label}: ${field.value}`).join('\n') : ''].filter(Boolean).join('\n')).join('\n\n')
    : '';
  return [text, blocks].filter(Boolean).join('\n\n').trim();
}

function option(input, key) {
  const value = input?.[key];
  return typeof value === 'string' ? value.trim() : '';
}

function safeSlug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'coding-workflow';
}

function extractJson(text) {
  const fenced = text.match(/```json\s*([\s\S]*?)```/i);
  const raw = fenced?.[1] ?? text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  return JSON.parse(raw);
}

async function writeArtifacts(root, runId, artifacts) {
  const dir = join(root, '.moorline', 'workflows', runId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'SPEC.md'), artifacts.spec.trim() + '\n', 'utf8');
  await writeFile(join(dir, 'GOAL_CHECK.md'), artifacts.goalCheck.trim() + '\n', 'utf8');
  await writeFile(join(dir, 'README.md'), `# Moorline coding workflow ${runId}\n\n- Spec: SPEC.md\n- Goal check: GOAL_CHECK.md\n`, 'utf8');
  return dir;
}

async function planWorkflow(context, session, idea, actor) {
  const prompt = `You are a senior product/engineering planner. Turn the user's feature idea into implementation artifacts.\n\nIf crucial information is missing, return JSON with status "questions" and a questions array. Ask all important end-user/product-side questions at once.\n\nIf enough is known, return JSON with status "ready", title, spec, and goalCheck. The spec is system instructions for an implementation agent. The goalCheck is instructions for a reviewer agent to decide if the feature is complete.\n\nUser idea:\n${idea}`;
  const reply = await context.runAgent({
    surface: 'session',
    transportResourceId: session.transportResourceId,
    actorId: actor.actorId,
    actorLabel: actor.displayName ?? actor.actorId,
    message: prompt,
    session,
    cwd: session.workspacePath,
    runtimeMode: session.runtimeMode,
    context: {
      systemPromptSections: ['You produce concise, valid JSON only. Do not include markdown outside JSON.']
    },
    promptSource: 'workflow.planning'
  });
  return extractJson(textOf(reply));
}

async function runReview(context, session, artifactDir, spec, goalCheck, loop) {
  const reply = await context.runAgent({
    surface: 'session',
    transportResourceId: session.transportResourceId,
    actorId: 'workflow:reviewer',
    actorLabel: 'Moorline Workflow Reviewer',
    message: `Review implementation loop ${loop}. Inspect the repository and decide whether the feature is complete.\n\nArtifact directory: ${artifactDir}\n\nSPEC:\n${spec}\n\nGOAL CHECK:\n${goalCheck}\n\nReturn JSON only: {"done": boolean, "summary": string, "findings": string[], "remainingWork": string[], "confidence": number}.`,
    session,
    cwd: session.workspacePath,
    runtimeMode: session.runtimeMode,
    context: {
      systemPromptSections: ['You are a strict reviewer. Return valid JSON only. Prefer done=false unless the goal check is satisfied by repo state.']
    },
    promptSource: 'workflow.review'
  });
  return extractJson(textOf(reply));
}

async function runHandoff(context, session, artifactDir, spec, review, loop) {
  const reply = await context.runAgent({
    surface: 'session',
    transportResourceId: session.transportResourceId,
    actorId: 'workflow:handoff',
    actorLabel: 'Moorline Workflow Handoff',
    message: `Create the next focused implementation prompt for loop ${loop + 1}.\n\nArtifact directory: ${artifactDir}\n\nSPEC:\n${spec}\n\nReviewer result JSON:\n${JSON.stringify(review, null, 2)}\n\nReturn a direct prompt for the implementation agent. Include concrete files/areas to inspect and acceptance targets.`,
    session,
    cwd: session.workspacePath,
    runtimeMode: session.runtimeMode,
    context: {
      systemPromptSections: ['You write concise implementation handoff prompts.']
    },
    promptSource: 'workflow.handoff'
  });
  return textOf(reply);
}

async function runCodingWorkflow(event, context) {
  const idea = option(event.input, 'idea');
  if (!idea) {
    return { handled: true, reply: { text: 'Missing required `idea` input.' } };
  }
  if (!event.transportResourceId) {
    return { handled: true, reply: { text: 'Coding workflows must be started from a session transport resource.' } };
  }
  const snapshot = context.getSessionSnapshotByTransportResourceId(event.transportResourceId);
  const parent = snapshot?.session;
  if (!parent?.workspacePath) {
    return { handled: true, reply: { text: 'This workflow needs to be started in a workspace-backed Moorline session.' } };
  }

  await context.sendMessage(event.transportResourceId, { text: 'Starting coding workflow planning…' });
  const plan = await planWorkflow(context, parent, idea, event.actor);
  if (plan.status === 'questions') {
    const questions = Array.isArray(plan.questions) ? plan.questions : [];
    return {
      handled: true,
      reply: {
        text: `I need a little more detail before starting implementation:\n\n${questions.map((q, index) => `${index + 1}. ${q}`).join('\n')}\n\nReply with the answers, then run the workflow again with the expanded idea.`
      }
    };
  }

  const title = typeof plan.title === 'string' ? plan.title : 'Coding workflow';
  const spec = String(plan.spec ?? '').trim();
  const goalCheck = String(plan.goalCheck ?? '').trim();
  if (!spec || !goalCheck) {
    return { handled: true, reply: { text: 'Planner did not produce both spec and goal-check docs. Please retry with more detail.' } };
  }

  const runId = `${Date.now()}-${safeSlug(title)}`;
  const artifactDir = await writeArtifacts(parent.workspacePath, runId, { spec, goalCheck });
  await context.sendMessage(event.transportResourceId, { text: `Created workflow artifacts in ${artifactDir}. Creating implementation session…` });

  const created = await context.createSession({
    requestedName: `workflow-${safeSlug(title)}`,
    runtimeMode: parent.runtimeMode,
    objective: title,
    owner: { kind: 'workflow', id: runId, label: title },
    tags: ['workflow', 'coding'],
    initialInstruction: `You are the implementation agent for Moorline coding workflow ${runId}.\n\nRead and follow:\n- ${join(artifactDir, 'SPEC.md')}\n- ${join(artifactDir, 'GOAL_CHECK.md')}\n\nImplement the feature in the repository. Run appropriate checks. Report changed files, tests, and remaining risks.`
  });

  let loop = 1;
  let review = null;
  while (loop <= MAX_LOOPS) {
    await context.sendMessage(event.transportResourceId, { text: `Workflow ${runId}: review loop ${loop}/${MAX_LOOPS}…` });
    review = await runReview(context, created.session, artifactDir, spec, goalCheck, loop);
    if (review.done === true) {
      return {
        handled: true,
        reply: {
          text: `Workflow complete: ${title}\n\nImplementation session: ${created.session.sessionId}\nArtifacts: ${artifactDir}\nReviewer summary: ${review.summary ?? 'done'}\nConfidence: ${review.confidence ?? 'unknown'}`
        },
        audit: { event: 'workflow.coding.completed', payload: { runId, sessionId: created.session.sessionId, loops: loop } }
      };
    }
    const handoff = await runHandoff(context, created.session, artifactDir, spec, review, loop);
    await context.directSession({
      sessionId: created.session.sessionId,
      instruction: handoff,
      reason: `workflow ${runId} handoff loop ${loop}`
    });
    loop += 1;
  }

  return {
    handled: true,
    reply: {
      text: `Workflow paused after ${MAX_LOOPS} review loops: ${title}\n\nImplementation session: ${created.session.sessionId}\nArtifacts: ${artifactDir}\nLast reviewer summary: ${review?.summary ?? 'n/a'}\nRemaining work: ${Array.isArray(review?.remainingWork) ? review.remainingWork.join('; ') : 'unknown'}`
    },
    audit: { event: 'workflow.coding.paused', payload: { runId, sessionId: created.session.sessionId, loops: MAX_LOOPS } }
  };
}

export default {
  id: manifest.id,
  manifest,
  workflows() {
    return [
      {
        id: 'coding-workflow',
        title: 'Coding workflow',
        description: 'Plan, implement, review, and iterate on a coding feature.',
        inputSchema: {
          type: 'object',
          required: ['idea'],
          properties: {
            idea: {
              type: 'string',
              description: 'Feature idea or implementation request'
            }
          }
        },
        requiredCapability: 'session.create',
        trigger: {
          label: 'Start coding workflow',
          sessionOnly: true
        }
      }
    ];
  },
  async onAction(event, context) {
    if (event.actionId !== 'coding-workflow') {
      return { handled: false };
    }
    if (!event.transportResourceId) {
      return { handled: true, reply: { text: 'Coding workflows must be started from a session transport resource.' } };
    }
    const idea = option(event.input, 'idea');
    if (!idea) {
      return { handled: true, reply: { text: 'Missing required `idea` input.' } };
    }
    if (typeof event.input?.__workflowRunId === 'string') {
      return await runCodingWorkflow(event, context);
    }
    void runCodingWorkflow(event, context)
      .then(async (result) => {
        if (result?.reply) {
          await context.sendMessage(event.transportResourceId, result.reply);
        }
        if (result?.audit) {
          context.appendAuditEvent(result.audit.event, result.audit.payload ?? {});
        }
      })
      .catch(async (error) => {
        const detail = error instanceof Error ? error.message : String(error);
        await context.sendMessage(event.transportResourceId, {
          text: `Coding workflow failed: ${detail.slice(0, 1000)}`
        });
        context.appendAuditEvent('workflow.coding.failed', { error: detail });
      });
    return { handled: true, reply: { text: 'Coding workflow started. I will post planning, review, and completion updates here.' } };
  }
};
