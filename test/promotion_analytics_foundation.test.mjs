import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizePaidAnalytics } from '../src/promotion/analytics.mjs';

const base = {
  ad: { id: 'campaign', currency: 'EUR' }, range: { since: '2026-09-01', until: '2026-09-30' },
  capturedAt: '2026-09-30T12:00:00.000Z', stale: false,
  meta: { summary: { dateStart: '2026-09-01', dateStop: '2026-09-30', spend: 20, impressions: 1000,
    reach: 700, clicks: 40 }, ads: [
    { adId: 'remote-a', spend: 10, impressions: 400, reach: 300, clicks: 20 },
    { adId: 'remote-b', spend: 5, impressions: 300, reach: 250, clicks: 10 },
  ] },
  ysong: { totals: { clicks: 7, conversions: 2 }, destinations: [
    { id: 'spotify', clicks: 5 }, { id: 'apple', clicks: 2 },
  ], creatives: [
    { id: 'creative-a', metaAdIds: [{ adId: 'remote-a' }, { adId: 'remote-b' }],
      ysong: { clicks: 5, conversions: 1, destinations: [
        { id: 'spotify', destinationVariantId: 'variant-a', clicks: 3 },
        { id: 'spotify', destinationVariantId: 'variant-b', clicks: 2 },
      ] } },
    { id: 'creative-b', metaAdIds: [{ adId: 'remote-missing' }],
      ysong: { clicks: 0, conversions: 0, destinations: [] } },
  ] },
};

test('normalizes provider and Smart Link measures without allocating spend to destinations', () => {
  const result = normalizePaidAnalytics(base);
  assert.equal(result.currency, 'EUR');
  assert.deepEqual(result.sources.provider, { name: 'meta', capturedAt: base.capturedAt, stale: false,
    currency: 'EUR', dateStart: '2026-09-01', dateStop: '2026-09-30' });
  assert.equal(result.campaign.spend, 20);
  assert.equal(result.campaign.ctr, 4);
  assert.equal(result.campaign.cpc, .5);
  assert.equal(result.campaign.cpm, 20);
  assert.equal(result.campaign.conversions, 2);
  assert.equal(result.creatives[0].spend, 15);
  assert.equal(result.creatives[0].reach, null);
  assert.equal(result.creatives[0].cpc, .5);
  assert.equal(result.creatives[1].spend, null);
  assert.equal(result.creatives[1].smartLinkClicks, 0);
  assert.deepEqual(result.destinationVariants.map(row => [row.creativeId, row.destinationId,
    row.destinationVariantId, row.smartLinkClicks, row.spend]), [
    ['creative-a', 'spotify', 'variant-a', 3, null],
    ['creative-a', 'spotify', 'variant-b', 2, null],
  ]);
  assert.equal(result.destinations[0].smartLinkClicks, 5);
  assert.equal(result.destinations[0].conversions, null);
});

test('missing provider reports remain null while measured zero remains zero', () => {
  const input = structuredClone(base);
  input.meta = { summary: {}, ads: [{ adId: 'remote-a', spend: 0, impressions: 0, clicks: 0 }] };
  input.capturedAt = null;
  input.stale = true;
  input.ysong.creatives[0].metaAdIds = [{ adId: 'remote-a' }];
  const result = normalizePaidAnalytics(input);
  assert.equal(result.campaign.spend, null);
  assert.equal(result.campaign.clicks, null);
  assert.equal(result.campaign.ctr, null);
  assert.equal(result.creatives[0].spend, 0);
  assert.equal(result.creatives[0].reach, null);
  assert.equal(result.creatives[0].cpc, null);
  assert.equal(result.sources.provider.stale, true);
});

test('destination variants combine UTM rows and retain unattributed creative clicks', () => {
  const input = structuredClone(base);
  input.ysong.attribution = [
    { creativeId: 'creative-a', destinationId: 'spotify', destinationVariantId: 'variant-a', clicks: 2 },
    { creativeId: 'creative-a', destinationId: 'spotify', destinationVariantId: 'variant-a', clicks: 1 },
    { creativeId: '', destinationId: 'apple', destinationVariantId: '', clicks: 2 },
  ];
  assert.deepEqual(normalizePaidAnalytics(input).destinationVariants.map(row =>
    [row.creativeId, row.destinationId, row.destinationVariantId, row.smartLinkClicks]), [
    ['creative-a', 'spotify', 'variant-a', 3], [null, 'apple', null, 2],
  ]);
});
