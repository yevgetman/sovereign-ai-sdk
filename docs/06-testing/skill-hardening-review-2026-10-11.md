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
