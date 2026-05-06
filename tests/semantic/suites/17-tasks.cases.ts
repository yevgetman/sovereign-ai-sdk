// Phase 13.2 — Task system semantic tests. Five tools (task_create /
// task_list / task_get / task_output / task_stop) and the /tasks slash
// command shipped without semantic coverage; this suite closes the gap.
//
// The build plan's "Check" stanza for Phase 13.2 reads:
//   "ask the model to run two read-only exploration tasks and one
//    verification task. task_list shows running/completed states,
//    task_output returns bounded summaries, and task_stop cancels a
//    long task."
// — that's the authoritative spec for cases 1 and 3 here. Case 2 covers
// the task_get round-trip (id passed in, full record returned). Case 4
// covers the unknown-subagent_type clear-error path: the tool throws
// rather than silently dropping the call, and the model surfaces that
// error in plain language.
//
// Why the assertions are flexible about the task's terminal state:
// task_create is fire-and-forget — task_list called immediately after
// will typically see 'queued' or 'running', not 'completed'. The judge
// criteria intentionally do not require the task to have completed; the
// signal we want to catch is "the tools dispatched and surfaced sensible
// state", not "the child finished in N seconds". That makes the tests
// robust to live-model timing variance.

import type { SemanticTest } from '../framework/types.js';

