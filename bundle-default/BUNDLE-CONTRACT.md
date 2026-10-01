# Harness bundle contract

A bundle is a directory selected with `sov --bundle <directory>`.
Run `sov init` in a new directory to create its manifest and starter files.

- `index.yaml` is the manifest. It lists documents, their relative paths, and reading order.
- `business/` holds project context. The runtime reads this content; it does not write it.
- `harness/schemas/` holds validation schemas. This is read-only runtime input.
- `skills/` holds Markdown skills with `name`, `description`, and `whenToUse` frontmatter.
- `state/` holds per-installation memory, sessions, trajectories, and runtime artifacts.

All document paths in the manifest are relative to the bundle root. Keep each
bundle's state separate. Edit `business/README.md` to describe the project,
then run `sov chat` from the bundle directory. Use `sov --help` for commands.

The packaged default bundle and this contract are shipped together.
`sov init` also writes this contract to `harness/BUNDLE-CONTRACT.md`, so its
help remains available in a new project without the source checkout.
