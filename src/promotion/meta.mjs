import crypto from "crypto";
import fs from "fs";
import path from "path";
import { pool } from "../db.js";
import { decryptSecret, encryptSecret, promotionSecretsConfigured } from "./crypto.mjs";

export const META_GRAPH_VERSION = String(process.env.META_GRAPH_VERSION || "v26.0").replace(/^([^v])/, "v$1");
const GRAPH = `https://graph.facebook.com/${META_GRAPH_VERSION}`;
const FACEBOOK = `https://www.facebook.com/${META_GRAPH_VERSION}`;
const META_SCOPES = [
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_posts",
  "instagram_basic",
  "instagram_content_publish",
  "ads_read",
  "ads_management",
  "business_management",
];

export function metaConfigured() {
  return Boolean(process.env.META_APP_ID && process.env.META_APP_SECRET && promotionSecretsConfigured());
}
export function metaRedirectUri(req) {
  if (process.env.META_OAUTH_REDIRECT_URI) return process.env.META_OAUTH_REDIRECT_URI;
  const proto = String(req.get("x-forwarded-proto") || req.protocol || "http").split(",")[0].trim();
  const host = req.get("x-forwarded-host") || req.get("host");
  return `${proto}://${host}/api/tools/promotion/meta/oauth/callback`;
}
function stateHash(state) { return crypto.createHash("sha256").update(state).digest("hex"); }
async function jsonFetch(url, init = {}) {
  const response = await fetch(url, init);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.error) {
    const err = new Error(data?.error?.message || `Meta HTTP ${response.status}`);
    err.code = data?.error?.code || response.status;
    err.meta = data?.error || data;
    throw err;
  }
  return data;
}
function actId(value) {
  const raw = String(value || "").trim();
  if (!raw) throw new Error("meta_ad_account_required");
  return raw.startsWith("act_") ? raw : `act_${raw}`;
}
function plainAdAccountId(value) { return String(value || "").replace(/^act_/, ""); }

