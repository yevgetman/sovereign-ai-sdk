# Skills hardening review evidence — 2026-10-11

Latest evidence: [sixth review](#owner-requested-sixth-review--2026-10-11). Earlier rounds below are historical receipts.

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

## Owner-requested fifth review — 2026-10-11

Three native subagents reviewed eight independent PR tasks against their actual incoming parent branches. They followed downstream SDK, SOV, registry, storage, catalog and continuity consumers. The coordinator checked the corrections, supplied an additional bounded pagination witness, reproduced the queued prerequisite finding and ran complete source gates in dependency order. Independent read-only peers rechecked the activation/discovery, storage and continuity corrections. This pass closes **thirteen confirmed findings above Low: five High and eight Medium**. The repeated ancestor-read mechanism affected separate readers introduced by PR52, PR53 and PR57; PR58 carries the loader correction into its later lazy reader.

| Owning PR | Severity and concrete trigger | Correction and regression evidence |
|---|---|---|
| #52 | High — concurrent host activations snapshot one permission floor and later restore a tool removed by the earlier activation. | Per-state request queue covers resolution, guard approval and expansion. Native Write and inline Bash effects are zero after correction; rejected/cancelled slots release and independent states remain concurrent. `activationConcurrency.test.ts`. |
| #52 | High — fallback reference reads accept bytes from a temporary outside ancestor restored before separate canonical checks. | Pin canonical directory and leaf metadata before open, compare the opened descriptor before reading, then recheck current leaf, handle and directories. Hidden-open and hidden-pre-snapshot fixtures reject. `skillsViewSecurity.test.ts`. |
| #53 | High — eager/direct/reload skill loading and resource guards have the same split metadata/path check defect. | Shared bounded reader uses the parent identity pins and original byte limits; strict-Node direct/catalog/reload/resource fixtures fail on baseline and pass afterward. `discovery.identity.test.ts`. |
| #53 | Medium — an ordinary link alias traverses excluded VCS/dependency/vendor descendants and advertises them as project workflows. | Canonical descendant exclusions apply relative to approved targets; explicitly approved package roots remain eligible without trust elevation. Five negative alias and positive approved-root controls in `discovery.test.ts`. |
| #53 | Medium — the initial canonical exclusion correction hides an explicitly contributed package beneath its enclosing pluginRoot or an approved external container. | Preserve exact host-contributed canonical roots within an already approved scope. Keep inferred roots, excluded descendants, private stores and unapproved targets blocked. A final peer reproduced the regression; enclosing-plugin, external approval, classification and refusal controls pass. `discovery.test.ts`. |
| #54 | High — a transaction stage changes before publication, but success returns the requested safe bytes/revision instead of the actual tree. | Verify stage directory identity and complete tree before moving the prior tree, then verify the actual published tree before commitment. Roll back owned uncommitted stages; retain unrelated replacement conflicts. Four packaged-Node create/edit body/reference fixtures retain old state and emit no false event. `storePublicationRace.test.ts`. |
| #57 | High — the composed filesystem reference reader repeats the temporary-ancestor read defect. | Apply the parent identity pins while keeping the shared 1 MiB resource bound. Strict-Node composed reader fixtures reject changed ancestors. `runtimeReferenceIdentity.test.ts`. |
| #57 | Medium — empty cursor cycles or ever-changing empty pages keep store discovery pending indefinitely without consuming entry limits. | Track all cursors and bound total pages by the explicit entry allowance plus one terminal/empty page. Keep prior catalog/generation on failure and allow a repaired refresh. `runtimePaginationBounds.test.ts`. |
| #57 | Medium — eligibility is selected before a queued activation; earlier narrowing or newly resolved metadata removes required tools, but the workflow still activates. | Recheck resolved identity and actual current tool/profile prerequisites inside the activation queue before guard approval or expansion. Unavailable cases reject; matching profile/tool control passes. `runtimeQueuedVisibility.test.ts`. |
| #58 | Medium — metadata reads use the full-body overflow byte and reject valid frontmatter in a partial final chunk despite a fitting header. | Metadata reads exactly its cap in chunks up to 256 bytes; full-body reads retain overflow detection. Exact/128/300-byte positive caps and undersized controls remain lazy. `metadata.test.ts`. |
| #58 | Medium — original query echo exceeds serialized page bytes through unbounded whitespace or valid escaped control characters. | Check raw query length and base JSON response envelope against the active cap before adding entries. Preserve valid query echo/search behavior. `catalog.test.ts`. |
| #59 | Medium — a new child with no profile row inherits parent guidance first activated after child creation. | Only actual pre-schema-7 sessions use legacy lineage fallback. Current children keep an empty creation-time profile snapshot; owner/cycle/depth checks and genuine legacy controls remain. `continuity-host.test.ts`. |
| #59 | Medium — a query stopped by `max_turns` records guidance lifecycle success despite an unfinished task. | Treat the exhausted terminal as failed, retain pinned recovery guidance and emit failed diagnostics. Real capped query fixture checks terminal, record and diagnostics. `continuity.query.test.ts`. |

Source locations: `packages/sdk/src/skills/activation.ts` and `tools/SkillsViewTool.ts` (PR52); `skills/discovery.ts`, `skills/loader.ts` and `skills/guard.ts` (PR53); `skills/storeWorker.ts` (PR54); `skills/runtime.ts` (PR57); `skills/loader.ts` and `skills/catalog.ts` (PR58); `packages/sdk/src/core/query.ts` and `src/skills/continuity.ts` (PR59). SDK-relative short paths in this list are under `packages/sdk/src/`.

PR55 and PR56 have no new independent confirmed finding above Low. They were independently reviewed, retain focused checks and receive every corrected ancestor. No further confirmed above-Low finding remains in the bounded reviewed source. The earlier Low one-byte continuity separator excess remains under the requested severity threshold.

### Fifth-review validation and publication

Frozen functional source `1a9ac75b095d696c631c577b35bc09574f2b22fb` passes configured lint/boundary, root types, strict public SDK build and **every discovered test file**: **5,972 passed / 19 existing skips / zero failures**, 25,192 assertions across 580 files. Each published branch receives a complete source gate after owning changes and ordinary parent propagation. Compiler, shared-theme, redaction-timing and subprocess fixtures run separately without omitting files or weakening original assertions. Public protocol/SDK and TUI artifacts are built before fixtures. Strict Go, actual packed Node/Bun consumers/public types/artifact checks and unchanged release-plan validation also pass; the final testing-log receipt records commands/results.

The final PR58 peer found the explicit-contributed-root compatibility regression introduced by the first exclusion correction. It is corrected on the owning PR53, then carried through every descendant with complete rerun gates; 19 focused discovery/compiled-identity checks pass with 83 assertions.

The first PR52 type gate rejected an inferred fixture output generic. The fixture now declares its broad tool output type; effect assertions are unchanged. A complete clean gate passes afterward. Early PR57 focused checks filtered its compiled-Node fixture until artifacts existed; the coordinator's complete focused rerun includes it (42 passed, 178 assertions), and every publication gate includes every file. The coordinator keeps the lazy metadata reader and combines all original testing histories when resolving parent propagation. The functional source is frozen before this report-only receipt.

Independent activation/discovery peer checks pass 28 tests / 95 assertions. Storage/continuity/session ownership peer checks pass 89 tests / 322 assertions. Integrated runtime peer checks pass 22 tests / 90 assertions, including compiled public-Node behavior. Final integration peer checks pass 39 tests / 255 assertions; exact current-head GitHub checks are recorded in the owner handoff and PR descriptions. Every original head and all seven updated parent edges remain ancestors. No force push or PR merge into master occurs.

| PR | Incoming head | Final functional publication head |
|---|---|---|
| #52 | `634914c0` | `fa0e301b5c1d2fcdebf59a412266e97e9e0b9cd6` |
| #53 | `a939f457` | `1c6162d7fb6243de993f57f1ca41e578429548b1` |
| #54 | `827be897` | `c15a0fd69b945a6a24d7fc2ccca8481b846c3c49` |
| #55 | `87a35120` | `088fbcef6305fc227162291d122c9c27a3b17ca0` |
| #56 | `fa87169c` | `39619d23f092ec0be3b22b2c0920a7cd2f5fd044` |
| #57 | `bfee8c12` | `8af26bb123a4e3d76ac9f95084d76b4ed02de0f8` |
| #58 | `1f055954` | `40729fd0c5ee1d46753dd6131057e8c576e1d1cb` |
| #59 | `b2e44595` | `1a9ac75b095d696c631c577b35bc09574f2b22fb` |

Controlled filesystem boundaries, mock providers, temporary adapters and real Node/Bun/SQLite fixtures establish the specified effects. They do not certify arbitrary hostile filesystem scheduling, physical power-loss recovery or longitudinal model success. Cancellation refuses queued work before execution; an already-running trusted callback retains host-owned cancellation behavior. A catalog page bound cannot bound time spent inside a host callback. Explicit approved package roots stay deliberate host authority. Public versions, consumer pins and installed hosts remain unchanged. All eight PRs stay open in dependency order.

### Read next

- [Exact testing log](testing-log.md)
- [Composed skill runtime](../04-extending/skill-runtime.md)
- [Bounded catalog](../04-extending/skill-catalog.md)
- [Private skill continuity](../04-extending/skill-continuity.md)

## Owner-requested sixth review — 2026-10-11

The owner requested native parallel agents, separate review of each PR52–59, interdependency checks and correction of every confirmed severity above Low. Each incoming parent-relative change was a separate task. Three native review workers plus the coordinator traced source contracts and later consumers. The final reviewer performed independent checks on the corrections. The transiently interrupted discovery task left its draft; the coordinator completed and verified that correction.

**Current result: nine confirmed findings above Low closed — two High and seven Medium.** The table lists the owning PR. PR55 and PR57 have no new independent above-Low finding and inherit all corrected ancestors. The Low prototype-key parent issue was also corrected within complete-tree validation. The existing Low continuity separator-budget excess remains outside the requested threshold.

| PR | Severity and concrete trigger | Correction and effects verified |
| --- | --- | --- |
| 52 activation | Medium: inline policy decisions execute before the native provider drive has an evidence ID. | A distinct context-expansion evidence segment begins before policy callbacks and settles on approval or rejection. Actual HTTP checks verify one joined policy row, correct session, no invented delivered text and a separate later provider-drive ID. |
| 53 discovery | High: a directory or outer ancestor is substituted during iterator opening, then restored; omitted sidecars escape the guard. | Pin scanned directory metadata and validate the final canonical entry names/types with bounded streaming. Catalog/direct/reload/guard witnesses now reject; approved exact plugin roots, managed links, exclusions and resource limits remain usable. |
| 54 storage | High: a final opened leaf differs from its current published pathname; prior captured leaves or resource membership can change before receipt. | Compare before/opened/current metadata and recheck every captured file/directory before issuing a complete-tree revision. Packaged create/edit fixtures reject, emit no false event and restore the prior accepted tree. |
| 54 storage | Medium: an accepted directory mode makes staging and recovery permanently inaccessible. | Reject files lacking owner-read and directories lacking owner-read/execute before effects in both adapters. Invalid modes leave the store usable; restrictive0440/0550 controls retain immediate CAS. |
| 56 diagnostics | Medium: explicit profile B diagnostics use environment-selected profile A's default bundle. | The shared default resolver accepts the captured explicit home. Standalone doctor honors B's bundle; explicit bundle paths still win and the zero-argument resolver keeps its behavior. |
| 58 budgets | Medium: opaque host names expand during JSON escaping, so a fragment exceeds its issued page allocation. | Fit the complete serialized page and its actual next cursor before publication. Quotes, controls, Unicode and lone surrogates reconstruct exactly with unique progressing cursors and later-entry reachability. |
| 59 continuity | Medium: native activation lifetime identity is discarded by fresh composition. | Carry the private lifetime identity without restoring tool grants, so real route outcomes match the activated record. |
| 59 continuity | Medium: post-activation pre-query failure leaves guidance active after turn_error. | Host-owned finalization closes reached native main-session records for errors/cancellation before terminal session events release the slot. |
| 59 continuity | Medium: successful overflow recovery clones the first hop's failed outcome. | Native gateway finishing follows the final logical route outcome across reached session ports; generic SDK queries and native children retain their per-call finishing contract. Only matching active lifetime records transition. |

Owning file locations and full reproductions are in the testing receipts: `src/server/routes/turns.ts`, `src/server/turnComposition.ts`, `packages/sdk/src/skills/guard.ts`, `storeWorker.ts`, `storeValidation.ts`, `store.ts`, `catalog.ts`, `packages/sdk/src/bundle/defaultBundle.ts`, and `src/cli/skillsDoctorCommand.ts`. Tests assert actual HTTP/SQLite/store/provider/subprocess effects rather than calling lifecycle finish directly.

All corrections are pushed to their owning PR branches and carried forward by ordinary parent merges. Incoming heads and all seven updated parent edges remain ancestors. Full testing-log histories from both sides of each merge remain intact. PRs stay open in order52→53→54→55→56→57→58→59.

**Frozen functional source:** `a9e861e9def5bf0f50c5a1e66c7113a654804a5f`. Complete combined source gate: **6,009 passed / 19 existing skips / zero failures**, 25,736 assertions across all 584 discovered files. Configured lint/boundary, root types, strict public SDK/TUI builds, Go, packed Node/Bun consumer/types/artifact checks and unchanged release-plan validation pass. Existing compiler/theme/timing/subprocess fixtures run separately; no file or assertion is omitted or weakened. Report-only receipt commits do not change this functional source.

| PR | Published functional head before this report receipt | Local pass / existing skip / fail |
| --- | --- | --- |
| PR52 | `5e2b06dc6a6700b87f987b54be0a7e76fa7fa44c` | 5,776 / 19 / 0 |
| PR53 | `29e03bc94383fbba00d4db74823e90f5d82c9edd` | 5,803 / 19 / 0 |
| PR54 | `41b27f0cf3ea859994ae65bf6bd9a0f9730c816f` | 5,882 / 19 / 0 |
| PR55 | `f0cade9bba4c6546be831c66f0aee4e86c9d7dd2` | 5,889 / 19 / 0 |
| PR56 | `0fe1261dfb715871a7ff5cdcb0f8b18e261be0da` | 5,901 / 19 / 0 |
| PR57 | `030925a7bb7c9271a794055b6908a8624fb3df2d` | 5,945 / 19 / 0 |
| PR58 | `5e86c6ebcdcda38b63f79e3c6ff91d3a61bc0af6` | 5,963 / 19 / 0 |
| PR59 | `a9e861e9def5bf0f50c5a1e66c7113a654804a5f` | 6,009 / 19 / 0 |

Independent correction checks: discovery identity12/36 assertions plus discovery/guard/loader65/161; doctor14/26; invocation controls37/155; catalog8/489 plus15 escaped/Unicode allocation cases over286pages. Final merged native continuity peer checks pass65tests/950assertions. Four actual-route dual-identity witnesses cover completion, denial, setup failure and real overflow recovery. Policy evidence settles once without invented delivery; private lifetime UUIDs remain separate and match settled parent/child outcomes. Native child finishing and permission floors remain intact.

The first PR53 directory-metadata correction passed its then-covered gate but missed an outer-ancestor listing omission. Its independent failed witness prompted bounded canonical listing validation and a new clean complete gate. Clarification of that PR's immutable test-log receipt: **one** queued baseline gate was stopped before checks for parent integration. A later attempted cancellation correctly refused the already-started partial-correction gate; it completed5,799/19skip/0fail. The corrected listing source subsequently passed5,803/19skip/0fail. The receipt's phrase “two queued earlier gate attempts were stopped” was a recording error. All logs remain archived.

Controlled faults, mock providers and public packed-process fixtures prove the reviewed paths and regressions. They do not certify arbitrary hostile filesystem scheduling, physical power-loss recovery, live paid inference or longitudinal workflow quality. No master merge, force push, release/version/manifest change, consumer pin, installed upgrade or restart. Public SDK0.14.0/SOV0.6.77 remains current; the existing documentation-only next-release draft stays unchanged.
