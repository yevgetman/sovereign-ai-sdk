import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { bearerAuth } from '../../src/openai/auth.js';

describe('bearerAuth', () => {
  test('returns 401 when Authorization header is missing', async () => {
    const app = new Hono().use('*', bearerAuth('secret')).get('/x', (c) => c.text('ok'));
    const res = await app.request('/x');
    expect(res.status).toBe(401);
  });

  test('returns 401 on header mismatch', async () => {
    const app = new Hono().use('*', bearerAuth('secret')).get('/x', (c) => c.text('ok'));
    const res = await app.request('/x', { headers: { authorization: 'Bearer wrong' } });
    expect(res.status).toBe(401);
  });

  test('returns 401 when Bearer prefix is missing', async () => {
    const app = new Hono().use('*', bearerAuth('secret')).get('/x', (c) => c.text('ok'));
    const res = await app.request('/x', { headers: { authorization: 'secret' } });
    expect(res.status).toBe(401);
  });

  test('calls next on match', async () => {
    const app = new Hono().use('*', bearerAuth('secret')).get('/x', (c) => c.text('ok'));
    const res = await app.request('/x', { headers: { authorization: 'Bearer secret' } });
    expect(res.status).toBe(200);
  });

  test('returns OpenAI error shape on 401', async () => {
    const app = new Hono().use('*', bearerAuth('secret')).get('/x', (c) => c.text('ok'));
    const res = await app.request('/x');
    const body = (await res.json()) as { error?: { type?: string; message?: string } };
    expect(body.error?.type).toBe('invalid_api_key');
    expect(body.error?.message).toBeTruthy();
  });
});
