# Skill catalogs and model context budgets

The model gets a complete metadata index when all enabled skills fit its
allocation. Larger catalogs get a search and paging instruction. The initial
index contains names, descriptions and trigger predicates. It contains no
skill bodies. A partial first-N index is never presented as the default catalog.

## Complete enumeration

`skills_list` accepts `query`, `cursor` and `limit` (1–100, default 25).
The byte budget can return fewer entries than the entry limit. Follow
`nextCursor` with the same query until it is absent. `total` counts matching
entries, and `truncated` states whether more entries remain.

The cursor pins the registry generation, visible entries and normalized query.
A mutation, visibility change or changed query rejects an old cursor with a
restart instruction. Sorting uses names, independent of locale. A refresh never
silently splices two generations into one enumeration.

Long descriptions and trigger predicates carry `metadataTruncated: true`.
Use `skill_view` for the skill's full guidance. Even an oversized name cannot
block subsequent entries: `nameFragment` gives ordered name slices, their
string offsets and the final-slice flag. Concatenate the slices before invoking
that name. An exhausted context budget returns `budgetExhausted`, with a recovery
instruction, instead of a cursor that cannot advance.

The public pure helpers `listSkillCatalog` and `buildSkillCatalogIndex` implement
these rules. Hosts can use the same contracts without the model tools.

## Model metadata is the input

`query` freezes effective provider/window metadata once per turn. It derives the
skill allocation from that window, the reserved output, and a conservative bound
for standing instructions, task input and tool schemas. It reserves a further
10% for task headroom. No skill code uses a model-name or context-window table.
Changing publisher metadata changes allocations on the next turn.

`resolveSkillContextBudget` returns allocations for the initial index, each page
and retained skill guidance. Unknown windows use the shared 32,768-token
conservative fallback. The index receives at most 1% of available context and
2,048 tokens; a page receives at most 2% and 1,024 tokens; retained guidance
receives at most 4% and 8,192 tokens. No remaining headroom means zero allocation.
The full request still passes the SDK's model-aware input/output checks.

`skillTextTokenBound` uses UTF-8 bytes. It is conservative text accounting,
not a provider tokenizer. `clipSkillText` preserves complete Unicode characters.
Generated system segments carry `kind: 'skill-catalog'`; query replaces only that
segment when it knows the effective model. Host standing guidance is preserved.

## Lazy filesystem discovery

`loadSkills({ ..., mode: 'metadata' })` reads bounded frontmatter with the same
regular-file, real-path and inode checks as full reads. Its header limit defaults
to 64 KiB within the configured file limit. The parser and header guard still
run. Resource directories and complete bodies are deferred.

A lazy entry has `bodyLoaded: false`, `guardDeferred: true` and a
`metadataRevision` header hash. It has no full `revision`. These fields do not
certify its body or resources. `reloadSkill`, activation and inspection perform
the full body/resource guard before using the contents. A blocked body or an
incomplete resource scan still fails closed. The compatible direct loader
default remains `mode: 'eager'`; SOV uses the metadata mode for startup catalogs.

`onLoadStats` reports candidate reads, bytes read, deferred bodies, rejected
candidates and elapsed time. It emits no paths or skill contents. Discovery and
header overflow remain visible in registry diagnostics.

## Measured default and limits of the evidence

A public fixture ran through native Claude Haiku 5.5 and OpenAI gpt-oss-20b via
OpenRouter on 2026-10-11. Each route made the correct selection in 1/4 reminder
cases and 3/4 metadata cases. Both kept the unrelated arithmetic case free of
activation. Metadata reduced provider requests from 7 to 4 on the native route
and from 6 to 4 on the router route. Native input tokens fell from 4,344 to 3,476;
router input tokens rose from 1,569 to 1,628. Total fixture cost was about $0.0015.

This is one repetition of four public tasks per mode and route. It supports the
bounded complete metadata default; it does not prove general or longitudinal
selection accuracy. The review task had no supplied patch, and both modes
abstained. No workflow bodies or private prompts were sent or executed.

A local startup fixture with 35 skills read 1,194,155 bytes in eager mode and
8,960 bytes in metadata mode. Median startup time was 28.5 ms and 9.68 ms across
three warm filesystem repetitions. Activation now pays the deferred scan cost.
These numbers measure this fixture, not production latency.

The live evaluation also found that the newly advertised native model rejects
the deprecated `temperature` parameter. The runner omits optional fixed controls.
Its report retains rejected attempts and their absence of billed usage. This
catalog change makes no broad claim about every provider's optional controls.

Repeat the checks explicitly; the paid evaluation never runs in the test gate:

```sh
bun scripts/evals/skill-startup.ts --out /tmp/skill-startup.json
bun scripts/evals/skill-catalog.ts --live --config /explicit/config.json --out /tmp/skill-catalog.json
```

The live runner selects currently advertised models, caps a run at 24 requests
and 192 output tokens per request, applies a $1 cost reservation using current
publisher pricing, and stops a route on request errors. Credential
values are neither logged nor saved. Machine-readable evidence lives in
`docs/06-testing/skill-catalog-eval-2026-10-11.json` and
`docs/06-testing/skill-startup-eval-2026-10-11.json`.

## Read next

- `docs/04-extending/skill-activation.md` — permissioned activation.
- `docs/04-extending/skill-compatibility.md` — metadata controls.
- `docs/04-extending/skill-storage.md` — committed mutations.
- `docs/06-testing/testing-log.md` — verification records.
