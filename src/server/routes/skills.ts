// Phase 16.1 M8 T4 — skills discovery route.
//
// GET /sessions/:id/skills — projects the per-call filtered skill registry
// to a TUI-renderable JSON envelope `{ skills: [{ name, whenToUse,
// description }] }`. The TUI uses the result to populate its `/skills`
// slash-command discovery surface and to populate the byName cache for
// T5's `/skillname` dispatch.
//
// The registry stored on `runtime.skills` is the UNFILTERED superset
// (project + user + bundle roots — see runtime.ts comment). This route
// derives the active toolset from `runtime.toolPool` and runs
// `inferActiveToolsets` + `filterSkillRegistry` per request so a skill
// gated on a tool the runtime lacks (or is the fallback half of a
// primary/fallback pair whose primary is active) drops from the response.
// Filtering per request — not once at boot — keeps the registry on
// Runtime canonical for the T5 byName lookup and lets a future per-
// session filter narrowing (e.g. project-mode disabling Bash) plug in
// without changing the boot path.
//
// Validation matches sibling routes (sessions.ts, compact.ts):
//   200 — body `{ skills: Array<{ name, whenToUse, description }> }`
//   400 — body `{ error: 'invalid session id' }` (isValidSessionId failed)
//   404 — body `{ error: 'not found' }` (shape-valid but no DB row)
//
// No SSE on this path — discovery is a one-shot read so the TUI doesn't
// need an event stream. The wire shape is intentionally narrow: only the
// three fields the TUI renders (name + whenToUse + description). Skill
// body, path, source, trustTier, and guard details stay server-side
// (returning them would leak filesystem layout to the TUI and bloat the
// response for no rendering benefit).

import { join } from 'node:path';
import { Hono } from 'hono';
import { z } from 'zod';
import { installSkill, uninstallSkill } from '../../skills/install.js';
import { filterSkillRegistry, inferActiveToolsets } from '../../skills/visibility.js';
import type { Runtime } from '../runtime.js';
import { isValidSessionId } from '../sessionId.js';

const InstallBodySchema = z.object({
  source: z.string().min(1, 'source path is required'),
  force: z.boolean().optional(),
});

export function skillsRoute(runtime: Runtime): Hono {
  const r = new Hono();

  r.get('/sessions/:id/skills', (c) => {
    const sessionId = c.req.param('id');
    if (!isValidSessionId(sessionId)) {
      return c.json({ error: 'invalid session id' }, 400);
    }
    const session = runtime.sessionDb.getSession(sessionId);
    if (session === null) {
      // Align with sessions.ts (:41, :54) and compact.ts (:48) — same wire
      // shape across sibling routes. The TUI knows which sessionId it
      // requested, so echoing it back was redundant.
      return c.json({ error: 'not found' }, 404);
    }
    // Per-request filter (see header). The active tool list is the
    // runtime's full toolPool; T5/M9 may narrow this further if per-
    // session toolset overrides land. inferActiveToolsets translates tool
    // names into the toolset categories (`terminal`, `filesystem`,
    // `search`, `memory`, `skills`) that skill frontmatter gates against.
    const activeToolNames = runtime.toolPool.map((t) => t.name);
    const activeToolsets = inferActiveToolsets(activeToolNames);
    const filtered = filterSkillRegistry(runtime.skills, activeToolsets, activeToolNames);
    return c.json({
      skills: filtered.skills.map((s) => ({
        name: s.name,
        whenToUse: s.whenToUse,
        description: s.description,
      })),
    });
  });

  // M11.17 — POST /sessions/:id/skills/install
  // Body: { source: string, force?: boolean }
  // Installs a skill from the given local path into
  // `<harnessHome>/skills/<name>/`. Returns 200 with the result on
  // success; 4xx with `{ error }` on bad input or refusal.
  // Note: TUI typically runs colocated with the server (loopback only)
  // so source paths point at files visible to both processes.
  r.post('/sessions/:id/skills/install', async (c) => {
    const sessionId = c.req.param('id');
    if (!isValidSessionId(sessionId)) {
      return c.json({ error: 'invalid session id' }, 400);
    }
    if (runtime.sessionDb.getSession(sessionId) === null) {
      return c.json({ error: 'not found' }, 404);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const parsed = InstallBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message ?? 'invalid body' }, 400);
    }
    const userSkillsRoot = join(runtime.harnessHome, 'skills');
    const installArgs: Parameters<typeof installSkill>[0] = {
      source: parsed.data.source,
      userSkillsRoot,
    };
    if (parsed.data.force !== undefined) {
      installArgs.force = parsed.data.force;
    }
    const result = await installSkill(installArgs);
    if (!result.ok) {
      return c.json({ error: result.reason }, 400);
    }
    return c.json({ ok: true, name: result.name, installedAt: result.installedAt });
  });

  // M11.17 — DELETE /sessions/:id/skills/:name
  // Uninstalls a user-installed skill by name. Only removes the
  // `<harnessHome>/skills/<name>/` directory; bundle/default skills
  // are read-only here.
  r.delete('/sessions/:id/skills/:name', async (c) => {
    const sessionId = c.req.param('id');
    if (!isValidSessionId(sessionId)) {
      return c.json({ error: 'invalid session id' }, 400);
    }
    if (runtime.sessionDb.getSession(sessionId) === null) {
      return c.json({ error: 'not found' }, 404);
    }
    const name = c.req.param('name');
    const userSkillsRoot = join(runtime.harnessHome, 'skills');
    const result = await uninstallSkill({ name, userSkillsRoot });
    if (!result.ok) {
      return c.json({ error: result.reason }, 400);
    }
    return c.json({ ok: true, name: result.name, removedFrom: result.removedFrom });
  });

  return r;
}
