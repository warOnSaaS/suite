// AUTH_PROVIDER=waronsaas: sign-in through a warOnSaaS account (a fake one here), open sign-up, the demo stays
// open, and "sign out everywhere" on the account ends the session here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { makeCore, serveCore } from './helpers.ts';

async function fakeAccount() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
  const state = { nonce: '', live: new Set<string>(['ses_1']), url: '' };
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const srv = http.createServer(async (req, res) => {
    let b = '';
    for await (const c of req) b += c;
    const send = (o: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(o));
    if (req.url === '/jwks.json') return send({ keys: [jwk] });
    if (req.url === '/oauth/token') {
      const now = Math.floor(Date.now() / 1000);
      const body = `${enc({ alg: 'RS256', kid: 'k1' })}.${enc({ iss: state.url, aud: 'suite', sub: 'acc_casey', sid: 'ses_1', email: 'casey@birch.example', email_verified: true, name: 'Casey Riley', nonce: state.nonce, iat: now, exp: now + 3600 })}`;
      return send({ access_token: 'wat_x', id_token: `${body}.${crypto.sign('RSA-SHA256', Buffer.from(body), privateKey).toString('base64url')}` });
    }
    if (req.url === '/api/sessions/check') { const sid = JSON.parse(b).sid; return send({ sessions: { [sid]: state.live.has(sid) } }); }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => srv.listen(0, r));
  srv.unref();
  state.url = `http://127.0.0.1:${(srv.address() as any).port}`;
  return state;
}

test('hosted sign-in goes through the warOnSaaS account and follows its sign-out', async () => {
  const fake = await fakeAccount();
  const core = await makeCore({ AUTH_PROVIDER: 'waronsaas', WOS_ACCOUNT_CLIENT_ID: 'suite', WOS_ACCOUNT_CLIENT_SECRET: 'shh', WOS_ACCOUNT_URL: fake.url });
  const { url } = await serveCore(core);

  // The sign-in page offers the account, not the old GitHub and email forms.
  const pageHtml = await (await fetch(`${url}/auth/sign-in`)).text();
  assert.match(pageHtml, /Free\. We ask so we can keep it fast and fair/);
  assert.match(pageHtml, /\/auth\/waronsaas\?next=/);

  // GitHub sign-in on this server now goes through the account.
  let r = await fetch(`${url}/auth/github?next=/a/crm`, { redirect: 'manual' });
  assert.match(r.headers.get('location')!, /^\/auth\/waronsaas\?next=%2Fa%2Fcrm&provider=github/);

  r = await fetch(`${url}/auth/waronsaas?next=/a/crm`, { redirect: 'manual' });
  const to = new URL(r.headers.get('location')!);
  assert.equal(to.origin + to.pathname, `${fake.url}/oauth/authorize`);
  assert.equal(to.searchParams.get('client_id'), 'suite');
  fake.nonce = to.searchParams.get('nonce')!;
  const flow = r.headers.getSetCookie()[0].split(';')[0];

  r = await fetch(`${url}/auth/waronsaas/callback?code=c1&state=${to.searchParams.get('state')}&iss=${encodeURIComponent(fake.url)}`, { redirect: 'manual', headers: { cookie: flow } });
  assert.equal(r.headers.get('location'), '/a/crm');
  const session = r.headers.getSetCookie().find((c) => c.startsWith('wos_session='))!.split(';')[0];

  const me = await (await fetch(`${url}/api/tools/account.me`, { method: 'POST', headers: { cookie: session, 'content-type': 'application/json', 'x-wos': '1' }, body: '{}' })).json() as any;
  assert.equal(me.result.user.email, 'casey@birch.example');
  assert.equal(me.result.teams.length, 1, 'a new account gets its own team (open sign-up)');

  // Signed out everywhere on the account: this server follows within the cache minute (cleared here).
  fake.live.delete('ses_1');
  const { accountFor } = await import('../../core/auth.ts');
  accountFor(core).live.clear();
  r = await fetch(`${url}/api/tools/account.me`, { method: 'POST', headers: { cookie: session, 'content-type': 'application/json', 'x-wos': '1' }, body: '{}' });
  assert.equal(r.status, 401);
  await core.stop?.();
});

test('a hosted demo server opens the demo on a first visit instead of a sign-in wall', async () => {
  const fake = await fakeAccount();
  const core = await makeCore({ AUTH_PROVIDER: 'waronsaas', WOS_ACCOUNT_CLIENT_ID: 'suite', WOS_ACCOUNT_CLIENT_SECRET: 'shh', WOS_ACCOUNT_URL: fake.url, WOS_DEMO: '1' });
  const { url } = await serveCore(core);
  const r = await fetch(`${url}/`, { redirect: 'manual' });
  assert.match(r.headers.get('location')!, /^\/auth\/demo\?next=/);
  await core.stop?.();
});

test('self-hosted servers keep their own sign-in', async () => {
  const core = await makeCore({});
  const { url } = await serveCore(core);
  const html = await (await fetch(`${url}/auth/sign-in`)).text();
  assert.match(html, /Email me a link/);
  await core.stop?.();
});

test('the shell sending a first-time visitor to sign in opens the demo instead', async () => {
  const fake = await fakeAccount();
  const core = await makeCore({ AUTH_PROVIDER: 'waronsaas', WOS_ACCOUNT_CLIENT_ID: 'suite', WOS_ACCOUNT_CLIENT_SECRET: 'shh', WOS_ACCOUNT_URL: fake.url, WOS_DEMO: '1' });
  const { url } = await serveCore(core);
  let r = await fetch(`${url}/auth/sign-in?auto=1&next=/`, { redirect: 'manual' });
  assert.match(await r.text(), /Opening the demo[\s\S]*\/auth\/demo\?next=/);
  r = await fetch(`${url}/auth/sign-in?next=/`, { redirect: 'manual' });
  assert.equal(r.status, 200, 'asking for the sign-in page shows it');
  await core.stop?.();
});

test('a browser already signed in to the account signs in here silently instead of opening the demo', async () => {
  const fake = await fakeAccount();
  const core = await makeCore({ AUTH_PROVIDER: 'waronsaas', WOS_ACCOUNT_CLIENT_ID: 'suite', WOS_ACCOUNT_CLIENT_SECRET: 'shh', WOS_ACCOUNT_URL: fake.url, WOS_DEMO: '1' });
  const { url } = await serveCore(core);
  let r = await fetch(`${url}/auth/sign-in?auto=1&next=/`, { redirect: 'manual', headers: { cookie: 'wos_signed_in=1' } });
  assert.match(r.headers.get('location')!, /^\/auth\/waronsaas\?prompt=none&next=%2F/);
  r = await fetch(`${url}/auth/sign-in?auto=1&tried=1&next=/`, { redirect: 'manual', headers: { cookie: 'wos_signed_in=1' } });
  assert.match(await r.text(), /Opening the demo/);
  await core.stop?.();
});
