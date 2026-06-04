// src/learning-layer/eval/synthesisAudit.ts — real-corpus synthesis-quality audit.
//
// Track A (the curated learning eval) HAND-SEEDS instincts, so it proves
// recall→behavior but says NOTHING about whether *synthesis* produces useful
// lessons. This tool closes that gap: it runs the REAL (fixed) instinct
// synthesizer over the user's actual observation corpus and reports, honestly,
// what it yields.
//
// ISOLATION CONTRACT (critical): the user's live corpus at
// `~/.harness/learning/<projectId>/observations.jsonl` is treated READ-ONLY.
// We COPY each chosen project's observations into a fresh temp HARNESS_HOME and
// synthesize there, so no new instincts ever land in the live corpus.
//
// The synthesizer makes live model calls (the instinct-synthesizer sub-agent),
// so this is a manual dev tool — NOT part of the gated suite. Requires
// ANTHROPIC_API_KEY in the environment (the audit harness exports it from
// `~/.harness/config.json` providers.anthropic.apiKey before invoking).
//
// Usage:
//   ANTHROPIC_API_KEY=... bun run src/learning-layer/eval/synthesisAudit.ts [projectId ...]
// With no project ids, audits the top-N projects by observation count.

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { InstinctStore } from '../../learning/instinctStore.js';
import { GLOBAL_PROJECT_ID, observationsPath } from '../../learning/paths.js';
import { runSynthesizer } from '../../learning/synthesizer.js';
import type { Instinct } from '../../learning/types.js';

/** Default number of busiest projects to audit when none are named. */
const DEFAULT_TOP_N = 4;
/** Minimum observation count for a project to be worth clustering. Below this,
 *  there isn't enough signal to reach the 3-observation propose bar reliably. */
const MIN_OBS_FOR_AUDIT = 10;
/** Synthesizer dispatch timeout (live sub-agent: read + cluster + propose). */
const SYNTH_TIMEOUT_MS = 240_000;
/** Model class for the synthesis runtime — matches the eval's synth model. */
const SYNTH_MODEL = 'claude-sonnet-4-6';
/** OLD broken reinforcement coefficient, for the confidence-delta comparison. */
const OLD_REINFORCEMENT_K = 0.04;

export interface ProjectInventory {
  readonly projectId: string;
  readonly projectName: string;
  readonly obsCount: number;
}

export interface AuditResult {
  readonly projectId: string;
  readonly projectName: string;
  readonly obsCount: number;
  readonly synthesisOk: boolean;
  readonly synthesisDetail: string;
  readonly instincts: readonly Instinct[];
}

/** The OLD (broken) confidence an instinct with `n` evidence would have had:
 *  reinforce(0, n) = 0.04 * ln(1 + n). Pure; mirrors the pre-fix curve. */
export function oldConfidenceForEvidence(n: number): number {
  if (n <= 0) return 0;
  return Math.round(OLD_REINFORCEMENT_K * Math.log(1 + n) * 1000) / 1000;
}

/** Read the live learning root and return every project with an
 *  observations.jsonl, sorted by observation count descending. READ-ONLY. */
export function inventoryCorpus(liveHarnessHome: string): ProjectInventory[] {
  const root = join(liveHarnessHome, 'learning');
  if (!existsSync(root)) return [];
  const out: ProjectInventory[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === GLOBAL_PROJECT_ID) continue;
    const obsFile = join(root, entry.name, 'observations.jsonl');
    if (!existsSync(obsFile)) continue;
    const raw = readFileSync(obsFile, 'utf-8');
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    let projectName = entry.name;
    try {
      const first = JSON.parse(lines[0] ?? '{}') as { project_name?: string };
      if (typeof first.project_name === 'string' && first.project_name.length > 0) {
        projectName = first.project_name;
      }
    } catch {
      // keep the dir name as the fallback label
    }
    out.push({ projectId: entry.name, projectName, obsCount: lines.length });
  }
  return out.sort((a, b) => b.obsCount - a.obsCount);
}

