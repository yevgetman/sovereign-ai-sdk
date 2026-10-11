// Public tarball consumption under Node and Bun. No provider network calls.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FilesystemSkillStore,
  InMemorySkillContinuityStore,
  InMemorySkillStore,
  createAgent,
  createSkillActivationState,
  createSkillContinuity,
  createSkillRuntime,
} from '@yevgetman/sov-sdk';
import { SkillTool } from '@yevgetman/sov-sdk/tools/SkillTool';

const content =
  '---\nname: packed\ndescription: Packed workflow\nwhenToUse: Use when asked to run the packed workflow.\n---\nPacked {{args}}';
// Patch the public fs seam after module import. Named exports are synchronized
// for Node. Memory skill operations must not call any of these APIs.
const originals = new Map();
let diskCalls = 0;
for (const name of [
  'access',
  'open',
  'readFile',
  'writeFile',
  'mkdir',
  'readdir',
  'opendir',
  'realpath',
  'stat',
  'lstat',
  'rename',
  'unlink',
]) {
  originals.set(name, fs.promises[name]);
  fs.promises[name] = async () => {
    diskCalls++;
    throw new Error(`memory runtime accessed fs.${name}`);
  };
}
syncBuiltinESMExports();
try {
  const store = new InMemorySkillStore();
  const runtime = createSkillRuntime({ store });
  await runtime.mutate({ action: 'create', name: 'packed', content });
  await runtime.discover();
  const context = runtime.bindContext({
    cwd: '/missing-memory-catalog',
    sessionId: 'packed-memory',
  });
  const continuityStore = new InMemorySkillContinuityStore();
  const continuityScope = { profile: 'packed', owner: 'fixture', session: context.sessionId };
  context.skillContinuity = createSkillContinuity({
    scope: continuityScope,
    store: continuityStore,
  });
  context.skillActivation = createSkillActivationState({ tools: [SkillTool] });
  const result = await SkillTool.call({ skill: 'packed', args: 'works' }, context);
  assert.equal(result.data.prompt, 'Packed works');
  assert.deepEqual(result.data.activation.allowedResourceRoots, []);
  assert.equal((await runtime.inspect('packed')).content, 'Packed {{args}}');
  const requests = [];
  const provider = {
    name: 'packed-fixture',
    async *stream(request) {
      requests.push(request);
      const message =
        requests.length === 1
          ? {
              role: 'assistant',
              content: [
                {
                  type: 'tool_use',
                  id: 'packed-call',
                  name: 'SkillTool',
                  input: { skill: 'packed', args: 'agent' },
                },
              ],
            }
          : { role: 'assistant', content: [{ type: 'text', text: 'done' }] };
      yield { type: 'message_start' };
      yield { type: 'message_stop', stop_reason: requests.length === 1 ? 'tool_use' : 'end_turn' };
      yield { type: 'assistant_message', message };
      return message;
    },
  };
  const agent = createAgent({
    provider,
    model: 'fixture',
    cwd: context.cwd,
    tools: [SkillTool],
    skillRuntime: runtime,
  });
  const { skillActivation: _expired, ...resumedContext } = context;
  resumedContext.skillContinuity = createSkillContinuity({
    scope: continuityScope,
    store: continuityStore,
  });
  const run = agent.run('Activate packed', {
    sessionId: context.sessionId,
    toolContext: resumedContext,
  });
  let end = await run.next();
  while (!end.done) end = await run.next();
  assert.equal(end.value.terminal.reason, 'completed');
  assert.match(JSON.stringify(requests[0].messages), /Packed works/);
  assert.match(JSON.stringify(requests[1].messages), /Packed agent/);
  assert.doesNotMatch(JSON.stringify(requests[1].system), /Packed agent/);
  const records = await resumedContext.skillContinuity.exportRecords();
  assert.equal(records[0].outcome, 'succeeded');
  assert.equal(Object.hasOwn(records[0], 'allowedTools'), false);
  assert.equal(diskCalls, 0);
  runtime.dispose();
} finally {
  for (const [name, fn] of originals) fs.promises[name] = fn;
  syncBuiltinESMExports();
}

// The explicit filesystem adapter proves the packaged worker path, not just
// source imports or a mocked store. Its effects are confined to this fixture.
const scratch = await mkdtemp(join(tmpdir(), 'sov-packed-skills-'));
try {
  const root = join(scratch, 'writable');
  await mkdir(root);
  const runtime = createSkillRuntime({ store: new FilesystemSkillStore({ root }) });
  const created = await runtime.mutate({ action: 'create', name: 'packed', content });
  await runtime.discover();
  assert.ok(created.entry.revision);
  assert.equal(runtime.snapshot().registry.skills.length, 1);
  const activated = await runtime.activate('packed', {
    source: 'user',
    args: 'filesystem',
    toolContext: { cwd: scratch, sessionId: 'packed-filesystem' },
    state: createSkillActivationState({ tools: [] }),
  });
  assert.equal(activated.prompt, 'Packed filesystem');
  runtime.dispose();
} finally {
  await rm(scratch, { recursive: true, force: true });
}
console.log('SKILL_RUNTIME_OK');
