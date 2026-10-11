# Skills hardening review evidence — 2026-10-11

Batch: `SKILL-HARDENING-2026-10-11`, issues #44–#51. Source baseline:
`85d78f9acd9ef863c7abb9bd414b61d10111fe96`. Review branches only; no release,
installed-host update, restart or consumer change.

Independent agents used the node's code-review skill on the foundations and
composed runtime/continuity integration. The coordinator verified findings and
integrated each correction into its owning issue branch before delivery.

| Issue | Confirmed finding above Low | Correction and regression evidence |
|---|---|---|
| #44 | High: shell data could execute inside author double quotes | Quote-aware inert substitution; real directory payloads produce no injected effects; unsupported nested quoting refuses before approval |
| #44 | Medium: plugin-only commands lost their activation descriptor | Private transport descriptor with canonical command precedence; actual HTTP plugin-only/collision fixtures |
| #47 | Medium: extension-limited resource guard and mismatched file allowance | Guard every regular text resource and use the shared discovery cap; rejected writes retain prior revision and emit no event |
| #50 | Medium: catalog budgets remained exhausted after compaction | Refresh from current history/tools before requests and after reduction; real query tests compaction plus later tool growth |
| #51 | Medium: nested child factory used the original parent | Scheduler-stamped actual parent and captured owner checks; grandchild and foreign-owner checks |
| #51 | Medium: reference retarget silently changed workflow input | Pin logical key, canonical target and content separately; same-content link retarget refuses replacement |
| #51 | Medium: private persisted IDs leaked to diagnostics | Hash all diagnostic IDs; imported private identifier regression |
| #51 | Medium: explicit main-body view mixed active revisions | Main body and canonical aliases remain inert; composed and legacy resume retain only original expanded guidance |
| #51 | Medium: restored text preceded Anthropic tool results | Append after existing blocks; actual Anthropic wire ordering regression |

No further confirmed finding above Low remained in the independently reviewed
combined source. The reviewer reran 23 focused checks with zero failures and 176
assertions. Earlier passing draft tests did not catch the new negative cases.

The review also identified an unverified instruction-integrity concern about
restored tool data. The coordinator added explicit activation provenance,
quoted JSON guidance/references, escaped wrapper delimiters and a fixed
current-user/host-policy priority rule. A new core regression verifies the
framing, alongside the real query/host checks. No model exploit or general
prompt-injection protection claim was made.

The final coordinator gate covers the complete combined source, SDK public API
witnesses, all discovered tests, strict builds and packaged Node/Bun consumers.
Exact final counts and any failed attempts are in `testing-log.md`. Live evidence
is restricted to the public catalog and continuity fixtures and their recorded
limits; it is not a production long-turn or longitudinal certification.

## Owner-requested second review — 2026-10-11

The owner requested a fresh review of all eight PRs with subagents and fixes for every confirmed severity above Low. Reviewers read each original parent-relative change, traced its callers and checked later stack consumers. The coordinator reproduced and fixed the continuity finding, independently checked storage recovery, and propagated ordinary parent merges without force-pushing or merging any PR into master.

| PR / issue | Review outcome | Evidence and correction |
|---|---|---|
| #52 / #44 | High: legacy reference ancestor swap exposes outside bytes. Medium: unbounded reference read. | Open a no-follow, nonblocking regular-file handle; cap content at 1 MiB; verify opened identity and canonical/logical paths. Three regressions cover oversize data and two swap boundaries. |
| #53 / #45 | No further confirmed finding above Low. | Reviewed discovery boundaries, precedence, approved links, resource limits and canonical reloads. Inherits #52 fixes. |
| #54 / #47 | Five High and three Medium findings; detailed below. | Pinned directory traversal/publication, durability and rollback checks, complete-tree normalization, ownership-safe approval and isolated observers. |
| #55 / #46 | No further confirmed finding above Low. | Reviewed descriptor preservation, execution controls, manual/model rules and native/HTTP permission ceilings. Inherits storage and reference fixes. |
| #56 / #48 | No further confirmed finding above Low. | Reviewed atomic catalog generations, failed refresh retention, current tool visibility, host ownership and diagnostics redaction. Inherits upstream fixes. |
| #57 / #49 | Medium: rejected async observers terminate Node. Medium: forwarding a mutation recursively re-emits the commit. | Catch listener rejections; record bounded commit identities before notification and suppress repeated forwarding. Node-process and synchronous/asynchronous copied-event regressions pass. |
| #58 / #50 | No further confirmed finding above Low. | Reviewed frozen budget stamps, UTF-8 paging, fallback, lazy loading and refresh after reduction; 32 focused checks pass. Inherits runtime fixes. |
| #59 / #51 | Medium: output truncation records a successful activation turn. | `max_tokens` now records `failed`; guidance remains available for recovery. Incomplete tool effects remain unexecuted. Real query regression fails before and passes after the correction. Existing `max_turns` behavior is preserved. |

