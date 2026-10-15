# SDK 0.16.1 / SOV 0.6.81 candidate freeze review

Result: **approved for the frozen snapshot and publication of the exact reviewed bytes; no above-Low finding.** This is a read-only candidate review before the immutable freeze commit. Root must commit the manifest/plan/schemas coherently, resolve that snapshot, and reproduce the manifest hash before publication. Null frozen_manifest_commit in this first snapshot is expected; record the immutable SHA in a later evidence update.

Reviewed candidate: `/private/tmp/sov-release-0161-20261015`, based on source master `47f23334888860d3d74339df5e20045310477e5b`. Exact build `0b7a69e31b26ae91201558a1a500bab25402a1bb`. SDK0.16.1/SOV0.6.81, verified baseline SDK0.16.0/SOV0.6.80 at `48a287d01d74cfd2e15ba7a164b93c9a56aeb164`.

## Ledger and authority

Independently validated both candidate YAML files against the matching Draft2020-12 schemas with formats. Manifest has one feature PR95 plus required reviewed preparation PR96, ordered dependency closure, exact source mainline1 merges, exactly two applied source/result mappings and preparation review linked to its existing mapped result. Prior final-source review established the baseline-to-build log contains exactly those two results. Versions, build and authorization agree throughout the candidate. Owner's explicit Telegram merge/select/cut/publish request covers this GitHub cut and source pins/local public binary update under the release skill. npm and consumer product publication remain excluded.

Manifest SHA-256 reproduced: `c7df78305d4e614e17cb822cec393744a1af8152e580f558729a9f3543b461fa`. Active and history candidate manifest bytes are identical. Matching schemas are present in sdk-0.16.1 history. Frozen status, all-pass validation, six version-specific artifact records and null publication fields reflect prepared/unpublished state accurately. Last verified baseline has not advanced prematurely.

## Exact QA and artifacts

Independently hash-checked all twelve referenced local gate logs against qa.json and inspected their conclusions. Exact source reports6485pass/19existing skips/0fail,28715assertions/619files. Strict build, lint/boundary, root/browser types, Go suite, current/floor packed canaries with purity/types, zero-advisory audit and three npm dry-runs pass. Read-only GitHub verification confirms sourceCI38735486848 success at the exact build, including Linux/Mac fullruntime+Go, lint/types, current/floor package checks and advisory gate. All-platform dryrun38735483308 also succeeds at that SHA, including nativeWindows smoke, Linuxx64/Macarm64 smoke and allfive platform builds.

Independently recomputed hashes and sizes of all eight frozen files in assets/: five CLI archives, SDK tarball and both checksum files. Every value matches frozen-artifacts.json and both checksum files resolve exactly to these asset bytes. For each CLI archive, verified the retained generic scan is clean with zero findings/errors and matching artifact hash, and independently opened archive metadata to verify source revision, target, v0.6.81 version file/build-inputs and license hash. Retained cli-verification.json records bothMac version0.6.81 and strict ad-hoc verification for sov and sov-tui. No DeveloperID/notarization or nativeLinuxarm64 claim.

SDK SHA-256 `0c423696e35e6e924e81eaa7338361dcc543a9176aa28326abd0284877462f51` matches this reviewer's independently adjudicated exact tarball. Raw scanner exit1/oneREADME namespace pair is preserved; its raw receipt hash matches the independent occurrence report. No source/policy rewrite or fake clean. All four rejected spans are exact required public identities; zero private literal-rule occurrences under all three policy encodings; complete recursive raw coverage has zero errors/exclusions. SDK allow-list, MIT license/version and reviewed README parity passed independently.

## Publication obligations and limits

Publication has not been certified by this review. Publish only these frozen eight files, preserve bytes/checksums, then download and compare every promised public file before marking released or opening/advancing a successor. Public source tags belong on the exact assembled build; preserve build ancestry on master using a merge, not squash. Record immutable freeze SHA and reproduce exact manifest bytes before trigger. Retain candidate/log/artifact receipts for retries.

Known limits remain:19existing skips; Linuxarm64 cross-compilation; ad-hocMac signatures; installed matchingKernel producer integration unverified; synthetic fixtures proveSOV mechanism only; no new paid-provider/power-loss certification; finite known-residue policy cannot establish absence of arbitrary secrets. No source, manifest, package, scanner or policy was modified by this review.