/** Read instincts visible to recall (project corpus + _global) from a
 *  harnessHome. Deduped by id, project entries first. */
function readInstinctsFor(harnessHome: string, projectId: string): Instinct[] {
  const store = new InstinctStore(harnessHome);
  const seen = new Set<string>();
  const out: Instinct[] = [];
  for (const scope of [projectId, GLOBAL_PROJECT_ID]) {
    for (const inst of store.list(scope)) {
      if (seen.has(inst.id)) continue;
      seen.add(inst.id);
      out.push(inst);
    }
  }
  return out;
}

/** Run the real synthesizer over ONE project's copied observations inside an
 *  isolated temp HARNESS_HOME. Returns the synthesized instincts read back from
 *  the temp corpus. Cleans up the temp home unless `keepTemp` is set. */
export async function auditProject(opts: {
  liveHarnessHome: string;
  projectId: string;
  projectName: string;
  bundleRoot: string;
  keepTemp?: boolean;
  log?: (msg: string) => void;
}): Promise<AuditResult> {
  const log = opts.log ?? ((m: string): void => void process.stderr.write(`${m}\n`));
  const liveObs = observationsPath(opts.liveHarnessHome, opts.projectId);
  if (!existsSync(liveObs)) {
    return {
      projectId: opts.projectId,
      projectName: opts.projectName,
      obsCount: 0,
      synthesisOk: false,
      synthesisDetail: 'no observations.jsonl in live corpus',
      instincts: [],
    };
  }

  // --- Build an isolated temp HARNESS_HOME and COPY the observations in. -----
  const tempHome = mkdtempSync(join(tmpdir(), 'sov-synth-audit-'));
  const tempProjDir = join(tempHome, 'learning', opts.projectId);
  mkdirSync(tempProjDir, { recursive: true });
  cpSync(liveObs, join(tempProjDir, 'observations.jsonl'));
  const obsRaw = readFileSync(liveObs, 'utf-8');
  const obsCount = obsRaw.split('\n').filter((l) => l.trim().length > 0).length;

  // Empty clean config so the schema defaults apply (learning is enabled by
  // default — the live config's learning.disabled flag is NOT inherited).
  // The runtime resolves its credential from the ambient ANTHROPIC_API_KEY
  // (exported by the caller), not from here.
  const tempConfig = join(tempHome, 'config.json');
  writeFileSync(tempConfig, JSON.stringify({}, null, 2));

  const prevHome = process.env.HARNESS_HOME;
  const prevConfig = process.env.HARNESS_CONFIG;
  process.env.HARNESS_HOME = tempHome;
  process.env.HARNESS_CONFIG = tempConfig;

  const { buildRuntime } = await import('../../server/runtime.js');
  const runtime = await buildRuntime({
    cwd: process.cwd(),
    harnessHome: tempHome,
    dbPath: join(tempHome, 'sessions.db'),
    bundleRoot: opts.bundleRoot,
    provider: 'anthropic',
    model: SYNTH_MODEL,
    preflight: false,
    cronEnabled: false,
  });

  try {
    const parentSessionId = runtime.sessionDb.createSession({
      model: runtime.model,
      provider: runtime.resolvedProvider.transport.name,
      metadata: { cwd: runtime.cwd, kind: 'synthesis-audit-parent' },
    });
    const signal = new AbortController().signal;
    log(
      `   [synth] dispatching live synthesizer over ${obsCount} observation(s) for ${opts.projectName} (${opts.projectId})...`,
    );
    const synthPromise = runSynthesizer({
      scheduler: runtime.subagentScheduler,
      parentSessionId,
      parentSignal: signal,
      parentToolPool: runtime.toolPool,
      parentToolContext: {
        cwd: runtime.cwd,
        sessionId: parentSessionId,
        harnessHome: runtime.harnessHome,
        agents: runtime.agents,
        subagentScheduler: runtime.subagentScheduler,
        taskManager: runtime.taskManager,
        laneRegistry: runtime.laneRegistry,
        parentToolPool: runtime.toolPool,
      },
      harnessHome: runtime.harnessHome,
      projectId: opts.projectId,
      projectName: opts.projectName,
      recentObservationCount: Math.max(obsCount, 1),
    });
    const synth = await Promise.race([
      synthPromise,
      new Promise<{ ok: false; reason: string }>((resolve) =>
        setTimeout(() => resolve({ ok: false, reason: 'synthesis timed out' }), SYNTH_TIMEOUT_MS),
      ),
    ]);

    const instincts = readInstinctsFor(tempHome, opts.projectId);
    return {
      projectId: opts.projectId,
      projectName: opts.projectName,
      obsCount,
      synthesisOk: synth.ok,
      synthesisDetail: synth.ok ? synth.summary : synth.reason,
      instincts,
    };
  } finally {
    await runtime.dispose();
    if (prevHome === undefined) Reflect.deleteProperty(process.env, 'HARNESS_HOME');
    else process.env.HARNESS_HOME = prevHome;
    if (prevConfig === undefined) Reflect.deleteProperty(process.env, 'HARNESS_CONFIG');
    else process.env.HARNESS_CONFIG = prevConfig;
    if (!opts.keepTemp) rmSync(tempHome, { recursive: true, force: true });
  }
}

