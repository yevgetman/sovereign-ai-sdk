import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Fail closed on registry/process errors. An empty response is not a clean audit.
const result = spawnSync('bun', ['audit', '--json'], { encoding: 'utf8' });
if (result.error || result.signal || ![0, 1].includes(result.status)) {
  throw result.error ?? new Error(`Dependency audit could not run (status ${result.status})`);
}
const report = JSON.parse(result.stdout);
if (!report || Array.isArray(report) || typeof report !== 'object' || (result.status === 1 && Object.keys(report).length === 0)) {
  throw new Error('Dependency audit returned an invalid report');
}
const exceptions = JSON.parse(readFileSync(fileURLToPath(new URL('./security/dependency-exceptions.json', import.meta.url)), 'utf8'));
if (!Array.isArray(exceptions)) throw new Error('Dependency exceptions must be an array');
const now = new Date().toISOString().slice(0, 10);
for (const entry of exceptions) {
  if (typeof entry.package !== 'string' || typeof entry.advisory !== 'string' || !/^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/.test(entry.advisory) ||
      typeof entry.reason !== 'string' || !entry.reason.trim() ||
      typeof entry.expires !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(entry.expires) || entry.expires < now || !Number.isFinite(Date.parse(entry.expires)) ||
      new Date(entry.expires).toISOString().slice(0, 10) !== entry.expires) {
    throw new Error('Invalid or expired dependency exception; every exception needs package, advisory, reason and future expiry');
  }
}
const failures = [];
let count = 0;
const severities = new Set(['low', 'moderate', 'high', 'critical']);
for (const [pkg, entries] of Object.entries(report)) {
  if (!Array.isArray(entries)) throw new Error(`Invalid dependency report for ${pkg}`);
  for (const advisory of entries) {
    if (!severities.has(advisory.severity) || typeof advisory.url !== 'string') {
      throw new Error(`Invalid advisory for ${pkg}`);
    }
    count++;
    if (!['high', 'critical'].includes(advisory.severity)) continue;
    const id = advisory.url.split('/').at(-1);
    if (!exceptions.some(entry => entry.package === pkg && entry.advisory === id)) {
      failures.push(`${pkg}: ${advisory.severity} ${id}`);
    }
  }
}
if (failures.length) {
  console.error(`Unexcepted high/critical dependency advisories:\n${failures.join('\n')}`);
  process.exitCode = 1;
} else {
  console.log(`Dependency audit passed: ${count} reported advisories, no unexcepted high/critical findings.`);
}
