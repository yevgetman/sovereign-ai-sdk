# Independent release preparation review — 2026-10-14

Scope: working-tree preparation diff on `release/prepare-sdk-0160-20261014`, HEAD `8519af8c2126495fc379fd6f6e93f3dea268665f`. Root and SDK package versions, SDK workspace lockfile, root/package README, CHANGELOG, PUBLISHING, and the inherited preflight testing receipt only. No runtime source modification. No public release action performed by this reviewer.

Diff SHA-256: `298f219ffb32c83a27763c816a7a84243ffe962439ce783a47d7d19576302a7a`.

## Result

**No findings above Low. Preparation may proceed through the normal PR and manifest registration process.** This receipt does not approve publication from a dirty checkout and does not replace exact final-build or frozen-record review.

- Package source stamps agree: SDK 0.16.0, SOV 0.6.80. Lockfile SDK workspace version agrees. Additive public types, exports and journal ports justify the Owner-approved minor.
- Packaged SDK README names companion v0.6.80, `yevgetman-sov-sdk-0.16.0.tgz`, `SDK-SHA256SUMS`, and matching Node/Bun install filenames. Checksum command verifies before install.
- Changelog summary covers all 13 selected PR81–93, with no extra runtime fix. Root/package SDK source versions are the only package stamp changes; protocol/debug-console remain unchanged.
- Migration text retains custom-store compatibility, optional individual journal requirements, exact reasoning route/model/login binding, legacy new-session requirement, activeSessionId handling, deferred ToolSearch requirement, and unknown external-effect inspection before retry.
- Live acceptance limits remain explicit: ChatGPT replay is unverified for the exact available login; unknown tokenizer accounting is advisory; Grok image transport certification is exact-model and expires 2026-11-13; fixtures do not establish general paid-provider eligibility or physical power-loss recovery.
- PUBLISHING distinguishes this prepared cut from the verified SDK0.15.1/SOV0.6.79 public baseline. npm remains Owner-only. The inherited testing entry states its earlier version-pending preflight scope and does not claim final-cut QA or public success.
- `git diff --check` passes. JSON source version checks pass. No tests rerun: preparation has no runtime code change and final exact-build QA is performed by the release operator.

## Follow-up requirements

The active manifest and plan now agree on Owner-approved SDK0.16.0/SOV0.6.80, ID sdk-0.16.0, draft status. List the merged preparation application unit before freeze, assemble it once, and record this reviewed result against its mapped release SHA. Review final clean assembled SHA and frozen records separately. Public downloads and binary/platform gates remain outstanding at this preparation review.

## Low observations

- Detailed legacy CHANGELOG paragraphs still use future wording such as "the next release already requires an SDK minor" under the new 0.16.0 heading. The new summary establishes the approved minor; this is a wording issue only.
- New install examples name the planned cut before its public upload. PUBLISHING clearly records preparation-only state; retain that distinction until public download verification.

Reviewed files and SHA-256:

- `CHANGELOG.md`: `49238680559e25fe7077585c6f44c0868fd4546694cca09c9051dd7f76e1a8b5`
- `PUBLISHING.md`: `c5c37aef1fdf9a9cba4ad034951e4b4d4b979beca903405a5da4c211e0bb3778`
- `README.md`: `811b5b1bc15b53a5bf35dde394a617634a01631681e60b92aeedf27fb85f68a9`
- `bun.lock`: `a96686db211130800244805f7e098b756b3a6c51387c33bf6dafc021608ceb41`
- `docs/06-testing/testing-log.md`: `45592f0933e04e7ab8bc25eb4faa7db457795f41829f6418ddb188bb46acf2dd`
- `package.json`: `72ed7d32ec8528d76a420b2bfe210f266e28b0affc0c07da6cc8b17580c5db46`
- `packages/sdk/README.md`: `53a5f07eecfc2f5da72e33f1d25313490cc9884765a91e99b0310ecb59610bbe`
- `packages/sdk/package.json`: `a63864a324a82a1a7b3571608deb7ca8d4990af076f68185150d69fa63a0a559`


## YAML preparation addendum — 2026-10-14

Reviewed working diff also includes `releases/manifest.yml` and `releases/release-plan.yml`. No above-Low finding. SDK version and release ID change to approved 0.16.0, CLI remains0.6.80; verified SDK0.15.1/SOV0.6.79 baseline and source SHA85350f48cc726f62b7b6396919015960d810b2f5 remain unchanged. All13 application units, item order, dependencies, PRs, times and non-compatibility QA are unchanged by a parsed field comparison. Compatibility strings record Owner approval; the reconciliation append makes prior version references historical. No assembly/freeze/publication authority or evidence is fabricated. Derived cut fields remain empty/null and status remains draft.

Reviewer reran `bun run release:validate`: passes Draft2020-12 manifest/plan schema and relational/source checks, reporting SDK0.16.0/CLI0.6.80/13items/draft. Release operator reports the preparation build, lint, types and full6459pass/19skip/0fail gate; reviewer did not duplicate that gate.

- `releases/manifest.yml` SHA-256: `514f4f86c5aaecc01fd2f6ebe9ff898ad3a78f1745d3fbfcb3c637dbad103a7c`
- `releases/release-plan.yml` SHA-256: `3265411e7e7305ca5bf2359f587577730a06a83a4b3b121c3f400790a61c6daf`

Expanded diff SHA-256: `0bb39ef6f2476495f16b752e12083f87348e3c77d569539b304a807b41cd4ac8`.
