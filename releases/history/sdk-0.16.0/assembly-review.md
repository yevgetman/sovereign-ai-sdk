# Independent preliminary assembly review

Date: 2026-10-14
Reviewer: delegated read-only release assembly reviewer
Result: **No confirmed finding above Low in the preliminary assembly. Not final release approval.**

## Pinned scope

- Planning snapshot: `8519af8c` at `/private/tmp/sov-release-preflight-20261014`.
- Published-source baseline: `85350f48cc726f62b7b6396919015960d810b2f5`.
- Preliminary assembled tip: `90d158dd63582bc8eee9a4436dad8bc17a87ed25`.
- Previously reviewed runtime comparison: `d8c96f7621088f8f237b934776a6c007635f58d5`.
- Mapping receipt: `applied-source-units.json` in this receipt directory.

## Verification

1. Parsed all 13 selected IDs and exact source SHAs from the pinned manifest. IDs, source SHAs, ordering and mainline 1 match the 13 mapping records exactly. All IDs and source SHAs are unique.
2. Every selected source unit is a two-parent merge on the reviewed master's first-parent chain. Thus mainline 1 is its original main parent. Each source merge appears once.
3. `git rev-list --reverse <baseline>..HEAD` equals the ordered mapped resulting release SHAs exactly: 13 commits, no extra source or preparation commit.
4. For all 13 mappings, the stable patch ID of source first-parent-to-merge diff equals result-parent-to-result diff after excluding only `docs/06-testing/testing-log.md`. This proves selected product patches were applied without unlisted changes or omitted changes. Earlier literal-diff comparisons differed in hunk offsets; stable patch-ID comparison handles these offsets.
5. Every selected added testing-log line is retained. PR81 and PR90 conflict resolutions also retain adjacent existing historical/testing entries from the incoming context. These are documentation-only additions; no executable content differs. PR93's two removed blank/heading lines match its selected source diff. No conflict markers remain.
6. `src/`, `packages/`, root TypeScript configuration, and dependency boundary configuration exactly equal reviewed master `d8c96f76`. Tests and build scripts differ only by omission of the unlisted release-planning validator and its tests. Root manifest and Bun lockfile differences remove only the planning validator command and direct ajv/ajv-formats dev dependencies; CI differences omit that planning-only validator step and fetch-depth. Runtime package dependencies are unchanged relative to the reviewed product source.
7. Working tree is clean. Review did not mutate source, shared records, tags, pins or public state.

## Packaging readiness and limits

This source is intentionally preliminary. Wrapper is still 0.6.79; SDK is still 0.15.1. Packed README still names the previous tarball and companion channel. CHANGELOG still has unreleased sections. Final version, lockfile, publishing-guide, changelog and package-README preparation must become selected reviewed manifest items and be applied before final exact-SHA review, QA and freeze. Current assigned draft SDK 0.15.2 has additive public API semver tension; Owner direction is pending. The proposed minor SDK 0.16.0 must not be treated as approved by this receipt.

No build, complete test suite, packed Node/Bun consumer check, dependency audit, privacy scan, platform archive scan or native binary check was performed by this read-only assembly reviewer. These remain final combined-cut gates. No publication or consumer readiness is certified. Historical/docs/planning omissions relative to master are expected for manifest-only assembly; matching schemas and plan validation must occur in the separate release-record snapshot.

The manifest explicitly records open exact ChatGPT live acceptance, provider accounting limitations, time-limited exact Grok image certification, and lack of physical power-loss certification. Source-tree identity and offline fixtures do not remove those limits. Final release evidence must retain them.
