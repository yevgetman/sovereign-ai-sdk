# Explicit skill storage

The SDK exposes `SkillWritableStore`, `FilesystemSkillStore` and
`InMemorySkillStore`. A host selects the writable store explicitly. `createAgent`
does not select an ambient home or create a skill directory.

`skill_manage` accepts an injected `ToolContext.skillStore`. An explicit
`ToolContext.harnessHome` remains a compatibility adapter for hosts that already
selected a home. With neither field, the tool refuses mutation and writes nothing.

## Identity and revisions

A stored identity is its slash-safe name. Create refuses an existing identity.
Edit and delete require `expectedRevision` from `store.read(name)` or a successful
mutation result. Missing identities and stale revisions fail before replacement.

A **store revision** is SHA256 over the complete stored tree: filenames, bytes,
file modes and directory modes. Changing a script or reference changes the tree
revision. This is separate from an activation's SKILL.md content revision and
from a live registry's generation. Do not pass either of those values as the
store's `expectedRevision`.

```ts
import { InMemorySkillStore } from '@yevgetman/sov-sdk';

const store = new InMemorySkillStore();
const created = await store.mutate({
  action: 'create',
  name: 'review',
  content: '---\nname: review\ndescription: Review changes\n---\nCheck defects.\n',
});
await store.mutate({
  action: 'edit',
  name: 'review',
  expectedRevision: created.entry!.revision,
  content: '---\nname: review\ndescription: Review changes\n---\nCheck defects and privacy.\n',
});
```

## Complete trees and committed events

Mutation can include a `files` map of relative resource names to `{ data, mode }`.
Omitting that map on edit retains existing scripts and references. Providing it
replaces the complete resource set. `content` sets SKILL.md within that tree.
Directory modes can be supplied separately. Existing destination modes remain
in force when replacing the matching resources with a more permissive source.

The store validates frontmatter, identity, resource paths, guard policy and bounds
before publication. The filesystem worker validates the staged input again.
The in-memory adapter applies the same validation and revision checks.

Each mutation returns `{ entry?, event }`. Events contain the action, name,
previous revision, new revision and an optional filesystem path. They contain no
skill body. `store.subscribe(listener)` receives committed events only. Listener
errors cannot turn durable success into a failed mutation.

`ToolContext.onSkillMutation(event)` and the equivalent command-context hook let
the host refresh future registry snapshots. The tool leaves the current turn's
registry unchanged. The host must report refresh failures separately from the
already committed write.

## Enumeration

`store.list({ limit, cursor })` returns sorted names, a names-only `generation`,
`truncated`, and `nextCursor` when another page exists. The page limit is 1–512;
the default is 100. Follow the cursor until it is absent to reach larger stores.

Adding or removing an identity invalidates old cursors. Restart enumeration when
the store reports that its catalog changed. Content edits preserve the names
generation; subsequent `read` calls still return the current tree revision.

Filesystem enumeration refuses more than 100,000 directory entries with an
explicit error. Narrow the store root rather than treating that error as an empty
catalog. Transaction stages, backups and locks do not appear in enumeration.

## Filesystem transactions and confinement

The filesystem adapter stages complete validated trees under `.sov-skill-store`.
Discovery excludes this directory. A process lock serializes cooperating writers.
A written owner record is linked atomically to the lock, so an interrupted owner
can be identified without an empty lock file. A live owner causes a clear busy
error. Retry after its transaction completes.

The adapter retains the previous tree until publication. A journal records each
replacement or delete. The next store operation recovers an interrupted change:
an unpublished replacement restores its backup; an already published replacement
keeps the new tree; a delete without its committed marker restores the backup.

Destination directories and resources cannot be symlinks. Resource names reject
absolute paths, parent segments and platform separators. A short-lived Node/Bun
worker pins the chosen root with its kernel working directory and checks directory
identity before effects and publication. Replacing a root pathname with a link
cannot redirect the worker's writes. Store-internal state is private (0700).

Each tree is bounded to 512 files, 512 directories, depth 16 and 16 MiB of data.
Resource reads enforce those bounds before and during capture. Import accepts
links to resources within the source tree by capturing their bytes. It refuses
outside or dangling links and directory cycles. Installed aliases become ordinary
files, so source locations are not retained as destination links.

File data and transaction records are synced before publication. POSIX directory
syncs preserve ordering. Windows supports process-interruption recovery; it does
not provide the same directory-fsync power-loss guarantee through Node.

SDK Node/Bun hosts use the packaged worker module. A compiled host supplies an
explicit `workerCommand` for its embedded helper. SOV supplies its own internal
helper before config, profiles or providers start. This helper needs no model call.

## SOV write paths

Install, import, uninstall, `skill_manage`, skill auto-promotion and `/review`
approval/revoke use this contract. Force replacement takes a current revision and
commits conditionally, so a concurrent accepted edit cannot be silently lost.
Review approvals record the applied tree revision. Revoke refuses a later changed
revision. Pending review proposals remain separate queue artifacts.

## Read next

- [Extending skills](extending.md)
- [SDK host lifecycle](host-session-lifecycle.md)
- [CLI skills](../03-cli-reference/usage.md#skills)
