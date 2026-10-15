# SDK 0.16.1 / SOV 0.6.81 preliminary assembly review

Result: no above-Low finding in the selected feature assembly. Read-only review; no product/source/manifest changes, tests or publication performed.

- Published baseline: `48a287d01d74cfd2e15ba7a164b93c9a56aeb164`.
- Selected PR95 source merge: `07fcc250950839c56140258db6a2c1d7973197f3`, first parent `b34f3cdd8800027c40f403b3730b9e70e7f74d14`, second parent `850451449016c3c3e2dd5c42b1f71b7c35a58be3`. Source merge is reachable from observed `origin/master` at the same merge SHA.
- Applied result: `0895dafbd1d83858b6b39af30f7e598148754dd2`. The baseline-to-result log contains exactly this one commit. Ordinary source changes match merge mainline 1.
- Fourteen of sixteen changed files have byte-identical patches and resulting blobs against merged PR95. The two exceptions are documentary conflict resolutions: testing log retains exactly the selected 18-line new entry above unmodified published-baseline history; TOC adds the feature snapshot and links the prior public release using the public v0.6.80 URL because its archival state snapshot is not in the published baseline. No runtime conflict resolution.
- `src/`, `packages/`, `bundle-default/`, and root tsconfig match merged PR95 byte-for-byte. Changed runtime/SDK/test/canary files match their merged PR95 blobs. Existing link containment, retarget checks, trust assignment and tool permissions are not modified by assembly.
- Root package/lock/dev tooling differ from source master because unlisted bookkeeping introduced manifest-validator development dependencies/scripts after the published baseline. These are baseline-preserving omissions, not newly altered product dependencies. No new product change is present in the selected baseline-to-result patch.
- `STABILITY.md` permits a patch: no frozen barrel export name changed; new diagnostic fields are optional; descriptor acceptance and deep-subpath canary changes stay within patch policy.
- Observed planning draft selects exactly `sdk-pr-95` with mainline 1 and SDK 0.16.1 / CLI 0.6.81. Required preparation and final mappings were still pending at review time.

Limits: this is preliminary assembly equivalence review, not final preparation/freeze/artifact/publication review or a replacement for full gates. The Kernel producer contract and installed cross-product support remain unverified. Synthetic tests certify only SOV mechanism. Root must record the mapping, preparation source unit, exact final build, QA and freeze evidence before publication.
