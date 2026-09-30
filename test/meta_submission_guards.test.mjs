import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ||= 'postgres://test:test@localhost/test';
const { pool } = await import('../src/db.js');
const { registerPromotionRoutes } = await import('../src/promotion/routes.mjs');

const handlers = new Map();
const app = {
  get(path, ...callbacks) { handlers.set(`GET ${path}`, callbacks.at(-1)); },
  post(path, ...callbacks) { handlers.set(`POST ${path}`, callbacks.at(-1)); },
  patch(path, ...callbacks) { handlers.set(`PATCH ${path}`, callbacks.at(-1)); },
  delete(path, ...callbacks) { handlers.set(`DELETE ${path}`, callbacks.at(-1)); },
};
registerPromotionRoutes(app, { requireAuth: (_req, _res, next) => next(), objectPath: () => '', readObjectMetadata: () => {}, writeObjectMetadata: () => {}, assertOwnedObjectKey: () => '' });

function response() {
  return {
    statusCode: 200, body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('repeat publish and incomplete status updates stop before any Meta request', async () => {
  const originalQuery = pool.query;
  let calls = 0;
  pool.query = async () => {
    calls++;
    return { rows: [{ id: 'ad-1', owner_user_id: 'user-1', meta_publish_fingerprint: 'a'.repeat(64), meta_campaign_id: '123', status: 'failed', meta_published_at: null }] };
  };
  try {
    const req = { params: { id: 'ad-1' }, user: { id: 'user-1' }, body: { status: 'ACTIVE', confirmationText: 'RESUME', confirm: true } };
    const publish = response();
    await handlers.get('POST /api/tools/promotion/ad-campaigns/:id/meta/publish')(req, publish);
    assert.equal(publish.statusCode, 409);
    assert.equal(publish.body.error, 'meta_submission_already_started');
    const status = response();
    await handlers.get('POST /api/tools/promotion/ad-campaigns/:id/meta/status')(req, status);
    assert.equal(status.statusCode, 409);
    assert.equal(status.body.error, 'meta_submission_incomplete');
    assert.equal(calls, 2);
  } finally {
    pool.query = originalQuery;
  }
});

test('legacy draft edits stay locked after a submission claim without a provider ID', async () => {
  const originalQuery = pool.query;
  let calls = 0;
  pool.query = async () => {
    calls++;
    return { rows: [{ id: 'ad-1', owner_user_id: 'user-1', meta_publish_fingerprint: 'a'.repeat(64), meta_campaign_id: '', status: 'failed' }] };
  };
  try {
    const res = response();
    await handlers.get('PATCH /api/tools/promotion/ad-campaigns/:id')({ params: { id: 'ad-1' }, user: { id: 'user-1' }, body: { name: 'changed' } }, res);
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.error, 'ad_campaign_locked');
    assert.equal(calls, 1);
  } finally {
    pool.query = originalQuery;
  }
});
