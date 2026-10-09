// Preview is read-only. Activation requires these jobs already passing on master.
import { execFileSync } from 'node:child_process';
const repository = 'yevgetman/sovereign-ai-sdk';
const checks = [
  'lint + boundary + typecheck',
  'full runtime + Go (ubuntu-22.04)', 'full runtime + Go (macos-14)',
  'open packages (Bun 1.2.0, Node 20.19.0)',
  'open packages (Bun 1.3.13, Node 24.14.0)',
  'dependency advisories',
];
const payload = {
  required_status_checks: { strict: true, contexts: [], checks: checks.map(context => ({ context, app_id: 15368 })) },
  enforce_admins: true,
  required_pull_request_reviews: { required_approving_review_count: 0 },
  restrictions: null,
  allow_force_pushes: false,
  allow_deletions: false,
};
if (!process.argv.includes('--apply')) {
  console.log(JSON.stringify({ repository, branch: 'master', mode: 'preview', protection: payload }, null, 2));
} else {
  const get = path => JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8' }));
  const revision = get(`repos/${repository}/commits/master`).sha;
  const runs = get(`repos/${repository}/commits/${revision}/check-runs?per_page=100`).check_runs;
  for (const name of checks) {
    const latest = runs.filter(run => run.name === name && run.app?.slug === 'github-actions' && run.app?.id === 15368).sort((a, b) => b.id - a.id)[0];
    if (!latest || latest.status !== 'completed' || latest.conclusion !== 'success') {
      throw new Error(`Cannot activate PR gates: ${name} must pass on master first`);
    }
  }
  const result = JSON.parse(execFileSync('gh', ['api', '--method', 'PUT',
    `repos/${repository}/branches/master/protection`, '--input', '-'], {
    input: JSON.stringify(payload), encoding: 'utf8',
  }));
  const actual = result.required_status_checks?.checks ?? [];
  if (!result.required_status_checks?.strict || !checks.every(name => actual.some(check => check.context === name && check.app_id === 15368)) || !result.enforce_admins?.enabled ||
      !result.required_pull_request_reviews || result.allow_force_pushes?.enabled || result.allow_deletions?.enabled) {
    throw new Error('GitHub returned unexpected branch protection; inspect effective rules');
  }
  console.log(`PR-only master checks enabled at ${revision}.`);
}