export const tests: SemanticTest[] = [
  {
    id: 'tasks-create-list-output-flow',
    name: 'Model dispatches two parallel tasks and reads bounded output',
    description:
      'Phase 13.2 build-plan check: parent uses task_create to launch two read-only exploration ' +
      'tasks against the explore agent, observes them via task_list, and retrieves bounded output ' +
      'via task_output for each. Guards against: task_create not registering tasks under the parent ' +
      "session id, task_list missing in-flight tasks, task_output's bounded payload not surfacing " +
      'state/summary, or the manager dropping tasks between create and observation.',
    category: 'tools',
    setup: {
      files: [
        {
          path: 'src/agents/loader.ts',
          content:
            '// Loader for agent definitions.\n' +
            'export function loadAgents(): string[] {\n' +
            '  return ["explore", "verify", "plan"];\n' +
            '}\n',
        },
        {
          path: 'src/agents/types.ts',
          content:
            '// Agent-related TypeScript types.\n' +
            'export interface AgentDefinition {\n' +
            '  name: string;\n' +
            '  description: string;\n' +
            '}\n',
        },
        {
          path: 'src/runtime/scheduler.ts',
          content:
            '// SubagentScheduler — owns concurrency, lineage, cancellation.\n' +
            '// AgentTool reads ctx.subagentScheduler at call time.\n' +
            'export class SubagentScheduler {}\n',
        },
        {
          path: 'README.md',
          content: '# Demo Repo\n\nA tiny TypeScript project with a few files under src/.\n',
        },
      ],
    },
    prompt:
      'I want to dispatch two background exploration tasks in parallel. Use the task_create tool ' +
      'twice (subagent_type "explore" both times): the first task should find files matching the ' +
      "glob 'src/agents/*.ts' and report their paths; the second should grep for 'SubagentScheduler' " +
      'inside src/. After dispatching both, call task_list to confirm the tasks were registered, ' +
      'then call task_output for each task id (using the ids returned by task_create) to read ' +
      'their state. Finally, summarise what tasks you launched, what task_list showed, and what ' +
      'state task_output reported for each. Do not block waiting for completion — report whatever ' +
      'state the tools currently show.',
    binaryArgs: ['--permission-mode', 'bypass'],
    judgeCriteria: {
      mustSatisfy: [
        'The agent invoked the task_create tool at least twice (one call per exploration task).',
        'The agent invoked the task_list tool at least once after the task_create calls.',
        'The agent invoked the task_output tool at least twice (once per task id returned by task_create).',
        "The agent's final response references both tasks it launched (file glob task and SubagentScheduler grep task) and reports a concrete state for each (e.g., queued, running, completed, or similar lifecycle term).",
      ],
      shouldNot: [
        'The agent claims it cannot dispatch tasks or that the task tools are unavailable.',
        'The agent fabricates task ids without any task_create invocation in the transcript.',
        'The agent invokes AgentTool (synchronous delegation) instead of task_create when explicitly asked to use task_create.',
      ],
    },
    timeoutMs: 180_000,
  },
  {
    id: 'tasks-get-roundtrip-by-id',
    name: 'task_get returns the persisted record for a task id',
    description:
      'task_create returns a TaskRecord; task_get on the same id should return the same record ' +
      'with agent + prompt round-tripping. Guards against: task_get missing in the tool pool, the ' +
      'store losing rows between insert and read, or the model fabricating a response without ' +
      'calling task_get at all. Single-task case so the assertion can be precise.',
    category: 'tools',
    prompt:
      'Use task_create to launch a single explore task with subagent_type "explore" and ' +
      'prompt "find auth-related files in this repo". Capture the task id from the result. ' +
      'Then call task_get with that exact id. Confirm in your final response that the agent ' +
      'name on the returned record is "explore" and that the prompt round-tripped (matches what ' +
      'you sent). Quote the relevant fields from the task_get result.',
    binaryArgs: ['--permission-mode', 'bypass'],
    judgeCriteria: {
      mustSatisfy: [
        'The agent invoked the task_create tool with subagent_type "explore".',
        'The agent invoked the task_get tool with the task id returned by task_create (the id should appear in the task_get input visible in the transcript).',
        'The agent\'s final response confirms that task_get returned a record with agent="explore" and a prompt referencing auth-related files.',
      ],
      shouldNot: [
        'The agent skipped task_get and fabricated the round-trip claim.',
        'The agent called task_get with a hardcoded or invented id rather than the one returned by task_create.',
        'The agent reported a different agent name (e.g., "verify" or "plan") than what it actually requested.',
      ],
    },
    timeoutMs: 120_000,
  },
  {
    id: 'tasks-stop-cancels-running-task',
    name: 'task_stop cancels a running task and the state moves toward terminal',
    description:
      'Phase 13.2 build-plan check: the parent should be able to launch a long-running task and ' +
      'cancel it via task_stop. Guards against: task_stop being missing from the parent tool pool ' +
      "(it's correctly excluded from sub-agents but must be present for the parent), the abort " +
      'signal not propagating from the controller to the scheduler, or the manager not surfacing ' +
      'the cancellation in subsequent task_get calls. The assertion accepts cancelled / timed_out ' +
      "/ still-running because cancellation is cooperative and may race with the test's view of " +
      'the record — what we strictly require is that task_stop was invoked.',
    category: 'tools',
    prompt:
      'Use task_create to launch a long-running explore task: subagent_type "explore", prompt ' +
      '"List every single file under the entire repository recursively and provide a one-sentence ' +
      'summary of each one. Be thorough and exhaustive — visit every directory.". Capture the task ' +
      'id from the result. Then IMMEDIATELY (do not wait, do not think out loud first, do not call ' +
      'any other tool first) call task_stop with that task id. After task_stop returns, call ' +
      'task_get with the same id and report the state field from the returned record. Do not ' +
      'launch any additional tasks.',
    binaryArgs: ['--permission-mode', 'bypass'],
    judgeCriteria: {
      mustSatisfy: [
        'The agent invoked the task_create tool with subagent_type "explore".',
        'The agent invoked the task_stop tool with the task id returned by task_create.',
        'The agent invoked the task_get tool after task_stop to inspect the resulting state.',
        "The agent's final response reports a state for the task (any of: queued, running, cancelled, timed_out, failed, or completed — the exact terminal state may race with the test view, but a concrete state must be named).",
      ],
      shouldNot: [
        'The agent fabricated a cancellation result without calling task_stop.',
        'The agent skipped the task_get verification step entirely.',
        'The agent claims task_stop is unavailable or refuses to call it.',
      ],
    },
    timeoutMs: 180_000,
  },
  {
    id: 'tasks-unknown-subagent-type-errors-clearly',
    name: 'task_create with an unknown subagent_type surfaces a clear error',
    description:
      'task_create rejects unknown subagent_type values with an error listing the available ' +
      'agents. The schema patch in patchSchemasAgainstAvailable() rewrites subagent_type to a ' +
      'closed enum at tool-pool assembly time, so most live calls will be schema-rejected before ' +
      'they reach the tool body — but the tool body also defends in depth (see TaskCreateTool.ts). ' +
      'This test exercises the failure path end-to-end: whether rejection comes from the schema ' +
      'enum or the tool body, the model should see an error and surface it honestly rather than ' +
      'fabricating success.',
    category: 'tools',
    prompt:
      'Try to call task_create with subagent_type "nonexistent_agent" and prompt "do something". ' +
      'Tell me exactly what happened — did the call succeed, did it error, and if it errored, ' +
      'what did the error message say?',
    binaryArgs: ['--permission-mode', 'bypass'],
    judgeCriteria: {
      mustSatisfy: [
        'The agent attempted to invoke task_create with subagent_type "nonexistent_agent" (the attempt should be visible in the transcript, even if the schema layer rejected the call before dispatch).',
        "The agent's final response reports that the call failed / errored / was rejected — it must NOT claim success.",
        "The agent's final response identifies the cause as an unknown / unavailable / invalid subagent_type, OR references the available agents (explore / verify / plan), OR quotes the error text.",
      ],
      shouldNot: [
        'The agent claims the task was successfully created.',
        'The agent fabricates a task id for a call that never succeeded.',
        'The agent silently substitutes a different subagent_type without telling the user.',
      ],
    },
    timeoutMs: 90_000,
  },
];