Independent reviewers found no confirmed above-Low issue left in their corrected source. The original implementation review above is a historical receipt, not the result of this second pass. Source gates execute all discovered test files. The global compiler fixture and shared-theme footer fixture run separately; the remaining files use isolated temporary roots. Existing skips remain reported. Initial missing-TUI fixture preparation and any failed integration attempts remain in the testing log.

The review uses temporary stores, injected filesystem faults, process-kill/reopen boundaries and mock providers. It does not establish hardware power-loss behavior, Windows directory-fsync durability or long-term live workflow success. Hosts still own custom adapter authority and continuity scope. The PR stack remains open in order 52 → 53 → 54 → 55 → 56 → 57 → 58 → 59.

### Storage findings on PR54

| Severity | Trigger and consequence | Correction and evidence |
|---|---|---|
| High | Nested resource or private transaction ancestors are replaced; captures return outside bytes or staging/journal/cleanup paths follow outside links. | Pin directories and validate restoration; publish stage/backup leaf names under the pinned root; use pinned cleanup and identity-safe lock release. Outside-byte, lock/cleanup sentinel and interruption fixtures pass. |
| High | New root ancestors, nested stage directories or transaction parents are not durably ordered before publication. | Flush new parent entries, complete nested stages and journal parents before moving accepted trees. Instrumented ordering and six kill/reopen boundaries pass. This is not hardware power-loss certification. |
| High | Delete marker rename/flush fails; the call reports failure and no event while recovery removes the accepted tree. | Restore the root-leaf backup before recovery can treat a visible failed marker as committed. Create/edit/delete failures before and after marker rename preserve the documented accepted state. |
| High | Source capture follows a temporary outside ancestor, which is restored before the final realpath check. Both import APIs accept outside bytes. | Track canonical directory identities and compare pre-read metadata, opened handle and current leaf identity/mode/size/times. Direct and concealed-check fixtures fail on baseline and reject after the fix. Stable in-tree aliases retain bytes and modes. |
| Medium | Missing implicit directories make returned revisions differ from the immediate filesystem read; memory trees can accept impossible file/directory layouts. | Normalize full directory ancestry and validate the same topology in both adapters. Immediate conditional delete and conflicting topology fixtures pass. |
| High | Approval adopts an existing tree solely because its main body matches the proposal; revocation can remove unrelated resources. | Require the proposal's recorded complete-tree revision for a retry. Same-body unrelated-tree fixture refuses approval and leaves resources intact. |
| Medium | An asynchronous committed-store observer rejects after mutation and terminates Node. | Attach a rejection handler to callback results without undoing the commit. Strict-rejection Node subprocess retains the committed entry and exits successfully. |
| Medium | A regular leaf becomes a FIFO between metadata and open; the worker waits for timeout and source capture can block indefinitely. | Use nonblocking no-follow opens and require the expected regular descriptor. The original Node fixture timed out; the corrected worker rejects promptly. |

The second pass corrected **13 confirmed findings above Low: six High and seven Medium**. Corrections belong to PR52, PR54, PR57 and PR59. The other four PRs inherit upstream corrections and have no new independent finding above Low in this pass.

### Second-review final combined validation

