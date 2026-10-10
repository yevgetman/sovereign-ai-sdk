import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
// Release tooling is deliberately outside the production TypeScript graph.
import {
  validatePlanningRecords,
  validateSourceUnits,
} from '../../scripts/validate-release-manifest.mjs';

const read = (name: string) =>
  parse(readFileSync(new URL(`fixtures/${name}.yml`, import.meta.url), 'utf8'));
const fresh = () => ({ manifest: read('manifest'), plan: read('release-plan') });

describe('release planning regressions', () => {
  test('current editable draft has valid schemas and relationships', () => {
    const { manifest, plan } = fresh();
    expect(validatePlanningRecords(manifest, plan)).toEqual([]);
  });

  test('rejects version divergence and malformed UTC dates', () => {
    const { manifest, plan } = fresh();
    plan.release.version = '0.13.2';
    expect(validatePlanningRecords(manifest, plan)).toContain('Manifest and plan versions differ');
    manifest.items[0].merged_at = 'not-a-date';
    expect(validatePlanningRecords(manifest, plan).join(' ')).toContain('schema:');
  });

  test('rejects duplicate source commits across distinct items', () => {
    const { manifest, plan } = fresh();
    manifest.items.push({ ...structuredClone(manifest.items[0]), id: 'other' });
    expect(validatePlanningRecords(manifest, plan).join(' ')).toContain('Duplicate source SHA');
  });

  test('rejects a missing dependency and a dependency cycle', () => {
    const { manifest, plan } = fresh();
    manifest.items[0].requires = ['absent'];
    expect(validatePlanningRecords(manifest, plan).join(' ')).toContain(
      'Missing or later dependency',
    );
    manifest.items[0].requires = ['later'];
    manifest.items.push({
      ...structuredClone(manifest.items[0]),
      id: 'later',
      requires: [manifest.items[0].id],
    });
    expect(validatePlanningRecords(manifest, plan).join(' ')).toContain(
      'Missing or later dependency',
    );
  });

  test('rejects a source mapping to unlisted work', () => {
    const { manifest, plan } = fresh();
    plan.release.applied_commits = [
      { item_id: 'absent', source_commit: 'a'.repeat(40), release_commit: 'b'.repeat(40) },
    ];
    expect(validatePlanningRecords(manifest, plan)).toContain(
      'Applied mapping is not a listed source unit',
    );
  });

  test('rejects unlisted preparation and baseline drift', () => {
    const { manifest, plan } = fresh();
    plan.release.preparation_commits = [
      {
        item_id: manifest.items[0].id,
        commit: 'b'.repeat(40),
        reason: 'notes',
        review: 'reviewed',
      },
    ];
    expect(validatePlanningRecords(manifest, plan)).toContain(
      'Preparation review is not an existing mapped result',
    );
    plan.release.base.cli_version = '0.6.75';
    expect(validatePlanningRecords(manifest, plan)).toContain(
      'Release base and last_release differ',
    );
  });

  test('an empty draft remains dormant with a concrete version', () => {
    const { manifest, plan } = fresh();
    manifest.items = [];
    expect(validatePlanningRecords(manifest, plan)).toEqual([]);
    manifest.version = null;
    expect(validatePlanningRecords(manifest, plan).join(' ')).toContain('schema:');
  });

  test('rejects a release target behind the published baseline', () => {
    const { manifest, plan } = fresh();
    manifest.version = plan.release.version = plan.last_release.version;
    plan.release.id = `sdk-${manifest.version}`;
    plan.release.cli_version = '0.6.75';
    const errors = validatePlanningRecords(manifest, plan);
    expect(errors).toContain('SDK target must be later than the published baseline');
    expect(errors).toContain('CLI target cannot precede the published baseline');
  });

  test('rejects missing source QA and duplicate item IDs', () => {
    const { manifest, plan } = fresh();
    manifest.items[0].qa = [];
    manifest.items.push(structuredClone(manifest.items[0]));
    const errors = validatePlanningRecords(manifest, plan).join(' ');
    expect(errors).toContain('Missing source QA');
    expect(errors).toContain('Duplicate item ID');
  });

  test('compares baseline fields independent of YAML key order', () => {
    const { manifest, plan } = fresh();
    plan.release.base = Object.fromEntries(Object.entries(plan.release.base).reverse());
    expect(validatePlanningRecords(manifest, plan)).toEqual([]);
  });

  test('rejects mainline 1 for a non-merge source', () => {
    const { manifest, plan } = fresh();
    const git = (args: string[]) => (args[0] === 'show' ? 'a'.repeat(40) : '');
    expect(validateSourceUnits(manifest, plan, git).join(' ')).toContain(
      'Incorrect merge mainline',
    );
  });

  test('rejects an unreachable source unit and an already-shipped source', () => {
    const { manifest, plan } = fresh();
    const unit = manifest.items[0].commits[0].sha;
    const git = (args: string[]) => {
      if (args[0] === 'show') return `${'a'.repeat(40)} ${'b'.repeat(40)}`;
      if (args[2] === unit && args[3] === plan.reconciliation.through_main_commit)
        throw new Error('unreachable');
      return '';
    };
    const errors = validateSourceUnits(manifest, plan, git).join(' ');
    expect(errors).toContain('Source unit is not reachable');
    expect(errors).toContain('Source unit already shipped');
  });
});