export async function createMetaOAuthUrl(userId, req) {
  if (!metaConfigured()) throw new Error("meta_not_configured");
  const state = crypto.randomBytes(32).toString("base64url");
  await pool.query(`DELETE FROM promotion_oauth_states WHERE expires_at < now()`);
  await pool.query(`INSERT INTO promotion_oauth_states(state_hash,owner_user_id,expires_at) VALUES($1,$2,now()+interval '10 minutes')`, [stateHash(state), userId]);
  const params = new URLSearchParams({ client_id: process.env.META_APP_ID, redirect_uri: metaRedirectUri(req), state, response_type: "code", scope: META_SCOPES.join(",") });
  return `${FACEBOOK}/dialog/oauth?${params.toString()}`;
}
async function consumeState(state) {
  const result = await pool.query(`DELETE FROM promotion_oauth_states WHERE state_hash=$1 AND expires_at>now() RETURNING owner_user_id`, [stateHash(state)]);
  return result.rows[0]?.owner_user_id || null;
}
export async function completeMetaOAuth({ code, state, req }) {
  if (!metaConfigured()) throw new Error("meta_not_configured");
  const userId = await consumeState(String(state || ""));
  if (!userId) throw new Error("meta_oauth_state_invalid");
  const redirectUri = metaRedirectUri(req);
  const shortParams = new URLSearchParams({ client_id: process.env.META_APP_ID, client_secret: process.env.META_APP_SECRET, redirect_uri: redirectUri, code: String(code || "") });
  const short = await jsonFetch(`${GRAPH}/oauth/access_token?${shortParams.toString()}`);
  let userToken = String(short.access_token || "");
  try {
    const longParams = new URLSearchParams({ grant_type: "fb_exchange_token", client_id: process.env.META_APP_ID, client_secret: process.env.META_APP_SECRET, fb_exchange_token: userToken });
    const long = await jsonFetch(`${GRAPH}/oauth/access_token?${longParams.toString()}`);
    if (long.access_token) userToken = String(long.access_token);
  } catch {}
  const me = await jsonFetch(`${GRAPH}/me?${new URLSearchParams({ fields: "id,name", access_token: userToken }).toString()}`).catch(() => ({}));
  const accounts = await jsonFetch(`${GRAPH}/me/accounts?${new URLSearchParams({ fields: "id,name,access_token,tasks,instagram_business_account{id,username,name}", access_token: userToken }).toString()}`);
  const rows = Array.isArray(accounts.data) ? accounts.data : [];
  if (!rows.length) throw new Error("meta_no_managed_pages");
  const existing = await pool.query(`SELECT page_id FROM promotion_meta_connections WHERE owner_user_id=$1 AND is_active=true LIMIT 1`, [userId]);
  const alreadyActive = existing.rows[0]?.page_id || "";
  const activePageId = rows.some((page) => String(page?.id || "") === alreadyActive) ? alreadyActive : String(rows[0]?.id || "");
  await pool.query(`UPDATE promotion_meta_connections SET is_active=false WHERE owner_user_id=$1`, [userId]);
  for (const page of rows) {
    if (!page?.id || !page?.access_token) continue;
    const ig = page.instagram_business_account || {};
    await pool.query(`INSERT INTO promotion_meta_connections(id,owner_user_id,page_id,page_name,page_access_token_ciphertext,ig_user_id,ig_username,tasks,scopes,is_active,connected_at,updated_at,meta_user_id,user_access_token_ciphertext)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,now(),now(),$11,$12)
      ON CONFLICT(owner_user_id,page_id) DO UPDATE SET page_name=EXCLUDED.page_name,page_access_token_ciphertext=EXCLUDED.page_access_token_ciphertext,ig_user_id=EXCLUDED.ig_user_id,ig_username=EXCLUDED.ig_username,tasks=EXCLUDED.tasks,scopes=EXCLUDED.scopes,meta_user_id=EXCLUDED.meta_user_id,user_access_token_ciphertext=EXCLUDED.user_access_token_ciphertext,updated_at=now()`,
      [crypto.randomUUID(), userId, String(page.id), String(page.name || ""), encryptSecret(page.access_token), String(ig.id || ""), String(ig.username || ig.name || ""), JSON.stringify(page.tasks || []), JSON.stringify(META_SCOPES), String(page.id) === activePageId, String(me.id || ""), encryptSecret(userToken)]);
  }
  return { userId, pageCount: rows.length };
}
export async function listMetaConnections(userId) {
  const { rows } = await pool.query(`SELECT id,page_id,page_name,ig_user_id,ig_username,tasks,scopes,is_active,connected_at,updated_at FROM promotion_meta_connections WHERE owner_user_id=$1 ORDER BY is_active DESC,page_name ASC`, [userId]);
  return rows.map((r) => ({ id: String(r.id), pageId: r.page_id, pageName: r.page_name, instagramUserId: r.ig_user_id, instagramUsername: r.ig_username, tasks: r.tasks || [], scopes: r.scopes || [], active: !!r.is_active, connectedAt: r.connected_at, updatedAt: r.updated_at }));
}
export async function selectMetaConnection(userId, id) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const found = await client.query(`SELECT id FROM promotion_meta_connections WHERE id=$1 AND owner_user_id=$2`, [id, userId]);
    if (!found.rows[0]) throw new Error("meta_connection_not_found");
    await client.query(`UPDATE promotion_meta_connections SET is_active=false WHERE owner_user_id=$1`, [userId]);
    await client.query(`UPDATE promotion_meta_connections SET is_active=true,updated_at=now() WHERE id=$1`, [id]);
    await client.query("COMMIT");
  } catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
}
export async function disconnectMeta(userId, id = null) {
  if (id) await pool.query(`DELETE FROM promotion_meta_connections WHERE owner_user_id=$1 AND id=$2`, [userId, id]);
  else await pool.query(`DELETE FROM promotion_meta_connections WHERE owner_user_id=$1`, [userId]);
}
async function activeConnection(userId, connectionId = "") {
  const params = connectionId ? [userId, connectionId] : [userId];
  const { rows } = await pool.query(connectionId
    ? `SELECT * FROM promotion_meta_connections WHERE owner_user_id=$1 AND id=$2 LIMIT 1`
    : `SELECT * FROM promotion_meta_connections WHERE owner_user_id=$1 AND is_active=true ORDER BY updated_at DESC LIMIT 1`, params);
  if (!rows[0]) throw new Error("meta_not_connected");
  return rows[0];
}
async function marketingToken(userId, connectionId = "") {
  const conn = await activeConnection(userId, connectionId);
  if (!conn.user_access_token_ciphertext) throw new Error("meta_reconnect_for_ads_permissions");
  return { conn, token: decryptSecret(conn.user_access_token_ciphertext) };
}

export const META_DSA_COUNTRIES = Object.freeze([
  "AT","BE","BG","HR","CY","CZ","DK","EE","FI","FR","DE","GR","HU","IE","IT","LV","LT","LU","MT","NL","PL","PT","RO","SK","SI","ES","SE","IS","LI","NO"
]);