The merged functional source passes configured lint/boundary, root typecheck, strict SDK build and all discovered tests: **5,898 passed / 19 existing skips / zero failures**, 24,790 assertions across 569 files. Public protocol/SDK and local TUI were built first. `go test ./...` passes every Go package. `bun run canary` packs and installs the actual protocol/SDK artifacts and passes Node/Bun consumers, consumer types and artifact-boundary checks. The final reference-read conflict resolution was independently inspected: the original bounded helper and all three security regressions remain intact alongside continuity scope checks, logical/canonical pins and inert main-body aliases. No further source change followed these passing checks. Exact published heads and GitHub run links are recorded in the updated PR descriptions and the owner review receipt.

## Owner-requested third review — 2026-10-11

The owner requested all eight PRs, native subagents and fixes for every confirmed finding above Low. Three reviewers used the code-review skill on separate parent-relative PR changes, followed later consumers and checked previous closed findings. The coordinator reproduced the storage/delegation/event cases, arranged independent peer checks and carried fixes through ordinary parent merges. Every original PR head and every updated parent edge remain in the stack. PR52, PR53 and PR55 have no new independent finding above Low; their reviewed behavior and inherited corrections remain.

This pass closes **ten confirmed findings above Low: two High and eight Medium**.

| PR / issue | Severity and trigger | Correction and evidence |
|---|---|---|
| #54 / #47 | High: a direct editor changes the accepted tree between the final check and backup rename; edit/delete discards that newer tree. | Compare the complete tree actually moved to backup before publication. Reject and recover the newer tree without a commit event. Three real packaged-worker race tests cover edit, delete and recreated-path recovery conflicts. Conflicting owner trees are preserved and reopening refuses safely. |
| #56 / #48 | Medium: required custom host profile tags vanish when tool names are inferred. | Preserve explicit non-derived host tags and recompute built-in capability tags from the actual pool. Positive custom-profile and unavailable-built-in controls pass. |
| #56 / #48 | Medium: stale context hints expose skills after activation narrows the actual tool state. | Registry visibility prefers current activation tools. Conflicting-hint and fallback tests pass, including signal-cloned query contexts. |
| #57 / #49 | Medium: SDK-only contexts advertise or activate skills whose required tools are absent; supplied activation state can lose to an older context. | Stamp effective turn/iteration hints and bind direct activation visibility to its supplied state. Real createAgent/query and both stale-context directions pass. |
| #57 / #49 | Medium: a selected custom capability profile is absent from a minimal SDK skill context. | Add the configured/per-run profile tag to the copied skill context. Matching-profile workflow tests pass without widening the tool pool. |
| #57 / #49 | Medium: delayed copied notifications recurse after 64 commit keys; shared runtimes duplicate events and distinct identical-revision recreation can be dropped. | Carry weak local provenance across shallow copies and shared-store origins. Distinct marked commits bypass revision-key dedupe; unmarked adapter data keeps bounded fallback. Independent delayed self-forwarding emits exactly 67 events; shared and separate stores each emit 70 per runtime and retain create/delete/create. |
| #58 / #50 | Medium: a rejected async startup diagnostic terminates Node after successful catalog loading. | Contain promise rejection without awaiting diagnostics. Strict-Node public import retains the loaded metadata and exits successfully. |
| #59 / #51 | High: a restricted parent delegates through native children, then launches a subprocess that cannot enforce inherited skill limits. | Preserve an inherited-restriction marker across fresh child/turn states and check it before subprocess execution. One- and two-hop restricted tests execute zero subprocesses; unrestricted controls execute once. Activation records and expired grants are not inherited. |
| #59 / #51 | Medium: rejected SDK lifecycle or SOV invalid-lineage observers terminate the host. | Contain async observer rejection while retaining accepted private guidance and ownership-barrier state. Strict Node and Bun subprocess regressions pass. This is one root cause across two callers. |
| #59 / #51 | Medium: catalog-valid names longer than 256 bytes silently lose private continuity. | Use the catalog name grammar and count UTF-8 identity bytes in all existing retention limits. Real 258-byte loader/activation/query, oversized identity, newest-four retention and public-redaction controls pass. |

