# Independent SDK privacy adjudication — 2026-10-15

Result: **approved for these exact SDK bytes; no true private residue or coverage blocker found under the pinned known-residue policy.** The raw generic scan still reports findings/exit1. This adjudication does not convert that result to clean, edit policy, or certify absence of arbitrary secrets.

Artifact `yevgetman-sov-sdk-0.16.1.tgz`, SHA-256 `0c423696e35e6e924e81eaa7338361dcc543a9176aa28326abd0284877462f51`, source `0b7a69e31b26ae91201558a1a500bab25402a1bb`. Raw `sdk-scan.json` is preserved unchanged, SHA-256 `96a7429b0c6cc4a0b1f40371190d1da20f5bfa1849a01a9f229d39481a9b4961`.

Pinned scanner1.0.1/policy2026-10-01.2, policyhash `8e04fd1980cd9a1a534eaa51e993f632a79f62b603efabaf99cbf6c65a95e1c2`. Independently verified every pinned scanner snapshot file against its manifest. Raw scan covers 701 files including container layers, 699 archive members, 9863488 bytes and 2796 metadata values, with zero links, exclusions and errors. Its sole finding is package/README.md / operator-namespace (one file/rule pair).

Independent enumeration used the unchanged Matcher.approved_span for every operator-namespace occurrence in all699 regular archive payloads, across UTF-8, UTF-16LE and UTF-16BE. It found40 occurrences:36 precisely allowed by existing policy and4 rejected. All other literal private-policy rules have zero occurrences across those same files and encodings. Independent direct Matcher invocation over each complete file reproduces the sole README/operator-namespace finding; raw recursive scanning supplies metadata/container and builder-home pattern coverage.

## All four rejected spans

| Packed location | Byte offset | Exact identity | Adjudication |
|---|---:|---|---|
| README.md:21:79 |1174|`yevgetman-sov-sdk-0.16.1.tgz`|Required public asset filename in approved companion release download URL|
| README.md:24:15 |1342|`yevgetman-sov-sdk-0.16.1.tgz`|Same public filename in local npm install|
| README.md:26:11 |1396|`yevgetman-sov-sdk-0.16.1.tgz`|Same public filename in local Bun install|
| README.md:342:29 |18620|`@yevgetman/sov-sdk/core/transcriptRepair`|Approved npm package identity with documented deep subpath|

The exact tarball filename agrees with the prepared package/release contract. The deep import is covered by the package wildcard export and its source, compiled JavaScript and declaration files all exist in this tarball. These identities contain no private machine path, routing, contact, credential or owner prompt. The generic Matcher has no bare npm tarball-filename exception and deliberately rejects slash suffixes after npm identity exceptions. Those boundaries explain the rejected public spans without altering the scanner.

All699 members are regular files under package/src/**, package/dist/** or exactly LICENSE, README.md, SECURITY.md and package.json. No tests, build records or proprietary wrapper source is packed. Package version is0.16.1/licenseMIT. Packed LICENSE and README are byte-identical to reviewed assembled source; license SHA-256 `a2283b321d9457ecf82aa4a7c8c623768f58eb2ab34ec40bfa41a87bd6bdb54f`.

Full exhaustive occurrence details and rule counts are in sdk-privacy-occurrences.json. No package, source, scanner or policy changes or repacking occurred. This SDK-specific exact-identity adjudication cannot waive mandatory clean CLI archive scans. Final ledger/freeze checks and public-byte verification remain separate gates. The policy is finite known-residue detection, not general secret detection.
