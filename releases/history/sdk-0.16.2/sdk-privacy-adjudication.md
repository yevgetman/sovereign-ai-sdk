# Independent SDK privacy and package adjudication — 2026-10-15

Result: **approved for these exact SDK bytes; no true private residue or coverage blocker found under the pinned known-residue policy.** The raw generic scan remains findings/exit1. This review does not relabel the scan, edit policy, or certify absence of arbitrary secrets.

Artifact `yevgetman-sov-sdk-0.16.2.tgz`, SHA-256 `a8c4f8fab29a2bd793b97fbe0540cf80d09118eae1cc9b4c1810ace9985f3850`, exact clean source `d1af49f5f4640ac0525f5cb61fb1a81c73c09684`. Raw unchanged receipt `sdk-scan.json` SHA-256 `8f871c33c38ea6dba87f38c88acbcffe16f046e1e44772c1ff1509be261d006b` and raw CLI output `sdk-scan.log` are preserved.

Pinned scanner1.0.1/policy2026-10-01.2, policy SHA-256 `8e04fd1980cd9a1a534eaa51e993f632a79f62b603efabaf99cbf6c65a95e1c2`. Every scanner snapshot file was independently verified against its pinned manifest before scanning. Recursive scan covers 707 files including container layers, 705 archive members, 9,917,429 bytes and 2,820 metadata values, with zero links, exclusions or coverage errors. Its sole finding is the packed README / operator-namespace pair.

Independent enumeration calls the unchanged Matcher.approved_span for every namespace occurrence in all705 regular payload files across UTF-8, UTF-16LE and UTF-16BE. It finds40 occurrences:36 allowed by existing policy and exactly4 rejected. All other literal private-policy rules have zero occurrences across these same payloads and encodings. Raw recursive scanning supplies builder-home patterns, metadata and container coverage.

## Every rejected span

| Packed location | Byte offset | Exact identity | Decision |
|---|---:|---|---|
| README.md:21:79 |1174|`yevgetman-sov-sdk-0.16.2.tgz`|Required asset filename in the approved public companion release download URL|
| README.md:24:15 |1342|`yevgetman-sov-sdk-0.16.2.tgz`|Same public filename in local npm installation|
| README.md:26:11 |1396|`yevgetman-sov-sdk-0.16.2.tgz`|Same public filename in local Bun installation|
| README.md:342:29 |18620|`@yevgetman/sov-sdk/core/transcriptRepair`|Approved npm package identity with documented deep import|

The filename matches the prepared release and package contract. The deep import is supported by the unchanged wildcard export, and matching source, JavaScript and declaration files all ship. These four public identities carry no private machine path, routing, contact, credential or owner prompt. The generic matcher lacks a bare tarball-filename exception and deliberately rejects npm slash suffixes. Those boundaries explain the rejected public spans without changing the scanner.

All705 packed members are regular files within the strict package allow-list: dist JavaScript/declarations, src TypeScript/source READMEs, LICENSE, README.md, SECURITY.md and package.json. Independently compared the full packed inventory to eligible source/dist files; no file is missing or added. Every packed file is byte-identical to the exact clean assembled checkout, including fresh compiled dist. No tests, fixtures, build records, private wrapper or bundled proprietary source ship. SDK version0.16.2, MIT license and unchanged exports match source. Packed README names companionv0.6.82, exact tarball and SDK-SHA256SUMS. Packed MIT LICENSE hash is `a2283b321d9457ecf82aa4a7c8c623768f58eb2ab34ec40bfa41a87bd6bdb54f` and equals the reviewed SDK source license.

Exhaustive occurrence and packed source/dist file hashes are retained in `sdk-privacy-occurrences.json`; the independent check script is `independent-sdk-review.py`. No package/source/scanner/policy edit or repack occurred. This SDK-specific review does not waive the mandatory clean harness archive scans. Freeze and public-download verification remain separate gates.
