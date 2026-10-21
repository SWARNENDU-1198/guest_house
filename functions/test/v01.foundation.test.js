import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { api, V, freshWorld, makeUser, auth, db, signIn, auditFor, sleep } from './helpers.js';

describe('v0.1 foundation', () => {
  before(freshWorld);

  it('GET /health is public', async () => {
    const r = await api().get(`${V}/health`);
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.ok(r.body.version);
  });

  it('request without token -> 401 UNAUTHENTICATED in the shared error format', async () => {
    const r = await api().get(`${V}/me`);
    assert.equal(r.status, 401);
    assert.equal(r.body.error.code, 'UNAUTHENTICATED');
    assert.equal(typeof r.body.error.message, 'string');
    assert.deepEqual(r.body.error.details, {});
  });

  it('garbage / forged token -> 401', async () => {
    const r = await api().get(`${V}/me`).set('Authorization', 'Bearer abc.def.ghi');
    assert.equal(r.status, 401);
  });

  it('unknown route -> 404 NOT_FOUND', async () => {
    const u = await makeUser();
    const r = await api().get(`${V}/nope`).set(u.auth);
    assert.equal(r.status, 404);
  });

  it('bootstrap creates a guest profile once, sets claims, and audits', async () => {
    const authUser = await auth.createUser({ email: 'newbie@test.local', password: 'pass1234!', displayName: 'New Bie' });
    let token = await signIn('newbie@test.local');
    let r = await api().get(`${V}/me`).set('Authorization', `Bearer ${token}`);
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, 'NOT_BOOTSTRAPPED');

    r = await api().post(`${V}/auth/bootstrap`).set('Authorization', `Bearer ${token}`).send({});
    assert.equal(r.status, 201);
    assert.equal(r.body.profile.role, 'guest');
    assert.equal(r.body.profile.verified, false);

    r = await api().post(`${V}/auth/bootstrap`).set('Authorization', `Bearer ${token}`).send({});
    assert.equal(r.status, 200, 'second bootstrap is idempotent');

    const claims = (await auth.getUser(authUser.uid)).customClaims;
    assert.equal(claims.role, 'guest');
    token = await signIn('newbie@test.local');
    r = await api().get(`${V}/me`).set('Authorization', `Bearer ${token}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.profile.email, 'newbie@test.local');
    assert.equal((await auditFor('user', authUser.uid)).filter((a) => a.action === 'user.bootstrap').length, 1);
  });

  it('bootstrap rejects unknown fields (cannot self-assign a role)', async () => {
    const u = await makeUser({ profile: false });
    const r = await api().post(`${V}/auth/bootstrap`).set(u.auth).send({ role: 'admin' });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'VALIDATION');
  });

  it('guest calling an admin route -> 403 FORBIDDEN', async () => {
    const g = await makeUser({ role: 'guest' });
    const r = await api().post(`${V}/admin/users/${g.uid}/role`).set(g.auth).send({ role: 'admin' });
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, 'FORBIDDEN');
  });

  it('frontdesk and accounts are also refused on admin routes', async () => {
    for (const role of ['official', 'frontdesk', 'accounts']) {
      const u = await makeUser({ role });
      const r = await api().post(`${V}/admin/users/${u.uid}/role`).set(u.auth).send({ role: 'admin' });
      assert.equal(r.status, 403, role);
    }
  });

  it('admin role change updates claims, revokes old tokens and writes an audit entry with before/after', async () => {
    const admin = await makeUser({ role: 'admin' });
    const g = await makeUser({ role: 'guest' });
    await sleep(1100); // revocation has 1-second granularity
    const r = await api().post(`${V}/admin/users/${g.uid}/role`).set(admin.auth).send({ role: 'frontdesk', reason: 'joined the counter team' });
    assert.equal(r.status, 200);
    assert.equal(r.body.profile.role, 'frontdesk');
    assert.equal((await auth.getUser(g.uid)).customClaims.role, 'frontdesk');

    const audits = (await auditFor('user', g.uid)).filter((a) => a.action === 'user.role.change');
    assert.equal(audits.length, 1);
    assert.deepEqual(audits[0].before, { role: 'guest' });
    assert.deepEqual(audits[0].after, { role: 'frontdesk' });
    assert.equal(audits[0].actorUid, admin.uid);
    assert.equal(audits[0].reason, 'joined the counter team');

    const old = await api().get(`${V}/me`).set(g.auth);
    assert.equal(old.status, 401);
    assert.equal(old.body.error.code, 'TOKEN_REVOKED');
    const fresh = await signIn(g.email);
    const now = await api().get(`${V}/me`).set('Authorization', `Bearer ${fresh}`);
    assert.equal(now.body.profile.role, 'frontdesk');
  });

  it('role change validates role and refuses self-change', async () => {
    const admin = await makeUser({ role: 'admin' });
    let r = await api().post(`${V}/admin/users/${admin.uid}/role`).set(admin.auth).send({ role: 'superuser' });
    assert.equal(r.status, 400);
    r = await api().post(`${V}/admin/users/${admin.uid}/role`).set(admin.auth).send({ role: 'guest' });
    assert.equal(r.status, 422);
    r = await api().post(`${V}/admin/users/doesnotexist/role`).set(admin.auth).send({ role: 'guest' });
    assert.equal(r.status, 404);
  });

  it('suspended users are refused with SUSPENDED', async () => {
    const s = await makeUser({ role: 'guest', status: 'suspended' });
    const r = await api().get(`${V}/me`).set(s.auth);
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, 'SUSPENDED');
  });

  it('CORS allows only configured frontend origins', async () => {
    const ok = await api().options(`${V}/health`).set('Origin', 'http://localhost:5173').set('Access-Control-Request-Method', 'GET');
    assert.equal(ok.headers['access-control-allow-origin'], 'http://localhost:5173');
    const bad = await api().options(`${V}/health`).set('Origin', 'https://evil.example').set('Access-Control-Request-Method', 'GET');
    assert.equal(bad.headers['access-control-allow-origin'], undefined);
  });

  it('security headers are set (helmet)', async () => {
    const r = await api().get(`${V}/health`);
    assert.ok(r.headers['x-content-type-options']);
    assert.equal(r.headers['x-powered-by'], undefined);
  });

  it('seed created the admin, categories and settings', async () => {
    assert.equal((await db.collection('categories').get()).size, 5);
    assert.equal((await db.doc('settings/global').get()).data().holdMinutes, 10);
  });
});
