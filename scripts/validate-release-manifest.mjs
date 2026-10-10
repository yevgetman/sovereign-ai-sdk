import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import addFormats from 'ajv-formats';
import Ajv2020 from 'ajv/dist/2020.js';
import { parse } from 'yaml';

const root = fileURLToPath(new URL('../', import.meta.url));
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const load = (name) => readFileSync(resolve(root, 'releases', name), 'utf8');
const schemas = ['manifest', 'release-plan'].map((name) =>
  ajv.compile(JSON.parse(load(`${name}.schema.json`))),
);
const compare = (a, b) => {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] - right[i];
  return 0;
};

// This checks the editable planning records. Freeze, build and public-byte
// verification remain the release-manifest lifecycle's separate required gates.
export function validatePlanningRecords(manifest, plan) {
  const errors = [];
  for (const [i, value] of [manifest, plan].entries()) {
    if (!schemas[i](value)) {
      errors.push(`${i === 0 ? 'manifest' : 'plan'} schema: ${ajv.errorsText(schemas[i].errors)}`);
    }
  }
  if (errors.length) return errors;
  const release = plan.release;
  if (manifest.version !== release.version) errors.push('Manifest and plan versions differ');
  if (release.id !== `sdk-${release.version}`) errors.push('Release ID must name the SDK version');
  if (!isDeepStrictEqual(release.base, plan.last_release)) {
    errors.push('Release base and last_release differ');
  }
  if (plan.last_release) {
    if (compare(release.version, plan.last_release.version) <= 0) {
      errors.push('SDK target must be later than the published baseline');
    }
    if (compare(release.cli_version, plan.last_release.cli_version) < 0) {
      errors.push('CLI target cannot precede the published baseline');
    }
    if (plan.reconciliation.history_start_commit !== plan.last_release.source_commit) {
      errors.push('Reconciliation baseline differs from last_release');
    }
  }
  if (!manifest.items.length && release.status !== 'draft')
    errors.push('An empty manifest must be draft');
  const ids = new Set();
  const units = new Map();
  for (const item of manifest.items) {
    if (ids.has(item.id)) errors.push(`Duplicate item ID: ${item.id}`);
    for (const required of item.requires) {
      if (!ids.has(required)) errors.push(`Missing or later dependency: ${item.id} -> ${required}`);
    }
    ids.add(item.id);
    if (!item.qa.length) errors.push(`Missing source QA evidence: ${item.id}`);
    for (const unit of item.commits) {
      if (units.has(unit.sha)) errors.push(`Duplicate source SHA: ${unit.sha}`);
      units.set(unit.sha, item.id);
    }
  }
  const mapped = new Map();
  const results = new Set();
  for (const entry of release.applied_commits) {
    if (units.get(entry.source_commit) !== entry.item_id)
      errors.push('Applied mapping is not a listed source unit');
    if (mapped.has(entry.source_commit) || results.has(entry.release_commit))
      errors.push('Duplicate applied mapping');
    mapped.set(entry.source_commit, entry);
    results.add(entry.release_commit);
  }
  for (const entry of release.preparation_commits) {
    if (
      ![...mapped.values()].some(
        (m) => m.item_id === entry.item_id && m.release_commit === entry.commit,
      )
    ) {
      errors.push('Preparation review is not an existing mapped result');
    }
  }
  if (release.status === 'frozen' || release.status === 'released') {
    if (mapped.size !== units.size) errors.push('Frozen cut must map every source unit');
    if (release.validation.some((v) => v.build_commit !== release.build_commit))
      errors.push('QA build SHA mismatch');
    if (release.authorization && release.authorization.build_commit !== release.build_commit)
      errors.push('Authorization build SHA mismatch');
  }
  return errors;
}

export function validateSourceUnits(manifest, plan, git) {
  const errors = [];
  const checkpoint = plan.reconciliation.through_main_commit;
  if (!checkpoint || !plan.last_release)
    return ['Verified baseline and source checkpoint are required'];
  const ancestor = (older, newer) => {
    try {
      git(['merge-base', '--is-ancestor', older, newer]);
      return true;
    } catch {
      return false;
    }
  };
  const base = plan.last_release.source_commit;
  if (!ancestor(base, checkpoint)) errors.push('Baseline is not reachable from checkpoint');
  for (const item of manifest.items) {
    let previous;
    for (const unit of item.commits) {
      if (!ancestor(unit.sha, checkpoint)) errors.push(`Source unit is not reachable: ${unit.sha}`);
      if (ancestor(unit.sha, base)) errors.push(`Source unit already shipped: ${unit.sha}`);
      if (previous && !ancestor(previous, unit.sha))
        errors.push(`Source units are out of order: ${item.id}`);
      previous = unit.sha;
      try {
        const parents = git(['show', '-s', '--format=%P', unit.sha])
          .trim()
          .split(/\s+/)
          .filter(Boolean);
        if (parents.length > 1 !== (unit.mainline === 1))
          errors.push(`Incorrect merge mainline: ${unit.sha}`);
      } catch {
        errors.push(`Cannot resolve source unit: ${unit.sha}`);
      }
    }
  }
  return errors;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifest = parse(load('manifest.yml'));
  const plan = parse(load('release-plan.yml'));
  const errors = validatePlanningRecords(manifest, plan);
  if (!errors.length) {
    const git = (args) =>
      execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    errors.push(...validateSourceUnits(manifest, plan, git));
  }
  if (errors.length) {
    for (const error of errors) console.error(error);
    process.exitCode = 1;
  } else {
    console.log(
      `Release planning valid: SDK ${manifest.version}, CLI ${plan.release.cli_version}, ${manifest.items.length} item(s), ${plan.release.status}`,
    );
  }
}
