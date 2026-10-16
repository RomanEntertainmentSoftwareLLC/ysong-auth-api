import assert from 'node:assert/strict';
import test from 'node:test';
import { eventDimensions } from '../src/promotion/eventPrivacy.mjs';

test('event dimensions discard referrer paths and full user agents', () => {
  const headers = { referer: 'https://example.com/private?token=secret', 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)' };
  assert.deepEqual(eventDimensions({ get: key => headers[key] }), {
    referrer: 'https://example.com', deviceClass: 'mobile', region: null,
  });
});

test('unavailable dimensions are explicit', () => {
  assert.deepEqual(eventDimensions({ get: () => '' }), { referrer: '', deviceClass: 'unknown', region: null });
});
