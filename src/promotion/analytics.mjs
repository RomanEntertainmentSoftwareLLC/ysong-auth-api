// A read model over the existing Meta snapshot and first-party event aggregates.
// Null means the source did not supply a valid value; an observed zero stays zero.
const number = (value) => value === null || value === undefined || value === '' || !Number.isFinite(Number(value))
  ? null : Number(value);
const ratio = (numerator, denominator, factor = 1) => numerator === null || denominator === null || denominator <= 0
  ? null : factor * numerator / denominator;

function providerMetrics(row) {
  const spend = number(row?.spend), impressions = number(row?.impressions);
  const reach = number(row?.reach), clicks = number(row?.clicks);
  return {
    spend, impressions, reach, clicks,
    ctr: ratio(clicks, impressions, 100),
    cpc: ratio(spend, clicks),
    cpm: ratio(spend, impressions, 1000),
  };
}

function creativeProviderMetrics(rows, expectedAdIds) {
  if (!expectedAdIds.length || expectedAdIds.some(id => !rows.some(row => String(row.adId) === id))) return providerMetrics(null);
  const sum = key => rows.some(row => number(row[key]) === null)
    ? null : rows.reduce((total, row) => total + number(row[key]), 0);
  const spend = sum('spend'), impressions = sum('impressions'), clicks = sum('clicks');
  // Reach is unique within a provider report, so adding reach across ads overcounts people.
  const reach = rows.length === 1 ? number(rows[0].reach) : null;
  return { spend, impressions, reach, clicks, ctr: ratio(clicks, impressions, 100),
    cpc: ratio(spend, clicks), cpm: ratio(spend, impressions, 1000) };
}

export function normalizePaidAnalytics({ ad, range, capturedAt, stale, meta, ysong }) {
  const ads = meta?.ads || [];
  const campaign = {
    campaignId: String(ad.id), creativeId: null, destinationId: null, destinationVariantId: null,
    providerDateStart: meta?.summary?.dateStart || null, providerDateStop: meta?.summary?.dateStop || null,
    ...providerMetrics(meta?.summary), conversions: number(ysong?.totals?.conversions),
    smartLinkClicks: number(ysong?.totals?.clicks),
  };
  const creatives = (ysong?.creatives || []).map(creative => {
    const adIds = [...new Set((creative.metaAdIds || []).map(item => String(item?.adId || item?.id || '')).filter(Boolean))];
    const rows = ads.filter(row => adIds.includes(String(row.adId)));
    const complete = adIds.length > 0 && adIds.every(id => rows.some(row => String(row.adId) === id));
    return {
      campaignId: String(ad.id), creativeId: String(creative.id), destinationId: null, destinationVariantId: null,
      providerDateStart: complete && rows.every(row => row.dateStart === rows[0].dateStart) ? rows[0].dateStart || null : null,
      providerDateStop: complete && rows.every(row => row.dateStop === rows[0].dateStop) ? rows[0].dateStop || null : null,
      ...creativeProviderMetrics(rows, adIds), conversions: number(creative.ysong?.conversions),
      smartLinkClicks: number(creative.ysong?.clicks),
    };
  });
  const destinations = (ysong?.destinations || []).map(destination => ({
    campaignId: String(ad.id), creativeId: null, destinationId: String(destination.id), destinationVariantId: null,
    providerDateStart: null, providerDateStop: null,
    ...providerMetrics(null), conversions: null, smartLinkClicks: number(destination.clicks),
  }));
  const variantClicks = new Map();
  const attributed = Array.isArray(ysong?.attribution)
    ? ysong.attribution
    : (ysong?.creatives || []).flatMap(creative => (creative.ysong?.destinations || [])
      .map(destination => ({ ...destination, destinationId: destination.id, creativeId: creative.id })));
  for (const row of attributed) {
    if (!row.destinationId) continue;
    const creativeId = row.creativeId && row.creativeId !== 'unknown' ? String(row.creativeId) : null;
    const destinationId = String(row.destinationId);
    const destinationVariantId = row.destinationVariantId || null;
    const key = JSON.stringify([creativeId, destinationId, destinationVariantId]);
    variantClicks.set(key, (variantClicks.get(key) || 0) + (number(row.clicks) || 0));
  }
  const destinationVariants = [...variantClicks].map(([key, smartLinkClicks]) => {
    const [creativeId, destinationId, destinationVariantId] = JSON.parse(key);
    return { campaignId: String(ad.id), creativeId, destinationId, destinationVariantId,
      providerDateStart: null, providerDateStop: null,
      ...providerMetrics(null), conversions: null, smartLinkClicks };
  });
  return {
    range, currency: ad.currency || null,
    sources: {
      provider: { name: 'meta', capturedAt: capturedAt || null, stale: !!stale,
        currency: ad.currency || null, dateStart: meta?.summary?.dateStart || null,
        dateStop: meta?.summary?.dateStop || null },
      smartLink: { name: 'ysong', dateStart: range.since, dateStop: range.until },
    },
    campaign, creatives, destinations, destinationVariants,
  };
}
