# SDK production checks — approved implementation scope

The owner approved addressing review issues #10–#15 and putting each issue on a
PR. This portion of #15 adds enforced CI behavior and consumer evidence without
changing product direction, release authority or the license boundary.

## Changes

- Run the full deterministic source suite and Go suite on Linux and macOS PRs.
  Build the TUI with a required Go build before tests. No release-only skip flag.
- Pin the primary toolchain to Bun 1.3.13, Go 1.26.1 and Node 24.14.0. Test packed
  consumers and type contracts against the documented Bun 1.2.0 / Node 20.19.0
  floor as well. Align the Node engines minimum to the tested 20.19.0 pin; the old >=20 declaration included versions lacking AbortSignal.any. Bun remains >=1.2.0.
- Pin PR workflow actions to checked commit hashes. Grant only contents-read.
- Gate high/critical dependency advisories. Exceptions need an exact package,
  advisory ID, reason and valid expiry. Registry failure fails closed.
- Update vulnerable dependency floors and selected transitive patches. Keep
  installed package shapes and behavior compatible through the existing gates.
- Add an independently authored public behavioral/type fixture and an actual
  private Agent Casa runner. The latter archives committed source into a temp
  directory, installs the packed SDK, then runs the real typecheck and tests.
  Never edit the consumer checkout or copy its source into this public repo.
- Supply a branch-protection preview/activation tool. Activation is explicitly
  separate from this PR, and refuses until every required job passes on master.

## Limits and activation

No workflows are enabled on master merely by opening a PR. The private consumer
workflow requires AGENT_CASA_READ_TOKEN with read-only access to that repo; the
secret is not configured by this change. It is manual until a reviewed private
source access arrangement exists. Public fixtures do not claim to replace its
actual suite. Branch rules must be activated after these jobs have landed and
passed. Release/publish authorization is unchanged.

The broader #15 capability work supplies portable host contracts, not a new
summary-engine license decision or a distributed deployment choice. Those two
owner decisions remain separate. No live paid checks or production capacity
claims are part of this offline gate.
