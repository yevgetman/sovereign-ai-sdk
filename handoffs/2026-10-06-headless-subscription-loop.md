---
feature: headless-subscription-loop
spec: specs/2026-10-06-headless-subscription-loop-design.md
plan: plans/2026-10-06-headless-subscription-loop.md
green-light: yes
status: complete-awaiting-check
branch: feat/headless-subscription-loop
last-commit: 60dd8d9
---

# Handoff — headless subscription loop

## Done

- ChatGPT and SuperGrok subscription providers. Tokens stay in the Keychain.
- Claude Max refuses before the Keychain and before HTTP. Terms checked 2026-10-06. The call is not sent.
- A failed login does not switch to an API key. The gateway cannot load these three names.
- Toolsets: chat, web, ops, coding. A missing or unknown name does not silently widen the pool. Unknown fails before stream. Omitted stays today's pool.
- The tool call is saved before it runs. A conduct regenerate removes that saved call.
- `sov login` and `sov logout` for the three names. Claude Max login exits 1 and writes nothing.

## Gate

- `bun run typecheck` passed.
- `bun run lint` passed.
- `bun test`: 5423 pass, 30 skip, 3 fail.
- The 3 failures are `tests/attestation/roundtrip.test.ts`. `../decorum-verify` cannot load package `yaml`. This branch does not change that test.

## Next

- Owner review of the pull request. Do not merge from this session.

## Blockers

- None in this repo. The verifier checkout is missing `yaml` on this Mac.