Independent bounded peer reviews confirm the corrected storage, visibility, notification and nested-delegation paths. No further confirmed finding above Low remains in the reviewed source. Earlier first/second review sections are historical receipts. Failed-before regressions and preparation/type failures are retained in `testing-log.md`; they were followed by clean complete runs.

### Third-review final combined validation

The complete integrated functional source at `bd798df4e60da5d802225712a7361284e8f72e3a` passes lint/boundary, root types, strict SDK build and every discovered test file: **5,925 passed / 19 existing skips / zero failures**, 24,915 assertions across 572 files. Public protocol/SDK and local TUI artifacts were built first. Global compiler and shared-theme fixtures ran separately; no test was omitted and no assertion was weakened. `go test ./...` passes all Go packages. `bun run canary` packs and installs actual public protocol/SDK artifacts and passes Node/Bun consumers, consumer types and artifact boundaries. Release-plan validation passes without changing planned or public versions. This report and its final testing-log receipt are documentation-only changes after that frozen source gate.

Review fixtures use temporary stores, controlled filesystem faults, mocked providers and mocked subprocess effects. They do not certify physical power-loss behavior or live longitudinal workflow success. Hosts retain authority over custom storage and persistence scopes. Notification provenance is local and survives shallow spread/Object.assign copies; JSON reconstruction loses it and uses the documented 64-key fallback. Use `refresh()` for an already-observed serialized notification. All eight PRs remain open in dependency order. Exact published heads and GitHub checks are recorded in the updated PR descriptions and owner receipt.

## Owner-requested fourth review — 2026-10-11

The owner requested a fresh review of all eight PRs, parallel native agents and fixes for every confirmed issue above Low. Three agents reviewed separate PR tasks against their actual incoming parent branches. They followed downstream consumers and used isolated stores, compiled public packages, real HTTP routes, mock providers and strict Node subprocesses. The coordinator inspected the corrections, checked their shared callers and requested independent effect checks. All seven findings are fixed: **one High and six Medium**. Three diagnostic findings share the same observer-failure mechanism in separate callers introduced by separate PRs.

| Owning PR / issue | Confirmed severity, trigger and consequence | Correction and effect evidence |
|---|---|---|
| #52 / #44 | `src/server/routes/turns.ts` — High: SOV rescans activated body, arguments and approved shell stdout for `@file`, `@folder`, `@url`, `@diff` and `@staged`. This reads denied private files or starts network/git effects outside the skill gate. | Only ordinary direct user text uses context expansion. Validated activated text remains literal; effects use permitted tools. Two real HTTP regressions fail on the incoming head and pass after correction. Ordinary explicit user references remain functional. |
| #53 / #45; downstream #55 / #46 | `packages/sdk/src/skills/discovery.ts` and `loader.ts` — Medium: throwing discovery/warning observers abort or silently drop valid loads; rejected async observers terminate Node. | Contain synchronous throws and asynchronous rejections while preserving callback delivery. Discovery/eager loading and compiled strict-Node effect checks pass; failures are reproduced before correction. The dependency carry applies the same containment to descriptor warnings added by PR55, with a failed-before strict-Node check. |
| #56 / #48 | `packages/sdk/src/skills/registry.ts` — Medium: the registry wrapper discards original observer promises, so the upstream observer containment cannot catch rejection and Node terminates after publication. | Contain the wrapper's host callbacks directly. Sync-throw and compiled strict-Node controls retain the correct registry and diagnostics. |
| #57 / #49 | `packages/sdk/src/skills/runtime.ts` — Medium: custom resource adapters return arbitrarily large references; the composed filesystem reader uses the 16 MiB tree allowance for one linked reference. The actual view tool exposes 2 MiB despite the shared 1 MiB file limit. | Apply the shared 1 MiB UTF-8 bound to all adapters and opened filesystem descriptors. Exact-limit reads pass; oversized ASCII, multibyte adapter data and approved external links refuse. Both effect checks fail before correction. |
| #57 / #49 | `packages/sdk/src/skills/loader.ts` (`loadSkillText`) — Medium: newly added pure-text loader warnings can abort valid parsing or terminate a strict Node host when a callback rejects. | Isolate both descriptor and trigger-warning observers. The unsupported execution decision remains intact. Sync-throw and compiled strict-Node effect checks fail before and pass after correction. |
| #58 / #50 | `packages/sdk/src/core/query.ts` (`refreshSkillCatalog`) — Medium: catalog reservation ignores the host's valid `inputTokenCounter`, so byte fallback empties the index/pages even though request admission has valid headroom. | Use the same request counter for current standing/history/tool reservation, with the conservative fallback retained. Positive catalog/page recovery, invalid/throwing counters and no-counter controls pass. Independent checks cover current tool narrowing and context reduction. |
| #59 / #51 | `packages/sdk/src/core/query.ts` (`attachSkillGuidance`) — Medium: continuity reserves fallback byte tokens while admission uses the image-aware host counter. A base request fits at 32,386 tokens, but 558 tokens of optional retained guidance makes it exceed the 32,768-token window and blocks all provider calls. | Reserve current base history/system/tool input through the same host counter, with fallback and validation retained. The real public-query control completes without continuity; the failed-before retained case now drops optional guidance and completes. Positive restoration and counter/fallback controls pass; the coordinator independently reproduced the baseline failure. |