export async function listMetaAdAccounts(userId, connectionId = "") {
  const { token } = await marketingToken(userId, connectionId);
  const fields = "id,account_id,name,account_status,currency,timezone_name,disable_reason,business{id,name},amount_spent,balance,spend_cap,default_dsa_beneficiary,default_dsa_payor";
  const data = await jsonFetch(`${GRAPH}/me/adaccounts?${new URLSearchParams({ fields, limit: "200", access_token: token }).toString()}`);
  return (data.data || []).map((r) => ({
    id: plainAdAccountId(r.account_id || r.id), graphId: actId(r.account_id || r.id), name: r.name || "Ad account",
    accountStatus: Number(r.account_status || 0), currency: r.currency || "", timezone: r.timezone_name || "", disableReason: Number(r.disable_reason || 0), business: r.business || null,
    amountSpentMinor: Number(r.amount_spent || 0), balanceMinor: Number(r.balance || 0), spendCapMinor: Number(r.spend_cap || 0),
    defaultDsaBeneficiary: String(r.default_dsa_beneficiary || ""), defaultDsaPayor: String(r.default_dsa_payor || ""),
  }));
}
export async function listMetaPixels(userId, adAccountId, connectionId = "") {
  const { token } = await marketingToken(userId, connectionId);
  const data = await jsonFetch(`${GRAPH}/${actId(adAccountId)}/adspixels?${new URLSearchParams({ fields: "id,name,last_fired_time,is_created_by_business", limit: "200", access_token: token }).toString()}`);
  return (data.data || []).map((r) => ({ id: String(r.id || ""), name: r.name || "Pixel", lastFiredTime: r.last_fired_time || null }));
}
export async function searchMetaInterests(userId, query, limit = 20, connectionId = "") {
  const { token } = await marketingToken(userId, connectionId);
  const params = new URLSearchParams({ type: "adinterest", q: String(query || "").slice(0, 120), limit: String(Math.max(1, Math.min(50, limit))), access_token: token });
  const data = await jsonFetch(`${GRAPH}/search?${params.toString()}`);
  return (data.data || []).map((r) => ({ id: String(r.id || ""), name: String(r.name || ""), audienceSizeLower: Number(r.audience_size_lower_bound || r.audience_size || 0), audienceSizeUpper: Number(r.audience_size_upper_bound || r.audience_size || 0), path: r.path || [] }));
}

export async function publishToMeta({ userId, channel, message, linkUrl, imageUrl }) {
  const conn = await activeConnection(userId);
  const token = decryptSecret(conn.page_access_token_ciphertext);
  const caption = String(message || "").slice(0, 4000);
  if (channel === "facebook") {
    const body = new URLSearchParams({ access_token: token, message: caption });
    if (linkUrl) body.set("link", linkUrl);
    const result = await jsonFetch(`${GRAPH}/${encodeURIComponent(conn.page_id)}/feed`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
    return { channel, objectId: String(result.id || ""), pageId: conn.page_id };
  }
  if (channel === "instagram") {
    if (!conn.ig_user_id) throw new Error("meta_instagram_not_linked");
    if (!imageUrl) throw new Error("meta_instagram_artwork_required");
    const createBody = new URLSearchParams({ access_token: token, image_url: imageUrl, caption });
    const container = await jsonFetch(`${GRAPH}/${encodeURIComponent(conn.ig_user_id)}/media`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: createBody });
    const publishBody = new URLSearchParams({ access_token: token, creation_id: String(container.id || "") });
    const result = await jsonFetch(`${GRAPH}/${encodeURIComponent(conn.ig_user_id)}/media_publish`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: publishBody });
    return { channel, objectId: String(result.id || ""), containerId: String(container.id || ""), instagramUserId: conn.ig_user_id };
  }
  throw new Error("meta_channel_invalid");
}

async function uploadAdVideo({ token, adAccountId, filePath, title }) {
  const bytes = await fs.promises.readFile(filePath);
  const form = new FormData();
  form.set("access_token", token);
  form.set("title", String(title || path.basename(filePath)).slice(0, 200));
  form.set("source", new Blob([bytes], { type: "video/mp4" }), path.basename(filePath));
  const data = await jsonFetch(`${GRAPH}/${actId(adAccountId)}/advideos`, { method: "POST", body: form });
  const id = String(data.id || "");
  if (!id) throw new Error("meta_video_upload_missing_id");
  return id;
}

