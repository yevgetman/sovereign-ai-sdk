# Portable TOML error-help examples

This directory contains the production Go sources from github.com/BurntSushi/toml v1.6.0 and its COPYING license. The local go.mod replacement keeps the public module identity. No parser behavior changes. Only the two account-specific Windows path examples in error.go use C:/path/to/file and its backslash form.

PROVENANCE.json records the locked upstream module checksums, every original production file hash, and the patched error.go hash. The original module passed go mod verify. The original upstream package tests and the complete Sov Go TUI suite pass against the patched sources.

For an upstream update, review the new module and license, copy its required production files, apply only the portable example change, refresh provenance, and run both suites plus final binary scans. Keep tests, examples, and captured data out of this production dependency copy.
