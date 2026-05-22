# Sovereign AI Harness — binary install

This tarball contains a compiled distribution of `sov`:

- `bin/sov` — the agent runtime CLI (Bun-compiled standalone)
- `bin/sov-tui` — the Bubble Tea TUI sibling binary
- `bundle-default/` — the default agent bundle
- `version` — the installed release tag
- `LICENSE.txt` — beta evaluation license
- `README.md` — this file

If you got here via `curl ... | bash`, the installer already placed
everything under `~/.sov/` and added `~/.sov/bin` to your `PATH`. Run:

```bash
sov --version
```

You should see the release tag. Then run:

```bash
sov
```

The interactive TUI starts up.

## Upgrade

```bash
sov upgrade
```

This re-runs the public installer, fetching the latest release.
Idempotent.

## Uninstall

```bash
rm -rf ~/.sov
# then remove the PATH line from ~/.zshrc or ~/.bashrc
```

## Support

This is a personal beta. For issues or feedback: **yevgetman@gmail.com**.
