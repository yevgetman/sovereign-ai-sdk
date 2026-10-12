# Skills hardening implementation

## Dependency sequence

1. #44 permissioned activation, #45 portable discovery and #47 transactional
   storage use isolated parallel worktrees.
2. #46 metadata/invocation controls integrates the #44 activation contract.
3. #48 atomic registry refresh and diagnostics combines all discovery,
   descriptor and committed-store contracts.
4. #49 optional SDK composition and #50 complete model-budgeted catalogs run in
   parallel after the registry is stable.
5. #51 continuity records and bounded reattachment integrates both final APIs.

## Review and delivery

Each issue gets focused tests, current documentation and a dedicated feature
branch/PR. Integrate dependency changes before final checks. Review permission,
storage, concurrency and headless-client behavior. Run lint/boundary, typecheck,
strict SDK build and every discovered test file. Preserve the dirty primary SDK
checkout and the running host processes. Record PRs, checks and material limits
in a resumable handoff. Do not merge or release without the separate request.

## Cross-references

- `specs/2026-10-11-skills-hardening-design.md`
- Issues #44–#51 in `yevgetman/sovereign-ai-sdk`
- `docs/06-testing/testing-log.md`
