// Public attribution is untrusted. Keep only short, reportable labels; never store
// arbitrary URL parameters or pass them through to a streaming destination.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LABEL = /^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u;
const fields = {
  adCampaignId: ["adCampaignId", "ac", "ysong_ad_campaign"],
  creativeId: ["creativeId", "cr", "ysong_creative"],
  destinationVariantId: ["destinationVariantId", "dv", "ysong_destination_variant"],
  utmSource: ["utmSource", "utm_source"],
  utmMedium: ["utmMedium", "utm_medium"],
  utmCampaign: ["utmCampaign", "utm_campaign"],
  utmContent: ["utmContent", "utm_content"],
  utmTerm: ["utmTerm", "utm_term"],
};
const inputKeys = new Set(Object.values(fields).flat());

export function eventMetadataWithAttribution(metadata, attribution) {
  return {
    ...Object.fromEntries(Object.entries(metadata || {}).filter(([key]) => !inputKeys.has(key))),
    ...attribution,
  };
}

export function parseAttribution(input = {}) {
  const result = {};
  for (const [key, aliases] of Object.entries(fields)) {
    const value = aliases.map(alias => input?.[alias]).find(value => value !== undefined && value !== null && value !== "");
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    const max = key === "utmCampaign" || key === "utmContent" ? 180 : 120;
    if (trimmed.length > max) continue;
    if (key === "adCampaignId" || key === "creativeId") {
      if (UUID.test(trimmed)) result[key] = trimmed.toLowerCase();
    } else if (trimmed && LABEL.test(trimmed)) result[key] = trimmed;
  }
  return result;
}

export async function verifiedAttribution(query, campaignId, input) {
  const parsed = parseAttribution(input);
  if (!parsed.adCampaignId) delete parsed.creativeId;
  if (parsed.adCampaignId) {
    const { rows } = await query(
      `SELECT a.id AS ad_id,c.id AS creative_id FROM promotion_ad_campaigns a
       LEFT JOIN promotion_ad_creatives c ON c.ad_campaign_id=a.id AND c.id=$3
       WHERE a.id=$1 AND a.campaign_id=$2 LIMIT 1`,
      [parsed.adCampaignId, campaignId, parsed.creativeId || null],
    );
    if (!rows[0]) {
      delete parsed.adCampaignId;
      delete parsed.creativeId;
    } else if (!rows[0].creative_id) delete parsed.creativeId;
  }
  return parsed;
}
