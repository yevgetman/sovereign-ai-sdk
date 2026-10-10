# SDK release planning

The source repository's default branch is **master**. A merge adds source to master;
it does not promise that source in a published version.

## Active records

- [`releases/manifest.yml`](../../releases/manifest.yml): schema-version-4 envelope,
  one concrete SDK version and one flat `items` list. Every listed item is intended
  for that version. Unlisted work remains in Git.
- [`releases/release-plan.yml`](../../releases/release-plan.yml): baseline, source
  checkpoint, cut mappings, QA, authorization and publication evidence.
- The matching Draft 2020-12 schemas live beside these files.
- [`releases/history/`](../../releases/history/): immutable completed/frozen records.
  The initial `sdk-0.13.0/publication.json` is a verified pre-manifest baseline;
  it does not invent a historical frozen manifest or authorization.

The SDK and SOV CLI have independent version lines. `manifest.version` and
`release.version` name the SDK. `release.cli_version` names its companion binary
release when the selected work also changes the wrapper. A library-only cut may
retain the published CLI version. Protocol/debug-console versions remain unchanged
unless explicitly selected work requires their own release preparation.

Current targets are SDK **0.13.1** and CLI **0.6.77**. PR23 is included once as its
master merge commit, with `mainline: 1`. Source package stamps remain at the last
release until cut preparation. The draft is planning, not an artifact or a pin.

## Adding work

Use the Kernel **release-manifest** skill for lifecycle transitions, as the runtime
and Mac installer do. Keep product data and schemas here. Follow the same v4
contract: stable ID, product, title, UTC merge time, PR URL (or an explicit direct
commit reason), exact ordered full source SHAs, dependency IDs and durable QA.
Record a merge once with mainline 1; a squash/direct/rebase unit uses null.
Dependencies must precede their dependents. Keep planning bookkeeping out of the
product item list. Re-read the shared draft before adding an item.

Run `bun run release:validate` before committing. CI runs it with full Git history.
It checks both schemas with formats, version/baseline agreement, dependency order,
duplicate IDs/SHAs, source reachability, already-shipped units, merge mainline and
cut-mapping references. It does **not** verify public downloads or certify a cut.

## Preparing and completing a release

Follow the release-manifest lifecycle for assembly, freeze, publication evidence,
recovery and rollover. The source-only planning validator is one gate in that
procedure, not its replacement:

Use [PUBLISHING](../../PUBLISHING.md) for packed SDK gates and npm authority.
Use [cutting releases](cutting-releases.md) for CLI compilation, platform scans,
Go tests and public binary distribution. Source lint/types/tests, Node/Bun packed
consumers, canary and the advisory audit must cover the exact assembled build.
Version/lockfile/notes preparation must be selected and reviewed before freeze.

For this product, publication evidence must distinguish the SDK tarball and
`SDK-SHA256SUMS` from the CLI archives and `SHA256SUMS`. Verify the SDK's installed
package version and every promised CLI platform's live bytes, version, checksum
and build-source metadata. These are different from successful compilation or
upload exit status. The plan's artifact `arch` names either `package` or the exact
CLI platform (`darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`, `windows-x64`).
The lifecycle skill governs freeze, recovery, immutable history and successor
versions. npm registry publication remains owner-only.

Build scripts currently do not assemble or freeze these records automatically.
The release operator must perform the lifecycle checks before invoking them. Do
not tag moving master as a substitute for the recorded assembled build.
