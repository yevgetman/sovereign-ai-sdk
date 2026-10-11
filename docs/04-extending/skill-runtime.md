# Composed SDK skill runtime

`createSkillRuntime()` connects the shared skill catalog, parser, activation
policy and explicit writable store. It is optional. A minimal `createAgent()`
still opens no skill catalog or store.

The host owns each runtime. Use one instance for each profile or tenant catalog.
Do not share a writable store between tenants unless that sharing is intentional.
The SOV runtime uses this same interface. Profile resolution stays in SOV.

## A direct Node or Bun host

This example uses the published SDK entry point. It has no filesystem adapter.
Discovery and mutation read only the supplied memory store.

```ts
import {
  createAgent,
  createSkillRuntime,
  InMemorySkillStore,
} from '@yevgetman/sov-sdk';
import { SkillTool } from '@yevgetman/sov-sdk/tools/SkillTool';

const skills = createSkillRuntime({ store: new InMemorySkillStore() });
await skills.mutate({
  action: 'create',
  name: 'review',
  content: `---
name: review
description: Review a proposed change
whenToUse: Use when asked to review a proposed change for defects.
---
Read the proposed change. Report defects with evidence.`,
});

const agent = createAgent({
  provider: myProvider,
  model: myModel,
  tools: [SkillTool],
  skillRuntime: skills,
});
for await (const event of agent.run('Review this change')) {
  // Handle streamed messages and progress.
}
skills.dispose();
```

The runtime does not add tools to the agent's pool. The host selects the tools
and approval policy. `SkillTool` calls the runtime's activation operation.
An explicit `skills.discover()` or `skills.refresh()` publishes a new catalog.
Successful `skills.mutate()` refreshes the catalog before it returns.
After writing through an injected store directly, call `onMutation(event)` or
`refresh()` to publish the change. Observing an external write does not run a
background refresh.

## Filesystem discovery and a writable store

The discovery configuration selects read roots. The store selects a separate
write root. Reading a project or bundle skill does not grant write authority.

```ts
import {
  createSkillRuntime,
  FilesystemSkillStore,
} from '@yevgetman/sov-sdk';

const skills = createSkillRuntime({
  discovery: {
    cwd: projectRoot,
    harnessHome: profileHome,
    allowedLinkRoots: [approvedNodeSkillDirectory],
  },
  store: new FilesystemSkillStore({
    root: `${profileHome}/skills/agent-created`,
  }),
});
await skills.discover();
```

Filesystem stores execute their packaged worker under Node or Bun. Compiled
SOV supplies its embedded worker command. No external daemon is required.
Managed links outside the project need explicit approved roots.

## Operations and host policy

`snapshot()` returns the current detached catalog and its generation.
`discover()` and `refresh()` atomically replace that generation. A failed refresh
keeps the last successful catalog.

`inspect(name, path?)` returns inert body or reference text. It does not expand
arguments, variables or inline shell commands. Store references remain inside
the supplied store. Memory resources are not copied to an implicit disk path.
Store-only loading checks every sidecar with the shared text guard. It applies
the shared default 1 MiB file limit before parsing or decoding, and the 16 MiB
tree limit. Each skill retains its own revision; publishing a catalog does not
create a transaction across multiple skill trees.

`activate(name, {source, toolContext, state, args?})` uses the common permissioned
activation path. Native tool restrictions only narrow the existing host pool.
Portable pre-approval metadata grants no host permissions. Unsupported execution
controls and disabled invocation sources fail before effects.

The host creates the turn's state with `createSkillActivationState()`. Inline
shell and guarded skills require an explicit host approval callback. A headless
host can return `deny` for every approval request. Memory inline shell uses the
explicit context's working directory and the same Bash permission path.

`mutate(change)` uses the selected store. Edit and delete require the current
store tree revision from `store.read()`. The activation's SKILL.md digest is a
different revision and must not be used for write comparison.

`bindContext(context)` copies a host context and connects its catalog, runtime,
store and awaited mutation refresh callback. It keeps the host's permission
fields. Child contexts inherit this profile reference and the parent tool floor.
The selected runtime is authoritative: binding a read-only runtime removes any
previous writable store. Mutation tools do not fall back to a profile directory.

## Programmatic SOV hosts

Within the SOV source host, pass the same explicit composition to `buildRuntime`:

```ts
const runtime = await buildRuntime({
  cwd: projectRoot,
  harnessHome: profileHome,
  skillRuntime: skills,
  // Supply the usual provider, database and service configuration.
});
```

SOV's server, run, drive and cron activation paths use that profile's composition.
SOV still owns its session database and services. An in-memory skill catalog does
not make the entire SOV application disk-free.
SOV keeps separate explicit stores for community installation and agent-created
skills by default. An injected composition uses its own store for installation,
management and approval. A read-only injection refuses those writes. SOV disposal
removes its subscriptions but leaves the injected composition open for its host.

## Events and injected hosts

`subscribe()` reports refreshed generations, committed store mutations and
operation errors. These are local host events. Errors can contain private paths;
use the catalog's remote-safe diagnostics for client responses. Observer errors
cannot roll back a published catalog or committed write.

A committed write can succeed while the catalog refresh fails. The mutation
result still describes that committed write. The host receives an error event
and can retry `refresh()`. Call `dispose()` to remove subscriptions; it does not
delete the catalog or close a host-owned store.

Hosts can inject `load`, `resolveSkill`, `readResource` and approved resource
roots for custom storage. A manager never reads disk on its own. Virtual loaders
must provide their resolver and an empty resource-root list if they have no
filesystem namespace. Store-only catalogs already supply these ports.

## Read next

- `docs/04-extending/skill-activation.md` — permissions and activation identity.
- `docs/04-extending/skill-storage.md` — tree revisions and committed writes.
- `docs/04-extending/skill-compatibility.md` — portable metadata and invocation controls.
