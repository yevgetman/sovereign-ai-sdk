import { describe, expect, test } from 'bun:test';
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { packageStage } from '../../scripts/release-build-target';
import {
  packageInventory,
  preflightPackageScanner,
  scanReleasePayload,
  validateScannerSnapshot,
  verifyPackagedInventory,
} from '../../scripts/release-scan';
import { TARGETS, artifactName, sha256 } from '../../scripts/release-shared';
import { verifyArtifactReleaseMetadata, verifyUploadArtifacts } from '../../scripts/release-upload';

const target = TARGETS[0];
if (!target) throw new Error('missing test target');

function stage(root: string, paths: string[]): void {
  for (const path of paths) {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, 'generic Julie default and portable ~/code example');
  }
}

function releaseMetadata(root: string, name: string, version = 'v0.7.0'): void {
  writeFileSync(join(root, 'version'), `${version}\n`);
  writeFileSync(join(root, 'build-inputs.json'), JSON.stringify({ version, target: name }));
}

describe('shared package scan adapter', () => {
  test('old clean artifacts renamed into a new release cannot authorize publication', () => {
    const root = mkdtempSync(join(tmpdir(), 'sov-version-binding-'));
    try {
      const newRelease = join(root, 'v0.8.0');
      mkdirSync(newRelease);
      for (const candidate of TARGETS) {
        const input = join(root, candidate.name);
        stage(input, packageInventory(candidate));
        releaseMetadata(input, candidate.name, 'v0.7.0');
        const archive = join(newRelease, artifactName(candidate));
        packageStage(candidate, input, archive);
        expect(() =>
          verifyArtifactReleaseMetadata(archive, 'v0.7.0', candidate.name),
        ).not.toThrow();
        expect(() => verifyArtifactReleaseMetadata(archive, 'v0.8.0', candidate.name)).toThrow(
          /exit 1/,
        );
        // Changing the plain version sidecar alone must not mask old provenance.
        writeFileSync(join(input, 'version'), 'v0.8.0\n');
        packageStage(candidate, input, archive);
        expect(() => verifyArtifactReleaseMetadata(archive, 'v0.8.0', candidate.name)).toThrow(
          /exit 1/,
        );
        releaseMetadata(input, candidate.name, 'v0.7.0');
        packageStage(candidate, input, archive);
      }
      expect(() => verifyUploadArtifacts(newRelease, 'v0.8.0')).toThrow(/exit 1/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  for (const name of ['linux-x64', 'windows-x64']) {
    const candidate = TARGETS.find((item) => item.name === name);
    if (!candidate) throw new Error('missing packaging test target');
    test(`${name} final inventory retains optional resources and rejects loss or changed bytes`, () => {
      const root = mkdtempSync(join(tmpdir(), 'sov-inventory-'));
      try {
        const input = join(root, 'stage');
        stage(input, packageInventory(candidate));
        const optional = join(input, 'bundle-default', 'optional-guide.md');
        writeFileSync(optional, 'portable guide');
        writeFileSync(join(input, 'bundle-default', 'café.md'), 'portable Unicode guide');
        if (candidate.goos !== 'windows')
          symlinkSync('optional-guide.md', join(input, 'bundle-default', 'guide'));
        const archive = join(root, artifactName(candidate));
        const before = scanReleasePayload(input, candidate, { receipt: join(root, 'stage.json') });
        const packed = () => {
          packageStage(candidate, input, archive);
          return scanReleasePayload(archive, candidate, {
            required: packageInventory(candidate),
            receipt: join(root, 'packed.json'),
          });
        };
        expect(() => verifyPackagedInventory(before, packed(), archive, candidate)).not.toThrow();
        const extra = join(input, 'extra-resource.md');
        writeFileSync(extra, 'clean but not staged');
        expect(() => verifyPackagedInventory(before, packed(), archive, candidate)).toThrow(
          /inventory differs/,
        );
        unlinkSync(extra);
        writeFileSync(optional, 'a changed but clean guide');
        expect(() => verifyPackagedInventory(before, packed(), archive, candidate)).toThrow(
          /inventory differs/,
        );
        writeFileSync(optional, 'portable guide');
        if (candidate.goos !== 'windows') {
          chmodSync(optional, 0o755);
          expect(() => verifyPackagedInventory(before, packed(), archive, candidate)).toThrow(
            /inventory differs/,
          );
          chmodSync(optional, 0o644);
          unlinkSync(join(input, 'bundle-default', 'guide'));
        }
        unlinkSync(optional);
        expect(() => verifyPackagedInventory(before, packed(), archive, candidate)).toThrow(
          /inventory differs/,
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  test('complete tar bytes and required inventory bind a clean receipt to the final hash', () => {
    const root = mkdtempSync(join(tmpdir(), 'sov-scan-'));
    try {
      const input = join(root, 'stage');
      stage(input, packageInventory(target));
      writeFileSync(join(input, 'README.md'), 'https://github.com/yevgetman/sov-releases/issues');
      const archive = join(root, 'package.tar.gz');
      packageStage(target, input, archive);
      const receipt = `${archive}.scan.json`;
      scanReleasePayload(archive, target, { required: packageInventory(target), receipt });
      const data = JSON.parse(readFileSync(receipt, 'utf8'));
      expect(data.result).toBe('clean');
      expect(data.exit_code).toBe(0);
      expect(data.artifact_sha256).toBe(sha256(archive));
      expect(data.architecture).toBe(target.name);
      expect(data.coverage.files).toBeGreaterThanOrEqual(packageInventory(target).length);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('findings and missing required files stop staging; receipt preserves both failures', () => {
    const root = mkdtempSync(join(tmpdir(), 'sov-scan-fail-'));
    try {
      const input = join(root, 'stage');
      stage(input, packageInventory(target));
      writeFileSync(join(input, 'LICENSE.txt'), 'private julie-alerts destination');
      const receipt = join(root, 'scan.json');
      expect(() =>
        scanReleasePayload(input, target, { required: packageInventory(target), receipt }),
      ).toThrow(/exit 1/);
      let data = JSON.parse(readFileSync(receipt, 'utf8'));
      expect(data.result).toBe('findings');
      expect(data.findings_count).toBeGreaterThan(0);
      expect(readFileSync(receipt, 'utf8')).not.toContain('private julie-alerts destination');
      unlinkSync(join(input, 'bin/sov-tui'));
      expect(() =>
        scanReleasePayload(input, target, { required: packageInventory(target), receipt }),
      ).toThrow(/exit 2/);
      data = JSON.parse(readFileSync(receipt, 'utf8'));
      expect(data.result).toBe('incomplete');
      expect(data.findings_count).toBeGreaterThan(0);
      expect(data.errors_count).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('manifest validates exact hashes, snapshot identity, policy revision, and schema', () => {
    const root = mkdtempSync(join(tmpdir(), 'sov-snapshot-'));
    try {
      cpSync(new URL('../../scripts/fresh_install/', import.meta.url), root, { recursive: true });
      const manifestPath = join(root, 'manifest.json');
      const original = JSON.parse(readFileSync(manifestPath, 'utf8'));
      validateScannerSnapshot(root);
      for (const mutate of [
        (manifest: typeof original) => {
          manifest.files['scanner.py'] = '0'.repeat(64);
        },
        (manifest: typeof original) => {
          manifest.source_revision = `sha256:${'0'.repeat(64)}`;
        },
        (manifest: typeof original) => {
          manifest.policy_version = 'unreviewed';
        },
        (manifest: typeof original) => {
          manifest.scanner_version = 'unreviewed';
        },
        (manifest: typeof original) => {
          manifest.schema_version = 0;
        },
        (manifest: typeof original) => {
          manifest.files['unexpected.py'] = '0'.repeat(64);
        },
      ]) {
        const changed = structuredClone(original);
        mutate(changed);
        writeFileSync(manifestPath, JSON.stringify(changed));
        expect(() => validateScannerSnapshot(root)).toThrow(/snapshot/);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('missing Python preflight propagates before the build', () => {
    expect(() =>
      preflightPackageScanner(() => {
        throw new Error('missing Python executable');
      }),
    ).toThrow(/missing Python/);
  });

  test('upload rechecks all target archives and rejects changed bytes instead of trusting old receipts', () => {
    const root = mkdtempSync(join(tmpdir(), 'sov-upload-scan-'));
    try {
      for (const candidate of TARGETS) {
        const input = join(root, candidate.name);
        stage(input, packageInventory(candidate));
        releaseMetadata(input, candidate.name);
        packageStage(candidate, input, join(root, artifactName(candidate)));
      }
      verifyUploadArtifacts(root, 'v0.7.0');
      const input = join(root, target.name);
      writeFileSync(join(input, 'bin/sov-tui'), '/Users/private-builder/workspace');
      packageStage(target, input, join(root, artifactName(target)));
      expect(() => verifyUploadArtifacts(root, 'v0.7.0')).toThrow(/exit 1/);
      const data = JSON.parse(
        readFileSync(join(root, `${artifactName(target)}.scan.json`), 'utf8'),
      );
      expect(data.result).toBe('findings');
      unlinkSync(join(input, 'bin/sov-tui'));
      packageStage(target, input, join(root, artifactName(target)));
      expect(() => verifyUploadArtifacts(root, 'v0.7.0')).toThrow(/exit 2/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
