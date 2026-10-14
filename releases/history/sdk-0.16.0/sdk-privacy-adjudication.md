# Independent SDK privacy scan adjudication — 2026-10-14

**Result: the four rejected occurrences are approved public publishing identities. No actual private residue is found under the pinned known-residue policy. The SDK privacy review passes for these exact bytes.** This does not change the generic scanner's failure result and does not claim absence of arbitrary secrets.

Artifact: `yevgetman-sov-sdk-0.16.0.tgz`, SHA-256 `c10ce8dd462bd697f2939f8b968005dd2501a5930291487be96f330854dae0e1`. Exact source `48a287d01d74cfd2e15ba7a164b93c9a56aeb164`.

## Raw evidence retained

`sdk-scan.json` remains unchanged, SHA-256 `cc11a11dbf679ccf6e89553ccf175ff9e423624c36ce5c73de9ff9b900ac01a0`. It records scanner1.0.1, policy2026-10-01.2/policyhash8e04fd1980cd9a1a534eaa51e993f632a79f62b603efabaf99cbf6c65a95e1c2, exit1/findings,701 scanned files,699 archive members,9,854,785 scanned bytes,2,796 metadata values,0 links,0 errors,0 exclusions. Its only finding is the file/rule pair `package/README.md` / `operator-namespace`. A file/rule pair can contain multiple occurrences.

Reviewer used the unchanged `fresh_install.scanner.Matcher.approved_span` and its pinned policy against every occurrence of `yevgetman` in all699 regular archive files, for all policy encodings UTF8/UTF16LE/UTF16BE. There are39 total occurrences;35 are already precisely approved by the scanner and4 are rejected. All4 are UTF8 in the packed README. Full occurrence details are retained in `sdk-privacy-occurrences.json`.

## Exhaustive rejected occurrence classification

| Packed file location | Exact rejected identity | Category and decision |
|---|---|---|
| README.md:21:79 (byte1170) | `yevgetman-sov-sdk-0.16.0.tgz` | Exact required public SDK asset filename within the approved SOV release download URL. Public publishing identity. |
| README.md:24:15 (byte1338) | `yevgetman-sov-sdk-0.16.0.tgz` | Exact same filename in local `npm install ./...`. Public publishing identity. |
| README.md:26:11 (byte1392) | `yevgetman-sov-sdk-0.16.0.tgz` | Exact same filename in local `bun add ./...`. Public publishing identity. |
| README.md:342:29 (byte18616) | `@yevgetman/sov-sdk/core/transcriptRepair` | Published SDK deep-subpath import. Package export `./*` resolves it; both shipped source and compiled modules exist. Public publishing identity. |

The filename prefix is required by the approved npm package identity and actual published-asset naming contract. It contains no machine path, routing, contact, account secret or owner prompt. The deep import is the same Owner-approved npm namespace with a documented SDK subpath, not a different package or private checkout.

The generic Matcher intentionally accepts exact npm package delimiters/version suffixes and refuses a slash after an npm namespace. It has no plain npm tarball-filename exception. Thus these4 SDK README occurrences exceed its CLI-oriented namespace boundary without representing private residue. The first operator occurrence in the download URL is already approved by the public `https://github.com/yevgetman/sov-releases` exception; only the filename's second occurrence is rejected.

## SDK-specific gate

PUBLISHING defines an SDK gate using packed Node/Bun canaries and shipped-tree purity checks, strict package builds/types, MIT license separation, and an exact package content allow-list. Reviewer independently confirms all699 regular files stay within `package/dist/**`, `package/src/**`, LICENSE/README/SECURITY/package.json; no tests, build state or source-wrapper manifest is packed. The packed MIT LICENSE is byte-identical to the selected SDK source, SHA-256 `a2283b321d9457ecf82aa4a7c8c623768f58eb2ab34ec40bfa41a87bd6bdb54f`. Packed README is byte-identical to the reviewed exact source.

For this artifact, retain the complete generic scan with no missing coverage, and add this exhaustive exact-identity classification as SDK privacy evidence. Record the packed canary/license/allow-list results separately and accurately. Do not mark raw scanner exit1 as exit0. Do not change source, scanner or policy to create a passing generic result. All mandatory CLI scanner gates still require actual clean receipts for all promised CLI archives; this SDK-specific adjudication cannot authorize a CLI scan finding.

No finding remains above Low from SDK known-residue privacy review. Final frozen ledger review, all mandatory QA/artifact evidence, and public download verification remain separate gates.