function selectedPlacementGroups(targeting = {}) {
  const targets = new Set(Array.isArray(targeting.placementTargets) ? targeting.placementTargets : []);
  return {
    feed: targets.has("facebook_feed") || targets.has("instagram_feed"),
    vertical: targets.has("facebook_stories") || targets.has("facebook_reels") || targets.has("instagram_stories") || targets.has("instagram_reels"),
  };
}
export function buildMetaTargetingPayload(targeting = {}) {
  const countries = Array.isArray(targeting.countries) ? targeting.countries.map((v) => String(v).toUpperCase()).filter(Boolean) : [];
  if (!countries.length) throw new Error("meta_target_countries_required");
  const targets = new Set(Array.isArray(targeting.placementTargets) ? targeting.placementTargets : []);
  if (!targets.size) throw new Error("meta_placement_required");
  const result = {
    geo_locations: { countries },
    age_min: Math.max(18, Math.min(65, Number(targeting.ageMin || 18))),
    age_max: Math.max(18, Math.min(65, Number(targeting.ageMax || 65))),
  };
  if (targeting.gender === "male") result.genders = [1];
  if (targeting.gender === "female") result.genders = [2];
  const interests = Array.isArray(targeting.interests) ? targeting.interests.filter((x) => x?.id).map((x) => ({ id: String(x.id), name: String(x.name || "") })) : [];
  if (interests.length) result.interests = interests;
  const publisherPlatforms = [];
  const facebookPositions = [];
  const instagramPositions = [];
  if ([...targets].some((v) => String(v).startsWith("facebook_"))) publisherPlatforms.push("facebook");
  if ([...targets].some((v) => String(v).startsWith("instagram_"))) publisherPlatforms.push("instagram");
  if (targets.has("facebook_feed")) facebookPositions.push("feed");
  if (targets.has("facebook_stories")) facebookPositions.push("story");
  if (targets.has("facebook_reels")) facebookPositions.push("facebook_reels");
  if (targets.has("instagram_feed")) instagramPositions.push("stream");
  if (targets.has("instagram_stories")) instagramPositions.push("story");
  if (targets.has("instagram_reels")) instagramPositions.push("reels");
  result.publisher_platforms = publisherPlatforms;
  if (facebookPositions.length) result.facebook_positions = facebookPositions;
  if (instagramPositions.length) result.instagram_positions = instagramPositions;
  return result;
}

function placementCustomization(kind, targeting = {}) {
  const targets = new Set(Array.isArray(targeting.placementTargets) ? targeting.placementTargets : []);
  const spec = { publisher_platforms: [] };
  const fb = [];
  const ig = [];
  if (kind === "vertical") {
    if (targets.has("facebook_stories")) fb.push("story");
    if (targets.has("facebook_reels")) fb.push("facebook_reels");
    if (targets.has("instagram_stories")) ig.push("story");
    if (targets.has("instagram_reels")) ig.push("reels");
  } else {
    if (targets.has("facebook_feed")) fb.push("feed");
    if (targets.has("instagram_feed")) ig.push("stream");
  }
  if (fb.length) { spec.publisher_platforms.push("facebook"); spec.facebook_positions = fb; }
  if (ig.length) { spec.publisher_platforms.push("instagram"); spec.instagram_positions = ig; }
  return spec;
}
function label(name) { return { name }; }
export function buildMetaPlacementCreativeSpec({ conn, targeting, verticalVideoId = "", feedVideoId = "", linkUrl, message, headline, ctaType = "LISTEN_NOW" }) {
  const groups = selectedPlacementGroups(targeting);
  const baseStory = { page_id: String(conn.page_id || "") };
  if (String(conn.ig_user_id || "")) baseStory.instagram_user_id = String(conn.ig_user_id);
  const cleanMessage = String(message || "").slice(0, 2200);
  const cleanHeadline = String(headline || "Listen now").slice(0, 255);
  const cleanLink = String(linkUrl || "");
  if (groups.vertical && groups.feed) {
    if (!verticalVideoId || !feedVideoId) throw new Error("meta_both_creative_formats_required");
    return {
      object_story_spec: baseStory,
      asset_feed_spec: {
        ad_formats: ["SINGLE_VIDEO"],
        call_to_action_types: [ctaType],
        bodies: [{ text: cleanMessage, adlabels: [label("ysong_body")] }],
        titles: [{ text: cleanHeadline, adlabels: [label("ysong_title")] }],
        link_urls: [{ website_url: cleanLink, adlabels: [label("ysong_link")] }],
        videos: [
          { video_id: String(verticalVideoId), adlabels: [label("ysong_vertical")] },
          { video_id: String(feedVideoId), adlabels: [label("ysong_feed")] },
        ],
        asset_customization_rules: [
          { customization_spec: placementCustomization("vertical", targeting), priority: 1, video_label: label("ysong_vertical"), body_label: label("ysong_body"), title_label: label("ysong_title"), link_url_label: label("ysong_link") },
          { customization_spec: placementCustomization("feed", targeting), priority: 2, video_label: label("ysong_feed"), body_label: label("ysong_body"), title_label: label("ysong_title"), link_url_label: label("ysong_link") },
        ],
      },
      degrees_of_freedom_spec: { creative_features_spec: { standard_enhancements: { enroll_status: "OPT_OUT" } } },
    };
  }
  const videoId = groups.vertical ? verticalVideoId : feedVideoId;
  if (!videoId) throw new Error(groups.vertical ? "meta_vertical_creative_required" : "meta_feed_creative_required");
  return {
    object_story_spec: {
      ...baseStory,
      video_data: {
        video_id: String(videoId), message: cleanMessage, title: cleanHeadline,
        call_to_action: { type: ctaType, value: { link: cleanLink } },
      },
    },
    degrees_of_freedom_spec: { creative_features_spec: { standard_enhancements: { enroll_status: "OPT_OUT" } } },
  };
}