/** Pretty-print one audit result to stdout, with a per-instinct confidence
 *  delta vs the old broken curve. */
function reportResult(r: AuditResult): void {
  const line = '─'.repeat(72);
  process.stdout.write(`\n${line}\n`);
  process.stdout.write(`PROJECT ${r.projectName} (${r.projectId}) — ${r.obsCount} observations\n`);
  process.stdout.write(`synthesis: ${r.synthesisOk ? 'OK' : 'FAILED'} — ${r.synthesisDetail}\n`);
  if (r.instincts.length === 0) {
    process.stdout.write('instincts: NONE written\n');
    return;
  }
  process.stdout.write(`instincts: ${r.instincts.length}\n`);
  for (const inst of r.instincts) {
    const oldConf = oldConfidenceForEvidence(inst.evidence_count);
    process.stdout.write(`\n  • [${inst.domain}/${inst.scope}] confidence=${inst.confidence}`);
    process.stdout.write(
      ` (old-curve would be ${oldConf}; evidence_count=${inst.evidence_count})\n`,
    );
    process.stdout.write(`    trigger: ${inst.trigger}\n`);
    process.stdout.write(`    action:  ${inst.action}\n`);
  }
}

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    process.stderr.write(
      'ERROR: ANTHROPIC_API_KEY not set. The synthesizer makes live model calls.\n',
    );
    process.exit(1);
  }
  const liveHarnessHome = join(process.env.HOME ?? homedir(), '.harness');
  const bundleRoot = join(process.cwd(), 'bundle-default');

  const inventory = inventoryCorpus(liveHarnessHome);
  process.stdout.write('=== Corpus inventory (live, read-only) ===\n');
  for (const p of inventory) {
    process.stdout.write(
      `  ${String(p.obsCount).padStart(4)}  ${p.projectName} (${p.projectId})\n`,
    );
  }

  const requested = process.argv.slice(2);
  const chosen =
    requested.length > 0
      ? inventory.filter((p) => requested.includes(p.projectId))
      : inventory.filter((p) => p.obsCount >= MIN_OBS_FOR_AUDIT).slice(0, DEFAULT_TOP_N);

  process.stdout.write(
    `\nAuditing ${chosen.length} project(s): ${chosen.map((p) => p.projectId).join(', ')}\n`,
  );

  const results: AuditResult[] = [];
  for (const p of chosen) {
    const r = await auditProject({
      liveHarnessHome,
      projectId: p.projectId,
      projectName: p.projectName,
      bundleRoot,
    });
    results.push(r);
    reportResult(r);
  }

  // Summary
  const totalInstincts = results.reduce((n, r) => n + r.instincts.length, 0);
  process.stdout.write(
    `\n${'='.repeat(72)}\nSUMMARY: ${totalInstincts} instinct(s) synthesized across ${results.length} project(s)\n`,
  );
}

if (import.meta.main) {
  void main();
}