PR54 and PR55 have no new independent above-Low finding in this pass. They inherit the corrected parents. A confirmed **Low** continuity separator-accounting excess of one byte in a two-record fixture remains unchanged under the owner's requested severity threshold.

### Fourth-review validation and publication

The final functional merged source `47934dd76eb035d666e5a0dd99b13ee371c8101b` passes configured lint/boundary, root types, strict SDK build and **every discovered test file**: **5,939 passed / 19 existing skips / zero failures**, 25,036 assertions across 575 files. Compiler, shared-theme, redaction-timing and subprocess fixtures ran separately; no file was omitted and no original assertion was weakened. Each functional correction and parent merge received its configured full gate. CI/log-only follow-ups preserve that tested source and pass lint/types. Strict Go checks, actual packed Node/Bun consumer/type/artifact checks and release-plan validation also pass. The coordinator's final testing-log receipt contains their exact commands and results.

PR53's first exact-head Mac/Linux CI failed because its new strict-Node regression imported public artifacts before the workflow built them. The identical prerequisite already present from PR54 was added to PR53 and carried forward. Functional source and regression assertions stay unchanged; the complete current-head CI results are recorded separately.

Native independent effect checks pass four resource/warning regressions, 51 counter/catalog/context checks, one actual SkillTool tool-narrowing fixture and four strict-Node descriptor/policy scenarios on each affected descriptor/pure-loader merge. The final continuity counter peer passes 18 tests / 150 assertions and compiled Node low-to-high headroom restoration, fallback and guidance-specific invalid-counter checks. Each original incoming head and every updated parent edge remain ancestors. Ordinary parent merges carry the owning fixes through the entire chain; no force push or PR merge into master occurs.

| PR | Incoming review head | Final functional publication head |
|---|---|---|
| #52 | `2852c14e` | `634914c0dff402d661fde2c4a3019d39223f026c` |
| #53 | `cf00b6d2` | `a939f457aa94de142f23109e21f1c3f05a10971e` |
| #54 | `7b1217e1` | `827be89752e6a35c2b41009a0f103c52b15bc45f` |
| #55 | `f5139456` | `87a351202bbb9fd6060c9eb4f6356e73fc16b777` |
| #56 | `dca7d8a3` | `fa87169c12e7d485610911321ed4ca9ff8414ea6` |
| #57 | `fd9b2ae0` | `bfee8c122e3b3f93306d39c1f9fbb0801ad815cf` |
| #58 | `831eb838` | `1f055954367f10bf4ba7fde61382748bd3c16732` |
| #59 | `debd77d6` | `47934dd76eb035d666e5a0dd99b13ee371c8101b` |

The later report-only commit on PR59 changes no functional source. Current exact-head platform checks and the report commit are recorded in the PR descriptions and owner handoff. Earlier sections are historical receipts. Tests establish behavior under controlled faults and mock-provider effects; they do not certify physical power-loss durability or long-term live workflow success. The work changes no release version, public asset, consumer pin or installed host.