async function createRemoteCampaign({ token, adAccountId, name }) {
  const body = new URLSearchParams({ access_token: token, name, objective: "OUTCOME_TRAFFIC", buying_type: "AUCTION", status: "PAUSED", special_ad_categories: "[]" });
  const data = await jsonFetch(`${GRAPH}/${actId(adAccountId)}/campaigns`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  const id = String(data.id || "");
  if (!id) throw new Error("meta_campaign_missing_id");
  return id;
}
async function createRemoteAdSet({ token, adAccountId, campaignId, name, dailyBudgetMinor, startTime, endTime, targeting, dsaBeneficiary, dsaPayor }) {
  const body = new URLSearchParams({
    access_token: token, name, campaign_id: campaignId, billing_event: "IMPRESSIONS", optimization_goal: "LINK_CLICKS",
    bid_strategy: "LOWEST_COST_WITHOUT_CAP", daily_budget: String(Math.max(100, Math.round(Number(dailyBudgetMinor || 500)))),
    targeting: JSON.stringify(buildMetaTargetingPayload(targeting)), destination_type: "WEBSITE", status: "PAUSED",
  });
  if (startTime) body.set("start_time", new Date(startTime).toISOString());
  if (endTime) body.set("end_time", new Date(endTime).toISOString());
  if (dsaBeneficiary) body.set("dsa_beneficiary", String(dsaBeneficiary).slice(0, 255));
  if (dsaPayor) body.set("dsa_payor", String(dsaPayor).slice(0, 255));
  const data = await jsonFetch(`${GRAPH}/${actId(adAccountId)}/adsets`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  const id = String(data.id || "");
  if (!id) throw new Error("meta_adset_missing_id");
  return id;
}
async function createRemoteCreative({ token, adAccountId, name, spec }) {
  const body = new URLSearchParams({ access_token: token, name });
  for (const [key, value] of Object.entries(spec || {})) body.set(key, JSON.stringify(value));
  const data = await jsonFetch(`${GRAPH}/${actId(adAccountId)}/adcreatives`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  const id = String(data.id || "");
  if (!id) throw new Error("meta_creative_missing_id");
  return id;
}
async function createRemoteAd({ token, adAccountId, name, adSetId, creativeId }) {
  const body = new URLSearchParams({ access_token: token, name, adset_id: adSetId, creative: JSON.stringify({ creative_id: creativeId }), status: "PAUSED" });
  const data = await jsonFetch(`${GRAPH}/${actId(adAccountId)}/ads`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  const id = String(data.id || "");
  if (!id) throw new Error("meta_ad_missing_id");
  return id;
}
async function setRemoteStatus(token, objectId, status) {
  const body = new URLSearchParams({ access_token: token, status });
  await jsonFetch(`${GRAPH}/${encodeURIComponent(objectId)}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
}

export async function createMetaPaidCampaign({ userId, connectionId, adAccountId, name, dailyBudgetMinor, startTime, endTime, targeting, message, headline, creatives, dsaBeneficiary = "", dsaPayor = "", activate = true, onProgress = null }) {
  const { conn, token } = await marketingToken(userId, connectionId);
  if (!conn.page_id) throw new Error("meta_page_required");
  const groups = selectedPlacementGroups(targeting);
  const needsInstagram = Array.isArray(targeting?.placementTargets) && targeting.placementTargets.some((v) => String(v).startsWith("instagram_"));
  if (needsInstagram && !conn.ig_user_id) throw new Error("meta_instagram_not_linked");
  if (!groups.feed && !groups.vertical) throw new Error("meta_placement_required");
  const campaignId = await createRemoteCampaign({ token, adAccountId, name });
  if (onProgress) await onProgress({ stage: "campaign", campaignId });
  const adSetId = await createRemoteAdSet({ token, adAccountId, campaignId, name: `${name} · Audience`, dailyBudgetMinor, startTime, endTime, targeting, dsaBeneficiary, dsaPayor });
  if (onProgress) await onProgress({ stage: "adset", campaignId, adSetId });
  const ads = [];
  const preferredCta = String(process.env.META_PROMOTION_CTA || "LISTEN_NOW").trim() || "LISTEN_NOW";
  for (let i = 0; i < creatives.length; i++) {
    const item = creatives[i];
    let verticalVideoId = "";
    let feedVideoId = "";
    if (groups.vertical) verticalVideoId = await uploadAdVideo({ token, adAccountId, filePath: item.filePath916, title: `${name} · ${i + 1} · 9x16` });
    if (groups.feed) feedVideoId = await uploadAdVideo({ token, adAccountId, filePath: item.filePath43, title: `${name} · ${i + 1} · 4x3` });
    if (onProgress) await onProgress({ stage: "video", campaignId, adSetId, localCreativeId: item.id, verticalVideoId, feedVideoId });
    let spec = buildMetaPlacementCreativeSpec({ conn, targeting, verticalVideoId, feedVideoId, linkUrl: item.linkUrl, message, headline, ctaType: preferredCta });
    let creativeId = "";
    try {
      creativeId = await createRemoteCreative({ token, adAccountId, name: `${name} · Creative ${i + 1}`, spec });
    } catch (error) {
      if (preferredCta === "LEARN_MORE") throw error;
      spec = buildMetaPlacementCreativeSpec({ conn, targeting, verticalVideoId, feedVideoId, linkUrl: item.linkUrl, message, headline, ctaType: "LEARN_MORE" });
      creativeId = await createRemoteCreative({ token, adAccountId, name: `${name} · Creative ${i + 1}`, spec });
    }
    const adId = await createRemoteAd({ token, adAccountId, name: `${name} · Ad ${i + 1}`, adSetId, creativeId });
    const created = { localCreativeId: item.id, verticalVideoId, feedVideoId, creativeId, adId, linkUrl: item.linkUrl };
    ads.push(created);
    if (onProgress) await onProgress({ stage: "ad", campaignId, adSetId, ad: created, ads: [...ads] });
  }
  if (activate) {
    for (const ad of ads) await setRemoteStatus(token, ad.adId, "ACTIVE");
    await setRemoteStatus(token, adSetId, "ACTIVE");
    await setRemoteStatus(token, campaignId, "ACTIVE");
  }
  const status = activate ? "ACTIVE" : "PAUSED";
  if (onProgress) await onProgress({ stage: "complete", campaignId, adSetId, ads, status });
  return { campaignId, adSetId, ads, status };
}

export async function setMetaPaidCampaignStatus(userId, connectionId, campaignId, status) {
  const normalized = String(status || "").toUpperCase();
  if (!["ACTIVE","PAUSED"].includes(normalized)) throw new Error("meta_status_invalid");
  const { token } = await marketingToken(userId, connectionId);
  const children = await fetchMetaPaidCampaignStatusWithToken(token, campaignId);
  const adSetIds = (children.adSets || []).map((x) => String(x.id || "")).filter(Boolean);
  const adIds = (children.ads || []).map((x) => String(x.id || "")).filter(Boolean);
  // Meta's hierarchy is intentionally changed in a safe order. Activating children first
  // cannot deliver while the parent Campaign remains paused; pausing the parent first
  // stops delivery before we pause its descendants.
  if (normalized === "ACTIVE") {
    for (const id of adIds) await setRemoteStatus(token, id, "ACTIVE");
    for (const id of adSetIds) await setRemoteStatus(token, id, "ACTIVE");
    await setRemoteStatus(token, campaignId, "ACTIVE");
  } else {
    await setRemoteStatus(token, campaignId, "PAUSED");
    for (const id of adSetIds) await setRemoteStatus(token, id, "PAUSED");
    for (const id of adIds) await setRemoteStatus(token, id, "PAUSED");
  }
  return { campaignId, status: normalized, adSetIds, adIds };
}
export async function deleteMetaPaidCampaign(userId, connectionId, campaignId) {
  const { token } = await marketingToken(userId, connectionId);
  const body = new URLSearchParams({ access_token: token });
  await jsonFetch(`${GRAPH}/${encodeURIComponent(campaignId)}`, { method: "DELETE", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  return { campaignId, deleted: true };
}
async function fetchMetaPaidCampaignStatusWithToken(token, campaignId) {
  const campaignFields = "id,name,status,effective_status,start_time,stop_time,updated_time";
  const campaign = await jsonFetch(`${GRAPH}/${encodeURIComponent(campaignId)}?${new URLSearchParams({ fields: campaignFields, access_token: token }).toString()}`);
  const adsets = await jsonFetch(`${GRAPH}/${encodeURIComponent(campaignId)}/adsets?${new URLSearchParams({ fields: "id,name,status,effective_status,start_time,end_time,daily_budget,budget_remaining", limit: "100", access_token: token }).toString()}`).catch(() => ({ data: [] }));
  const ads = await jsonFetch(`${GRAPH}/${encodeURIComponent(campaignId)}/ads?${new URLSearchParams({ fields: "id,name,status,effective_status,issues_info,adset_id,creative{id}", limit: "500", access_token: token }).toString()}`).catch(() => ({ data: [] }));
  return { campaign, adSets: adsets.data || [], ads: ads.data || [] };
}
export async function fetchMetaPaidCampaignStatus(userId, connectionId, campaignId) {
  const { token } = await marketingToken(userId, connectionId);
  return fetchMetaPaidCampaignStatusWithToken(token, campaignId);
}

export function deriveLocalMetaStatus(remote) {
  const campaign = String(remote?.campaign?.effective_status || remote?.campaign?.status || "").toUpperCase();
  const ads = Array.isArray(remote?.ads) ? remote.ads : [];
  const adStates = ads.map((a) => String(a.effective_status || a.status || "").toUpperCase());
  const combined = [campaign, ...adStates];
  if (combined.some((v) => ["DISAPPROVED","WITH_ISSUES","ERROR"].includes(v))) return "failed";
  if (combined.some((v) => ["PENDING_REVIEW","PREAPPROVED"].includes(v))) return "in_review";
  if (campaign === "PAUSED" || (adStates.length && adStates.every((v) => v === "PAUSED"))) return "paused";
  if (campaign === "ACTIVE" && (!adStates.length || adStates.some((v) => v === "ACTIVE"))) return "active";
  if (["ARCHIVED","DELETED"].includes(campaign)) return "archived";
  return "in_review";
}

function actionValue(row, type) {
  const found = Array.isArray(row) ? row.find((x) => String(x.action_type || "") === type) : null;
  return Number(found?.value || 0);
}
function actionTotal(row) {
  return Array.isArray(row) ? row.reduce((n, x) => n + Number(x?.value || 0), 0) : Number(row || 0);
}
function insightNumber(row, key) { return Number(row?.[key] || 0); }
function normalizeInsightRow(row = {}) {
  const outboundClicks = actionTotal(row.outbound_clicks);
  const linkClicks = insightNumber(row, "inline_link_clicks") || actionValue(row.actions, "link_click") || outboundClicks;
  const videoPlays = actionValue(row.video_play_actions, "video_view") || actionTotal(row.video_play_actions);
  const thruPlays = actionTotal(row.video_thruplay_watched_actions);
  return {
    campaignId: String(row.campaign_id || ""), campaignName: String(row.campaign_name || ""),
    adSetId: String(row.adset_id || ""), adSetName: String(row.adset_name || ""),
    adId: String(row.ad_id || ""), adName: String(row.ad_name || ""),
    dateStart: row.date_start || null, dateStop: row.date_stop || null,
    impressions: insightNumber(row, "impressions"), reach: insightNumber(row, "reach"), frequency: insightNumber(row, "frequency"),
    clicks: insightNumber(row, "clicks"), uniqueClicks: insightNumber(row, "unique_clicks"), linkClicks, outboundClicks,
    landingPageViews: actionValue(row.actions, "landing_page_view"),
    spend: insightNumber(row, "spend"), cpm: insightNumber(row, "cpm"), cpc: insightNumber(row, "cpc"), ctr: insightNumber(row, "ctr"),
    costPerLandingPageView: actionValue(row.cost_per_action_type, "landing_page_view"),
    videoPlays, thruPlays,
    video25: actionTotal(row.video_p25_watched_actions), video50: actionTotal(row.video_p50_watched_actions),
    video75: actionTotal(row.video_p75_watched_actions), video100: actionTotal(row.video_p100_watched_actions),
    publisherPlatform: String(row.publisher_platform || ""), platformPosition: String(row.platform_position || ""),
    country: String(row.country || ""), age: String(row.age || ""), gender: String(row.gender || ""),
  };
}

const META_INSIGHT_BASE_FIELDS = [
  "date_start","date_stop",
  "impressions","reach","frequency","clicks","unique_clicks","inline_link_clicks","outbound_clicks",
  "spend","cpm","cpc","ctr","actions","cost_per_action_type"
];
const META_INSIGHT_VIDEO_FIELDS = [
  "video_play_actions","video_thruplay_watched_actions","video_p25_watched_actions","video_p50_watched_actions","video_p75_watched_actions","video_p100_watched_actions"
];
async function jsonFetchPages(url, maxPages = 20) {
  const rows = [];
  let next = url;
  let pages = 0;
  while (next && pages < maxPages) {
    const data = await jsonFetch(next);
    if (Array.isArray(data?.data)) rows.push(...data.data);
    next = String(data?.paging?.next || "");
    pages += 1;
  }
  return rows;
}
async function fetchInsightRowsWithToken(token, objectId, { level = "campaign", since = "", until = "", timeIncrement = "", breakdowns = [], limit = 500 } = {}) {
  const levelFields = level === "ad" ? ["campaign_id","campaign_name","adset_id","adset_name","ad_id","ad_name"] : level === "adset" ? ["campaign_id","campaign_name","adset_id","adset_name"] : ["campaign_id","campaign_name"];
  const build = (fields) => {
    const params = new URLSearchParams({ fields: [...levelFields, ...fields].join(","), level, limit: String(Math.max(1, Math.min(5000, Number(limit) || 500))), access_token: token });
    if (since && until) params.set("time_range", JSON.stringify({ since, until }));
    if (timeIncrement) params.set("time_increment", String(timeIncrement));
    if (Array.isArray(breakdowns) && breakdowns.length) params.set("breakdowns", breakdowns.join(","));
    return `${GRAPH}/${encodeURIComponent(objectId)}/insights?${params.toString()}`;
  };
  let rows;
  try {
    rows = await jsonFetchPages(build([...META_INSIGHT_BASE_FIELDS, ...META_INSIGHT_VIDEO_FIELDS]));
  } catch (error) {
    // Meta occasionally retires or restricts a video metric independently of the rest
    // of Insights. Retry the core report rather than making the entire analytics page fail.
    rows = await jsonFetchPages(build(META_INSIGHT_BASE_FIELDS));
    if (rows && typeof rows === "object") rows._videoMetricError = error?.message || "video_metrics_unavailable";
  }
  return rows.map(normalizeInsightRow);
}

export async function fetchMetaCampaignInsights(userId, metaCampaignId, { since = "", until = "", connectionId = "" } = {}) {
  const { token } = await marketingToken(userId, connectionId);
  const rows = await fetchInsightRowsWithToken(token, metaCampaignId, { level: "campaign", since, until });
  return rows[0] || normalizeInsightRow({});
}

export async function fetchMetaCampaignAnalyticsBundle(userId, metaCampaignId, { since = "", until = "", connectionId = "" } = {}) {
  const { token } = await marketingToken(userId, connectionId);
  const warnings = [];
  const safe = async (label, fn) => {
    try { return await fn(); }
    catch (error) { warnings.push({ code: `meta_${label}_unavailable`, message: error?.message || `${label} analytics unavailable.` }); return []; }
  };
  const [summaryRows, daily, adSets, ads, placements, countries] = await Promise.all([
    safe("summary", () => fetchInsightRowsWithToken(token, metaCampaignId, { level: "campaign", since, until })),
    safe("daily", () => fetchInsightRowsWithToken(token, metaCampaignId, { level: "campaign", since, until, timeIncrement: "1", limit: 1000 })),
    safe("adsets", () => fetchInsightRowsWithToken(token, metaCampaignId, { level: "adset", since, until, limit: 1000 })),
    safe("ads", () => fetchInsightRowsWithToken(token, metaCampaignId, { level: "ad", since, until, limit: 2000 })),
    safe("placements", () => fetchInsightRowsWithToken(token, metaCampaignId, { level: "campaign", since, until, breakdowns: ["publisher_platform","platform_position"], limit: 2000 })),
    safe("countries", () => fetchInsightRowsWithToken(token, metaCampaignId, { level: "campaign", since, until, breakdowns: ["country"], limit: 1000 })),
  ]);
  return { summary: summaryRows[0] || normalizeInsightRow({}), daily, adSets, ads, placements, countries, warnings };
}
