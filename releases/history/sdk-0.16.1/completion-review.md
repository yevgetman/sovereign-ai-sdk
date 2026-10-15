# SDK 0.16.1 / SOV 0.6.81 independent completion review

Result: **PASS. No findings above Low; no additional findings.** Review performed 2026-10-15 against public metadata and saved downloaded bytes. This audit changed no source, release record or public artifact and ran no full suite, rebuild or repack.

## Release ledger and source

- Immutable released archive `c95b739a7c506a95e5ca2151efe4180d78965e6b` is pushed on remote `master` at audit time. Build `0b7a69e31b26ae91201558a1a500bab25402a1bb` remains its ancestor. Remote `sdk-v0.16.1` and `v0.6.81` both resolve to that build.
- Original freeze `3a6d46b9cb06499a6d44df1591354ba2f511cea4` and archived manifest are byte-identical. Their SHA-256 is `c7df78305d4e614e17cb822cec393744a1af8152e580f558729a9f3543b461fa`.
- Freeze, archived release and successor each pass their matching Draft 2020-12 schemas with format checks. YAML timestamps are validated as JSON strings, matching the repository parser.
- The baseline-to-build history contains exactly the two mapped results: feature PR95 and required preparation PR96. Manifest IDs/source SHAs match the mappings. The preparation review points to its existing mapped result. No extra source unit enters the build.
- The archived plan is released with the exact source, freeze, authority and publication evidence. Successor SDK0.16.2/SOV0.6.82 is empty and draft, retains the verified SDK0.16.1 baseline, and resets all derived cut fields.

## Public artifacts and installed products

- Public release `https://github.com/yevgetman/sov-releases/releases/tag/v0.6.81` currently has exactly eight assets: SDK tarball, five harness archives and two checksum files. All eight current GitHub asset digests and sizes match both frozen receipts and independently rehashed saved public downloads. Both downloaded checksum files match every payload they name.
- All five downloaded harness archives identify their intended target, SOV0.6.81 and build `0b7a69e31b26ae91201558a1a500bab25402a1bb` in their build metadata and version files.
- The existing isolated public SDK install imports `createAgent` as a function and reports package0.16.1.
- The live `~/.sov/bin/sov` reports0.6.81. Both installed `sov` and `sov-tui` bytes match the saved public Darwin-arm64 download and `local-install.json`; strict signature verification passes. The receipt accurately describes ad-hoc signing.
- Exact-source tag workflow `38737774333` is successful. Its release-step log explicitly says v0.6.81 already exists and upload was skipped. The subsequent eight public digests still match the frozen bytes. The tag workflow did not substitute its later build outputs.
- `post-publication-checks.json` agrees with the observed tags, successful CI, isolated SDK import and local installation receipt.

## Scope and limits

- Prior QA records6485 passing source tests and19 existing skips. This audit inspected the records and did not rerun those suites. Linuxarm64 native execution remains untested. Mac signatures are ad-hoc; no Developer ID or notarization claim is made. Paid provider behavior was not newly certified.
- The matching installed Kernel producer contract remains unverified. Synthetic fixtures establish the SOV compatibility mechanism only.
- npm publication remains Owner-operated and was not performed. No consumer publication, installation or service restart is certified here.
- Runtime source pin completion is separately verified: PR362 merge `5c7b63712d0dd7d3b9a1c7f08dded5d6efd0a807`; PR363 scheduling merge `08d08826d7c287b4320596147e35846c02eeb194`; planned Runtime0.50.75 keeps existing319+336 and schedules the pin once. Existing23 transitive runtime audit advisories remain disclosed.
- Mac and Telekit pin completion are outside this audit's completion claim. Root must add their final merge/scheduling receipts when they finish.

Machine-readable checks: `completion-audit-checks.json` beside this report.
