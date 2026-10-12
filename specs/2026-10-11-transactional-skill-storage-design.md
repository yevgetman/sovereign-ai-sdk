# Transactional skill storage — issue 47

Owner authorization: implement issues 44–51 and create issue-specific PRs.
This root work item provides the storage contract consumed by registry refresh
and the optional SDK skill runtime.

## Contract

The host explicitly selects a writable filesystem, in-memory or injected store.
Create never overwrites. Edit/delete require a full-tree revision. Validation and
guard checks precede durable effects. Successful writes emit a committed identity
and revision event without mutating the current turn's skill catalog.

Filesystem updates stage complete trees, preserve matching destination modes,
serialize processes and recover journaled replacements/deletes. A worker's pinned
cwd and inode checks protect against directory-path swaps on Node and Bun without
an external Python or shell dependency. Compiled SOV embeds that worker entry.

Install/import and all committed review writers use the same contract. Pending
proposals remain queue artifacts. SDK no-disk defaults, node/profile isolation,
learning soak settings and the open-core boundary stay in force.

## Verification

Effect-based fixtures cover rejected/stale edits, duplicate create, missing edit,
concurrent edits, destination links and a timed root swap, failed force imports,
mode/resource retention, journal/lock recovery, paginated enumeration above 512
entries, and Node/Bun consumers. SOV's helper and existing review/proposal tests
cover the host adapter. Full source gates run before commit. Publication and live
installation are outside this task.
