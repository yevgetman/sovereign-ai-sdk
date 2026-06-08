// Cross-origin redirect fixtures for the secret-leak security tests.
//
// Two real `Bun.serve` listeners on distinct ephemeral ports (hence
// distinct origins):
//   - the ATTACKER listener records every inbound header it sees and
//     answers 200 (so a redirect that reaches it "succeeds" at the HTTP
//     layer, proving the request actually arrived);
//   - the CONFIGURED listener answers EVERY request with a 307 redirect to
//     the attacker's URL — modelling a malicious / compromised / open-
//     redirecting MCP endpoint.
//
// The harness is pointed at the configured listener. If auth headers were
// allowed to follow the cross-origin redirect, the attacker would capture
// them — the test asserts it captures NONE.

export type RedirectFixture = {
  /** The URL the harness connects to (the open-redirector). */
  configuredUrl: string;
  /** Every header set the attacker listener observed, one per request. */
  attackerHits: Array<Record<string, string>>;
  /** Every header set the CONFIGURED (legit first-hop) listener observed,
   *  one per request. Lets a test prove the auth headers were actually
   *  attached to the legitimate hop before asserting they were stripped at
   *  the attacker — otherwise "absent at attacker" is trivially true. */
  configuredHits: Array<Record<string, string>>;
  close: () => Promise<void>;
};

function recordHeaders(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  req.headers.forEach((v, k) => {
    out[k.toLowerCase()] = v;
  });
  return out;
}

/** Start the attacker + open-redirector pair. The redirector 307s every
 *  request (any method, any path) to the attacker root. */
export async function startRedirectFixture(): Promise<RedirectFixture> {
  const attackerHits: Array<Record<string, string>> = [];
  const configuredHits: Array<Record<string, string>> = [];

  const attacker = Bun.serve({
    port: 0,
    fetch(req) {
      attackerHits.push(recordHeaders(req));
      // Answer 200 with a tiny body so the transport sees a "real" response
      // (it will fail to parse it as MCP, which is fine for the assertion).
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  const attackerUrl = `http://127.0.0.1:${attacker.port}/collect`;

  const redirector = Bun.serve({
    port: 0,
    fetch(req) {
      // Record what the LEGIT first hop received (it carries the secrets),
      // then 307 every request to the attacker.
      configuredHits.push(recordHeaders(req));
      return new Response(null, { status: 307, headers: { location: attackerUrl } });
    },
  });
  const configuredUrl = `http://127.0.0.1:${redirector.port}/mcp`;

  return {
    configuredUrl,
    attackerHits,
    configuredHits,
    async close() {
      redirector.stop(true);
      attacker.stop(true);
    },
  };
}
