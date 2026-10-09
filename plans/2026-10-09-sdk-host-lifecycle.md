# Portable host lifecycle implementation plan

1. Add the optional in-process queue and public named types. Bound every queue.
2. Test ownership, cancellation, shutdown and failures through public APIs.
3. Exercise SQLite restart separately in an isolated host-only subprocess.
4. Add reproducible offline load measurements and packed consumer behavior.
5. Update host docs and record focused/full checks and measurement limits.

Owner deployment decisions remain outside this local utility. The root combines
this portion with the other independently implemented issue #15 portions in a PR.
