# SDK 0.16.1 / SOV 0.6.81 final source review

Result: source approved at `0b7a69e31b26ae91201558a1a500bab25402a1bb`; no above-Low finding. This read-only review does not authorize skipping outstanding exact-source QA, artifacts or freeze checks.

## Source and mapping evidence

Verified published source baseline: `48a287d01d74cfd2e15ba7a164b93c9a56aeb164`.

The baseline-to-build log contains exactly two commits, in manifest order:

1. Source PR95 merge `07fcc250950839c56140258db6a2c1d7973197f3`, mainline 1, maps to `0895dafbd1d83858b6b39af30f7e598148754dd2`.
2. Source PR96 merge `47f23334888860d3d74339df5e20045310477e5b`, mainline 1, maps to `0b7a69e31b26ae91201558a1a500bab25402a1bb`.

PR96 main parent is `46eed40b7161d86dc65cd9fe9c13d823aee0d69e`; contained branch commits are covered once by its merge application unit. The observed planning manifest lists exactly the feature plus required preparation. Both applied mappings and the preparation review reference this build correctly. No unlisted intervening commit. Assembled tracked source is clean.

## Change equivalence and preparation

Feature equivalence is established by assembly-review.md. The preparation patch matches its source merge exactly in six of nine files. Its three documentary resolution files are README, PUBLISHING and testing-log. README retains the incoming SDK0.16.1/SOV0.6.81 candidate and verified baseline language while using the immutable b34f3cdd source URL for the missing baseline state snapshot. PUBLISHING similarly uses the immutable b34f3cdd publication proof; both targets exist at that commit. Testing-log adds the selected eight-line prep entry above the previously assembled history and omits the unrelated ledger entry.

All src/, packages/ and bundle-default/ bytes equal merged PR96. Product dependency versions and lock resolutions are unchanged; root script/dev-dependency differences versus master are baseline-preserving omission of unlisted manifest-validator bookkeeping, not extra runtime changes. No new functional source is introduced by preparation or conflict resolution.

SDK package/lock version0.16.1 and wrapper version0.6.81 agree with planning. Protocol remains0.1.0; debug-console0.3.0. Packed SDK README contains the new exact tarball filename, companionv0.6.81 paths, SDK-SHA256SUMS verification and npm/Bun local-file install examples. SDK/protocol license files are unchanged MIT; private wrapper remains UNLICENSED. No frozen barrel export names change, consistent with patch policy.

## Limits

Full source gates, CI, all-platform builds, packed consumer tests, privacy adjudication, frozen schemas/hash, native signatures and live publication proof are separate required receipts. This review ran no full gates and made no source/manifest edits. Installed Kernel producer support remains unverified; synthetic fixtures certify SOV mechanism only. Paid-provider quality and power-loss durability are not certified.
