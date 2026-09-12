import crypto from "crypto";
import fs from "fs";
import path from "path";
import { z } from "zod";
import { pool } from "../db.js";
import { buildLiveIntel } from "../musicSeo/analyze.mjs";
import { qrSvg } from "./qr.mjs";
import { inspectPromotionRenderRuntime, probeMedia, renderPromotionCreative } from "./creative.mjs";
import { ALL_COUNTRY_CODES, COUNTRY_TIERS, PROMOTION_PLATFORM_CATALOG, describeCountries } from "./catalog.mjs";
import { stockProviderStatus, searchStockVideos, resolveStockVideoForImport, downloadStockFile } from "./stock.mjs";
import { buildPromotionIntelligence } from "./intelligence.mjs";
import {
  META_GRAPH_VERSION,
  completeMetaOAuth,
  createMetaOAuthUrl,
  disconnectMeta,
  listMetaConnections,
  metaConfigured,
  publishToMeta,
  selectMetaConnection,
  listMetaAdAccounts,
  listMetaPixels,
  searchMetaInterests,
  createMetaPaidCampaign,
  fetchMetaCampaignAnalyticsBundle,
  fetchMetaPaidCampaignStatus,
  setMetaPaidCampaignStatus,
  deleteMetaPaidCampaign,
  deriveLocalMetaStatus,
  META_DSA_COUNTRIES,
} from "./meta.mjs";

const CampaignSchema = z.object({
  sourceReleaseId: z.string().uuid().nullable().optional(),
  kind: z.enum(["smart_link", "presave", "release"]).default("smart_link"),
  slug: z.string().max(100).optional().default(""),
  title: z.string().max(180).optional().default(""),
  artistName: z.string().max(180).optional().default(""),
  description: z.string().max(4000).optional().default(""),
  genre: z.string().max(120).optional().default(""),
  releaseDate: z.string().nullable().optional(),
  headline: z.string().max(220).optional().default(""),
  ctaLabel: z.string().max(80).optional().default(""),
  accentColor: z.string().max(32).optional().default("#8b5cf6"),
  seoQuery: z.string().max(300).optional().default(""),
  destinations: z.array(z.object({
    platform: z.string().max(80).optional().default("link"),
    label: z.string().min(1).max(120),
    url: z.string().url().max(2000).refine((v) => /^https?:\/\//i.test(v), "HTTP(S) URL required"),
    kind: z.enum(["stream","presave","social","store","other"]).optional().default("stream"),
    enabled: z.boolean().optional().default(true),
  })).max(100).optional().default([]),
});
const EventSchema = z.object({
  eventType: z.enum(["view","conversion","share","presave_intent","meta_referral","custom"]),
  visitorId: z.string().max(160).optional().default(""),
  destinationId: z.string().uuid().nullable().optional(),
  metadata: z.record(z.string(), z.any()).optional().default({}),
});
const FanSchema = z.object({
  email: z.string().email().max(320),
  consent: z.literal(true),
  source: z.string().max(80).optional().default("landing_page"),
  provider: z.string().max(80).optional().default(""),
  visitorId: z.string().max(160).optional().default(""),
  adCampaignId: z.string().uuid().optional().or(z.literal("")).default(""),
  creativeId: z.string().uuid().optional().or(z.literal("")).default(""),
  utmSource: z.string().max(120).optional().default(""),
  utmMedium: z.string().max(120).optional().default(""),
  utmCampaign: z.string().max(180).optional().default(""),
  utmContent: z.string().max(180).optional().default(""),
});

const AdCampaignSchema = z.object({
  campaignId: z.string().uuid(),
  sourceTrackId: z.string().uuid().nullable().optional(),
  name: z.string().min(1).max(180),
  goal: z.enum(["song_growth","release_growth","fan_growth","presave","custom"]).optional().default("song_growth"),
  genre: z.string().max(160).optional().default(""),
  genreSource: z.enum(["ysong","user"]).optional().default("ysong"),
  dailyBudgetMinor: z.number().int().min(100).max(100000000).optional().default(500),
  currency: z.string().min(3).max(3).optional().default("USD"),
  scheduleStart: z.string().datetime().nullable().optional(),
  scheduleEnd: z.string().datetime().nullable().optional(),
  timezone: z.string().max(100).optional().default("UTC"),
  placements: z.array(z.enum(["facebook","instagram"])).min(1).max(2).optional().default(["facebook","instagram"]),
  targeting: z.object({
    countries: z.array(z.string().length(2)).max(250).optional().default([]),
    ageMin: z.number().int().min(18).max(65).optional().default(18),
    ageMax: z.number().int().min(18).max(65).optional().default(65),
    gender: z.enum(["all","male","female"]).optional().default("all"),
    interests: z.array(z.object({ id:z.string().max(80), name:z.string().max(180), audienceSizeLower:z.number().nonnegative().optional(), audienceSizeUpper:z.number().nonnegative().optional(), path:z.array(z.any()).optional() })).max(200).optional().default([]),
    interestKeywords: z.array(z.string().min(1).max(180)).max(250).optional().default([]),
    countryPreset: z.enum(["tier1","tier2","tier3","custom","mixed"]).optional().default("custom"),
    placementTargets: z.array(z.enum([
      "facebook_feed","facebook_reels","facebook_stories",
      "instagram_feed","instagram_reels","instagram_stories"
    ])).min(1).max(6).optional().default(["facebook_feed","facebook_reels","facebook_stories","instagram_feed","instagram_reels","instagram_stories"]),
  }).optional().default({}),
  adText: z.string().max(2200).optional().default(""),
  adHeadline: z.string().max(255).optional().default("Listen now"),
  language: z.string().max(20).optional().default("en"),
  coverArtObjectKey: z.string().max(1000).nullable().optional(),
  metaConnectionId: z.string().uuid().nullable().optional(),
  metaAdAccountId: z.string().max(100).optional().default(""),
  metaPixelId: z.string().max(100).optional().default(""),
  dsaBeneficiary: z.string().max(255).optional().default(""),
  dsaPayor: z.string().max(255).optional().default(""),
}).superRefine((value,ctx)=>{
  if(value.targeting.ageMin>value.targeting.ageMax) ctx.addIssue({code:z.ZodIssueCode.custom,path:["targeting","ageMax"],message:"Maximum age must be greater than or equal to minimum age"});
  const hasStart=!!value.scheduleStart, hasEnd=!!value.scheduleEnd;
  if(hasStart!==hasEnd) ctx.addIssue({code:z.ZodIssueCode.custom,path:["scheduleEnd"],message:"Scheduled campaigns require both a start and end time"});
  if(hasStart&&hasEnd&&new Date(value.scheduleEnd).getTime()<=new Date(value.scheduleStart).getTime()) ctx.addIssue({code:z.ZodIssueCode.custom,path:["scheduleEnd"],message:"Campaign end must be after campaign start"});
  const allowedByPlatform=new Set(value.placements.flatMap(p=>p==="facebook"?["facebook_feed","facebook_reels","facebook_stories"]:["instagram_feed","instagram_reels","instagram_stories"]));
  for(const target of value.targeting.placementTargets){if(!allowedByPlatform.has(target))ctx.addIssue({code:z.ZodIssueCode.custom,path:["targeting","placementTargets"],message:`Placement ${target} does not match selected platforms`});}
});

const SnippetSchema = z.object({
  sourceTrackId: z.string().uuid().nullable().optional(),
  sourceObjectKey: z.string().max(1000).optional().default(""),
  label: z.string().max(160).optional().default(""),
  startSeconds: z.number().min(0).max(24*60*60),
  durationSeconds: z.number().min(5).max(60),
});

const BackgroundSchema = z.object({
  objectKey: z.string().min(1).max(1000),
  libraryId: z.string().uuid().nullable().optional(),
});

const RenderBatchSchema = z.object({
  snippetIds: z.array(z.string().uuid()).min(1).max(3),
  backgroundVideoIds: z.array(z.string().uuid()).min(1).max(5),
  libraryId: z.string().uuid().nullable().optional(),
});

const MetaPublishPreflightSchema = z.object({
  dsaBeneficiary: z.string().max(255).optional().default(""),
  dsaPayor: z.string().max(255).optional().default(""),
});
const MetaPublishSchema = z.object({
  fingerprint: z.string().length(64),
  mode: z.enum(["active","paused"]).default("active"),
  activateSmartLink: z.boolean().optional().default(false),
  dsaBeneficiary: z.string().max(255).optional().default(""),
  dsaPayor: z.string().max(255).optional().default(""),
  confirmationText: z.string().max(80).optional().default(""),
  acknowledgements: z.object({
    settingsCorrect: z.literal(true),
    rightsConfirmed: z.literal(true),
    metaBilling: z.literal(true),
    spendAuthorized: z.literal(true),
  }),
});

function safeSlug(value) {
  return String(value || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}
function webBase() { return String(process.env.PROMOTION_WEB_BASE_URL || process.env.WEB_BASE_URL || "http://127.0.0.1:5173").replace(/\/+$/, ""); }
function apiBase(req) {
  const configured = String(process.env.PROMOTION_API_PUBLIC_BASE_URL || "").replace(/\/+$/, "");
  if (configured) return configured;
  const proto = String(req.get("x-forwarded-proto") || req.protocol || "http").split(",")[0].trim();
  const host = req.get("x-forwarded-host") || req.get("host");
  return `${proto}://${host}`;
}
function isPublicHttpUrl(url) { try { const u=new URL(url); return u.protocol === "https:" && !["localhost","127.0.0.1","0.0.0.0"].includes(u.hostname); } catch { return false; } }
function landingUrl(slug) { return `${webBase()}/p/${encodeURIComponent(slug)}`; }
function mapCampaign(row, destinations = []) {
  return {
    id: String(row.id), sourceReleaseId: row.source_release_id ? String(row.source_release_id) : null,
    kind: row.kind, status: row.status, slug: row.slug, title: row.title, artistName: row.artist_name,
    description: row.description, genre: row.genre, releaseDate: row.release_date, hasArtwork: !!row.artwork_object_key,
    headline: row.headline, ctaLabel: row.cta_label, accentColor: row.accent_color, seoQuery: row.seo_query,
    seoSnapshot: row.seo_snapshot || {}, metadata: row.metadata || {}, createdAt: row.created_at, updatedAt: row.updated_at,
    publicUrl: landingUrl(row.slug), destinations,
  };
}
function mapDestination(row) { return { id:String(row.id), platform:row.platform, label:row.label, url:row.url, kind:row.destination_kind, position:Number(row.position||0), enabled:!!row.enabled }; }
async function campaignOwned(id,userId) { const {rows}=await pool.query(`SELECT * FROM promotion_campaigns WHERE id=$1 AND owner_user_id=$2 LIMIT 1`,[id,userId]); return rows[0]||null; }
async function campaignPublic(slug) { const {rows}=await pool.query(`SELECT * FROM promotion_campaigns WHERE slug=$1 AND status='active' LIMIT 1`,[slug]); return rows[0]||null; }
async function campaignDestinations(id, onlyEnabled=false) { const {rows}=await pool.query(`SELECT * FROM promotion_destinations WHERE campaign_id=$1 ${onlyEnabled?"AND enabled=true":""} ORDER BY position ASC, created_at ASC`,[id]); return rows.map(mapDestination); }
async function uniqueSlug(base, excludeId=null) {
  const stem=safeSlug(base)||`campaign-${crypto.randomBytes(3).toString("hex")}`; let candidate=stem;
  for(let i=0;i<30;i++){ const {rows}=await pool.query(`SELECT id FROM promotion_campaigns WHERE slug=$1 ${excludeId?"AND id<>$2":""} LIMIT 1`,excludeId?[candidate,excludeId]:[candidate]); if(!rows[0]) return candidate; candidate=`${stem}-${i+2}`.slice(0,96); }
  return `${stem}-${crypto.randomBytes(3).toString("hex")}`.slice(0,96);
}
async function replaceDestinations(client,campaignId,destinations){ await client.query(`DELETE FROM promotion_destinations WHERE campaign_id=$1`,[campaignId]); for(let i=0;i<destinations.length;i++){ const d=destinations[i]; await client.query(`INSERT INTO promotion_destinations(id,campaign_id,platform,label,url,destination_kind,position,enabled) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[crypto.randomUUID(),campaignId,d.platform,d.label,d.url,d.kind,i,d.enabled]); } }
async function releaseSeed(userId, releaseId){
  if(!releaseId) return null;
  const {rows}=await pool.query(`SELECT r.*, COALESCE(json_agg(json_build_object('id',t.id,'title',t.title,'genre',t.genre,'tags',t.tags,'explicit',t.explicit,'isrc',t.isrc,'trackNumber',t.track_number,'durationSeconds',t.duration_seconds,'audioObjectKey',t.audio_object_key) ORDER BY t.track_number) FILTER (WHERE t.id IS NOT NULL),'[]'::json) AS tracks FROM world_releases r LEFT JOIN world_tracks t ON t.release_id=r.id AND t.owner_user_id=$2 WHERE r.id=$1 AND r.owner_user_id=$2 GROUP BY r.id`,[releaseId,userId]);
  return rows[0]||null;
}
async function recordEvent(campaignId,eventType,req,{destinationId=null,visitorId="",metadata={}}={}){
  await pool.query(`INSERT INTO promotion_events(campaign_id,destination_id,event_type,visitor_id,referrer,user_agent,metadata) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`,[campaignId,destinationId,eventType,String(visitorId||"").slice(0,160),String(req.get("referer")||"").slice(0,1000),String(req.get("user-agent")||"").slice(0,1000),JSON.stringify(metadata||{})]);
}
async function analyticsFor(campaignId){
  const counts=await pool.query(`SELECT event_type,count(*)::int AS count,count(DISTINCT NULLIF(visitor_id,''))::int AS visitors FROM promotion_events WHERE campaign_id=$1 GROUP BY event_type`,[campaignId]);
  const fans=await pool.query(`SELECT count(*)::int AS count FROM promotion_fans WHERE campaign_id=$1`,[campaignId]);
  const destinations=await pool.query(`SELECT d.id,d.label,d.platform,count(e.id)::int AS clicks,count(DISTINCT NULLIF(e.visitor_id,''))::int AS visitors FROM promotion_destinations d LEFT JOIN promotion_events e ON e.destination_id=d.id AND e.event_type='click' WHERE d.campaign_id=$1 GROUP BY d.id,d.label,d.platform ORDER BY d.position`,[campaignId]);
  const daily=await pool.query(`SELECT to_char(date_trunc('day',created_at),'YYYY-MM-DD') AS day,event_type,count(*)::int AS count FROM promotion_events WHERE campaign_id=$1 AND created_at >= now()-interval '30 days' GROUP BY 1,2 ORDER BY 1`,[campaignId]);
  const byType=Object.fromEntries(counts.rows.map(r=>[r.event_type,{count:Number(r.count||0),visitors:Number(r.visitors||0)}]));
  const views=byType.view?.count||0, clicks=byType.click?.count||0, emailCaptures=Number(fans.rows[0]?.count||0), conversions=byType.conversion?.count||0;
  return { totals:{views,clicks,emailCaptures,conversions,uniqueVisitors:byType.view?.visitors||0,clickRate:views?clicks/views:0,emailRate:views?emailCaptures/views:0,conversionRate:views?conversions/views:0}, byType, destinations:destinations.rows.map(r=>({id:String(r.id),label:r.label,platform:r.platform,clicks:Number(r.clicks||0),visitors:Number(r.visitors||0)})), daily:daily.rows.map(r=>({day:r.day,eventType:r.event_type,count:Number(r.count||0)})) };
}

function safeRatio(a,b){const x=Number(a||0),y=Number(b||0);return y>0?x/y:0;}
function utcDateString(value){const d=value?new Date(value):new Date();return Number.isFinite(d.getTime())?d.toISOString().slice(0,10):new Date().toISOString().slice(0,10);}
function analyticsRange(ad,query={}){
  const until=/^\d{4}-\d{2}-\d{2}$/.test(String(query.until||''))?String(query.until):utcDateString(new Date());
  const published=ad.meta_published_at?new Date(ad.meta_published_at):null;
  const defaultSince=published&&Number.isFinite(published.getTime())?published:new Date(Date.now()-29*86400000);
  const since=/^\d{4}-\d{2}-\d{2}$/.test(String(query.since||''))?String(query.since):utcDateString(defaultSince);
  return since<=until?{since,until}:{since:until,until};
}
async function ysongPaidAttribution(ad,since,until){
  const params=[ad.campaign_id,String(ad.id),since,until];
  const where=`campaign_id=$1 AND metadata->>'adCampaignId'=$2 AND created_at >= $3::date AND created_at < ($4::date + interval '1 day')`;
  const whereE=`e.campaign_id=$1 AND e.metadata->>'adCampaignId'=$2 AND e.created_at >= $3::date AND e.created_at < ($4::date + interval '1 day')`;
  const [counts,daily,byCreative,destinations,creativeRows]=await Promise.all([
    pool.query(`SELECT event_type,count(*)::int AS count,count(DISTINCT NULLIF(visitor_id,''))::int AS visitors FROM promotion_events WHERE ${where} GROUP BY event_type`,params),
    pool.query(`SELECT to_char(date_trunc('day',created_at),'YYYY-MM-DD') AS day,event_type,count(*)::int AS count,count(DISTINCT NULLIF(visitor_id,''))::int AS visitors FROM promotion_events WHERE ${where} GROUP BY 1,2 ORDER BY 1`,params),
    pool.query(`SELECT COALESCE(NULLIF(metadata->>'creativeId',''),'unknown') AS creative_id,event_type,count(*)::int AS count,count(DISTINCT NULLIF(visitor_id,''))::int AS visitors FROM promotion_events WHERE ${where} GROUP BY 1,2 ORDER BY 1,2`,params),
    pool.query(`SELECT d.id,d.label,d.platform,COALESCE(NULLIF(e.metadata->>'creativeId',''),'unknown') AS creative_id,count(e.id)::int AS clicks,count(DISTINCT NULLIF(e.visitor_id,''))::int AS visitors FROM promotion_events e JOIN promotion_destinations d ON d.id=e.destination_id WHERE ${whereE} AND e.event_type='click' GROUP BY d.id,d.label,d.platform,4 ORDER BY clicks DESC,d.label`,params),
    pool.query(`SELECT c.id,c.audio_snippet_id,c.background_video_id,c.meta_ad_ids,c.duration_seconds,c.metadata,s.label AS snippet_label,s.start_seconds,s.duration_seconds AS snippet_duration,b.original_name AS background_name,b.metadata AS background_metadata FROM promotion_ad_creatives c JOIN promotion_audio_snippets s ON s.id=c.audio_snippet_id JOIN promotion_background_videos b ON b.id=c.background_video_id WHERE c.ad_campaign_id=$1 ORDER BY c.created_at ASC`,[ad.id])
  ]);
  const byType=Object.fromEntries(counts.rows.map(r=>[r.event_type,{count:Number(r.count||0),visitors:Number(r.visitors||0)}]));
  const creativeMap=new Map();
  for(const r of byCreative.rows){const id=String(r.creative_id);if(!creativeMap.has(id))creativeMap.set(id,{creativeId:id,byType:{},views:0,clicks:0,emailCaptures:0,conversions:0,uniqueVisitors:0});const item=creativeMap.get(id);const stat={count:Number(r.count||0),visitors:Number(r.visitors||0)};item.byType[r.event_type]=stat;if(r.event_type==='view'){item.views=stat.count;item.uniqueVisitors=stat.visitors;}if(r.event_type==='click')item.clicks=stat.count;if(r.event_type==='email_capture')item.emailCaptures=stat.count;if(r.event_type==='conversion')item.conversions=stat.count;}
  const destByCreative=new Map();
  const destinationTotals=new Map();
  for(const r of destinations.rows){const row={id:String(r.id),label:r.label,platform:r.platform,creativeId:String(r.creative_id),clicks:Number(r.clicks||0),visitors:Number(r.visitors||0)};if(!destByCreative.has(row.creativeId))destByCreative.set(row.creativeId,[]);destByCreative.get(row.creativeId).push(row);const key=String(r.id);const total=destinationTotals.get(key)||{id:key,label:r.label,platform:r.platform,clicks:0,visitors:0};total.clicks+=row.clicks;total.visitors+=row.visitors;destinationTotals.set(key,total);}
  const creatives=creativeRows.rows.map(r=>({id:String(r.id),audioSnippetId:String(r.audio_snippet_id),backgroundVideoId:String(r.background_video_id),metaAdIds:Array.isArray(r.meta_ad_ids)?r.meta_ad_ids:[],durationSeconds:Number(r.duration_seconds||0),snippetLabel:r.snippet_label||'',snippetStartSeconds:Number(r.start_seconds||0),snippetDurationSeconds:Number(r.snippet_duration||0),backgroundName:r.background_name||'',backgroundMetadata:r.background_metadata||{},renderMetadata:r.metadata||{},ysong:{...(creativeMap.get(String(r.id))||{creativeId:String(r.id),byType:{},views:0,clicks:0,emailCaptures:0,conversions:0,uniqueVisitors:0}),destinations:destByCreative.get(String(r.id))||[]}}));
  return {totals:{views:byType.view?.count||0,uniqueVisitors:byType.view?.visitors||0,clicks:byType.click?.count||0,emailCaptures:byType.email_capture?.count||0,conversions:byType.conversion?.count||0},byType,daily:daily.rows.map(r=>({day:r.day,eventType:r.event_type,count:Number(r.count||0),visitors:Number(r.visitors||0)})),destinations:[...destinationTotals.values()].sort((a,b)=>b.clicks-a.clicks),creatives};
}
function mergePaidAnalytics(meta,ysong,currency){
  const spend=Number(meta?.summary?.spend||0),smartViews=Number(ysong?.totals?.views||0),platformClicks=Number(ysong?.totals?.clicks||0);
  const remoteAdToCreative=new Map();
  for(const c of ysong.creatives||[])for(const item of c.metaAdIds||[]){const id=String(item?.adId||item?.id||'');if(id)remoteAdToCreative.set(id,c.id);}
  const metaByCreative=new Map();
  for(const row of meta?.ads||[]){const creativeId=remoteAdToCreative.get(String(row.adId||''));if(!creativeId)continue;const prev=metaByCreative.get(creativeId)||{impressions:0,reach:0,clicks:0,linkClicks:0,outboundClicks:0,landingPageViews:0,spend:0,videoPlays:0,thruPlays:0,video25:0,video50:0,video75:0,video100:0};for(const key of Object.keys(prev))prev[key]+=Number(row[key]||0);metaByCreative.set(creativeId,prev);}
  const creatives=(ysong.creatives||[]).map(c=>{const m=metaByCreative.get(c.id)||{};const y=c.ysong||{};return {...c,meta:m,derived:{smartLinkEngagement:safeRatio(y.clicks,y.views),metaToSmartLinkRate:safeRatio(y.views,m.outboundClicks||m.linkClicks||0),costPerSmartLinkVisit:safeRatio(m.spend,y.views),costPerPlatformClick:safeRatio(m.spend,y.clicks),costPerEmailCapture:safeRatio(m.spend,y.emailCaptures)}};});
  const destinations=(ysong.destinations||[]).map(d=>({...d,costPerClick:safeRatio(spend,d.clicks),shareOfPlatformClicks:safeRatio(d.clicks,platformClicks)}));
  const bestCreative=[...creatives].filter(c=>Number(c.ysong?.views||0)>0).sort((a,b)=>Number(b.ysong?.clicks||0)-Number(a.ysong?.clicks||0)||(Number.isFinite(Number(a.derived.costPerPlatformClick))?Number(a.derived.costPerPlatformClick):Infinity)-(Number.isFinite(Number(b.derived.costPerPlatformClick))?Number(b.derived.costPerPlatformClick):Infinity))[0]||null;
  const bestDestination=[...destinations].sort((a,b)=>b.clicks-a.clicks)[0]||null;
  const bestPlacement=[...(meta?.placements||[])].sort((a,b)=>Number(b.outboundClicks||b.linkClicks||0)-Number(a.outboundClicks||a.linkClicks||0))[0]||null;
  const bestCountry=[...(meta?.countries||[])].sort((a,b)=>Number(b.outboundClicks||b.linkClicks||0)-Number(a.outboundClicks||a.linkClicks||0))[0]||null;
  return {currency,spend,costPerSmartLinkVisit:safeRatio(spend,smartViews),costPerPlatformClick:safeRatio(spend,platformClicks),smartLinkEngagement:safeRatio(platformClicks,smartViews),metaToSmartLinkRate:safeRatio(smartViews,Number(meta?.summary?.outboundClicks||meta?.summary?.linkClicks||0)),destinations,creatives,bestCreative,bestDestination,bestPlacement,bestCountry};
}
function oauthCallbackHtml(ok,message){ const origin=webBase(); const payload=JSON.stringify({type:"ysong-meta-oauth",ok,message}).replace(/</g,"\\u003c"); const fallback=`${origin}/app`; return `<!doctype html><meta charset="utf-8"><title>YSong · Meta connection</title><style>body{font-family:system-ui;background:#09090b;color:#fafafa;display:grid;place-items:center;min-height:100vh;margin:0}.c{max-width:560px;padding:32px;border:1px solid #27272a;border-radius:20px;background:#18181b}a{color:#a78bfa}</style><div class="c"><h1>${ok?"Meta connected":"Meta connection failed"}</h1><p>${String(message).replace(/[<>&]/g,s=>({"<":"&lt;",">":"&gt;","&":"&amp;"}[s]))}</p><p><a href="${fallback}">Return to YSong</a></p></div><script>try{if(window.opener){window.opener.postMessage(${payload},${JSON.stringify(origin)});window.close();}}catch(e){}</script>`; }

function mapAdCampaign(row) {
  return {
    id:String(row.id), campaignId:String(row.campaign_id), sourceTrackId:row.source_track_id?String(row.source_track_id):null,
    name:row.name, goal:row.goal, status:row.status, genre:row.genre, genreSource:row.genre_source,
    dailyBudgetMinor:Number(row.daily_budget_minor||0), currency:row.currency, scheduleStart:row.schedule_start, scheduleEnd:row.schedule_end, timezone:row.timezone,
    placements:row.placements||[], targeting:row.targeting||{}, adText:row.ad_text, adHeadline:row.ad_headline, language:row.language,
    coverArtObjectKey:row.cover_art_object_key||"", metaConnectionId:row.meta_connection_id?String(row.meta_connection_id):null,
    metaAdAccountId:row.meta_ad_account_id, metaPixelId:row.meta_pixel_id, dsaBeneficiary:row.dsa_beneficiary||"", dsaPayor:row.dsa_payor||"",
    metaCampaignId:row.meta_campaign_id, metaAdSetId:row.meta_adset_id, metaStatus:row.meta_status, metaPublishedAt:row.meta_published_at||null,
    metaPublishFingerprint:row.meta_publish_fingerprint||"", metaLastError:row.meta_last_error||{}, metadata:row.metadata||{}, createdAt:row.created_at, updatedAt:row.updated_at,
  };
}
function mapSnippet(row) { return { id:String(row.id), adCampaignId:String(row.ad_campaign_id), sourceTrackId:row.source_track_id?String(row.source_track_id):null, sourceObjectKey:row.source_object_key, label:row.label, startSeconds:Number(row.start_seconds||0), durationSeconds:Number(row.duration_seconds||0), createdAt:row.created_at }; }
function mapBackground(row) { return { id:String(row.id), libraryId:row.library_id?String(row.library_id):null, objectKey:row.object_key, originalName:row.original_name, durationSeconds:row.duration_seconds==null?null:Number(row.duration_seconds), width:row.width==null?null:Number(row.width), height:row.height==null?null:Number(row.height), metadata:row.metadata||{}, createdAt:row.created_at }; }
function mapCreative(row) { return { id:String(row.id), adCampaignId:String(row.ad_campaign_id), libraryId:row.library_id?String(row.library_id):null, audioSnippetId:String(row.audio_snippet_id), backgroundVideoId:String(row.background_video_id), status:row.status, selected:!!row.selected, objectKey916:row.object_key_916, objectKey43:row.object_key_43, durationSeconds:row.duration_seconds==null?null:Number(row.duration_seconds), renderError:row.render_error, metaVideoId916:row.meta_video_id_916, metaVideoId43:row.meta_video_id_43, metaAdIds:row.meta_ad_ids||[], metadata:row.metadata||{}, createdAt:row.created_at, updatedAt:row.updated_at }; }
async function adCampaignOwned(id,userId){ const {rows}=await pool.query(`SELECT * FROM promotion_ad_campaigns WHERE id=$1 AND owner_user_id=$2 LIMIT 1`,[id,userId]); return rows[0]||null; }
async function loadPaidAnalyticsEnvelope(ad,userId,query={}){
  const range=analyticsRange(ad,query||{}); const ysong=await ysongPaidAttribution(ad,range.since,range.until);
  let meta={summary:{},daily:[],adSets:[],ads:[],placements:[],countries:[],warnings:[]}; let capturedAt=null; let stale=false; const warnings=[];
  if(ad.meta_campaign_id){
    const latest=(await pool.query(`SELECT snapshot,captured_at FROM promotion_meta_insights WHERE ad_campaign_id=$1 AND level='bundle' ORDER BY captured_at DESC LIMIT 1`,[ad.id])).rows[0]||null;
    const latestRange=latest?.snapshot?.range||{}; const sameRange=latest&&latestRange.since===range.since&&latestRange.until===range.until; const ageMs=latest?Date.now()-new Date(latest.captured_at).getTime():Infinity; const force=String(query.refresh||'')==='1';
    if(!force&&sameRange&&ageMs<10*60*1000){meta=latest.snapshot.meta||meta;capturedAt=latest.captured_at;}
    else{
      try{
        meta=await fetchMetaCampaignAnalyticsBundle(userId,ad.meta_campaign_id,{since:range.since,until:range.until,connectionId:String(ad.meta_connection_id||'')}); capturedAt=new Date().toISOString();
        await pool.query(`INSERT INTO promotion_meta_insights(ad_campaign_id,level,object_id,date_start,date_stop,snapshot) VALUES($1,'bundle',$2,$3::date,$4::date,$5::jsonb)`,[ad.id,ad.meta_campaign_id,range.since,range.until,JSON.stringify({range,meta})]);
        await pool.query(`DELETE FROM promotion_meta_insights WHERE id IN (SELECT id FROM promotion_meta_insights WHERE ad_campaign_id=$1 AND level='bundle' ORDER BY captured_at DESC OFFSET 100)`,[ad.id]).catch(()=>{});
      }catch(e){
        if(sameRange){meta=latest.snapshot.meta||meta;capturedAt=latest.captured_at;stale=true;warnings.push({code:'meta_refresh_failed_using_cache',message:e?.message||'Meta Insights refresh failed; showing the last cached snapshot.'});}
        else warnings.push({code:'meta_insights_unavailable',message:e?.message||'Meta Insights are unavailable for this campaign right now.'});
      }
    }
  }else warnings.push({code:'meta_campaign_not_created',message:'This YSong ad campaign has not been created in Meta yet. Smart Link attribution will still appear when tagged traffic exists.'});
  if(Array.isArray(meta.warnings))warnings.push(...meta.warnings);
  const derived=mergePaidAnalytics(meta,ysong,ad.currency);
  return {range,capturedAt,stale,meta,ysong,derived,warnings};
}

export function registerPromotionRoutes(app,{requireAuth,objectPath,readObjectMetadata,writeObjectMetadata,assertOwnedObjectKey}) {
  const ROOT="/api/tools/promotion";
  let renderPumpRunning=false;

  async function buildMetaPaidPreflight(ad,userId,req,{dsaBeneficiary="",dsaPayor=""}={}){
    const errors=[]; const warnings=[];
    const smart=await campaignOwned(ad.campaign_id,userId);
    const destinations=smart?await campaignDestinations(smart.id,true):[];
    const allCreatives=(await pool.query(`SELECT * FROM promotion_ad_creatives WHERE ad_campaign_id=$1 AND selected=true ORDER BY created_at ASC`,[ad.id])).rows;
    const creatives=allCreatives.filter(r=>r.status==='ready');
    const connections=await listMetaConnections(userId).catch(()=>[]);
    const connection=connections.find(c=>String(c.id)===String(ad.meta_connection_id||''))||null;
    let account=null;
    if(ad.meta_connection_id&&ad.meta_ad_account_id){
      try{account=(await listMetaAdAccounts(userId,String(ad.meta_connection_id))).find(a=>String(a.id)===String(ad.meta_ad_account_id))||null;}catch(e){warnings.push({code:'meta_account_lookup_failed',message:e?.message||'Meta ad account could not be refreshed.'});}
    }
    const targeting=ad.targeting||{}; const countries=Array.isArray(targeting.countries)?targeting.countries.map(v=>String(v).toUpperCase()):[];
    const placementTargets=Array.isArray(targeting.placementTargets)?targeting.placementTargets:[];
    const needsInstagram=placementTargets.some(v=>String(v).startsWith('instagram_'));
    const needsFeed=placementTargets.some(v=>['facebook_feed','instagram_feed'].includes(String(v)));
    const needsVertical=placementTargets.some(v=>['facebook_reels','facebook_stories','instagram_reels','instagram_stories'].includes(String(v)));
    const needsDsa=countries.some(c=>META_DSA_COUNTRIES.includes(c));
    const effectiveDsaBeneficiary=String(dsaBeneficiary||ad.dsa_beneficiary||account?.defaultDsaBeneficiary||'').trim();
    const effectiveDsaPayor=String(dsaPayor||ad.dsa_payor||account?.defaultDsaPayor||'').trim();
    const requiresSmartLinkActivation=smart?.status==='draft';
    if(!metaConfigured())errors.push({code:'meta_not_configured',message:'Meta Marketing API credentials are not configured on the server.'});
    if(!isPublicHttpUrl(webBase()))errors.push({code:'public_smart_link_required',message:'Paid Meta ads require a public HTTPS YSong Smart Link URL.'});
    if(!smart)errors.push({code:'smart_link_missing',message:'The linked YSong Smart Link campaign no longer exists.'});
    else if(smart.status==='archived')errors.push({code:'smart_link_archived',message:'The Smart Link is archived and cannot receive paid traffic.'});
    else if(requiresSmartLinkActivation)warnings.push({code:'smart_link_activation_required',message:'The Smart Link is still a draft. You must explicitly activate it when publishing.'});
    if(smart&&destinations.length<1)errors.push({code:'smart_link_destination_required',message:'Add at least one enabled destination to the Smart Link before buying traffic.'});
    if(ad.meta_campaign_id)errors.push({code:'meta_campaign_already_exists',message:'A Meta campaign already exists for this YSong ad campaign. Refresh or manage that campaign instead of publishing a duplicate.'});
    if(!ad.meta_connection_id||!connection)errors.push({code:'meta_connection_required',message:'Select a connected Facebook Page / Instagram profile.'});
    if(!ad.meta_ad_account_id)errors.push({code:'meta_ad_account_required',message:'Select a Meta Ad Account.'});
    else if(!account)errors.push({code:'meta_ad_account_unavailable',message:'The selected Meta Ad Account is not available through this connection.'});
    else if(Number(account.accountStatus)!==1)errors.push({code:'meta_ad_account_inactive',message:`The selected Meta Ad Account is not active (status ${account.accountStatus}).`});
    if(account?.currency&&ad.currency&&String(account.currency).toUpperCase()!==String(ad.currency).toUpperCase())errors.push({code:'meta_currency_mismatch',message:`Draft budget currency is ${ad.currency}, but the Meta Ad Account bills in ${account.currency}. Save the campaign using the ad account currency before publishing.`});
    if(needsInstagram&&!connection?.instagramUserId)errors.push({code:'meta_instagram_required',message:'Instagram placements were selected, but this Page has no linked Instagram professional account.'});
    if(!countries.length)errors.push({code:'target_countries_required',message:'Choose at least one audience country. YSong will not silently default a paid campaign to the United States.'});
    if(!placementTargets.length)errors.push({code:'placements_required',message:'Choose at least one Facebook or Instagram placement.'});
    if(Number(ad.daily_budget_minor||0)<100)errors.push({code:'budget_too_low',message:'Daily budget must be at least 1.00 in the ad account currency.'});
    if(allCreatives.some(c=>c.status!=='ready'))errors.push({code:'selected_creatives_not_ready',message:'Every selected ad creative must finish rendering before it can be published.'});
    if(!creatives.length)errors.push({code:'selected_creative_required',message:'Select at least one rendered ad creative.'});
    for(const c of creatives){if(needsVertical&&!c.object_key_916)errors.push({code:'vertical_asset_missing',message:`Creative ${String(c.id).slice(0,8)} is missing its 9:16 render.`});if(needsFeed&&!c.object_key_43)errors.push({code:'feed_asset_missing',message:`Creative ${String(c.id).slice(0,8)} is missing its 4:3 render.`});}
    if(needsDsa&&(!effectiveDsaBeneficiary||!effectiveDsaPayor))errors.push({code:'dsa_disclosure_required',message:'This audience includes EU/EEA countries. Meta requires beneficiary and payor disclosure information for the ad set.'});
    if(!Array.isArray(targeting.interests)||!targeting.interests.length)warnings.push({code:'broad_interest_targeting',message:'No Meta interests are selected. The campaign will rely on demographics, geography, and placements only.'});
    const fpPayload={ad:{id:String(ad.id),updatedAt:new Date(ad.updated_at).toISOString(),name:ad.name,dailyBudgetMinor:Number(ad.daily_budget_minor),currency:ad.currency,scheduleStart:ad.schedule_start||null,scheduleEnd:ad.schedule_end||null,timezone:ad.timezone,targeting,adText:ad.ad_text,adHeadline:ad.ad_headline,language:ad.language,metaConnectionId:ad.meta_connection_id?String(ad.meta_connection_id):null,metaAdAccountId:ad.meta_ad_account_id,metaPixelId:ad.meta_pixel_id,dsaBeneficiary:effectiveDsaBeneficiary,dsaPayor:effectiveDsaPayor},smart:smart?{id:String(smart.id),slug:smart.slug,status:smart.status,updatedAt:new Date(smart.updated_at).toISOString()}:null,destinations:destinations.map(d=>({id:d.id,platform:d.platform,url:d.url,enabled:d.enabled})).sort((a,b)=>String(a.id).localeCompare(String(b.id))),creatives:creatives.map(c=>({id:String(c.id),objectKey916:c.object_key_916,objectKey43:c.object_key_43})).sort((a,b)=>a.id.localeCompare(b.id))};
    const fingerprint=crypto.createHash('sha256').update(JSON.stringify(fpPayload)).digest('hex');
    return {ready:errors.length===0,errors,warnings,fingerprint,requiresSmartLinkActivation,smartLink:smart?{id:String(smart.id),status:smart.status,publicUrl:landingUrl(smart.slug),slug:smart.slug,destinationCount:destinations.length}:null,account,connection,effectiveDsa:{required:needsDsa,beneficiary:effectiveDsaBeneficiary,payor:effectiveDsaPayor},summary:{selectedCreativeCount:creatives.length,countries:countries.length,placements:placementTargets.length,dailyBudgetMinor:Number(ad.daily_budget_minor||0),currency:ad.currency,estimatedMaxDailySpendMinor:Number(ad.daily_budget_minor||0)},creatives};
  }

  function paidCreativeLink(smart,ad,creativeId){
    const q=new URLSearchParams({utm_source:'meta',utm_medium:'paid_social',utm_campaign:String(smart.slug||ad.id),utm_content:String(creativeId),ysong_ad_campaign:String(ad.id),ysong_creative:String(creativeId)});
    return `${landingUrl(smart.slug)}?${q.toString()}`;
  }

  async function nextQueuedCreative(){
    const client=await pool.connect();
    try{
      await client.query("BEGIN");
      const {rows}=await client.query(`
        SELECT c.*,s.source_object_key,s.start_seconds,s.duration_seconds,b.object_key AS background_object_key
        FROM promotion_ad_creatives c
        JOIN promotion_audio_snippets s ON s.id=c.audio_snippet_id
        JOIN promotion_background_videos b ON b.id=c.background_video_id
        WHERE c.status='queued'
        ORDER BY c.created_at ASC
        FOR UPDATE OF c SKIP LOCKED
        LIMIT 1
      `);
      const row=rows[0]||null;
      if(row) await client.query(`UPDATE promotion_ad_creatives SET status='rendering',render_error='',updated_at=now() WHERE id=$1`,[row.id]);
      await client.query("COMMIT");
      return row;
    }catch(e){await client.query("ROLLBACK");throw e;}finally{client.release();}
  }

  async function pumpCreativeQueue(){
    if(renderPumpRunning) return;
    renderPumpRunning=true;
    try{
      while(true){
        const row=await nextQueuedCreative();
        if(!row) break;
        try{
          const userId=String(row.owner_user_id);
          const songKey=assertOwnedObjectKey(userId,String(row.source_object_key||""));
          const bgKey=assertOwnedObjectKey(userId,String(row.background_object_key||""));
          const result=await renderPromotionCreative({
            userId,
            adCampaignId:String(row.ad_campaign_id),
            creativeId:String(row.id),
            videoPath:objectPath(bgKey),
            audioPath:objectPath(songKey),
            audioStart:Number(row.start_seconds||0),
            duration:Number(row.duration_seconds||30),
            objectPath,
            writeObjectMetadata,
          });
          await pool.query(`UPDATE promotion_ad_creatives SET status='ready',object_key_916=$2,object_key_43=$3,duration_seconds=$4,render_error='',metadata=metadata||$5::jsonb,updated_at=now() WHERE id=$1`,[row.id,result.key916,result.key43,result.durationSeconds,JSON.stringify({renderedAt:new Date().toISOString(),requestedDurationSeconds:result.requestedDurationSeconds,clippedToAvailableAudio:result.clippedToAvailableAudio,ffmpegVersion:result.runtime?.version||""})]);
        }catch(e){
          console.error("Promotion creative render failed",row?.id,e);
          await pool.query(`UPDATE promotion_ad_creatives SET status='failed',render_error=$2,updated_at=now() WHERE id=$1`,[row.id,String(e?.message||e||"render_failed").slice(0,2000)]).catch(()=>{});
        }
      }
    }finally{renderPumpRunning=false;}
  }

  // A process restart can strand rows marked rendering. Put them back in the
  // deterministic queue and resume in the background.
  void pool.query(`UPDATE promotion_ad_creatives SET status='queued',updated_at=now() WHERE status='rendering'`).then(()=>pumpCreativeQueue()).catch(()=>{});

  app.get(`${ROOT}/health`, requireAuth, async (req,res)=>{
    const [connections, renderRuntime]=await Promise.all([
      listMetaConnections(req.user.id).catch(()=>[]),
      inspectPromotionRenderRuntime(),
    ]);
    res.json({
      ok:true,
      meta:{configured:metaConfigured(),graphVersion:META_GRAPH_VERSION,connected:connections.length>0,connections},
      render:{
        available:renderRuntime.available,
        version:renderRuntime.version,
        h264:!!renderRuntime.encoders?.h264,
        aac:!!renderRuntime.encoders?.aac,
        error:renderRuntime.error||"",
      },
      stock:{providers:stockProviderStatus()},
      public:{webBase:webBase(),apiBase:apiBase(req),productionReady:isPublicHttpUrl(webBase())&&isPublicHttpUrl(apiBase(req))}
    });
  });

  app.get(`${ROOT}/catalog`, requireAuth, async (_req,res)=>{
    res.json({
      platforms:PROMOTION_PLATFORM_CATALOG,
      countries:describeCountries(ALL_COUNTRY_CODES),
      countryTiers:{
        tier1:describeCountries(COUNTRY_TIERS.tier1),
        tier2:describeCountries(COUNTRY_TIERS.tier2),
        tier3:describeCountries(COUNTRY_TIERS.tier3),
      },
      creativeLimits:{audioSnippets:3,backgroundVideosPerBatch:5,maxGeneratedPerBatch:15,maxSnippetSeconds:60,maxBackgroundSeconds:60},
    });
  });

  app.get(`${ROOT}/ad-campaigns`, requireAuth, async (req,res)=>{
    const {rows}=await pool.query(`SELECT * FROM promotion_ad_campaigns WHERE owner_user_id=$1 ORDER BY updated_at DESC`,[req.user.id]);
    res.json({adCampaigns:rows.map(mapAdCampaign)});
  });

  app.post(`${ROOT}/ad-campaigns`, requireAuth, async (req,res)=>{
    try{
      const input=AdCampaignSchema.parse(req.body||{});
      const campaign=await campaignOwned(input.campaignId,req.user.id);
      if(!campaign) return res.status(404).json({error:"campaign_not_found"});
      let sourceTrackId=input.sourceTrackId||null;
      if(sourceTrackId){
        const {rows}=await pool.query(`SELECT id FROM world_tracks WHERE id=$1 AND owner_user_id=$2 LIMIT 1`,[sourceTrackId,req.user.id]);
        if(!rows[0]) return res.status(404).json({error:"source_track_not_found"});
      }
      let coverKey=input.coverArtObjectKey||campaign.artwork_object_key||null;
      if(coverKey) coverKey=assertOwnedObjectKey(req.user.id,coverKey);
      const id=crypto.randomUUID();
      const target={...input.targeting,platforms:input.placements};
      const {rows}=await pool.query(`INSERT INTO promotion_ad_campaigns(
        id,owner_user_id,campaign_id,source_track_id,name,goal,genre,genre_source,daily_budget_minor,currency,schedule_start,schedule_end,timezone,placements,targeting,ad_text,ad_headline,language,cover_art_object_key,meta_connection_id,meta_ad_account_id,meta_pixel_id,dsa_beneficiary,dsa_payor
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb,$16,$17,$18,$19,$20,$21,$22,$23,$24) RETURNING *`,[
        id,req.user.id,input.campaignId,sourceTrackId,input.name,input.goal,input.genre||campaign.genre||"",input.genreSource,input.dailyBudgetMinor,input.currency.toUpperCase(),
        input.scheduleStart?new Date(input.scheduleStart):null,input.scheduleEnd?new Date(input.scheduleEnd):null,input.timezone,JSON.stringify(input.placements),JSON.stringify(target),input.adText,input.adHeadline,input.language,coverKey,input.metaConnectionId||null,input.metaAdAccountId,input.metaPixelId,input.dsaBeneficiary,input.dsaPayor
      ]);
      res.status(201).json({adCampaign:mapAdCampaign(rows[0])});
    }catch(e){
      if(e instanceof z.ZodError) return res.status(400).json({error:"invalid_ad_campaign",issues:e.issues});
      if(e?.statusCode===403) return res.status(403).json({error:"forbidden"});
      console.error("promotion ad campaign create",e); res.status(500).json({error:"ad_campaign_create_failed",message:e.message});
    }
  });

  app.get(`${ROOT}/ad-campaigns/:id`, requireAuth, async (req,res)=>{
    const row=await adCampaignOwned(req.params.id,req.user.id); if(!row)return res.status(404).json({error:"ad_campaign_not_found"});
    const [snips,bgs,creativeRows]=await Promise.all([
      pool.query(`SELECT * FROM promotion_audio_snippets WHERE ad_campaign_id=$1 ORDER BY created_at ASC`,[row.id]),
      pool.query(`SELECT DISTINCT b.* FROM promotion_background_videos b JOIN promotion_ad_creatives c ON c.background_video_id=b.id WHERE c.ad_campaign_id=$1 ORDER BY b.created_at ASC`,[row.id]),
      pool.query(`SELECT * FROM promotion_ad_creatives WHERE ad_campaign_id=$1 ORDER BY created_at ASC`,[row.id]),
    ]);
    res.json({adCampaign:mapAdCampaign(row),snippets:snips.rows.map(mapSnippet),backgroundVideos:bgs.rows.map(mapBackground),creatives:creativeRows.rows.map(mapCreative)});
  });

  app.patch(`${ROOT}/ad-campaigns/:id`, requireAuth, async (req,res)=>{
    const current=await adCampaignOwned(req.params.id,req.user.id); if(!current)return res.status(404).json({error:"ad_campaign_not_found"});
    try{
      const merged={
        campaignId:String(req.body?.campaignId||current.campaign_id),
        sourceTrackId:req.body?.sourceTrackId===undefined?(current.source_track_id?String(current.source_track_id):null):req.body.sourceTrackId,
        name:req.body?.name??current.name, goal:req.body?.goal??current.goal, genre:req.body?.genre??current.genre, genreSource:req.body?.genreSource??current.genre_source,
        dailyBudgetMinor:req.body?.dailyBudgetMinor??Number(current.daily_budget_minor), currency:req.body?.currency??current.currency,
        scheduleStart:req.body?.scheduleStart===undefined?(current.schedule_start?new Date(current.schedule_start).toISOString():null):req.body.scheduleStart,
        scheduleEnd:req.body?.scheduleEnd===undefined?(current.schedule_end?new Date(current.schedule_end).toISOString():null):req.body.scheduleEnd,
        timezone:req.body?.timezone??current.timezone, placements:req.body?.placements??current.placements, targeting:req.body?.targeting??current.targeting,
        adText:req.body?.adText??current.ad_text, adHeadline:req.body?.adHeadline??current.ad_headline, language:req.body?.language??current.language,
        coverArtObjectKey:req.body?.coverArtObjectKey===undefined?(current.cover_art_object_key||null):req.body.coverArtObjectKey,
        metaConnectionId:req.body?.metaConnectionId===undefined?(current.meta_connection_id?String(current.meta_connection_id):null):req.body.metaConnectionId,
        metaAdAccountId:req.body?.metaAdAccountId??current.meta_ad_account_id, metaPixelId:req.body?.metaPixelId??current.meta_pixel_id,
        dsaBeneficiary:req.body?.dsaBeneficiary??current.dsa_beneficiary, dsaPayor:req.body?.dsaPayor??current.dsa_payor,
      };
      const input=AdCampaignSchema.parse(merged);
      const target={...input.targeting,platforms:input.placements};
      let coverKey=input.coverArtObjectKey||null; if(coverKey)coverKey=assertOwnedObjectKey(req.user.id,coverKey);
      const {rows}=await pool.query(`UPDATE promotion_ad_campaigns SET source_track_id=$3,name=$4,goal=$5,genre=$6,genre_source=$7,daily_budget_minor=$8,currency=$9,schedule_start=$10,schedule_end=$11,timezone=$12,placements=$13::jsonb,targeting=$14::jsonb,ad_text=$15,ad_headline=$16,language=$17,cover_art_object_key=$18,meta_connection_id=$19,meta_ad_account_id=$20,meta_pixel_id=$21,dsa_beneficiary=$22,dsa_payor=$23,updated_at=now() WHERE id=$1 AND owner_user_id=$2 RETURNING *`,[
        current.id,req.user.id,input.sourceTrackId||null,input.name,input.goal,input.genre,input.genreSource,input.dailyBudgetMinor,input.currency.toUpperCase(),input.scheduleStart?new Date(input.scheduleStart):null,input.scheduleEnd?new Date(input.scheduleEnd):null,input.timezone,JSON.stringify(input.placements),JSON.stringify(target),input.adText,input.adHeadline,input.language,coverKey,input.metaConnectionId||null,input.metaAdAccountId,input.metaPixelId,input.dsaBeneficiary,input.dsaPayor
      ]);
      res.json({adCampaign:mapAdCampaign(rows[0])});
    }catch(e){ if(e instanceof z.ZodError)return res.status(400).json({error:"invalid_ad_campaign",issues:e.issues}); if(e?.statusCode===403)return res.status(403).json({error:"forbidden"}); res.status(500).json({error:"ad_campaign_update_failed",message:e.message}); }
  });

  app.get(`${ROOT}/creative-libraries`, requireAuth, async (req,res)=>{
    const {rows}=await pool.query(`SELECT l.*,count(c.id)::int AS creative_count FROM promotion_creative_libraries l LEFT JOIN promotion_ad_creatives c ON c.library_id=l.id WHERE l.owner_user_id=$1 GROUP BY l.id ORDER BY l.updated_at DESC`,[req.user.id]);
    res.json({libraries:rows.map(r=>({id:String(r.id),name:r.name,creativeCount:Number(r.creative_count||0),createdAt:r.created_at,updatedAt:r.updated_at}))});
  });
  app.post(`${ROOT}/creative-libraries`, requireAuth, async (req,res)=>{
    const name=String(req.body?.name||"").trim().slice(0,160); if(!name)return res.status(400).json({error:"library_name_required"});
    const {rows}=await pool.query(`INSERT INTO promotion_creative_libraries(id,owner_user_id,name) VALUES($1,$2,$3) RETURNING *`,[crypto.randomUUID(),req.user.id,name]);
    res.status(201).json({library:{id:String(rows[0].id),name:rows[0].name,creativeCount:0,createdAt:rows[0].created_at,updatedAt:rows[0].updated_at}});
  });

  app.post(`${ROOT}/ad-campaigns/:id/snippets`, requireAuth, async (req,res)=>{
    const ad=await adCampaignOwned(req.params.id,req.user.id); if(!ad)return res.status(404).json({error:"ad_campaign_not_found"});
    try{
      const count=await pool.query(`SELECT count(*)::int AS n FROM promotion_audio_snippets WHERE ad_campaign_id=$1`,[ad.id]);
      if(Number(count.rows[0]?.n||0)>=3)return res.status(409).json({error:"snippet_limit_reached",limit:3});
      const input=SnippetSchema.parse(req.body||{});
      let sourceKey=input.sourceObjectKey; let trackId=input.sourceTrackId||ad.source_track_id||null; let trackTitle="";
      if(trackId){ const {rows}=await pool.query(`SELECT id,title,audio_object_key FROM world_tracks WHERE id=$1 AND owner_user_id=$2 LIMIT 1`,[trackId,req.user.id]); if(!rows[0])return res.status(404).json({error:"source_track_not_found"}); sourceKey=sourceKey||rows[0].audio_object_key; trackTitle=rows[0].title; }
      if(!sourceKey)return res.status(400).json({error:"source_audio_required"});
      sourceKey=assertOwnedObjectKey(req.user.id,sourceKey); const probe=await probeMedia(objectPath(sourceKey)); if(!probe.audio)return res.status(400).json({error:"audio_stream_required"});
      const total=Number(probe.audio.duration||probe.duration||0); if(total>0&&input.startSeconds+input.durationSeconds>total+0.05)return res.status(400).json({error:"snippet_out_of_range",durationSeconds:total});
      const {rows}=await pool.query(`INSERT INTO promotion_audio_snippets(id,ad_campaign_id,source_track_id,source_object_key,label,start_seconds,duration_seconds) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,[crypto.randomUUID(),ad.id,trackId,sourceKey,input.label||trackTitle||`Clip ${Number(count.rows[0]?.n||0)+1}`,input.startSeconds,input.durationSeconds]);
      res.status(201).json({snippet:mapSnippet(rows[0]),sourceDurationSeconds:total||null});
    }catch(e){if(e instanceof z.ZodError)return res.status(400).json({error:"invalid_snippet",issues:e.issues}); if(e?.statusCode===403)return res.status(403).json({error:"forbidden"}); console.error("promotion snippet",e);res.status(500).json({error:"snippet_create_failed",message:e.message});}
  });
  app.delete(`${ROOT}/ad-campaigns/:id/snippets/:snippetId`, requireAuth, async (req,res)=>{
    const ad=await adCampaignOwned(req.params.id,req.user.id);if(!ad)return res.status(404).json({error:"ad_campaign_not_found"});
    const result=await pool.query(`DELETE FROM promotion_audio_snippets WHERE id=$1 AND ad_campaign_id=$2`,[req.params.snippetId,ad.id]); if(!result.rowCount)return res.status(404).json({error:"snippet_not_found"});res.json({ok:true});
  });

  app.post(`${ROOT}/background-videos`, requireAuth, async (req,res)=>{
    try{
      const input=BackgroundSchema.parse(req.body||{}); const key=assertOwnedObjectKey(req.user.id,input.objectKey); const meta=await readObjectMetadata(key); const probe=await probeMedia(objectPath(key));
      if(!probe.video)return res.status(400).json({error:"video_stream_required"});
      const duration=Number(probe.video.duration||probe.duration||0); if(duration>60.25)return res.status(400).json({error:"background_video_too_long",limitSeconds:60,durationSeconds:duration});
      if(input.libraryId){const own=await pool.query(`SELECT id FROM promotion_creative_libraries WHERE id=$1 AND owner_user_id=$2`,[input.libraryId,req.user.id]);if(!own.rows[0])return res.status(404).json({error:"library_not_found"});}
      const {rows}=await pool.query(`INSERT INTO promotion_background_videos(id,owner_user_id,library_id,object_key,original_name,duration_seconds,width,height,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) RETURNING *`,[crypto.randomUUID(),req.user.id,input.libraryId||null,key,String(meta.originalName||path.basename(key)).slice(0,240),duration||null,probe.video.width||null,probe.video.height||null,JSON.stringify({source:"upload"})]);
      res.status(201).json({backgroundVideo:mapBackground(rows[0])});
    }catch(e){if(e instanceof z.ZodError)return res.status(400).json({error:"invalid_background",issues:e.issues});if(e?.statusCode===403)return res.status(403).json({error:"forbidden"});console.error("promotion background",e);res.status(500).json({error:"background_register_failed",message:e.message});}
  });
  app.get(`${ROOT}/background-videos`, requireAuth, async (req,res)=>{
    const {rows}=await pool.query(`SELECT * FROM promotion_background_videos WHERE owner_user_id=$1 ORDER BY created_at DESC LIMIT 500`,[req.user.id]);res.json({backgroundVideos:rows.map(mapBackground)});
  });

  app.post(`${ROOT}/ad-campaigns/:id/render`, requireAuth, async (req,res)=>{
    const ad=await adCampaignOwned(req.params.id,req.user.id);if(!ad)return res.status(404).json({error:"ad_campaign_not_found"});
    try{
      const input=RenderBatchSchema.parse(req.body||{}); if(input.snippetIds.length*input.backgroundVideoIds.length>15)return res.status(400).json({error:"render_batch_too_large",limit:15});
      const snips=await pool.query(`SELECT id FROM promotion_audio_snippets WHERE ad_campaign_id=$1 AND id=ANY($2::uuid[])`,[ad.id,input.snippetIds]);if(snips.rows.length!==new Set(input.snippetIds).size)return res.status(400).json({error:"invalid_snippet_selection"});
      const bgs=await pool.query(`SELECT id FROM promotion_background_videos WHERE owner_user_id=$1 AND id=ANY($2::uuid[])`,[req.user.id,input.backgroundVideoIds]);if(bgs.rows.length!==new Set(input.backgroundVideoIds).size)return res.status(400).json({error:"invalid_background_selection"});
      if(input.libraryId){const own=await pool.query(`SELECT id FROM promotion_creative_libraries WHERE id=$1 AND owner_user_id=$2`,[input.libraryId,req.user.id]);if(!own.rows[0])return res.status(404).json({error:"library_not_found"});}
      const ids=[];
      for(const snippetId of [...new Set(input.snippetIds)]) for(const backgroundId of [...new Set(input.backgroundVideoIds)]){
        const id=crypto.randomUUID();
        const {rows}=await pool.query(`INSERT INTO promotion_ad_creatives(id,owner_user_id,ad_campaign_id,library_id,audio_snippet_id,background_video_id,status,selected) VALUES($1,$2,$3,$4,$5,$6,'queued',true)
          ON CONFLICT(ad_campaign_id,audio_snippet_id,background_video_id) DO UPDATE SET library_id=COALESCE(EXCLUDED.library_id,promotion_ad_creatives.library_id),selected=true,status=CASE WHEN promotion_ad_creatives.status='failed' THEN 'queued' ELSE promotion_ad_creatives.status END,render_error=CASE WHEN promotion_ad_creatives.status='failed' THEN '' ELSE promotion_ad_creatives.render_error END,updated_at=now() RETURNING *`,[id,req.user.id,ad.id,input.libraryId||null,snippetId,backgroundId]);
        ids.push(String(rows[0].id));
      }
      await pool.query(`UPDATE promotion_ad_campaigns SET status='rendering',updated_at=now() WHERE id=$1`,[ad.id]);
      void pumpCreativeQueue();
      const {rows}=await pool.query(`SELECT * FROM promotion_ad_creatives WHERE id=ANY($1::uuid[]) ORDER BY created_at ASC`,[ids]);
      res.status(202).json({queued:rows.map(mapCreative)});
    }catch(e){if(e instanceof z.ZodError)return res.status(400).json({error:"invalid_render_batch",issues:e.issues});console.error("promotion render queue",e);res.status(500).json({error:"render_queue_failed",message:e.message});}
  });

  app.get(`${ROOT}/ad-campaigns/:id/creatives`, requireAuth, async (req,res)=>{
    const ad=await adCampaignOwned(req.params.id,req.user.id);if(!ad)return res.status(404).json({error:"ad_campaign_not_found"});
    const {rows}=await pool.query(`SELECT * FROM promotion_ad_creatives WHERE ad_campaign_id=$1 ORDER BY created_at ASC`,[ad.id]);
    const creatives=rows.map(mapCreative); const pending=creatives.some(c=>c.status==='queued'||c.status==='rendering');
    if(!pending&&creatives.length&&creatives.every(c=>c.status==='ready'||c.status==='failed')) {
      const nextStatus=creatives.some(c=>c.status==='ready')?'ready':'failed';
      await pool.query(`UPDATE promotion_ad_campaigns SET status=$2,updated_at=now() WHERE id=$1 AND status='rendering'`,[ad.id,nextStatus]).catch(()=>{});
    }
    res.json({creatives});
  });
  app.patch(`${ROOT}/ad-campaigns/:id/creatives/:creativeId`, requireAuth, async (req,res)=>{
    const ad=await adCampaignOwned(req.params.id,req.user.id);if(!ad)return res.status(404).json({error:"ad_campaign_not_found"});
    const selected=req.body?.selected; const libraryId=req.body?.libraryId;
    if(selected===undefined&&libraryId===undefined)return res.status(400).json({error:"nothing_to_update"});
    if(libraryId){const own=await pool.query(`SELECT id FROM promotion_creative_libraries WHERE id=$1 AND owner_user_id=$2`,[libraryId,req.user.id]);if(!own.rows[0])return res.status(404).json({error:"library_not_found"});}
    const {rows}=await pool.query(`UPDATE promotion_ad_creatives SET selected=COALESCE($4,selected),library_id=CASE WHEN $5::boolean THEN $3::uuid ELSE library_id END,updated_at=now() WHERE id=$1 AND ad_campaign_id=$2 RETURNING *`,[req.params.creativeId,ad.id,libraryId||null,typeof selected==='boolean'?selected:null,libraryId!==undefined]);
    if(!rows[0])return res.status(404).json({error:"creative_not_found"});res.json({creative:mapCreative(rows[0])});
  });
  app.post(`${ROOT}/ad-campaigns/:id/creatives/:creativeId/retry`, requireAuth, async (req,res)=>{
    const ad=await adCampaignOwned(req.params.id,req.user.id);if(!ad)return res.status(404).json({error:"ad_campaign_not_found"});
    const {rows}=await pool.query(`UPDATE promotion_ad_creatives SET status='queued',render_error='',updated_at=now() WHERE id=$1 AND ad_campaign_id=$2 AND status='failed' RETURNING *`,[req.params.creativeId,ad.id]);if(!rows[0])return res.status(409).json({error:"creative_not_retryable"});
    await pool.query(`UPDATE promotion_ad_campaigns SET status='rendering',updated_at=now() WHERE id=$1`,[ad.id]);void pumpCreativeQueue();res.status(202).json({creative:mapCreative(rows[0])});
  });

  app.get(`${ROOT}/stock/videos`, requireAuth, async (req,res)=>{
    try{
      const provider=String(req.query.provider||"pexels");
      const query=String(req.query.q||"").trim();
      const orientation=String(req.query.orientation||"portrait");
      const page=Math.max(1,Number(req.query.page||1));
      const perPage=Math.max(1,Math.min(80,Number(req.query.perPage||30)));
      const locale=String(req.query.locale||"en-US");
      res.json(await searchStockVideos({provider,query,orientation,page,perPage,locale}));
    }catch(e){
      const status=e?.message==="pexels_not_configured"?503:(Number(e?.statusCode)||502);
      res.status(status).json({error:e?.message||"stock_video_search_failed"});
    }
  });

  app.post(`${ROOT}/stock/videos/import`, requireAuth, async (req,res)=>{
    let key="";
    try{
      const provider=String(req.body?.provider||"pexels");
      const id=String(req.body?.id||"");
      const fileId=String(req.body?.fileId||"");
      const libraryId=req.body?.libraryId?String(req.body.libraryId):null;
      if(libraryId){const own=await pool.query(`SELECT id FROM promotion_creative_libraries WHERE id=$1 AND owner_user_id=$2`,[libraryId,req.user.id]);if(!own.rows[0])return res.status(404).json({error:"library_not_found"});}
      const resolved=await resolveStockVideoForImport({provider,id,fileId});
      const safeProvider=provider.replace(/[^a-z0-9_-]/gi,"_").slice(0,32)||"stock";
      const safeId=String(resolved.video.id).replace(/[^a-zA-Z0-9_-]/g,"_").slice(0,80)||crypto.randomUUID();
      key=`user-uploads/${req.user.id}/${Date.now()}-${safeProvider}-${safeId}.mp4`;
      const destination=objectPath(key);
      const downloaded=await downloadStockFile(resolved.downloadUrl,destination);
      const originalName=`${safeProvider}-${safeId}.mp4`;
      const probe=await probeMedia(destination);
      if(!probe.video) throw new Error("video_stream_required");
      const duration=Number(probe.video.duration||probe.duration||resolved.video.durationSeconds||0);
      if(duration>60.25) throw new Error("background_video_too_long");
      await writeObjectMetadata(key,{userId:String(req.user.id),originalName,contentType:downloaded.contentType||"video/mp4",size:downloaded.bytes,createdAt:new Date().toISOString(),source:"stock",stockProvider:provider,stockId:resolved.video.id,stockPageUrl:resolved.video.pageUrl,contributor:resolved.video.contributor});
      const metadata={source:"stock",provider,stockId:resolved.video.id,pageUrl:resolved.video.pageUrl,previewImage:resolved.video.previewImage,contributor:resolved.video.contributor,selectedFile:resolved.selectedFile,attribution:{label:"Videos provided by Pexels",url:"https://www.pexels.com/"}};
      const {rows}=await pool.query(`INSERT INTO promotion_background_videos(id,owner_user_id,library_id,object_key,original_name,duration_seconds,width,height,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) RETURNING *`,[crypto.randomUUID(),req.user.id,libraryId,key,originalName,duration||null,probe.video.width||resolved.selectedFile.width||null,probe.video.height||resolved.selectedFile.height||null,JSON.stringify(metadata)]);
      res.status(201).json({backgroundVideo:mapBackground(rows[0])});
    }catch(e){
      if(key){await fs.promises.unlink(objectPath(key)).catch(()=>{});}
      const status=e?.message==="pexels_not_configured"?503:(e?.message==="stock_video_too_large"?413:502);
      console.error("promotion stock import",e);
      res.status(status).json({error:e?.message||"stock_video_import_failed"});
    }
  });

  app.get(`${ROOT}/meta/ad-accounts`, requireAuth, async (req,res)=>{try{const connectionId=String(req.query.connectionId||"");res.json({adAccounts:await listMetaAdAccounts(req.user.id,connectionId)});}catch(e){res.status(502).json({error:e.message||"meta_ad_accounts_failed",meta:e.meta||undefined});}});
  app.get(`${ROOT}/meta/pixels`, requireAuth, async (req,res)=>{try{const adAccountId=String(req.query.adAccountId||"");const connectionId=String(req.query.connectionId||"");if(!adAccountId)return res.status(400).json({error:"ad_account_required"});res.json({pixels:await listMetaPixels(req.user.id,adAccountId,connectionId)});}catch(e){res.status(502).json({error:e.message||"meta_pixels_failed",meta:e.meta||undefined});}});
  app.get(`${ROOT}/meta/interests`, requireAuth, async (req,res)=>{try{const q=String(req.query.q||"").trim();const connectionId=String(req.query.connectionId||"");if(q.length<2)return res.json({interests:[]});res.json({interests:await searchMetaInterests(req.user.id,q,Number(req.query.limit||20),connectionId)});}catch(e){res.status(502).json({error:e.message||"meta_interest_search_failed",meta:e.meta||undefined});}});

  app.post(`${ROOT}/ad-campaigns/:id/meta/preflight`, requireAuth, async (req,res)=>{
    const ad=await adCampaignOwned(req.params.id,req.user.id); if(!ad)return res.status(404).json({error:"ad_campaign_not_found"});
    try{const input=MetaPublishPreflightSchema.parse(req.body||{});res.json({preflight:await buildMetaPaidPreflight(ad,req.user.id,req,input)});}catch(e){if(e instanceof z.ZodError)return res.status(400).json({error:"invalid_preflight",issues:e.issues});console.error("Meta paid preflight",e);res.status(502).json({error:e.message||"meta_preflight_failed",meta:e.meta||undefined});}
  });

  app.post(`${ROOT}/ad-campaigns/:id/meta/publish`, requireAuth, async (req,res)=>{
    let ad=await adCampaignOwned(req.params.id,req.user.id); if(!ad)return res.status(404).json({error:"ad_campaign_not_found"});
    try{
      const input=MetaPublishSchema.parse(req.body||{});
      if(input.mode==='active'&&input.confirmationText.trim().toUpperCase()!=='PUBLISH')return res.status(400).json({error:'publish_confirmation_required',message:'Type PUBLISH to authorize an active paid Meta campaign.'});
      const preflight=await buildMetaPaidPreflight(ad,req.user.id,req,input);
      if(preflight.fingerprint!==input.fingerprint)return res.status(409).json({error:'campaign_changed_after_review',message:'Campaign settings changed after the confirmation screen was reviewed. Run preflight again.',preflight});
      if(!preflight.ready)return res.status(409).json({error:'meta_preflight_failed',preflight});
      if(preflight.requiresSmartLinkActivation&&!input.activateSmartLink)return res.status(409).json({error:'smart_link_activation_required',message:'Explicitly approve Smart Link activation before publishing.',preflight});
      if(preflight.requiresSmartLinkActivation)await pool.query(`UPDATE promotion_campaigns SET status='active',updated_at=now() WHERE id=$1 AND owner_user_id=$2 AND status='draft'`,[ad.campaign_id,req.user.id]);
      const smart=await campaignOwned(ad.campaign_id,req.user.id); if(!smart||smart.status!=='active')throw new Error('smart_link_not_active');
      await pool.query(`UPDATE promotion_ad_campaigns SET status='publishing',meta_status='CREATING',meta_last_error='{}'::jsonb,dsa_beneficiary=$3,dsa_payor=$4,updated_at=now() WHERE id=$1 AND owner_user_id=$2`,[ad.id,req.user.id,preflight.effectiveDsa.beneficiary,preflight.effectiveDsa.payor]);
      const creativeInputs=[];
      for(const c of preflight.creatives){
        const k916=assertOwnedObjectKey(req.user.id,String(c.object_key_916||'')); const k43=assertOwnedObjectKey(req.user.id,String(c.object_key_43||''));
        const filePath916=objectPath(k916); const filePath43=objectPath(k43); await Promise.all([fs.promises.access(filePath916,fs.constants.R_OK),fs.promises.access(filePath43,fs.constants.R_OK)]);
        creativeInputs.push({id:String(c.id),filePath916,filePath43,linkUrl:paidCreativeLink(smart,ad,String(c.id))});
      }
      const progress={stage:'starting',ads:[]};
      const onProgress=async(next)=>{
        Object.assign(progress,next); if(Array.isArray(next.ads))progress.ads=next.ads;
        if(next.campaignId)await pool.query(`UPDATE promotion_ad_campaigns SET meta_campaign_id=$3,meta_status=$4,updated_at=now() WHERE id=$1 AND owner_user_id=$2`,[ad.id,req.user.id,String(next.campaignId),String(next.stage||'CREATING').toUpperCase()]);
        if(next.adSetId)await pool.query(`UPDATE promotion_ad_campaigns SET meta_adset_id=$3,updated_at=now() WHERE id=$1 AND owner_user_id=$2`,[ad.id,req.user.id,String(next.adSetId)]);
        if(next.localCreativeId&&(next.verticalVideoId||next.feedVideoId))await pool.query(`UPDATE promotion_ad_creatives SET meta_video_id_916=COALESCE(NULLIF($3,''),meta_video_id_916),meta_video_id_43=COALESCE(NULLIF($4,''),meta_video_id_43),updated_at=now() WHERE id=$1 AND ad_campaign_id=$2`,[next.localCreativeId,ad.id,String(next.verticalVideoId||''),String(next.feedVideoId||'')]);
        if(next.ad?.localCreativeId)await pool.query(`UPDATE promotion_ad_creatives SET meta_ad_ids=$3::jsonb,updated_at=now() WHERE id=$1 AND ad_campaign_id=$2`,[next.ad.localCreativeId,ad.id,JSON.stringify([{adId:next.ad.adId,creativeId:next.ad.creativeId,linkUrl:next.ad.linkUrl}])]);
      };
      const remote=await createMetaPaidCampaign({userId:req.user.id,connectionId:String(ad.meta_connection_id||''),adAccountId:ad.meta_ad_account_id,name:ad.name,dailyBudgetMinor:Number(ad.daily_budget_minor),startTime:ad.schedule_start,endTime:ad.schedule_end,targeting:ad.targeting||{},message:ad.ad_text,headline:ad.ad_headline,creatives:creativeInputs,dsaBeneficiary:preflight.effectiveDsa.beneficiary,dsaPayor:preflight.effectiveDsa.payor,activate:input.mode==='active',onProgress});
      const localStatus=input.mode==='active'?'in_review':'paused';
      const metadata={...(ad.metadata||{}),metaPublish:{fingerprint:input.fingerprint,mode:input.mode,publishedAt:new Date().toISOString(),smartLinkActivated:preflight.requiresSmartLinkActivation,remoteAds:remote.ads.map(x=>({localCreativeId:x.localCreativeId,adId:x.adId,creativeId:x.creativeId}))}};
      const {rows}=await pool.query(`UPDATE promotion_ad_campaigns SET status=$3,meta_campaign_id=$4,meta_adset_id=$5,meta_status=$6,meta_published_at=now(),meta_publish_fingerprint=$7,meta_last_error='{}'::jsonb,metadata=$8::jsonb,updated_at=now() WHERE id=$1 AND owner_user_id=$2 RETURNING *`,[ad.id,req.user.id,localStatus,remote.campaignId,remote.adSetId,remote.status,input.fingerprint,JSON.stringify(metadata)]);
      await recordEvent(smart.id,'custom',req,{metadata:{kind:'meta_paid_campaign_published',adCampaignId:String(ad.id),metaCampaignId:remote.campaignId,mode:input.mode}}).catch(()=>{});
      res.status(201).json({adCampaign:mapAdCampaign(rows[0]),remote,preflight});
    }catch(e){
      console.error('Meta paid publish',e);
      const latest=await adCampaignOwned(req.params.id,req.user.id).catch(()=>null); const errorBody={message:e?.message||'meta_paid_publish_failed',code:e?.code||'',meta:e?.meta||{},at:new Date().toISOString()};
      if(latest)await pool.query(`UPDATE promotion_ad_campaigns SET status='failed',meta_status='ERROR',meta_last_error=$3::jsonb,updated_at=now() WHERE id=$1 AND owner_user_id=$2`,[latest.id,req.user.id,JSON.stringify(errorBody)]).catch(()=>{});
      if(e instanceof z.ZodError)return res.status(400).json({error:'invalid_meta_publish',issues:e.issues});
      res.status(502).json({error:e?.message||'meta_paid_publish_failed',meta:e?.meta||undefined});
    }
  });

  app.post(`${ROOT}/ad-campaigns/:id/meta/refresh`, requireAuth, async (req,res)=>{
    const ad=await adCampaignOwned(req.params.id,req.user.id);if(!ad)return res.status(404).json({error:'ad_campaign_not_found'});if(!ad.meta_campaign_id)return res.status(409).json({error:'meta_campaign_not_created'});
    try{const remote=await fetchMetaPaidCampaignStatus(req.user.id,String(ad.meta_connection_id||''),ad.meta_campaign_id);const localStatus=deriveLocalMetaStatus(remote);const metaStatus=String(remote.campaign?.effective_status||remote.campaign?.status||'');const metadata={...(ad.metadata||{}),metaDelivery:{refreshedAt:new Date().toISOString(),remote}};const {rows}=await pool.query(`UPDATE promotion_ad_campaigns SET status=$3,meta_status=$4,metadata=$5::jsonb,updated_at=now() WHERE id=$1 AND owner_user_id=$2 RETURNING *`,[ad.id,req.user.id,localStatus,metaStatus,JSON.stringify(metadata)]);res.json({adCampaign:mapAdCampaign(rows[0]),remote});}catch(e){res.status(502).json({error:e.message||'meta_status_refresh_failed',meta:e.meta||undefined});}
  });

  app.post(`${ROOT}/ad-campaigns/:id/meta/status`, requireAuth, async (req,res)=>{
    const ad=await adCampaignOwned(req.params.id,req.user.id);if(!ad)return res.status(404).json({error:'ad_campaign_not_found'});if(!ad.meta_campaign_id)return res.status(409).json({error:'meta_campaign_not_created'});
    const status=String(req.body?.status||'').toUpperCase();if(!['ACTIVE','PAUSED'].includes(status))return res.status(400).json({error:'meta_status_invalid'});if(status==='ACTIVE'&&(req.body?.confirm!==true||String(req.body?.confirmationText||'').trim().toUpperCase()!=='RESUME'))return res.status(400).json({error:'resume_confirmation_required',message:'Type RESUME to authorize paid delivery.'});
    try{await setMetaPaidCampaignStatus(req.user.id,String(ad.meta_connection_id||''),ad.meta_campaign_id,status);const remote=await fetchMetaPaidCampaignStatus(req.user.id,String(ad.meta_connection_id||''),ad.meta_campaign_id);const localStatus=deriveLocalMetaStatus(remote);const metaStatus=String(remote.campaign?.effective_status||remote.campaign?.status||status);const {rows}=await pool.query(`UPDATE promotion_ad_campaigns SET status=$3,meta_status=$4,updated_at=now() WHERE id=$1 AND owner_user_id=$2 RETURNING *`,[ad.id,req.user.id,localStatus,metaStatus]);res.json({adCampaign:mapAdCampaign(rows[0]),remote});}catch(e){res.status(502).json({error:e.message||'meta_status_update_failed',meta:e.meta||undefined});}
  });

  app.post(`${ROOT}/ad-campaigns/:id/meta/discard`, requireAuth, async (req,res)=>{
    const ad=await adCampaignOwned(req.params.id,req.user.id);if(!ad)return res.status(404).json({error:'ad_campaign_not_found'});if(!ad.meta_campaign_id)return res.status(409).json({error:'meta_campaign_not_created'});if(String(req.body?.confirmationText||'').trim().toUpperCase()!=='DELETE')return res.status(400).json({error:'delete_confirmation_required'});
    try{await deleteMetaPaidCampaign(req.user.id,String(ad.meta_connection_id||''),ad.meta_campaign_id);await pool.query(`UPDATE promotion_ad_creatives SET meta_video_id_916='',meta_video_id_43='',meta_ad_ids='[]'::jsonb,updated_at=now() WHERE ad_campaign_id=$1`,[ad.id]);const {rows}=await pool.query(`UPDATE promotion_ad_campaigns SET status='ready',meta_campaign_id='',meta_adset_id='',meta_status='',meta_published_at=NULL,meta_publish_fingerprint='',meta_last_error='{}'::jsonb,updated_at=now() WHERE id=$1 AND owner_user_id=$2 RETURNING *`,[ad.id,req.user.id]);res.json({adCampaign:mapAdCampaign(rows[0]),deleted:true});}catch(e){res.status(502).json({error:e.message||'meta_discard_failed',meta:e.meta||undefined});}
  });

  app.get(`${ROOT}/ad-campaigns/:id/analytics`, requireAuth, async (req,res)=>{
    const ad=await adCampaignOwned(req.params.id,req.user.id); if(!ad)return res.status(404).json({error:'ad_campaign_not_found'});
    const envelope=await loadPaidAnalyticsEnvelope(ad,req.user.id,req.query||{});
    res.json({adCampaign:mapAdCampaign(ad),...envelope});
  });

  app.get(`${ROOT}/ad-campaigns/:id/intelligence`, requireAuth, async (req,res)=>{
    const ad=await adCampaignOwned(req.params.id,req.user.id); if(!ad)return res.status(404).json({error:'ad_campaign_not_found'});
    const envelope=await loadPaidAnalyticsEnvelope(ad,req.user.id,req.query||{});
    const analytics={adCampaign:mapAdCampaign(ad),...envelope};
    res.json({analytics,intelligence:buildPromotionIntelligence(analytics)});
  });

  app.get(`${ROOT}/releases`, requireAuth, async (req,res)=>{
    const {rows}=await pool.query(`SELECT r.id,r.artist_name,r.title,r.release_type,r.genre,r.published_at,(r.artwork_object_key IS NOT NULL) AS has_artwork,count(t.id)::int AS track_count,COALESCE(json_agg(json_build_object('id',t.id,'title',t.title,'genre',t.genre,'tags',t.tags,'explicit',t.explicit,'isrc',t.isrc,'trackNumber',t.track_number,'durationSeconds',t.duration_seconds,'audioObjectKey',t.audio_object_key) ORDER BY t.track_number) FILTER (WHERE t.id IS NOT NULL),'[]'::json) AS tracks FROM world_releases r LEFT JOIN world_tracks t ON t.release_id=r.id WHERE r.owner_user_id=$1 GROUP BY r.id ORDER BY r.published_at DESC`,[req.user.id]);
    res.json({releases:rows.map(r=>({id:String(r.id),artistName:r.artist_name,title:r.title,releaseType:r.release_type,genre:r.genre||"",publishedAt:r.published_at,hasArtwork:!!r.has_artwork,trackCount:Number(r.track_count||0),tracks:r.tracks||[]}))});
  });

  app.get(`${ROOT}/campaigns`, requireAuth, async (req,res)=>{
    const {rows}=await pool.query(`SELECT * FROM promotion_campaigns WHERE owner_user_id=$1 ORDER BY updated_at DESC`,[req.user.id]);
    res.json({campaigns:rows.map(r=>mapCampaign(r))});
  });

  app.post(`${ROOT}/campaigns`, requireAuth, async (req,res)=>{
    try{
      const input=CampaignSchema.parse(req.body||{}); const seed=await releaseSeed(req.user.id,input.sourceReleaseId||null);
      if(input.sourceReleaseId && !seed) return res.status(404).json({error:"source_release_not_found"});
      const title=(input.title||seed?.title||"").trim(); const artist=(input.artistName||seed?.artist_name||"").trim(); if(!title) return res.status(400).json({error:"title_required"});
      const slug=await uniqueSlug(input.slug||`${artist}-${title}`); const id=crypto.randomUUID(); const genre=(input.genre||seed?.genre||"").trim();
      const metadata={source:"promotion_center",sourceReleaseTracks:seed?.tracks||[]};
      const client=await pool.connect(); try{ await client.query("BEGIN"); await client.query(`INSERT INTO promotion_campaigns(id,owner_user_id,source_release_id,kind,slug,title,artist_name,description,genre,release_date,artwork_object_key,headline,cta_label,accent_color,seo_query,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb)`,[id,req.user.id,input.sourceReleaseId||null,input.kind,slug,title,artist,input.description,genre,input.releaseDate?new Date(input.releaseDate):null,seed?.artwork_object_key||null,input.headline,input.ctaLabel,input.accentColor,input.seoQuery||`${artist} ${title} ${genre}`.trim(),JSON.stringify(metadata)]); await replaceDestinations(client,id,input.destinations); await client.query("COMMIT"); }catch(e){await client.query("ROLLBACK");throw e;}finally{client.release();}
      const row=await campaignOwned(id,req.user.id); res.status(201).json({campaign:mapCampaign(row,await campaignDestinations(id))});
    }catch(e){ if(e instanceof z.ZodError) return res.status(400).json({error:"invalid_campaign",issues:e.issues}); console.error("promotion create",e); res.status(500).json({error:"campaign_create_failed",message:e.message}); }
  });

  app.get(`${ROOT}/campaigns/:id`, requireAuth, async (req,res)=>{ const row=await campaignOwned(req.params.id,req.user.id); if(!row)return res.status(404).json({error:"campaign_not_found"}); res.json({campaign:mapCampaign(row,await campaignDestinations(row.id)),analytics:await analyticsFor(row.id)}); });

  app.patch(`${ROOT}/campaigns/:id`, requireAuth, async (req,res)=>{
    try{ const current=await campaignOwned(req.params.id,req.user.id); if(!current)return res.status(404).json({error:"campaign_not_found"}); const input=CampaignSchema.partial().parse(req.body||{}); const slug=input.slug!==undefined?await uniqueSlug(input.slug,current.id):current.slug;
      const values={title:input.title??current.title,artist:input.artistName??current.artist_name,description:input.description??current.description,genre:input.genre??current.genre,releaseDate:input.releaseDate===undefined?current.release_date:(input.releaseDate?new Date(input.releaseDate):null),headline:input.headline??current.headline,cta:input.ctaLabel??current.cta_label,accent:input.accentColor??current.accent_color,seo:input.seoQuery??current.seo_query,kind:input.kind??current.kind};
      const client=await pool.connect(); try{await client.query("BEGIN");await client.query(`UPDATE promotion_campaigns SET kind=$3,slug=$4,title=$5,artist_name=$6,description=$7,genre=$8,release_date=$9,headline=$10,cta_label=$11,accent_color=$12,seo_query=$13,updated_at=now() WHERE id=$1 AND owner_user_id=$2`,[current.id,req.user.id,values.kind,slug,values.title,values.artist,values.description,values.genre,values.releaseDate,values.headline,values.cta,values.accent,values.seo]); if(input.destinations) await replaceDestinations(client,current.id,input.destinations); await client.query("COMMIT");}catch(e){await client.query("ROLLBACK");throw e;}finally{client.release();}
      const row=await campaignOwned(current.id,req.user.id); res.json({campaign:mapCampaign(row,await campaignDestinations(row.id))});
    }catch(e){ if(e instanceof z.ZodError)return res.status(400).json({error:"invalid_campaign",issues:e.issues}); console.error("promotion patch",e);res.status(500).json({error:"campaign_update_failed",message:e.message}); }
  });

  app.post(`${ROOT}/campaigns/:id/status`, requireAuth, async (req,res)=>{ const status=String(req.body?.status||""); if(!["draft","active","archived"].includes(status))return res.status(400).json({error:"invalid_status"}); const {rows}=await pool.query(`UPDATE promotion_campaigns SET status=$3,updated_at=now() WHERE id=$1 AND owner_user_id=$2 RETURNING *`,[req.params.id,req.user.id,status]); if(!rows[0])return res.status(404).json({error:"campaign_not_found"}); res.json({campaign:mapCampaign(rows[0],await campaignDestinations(rows[0].id))}); });
  app.delete(`${ROOT}/campaigns/:id`, requireAuth, async (req,res)=>{ const result=await pool.query(`DELETE FROM promotion_campaigns WHERE id=$1 AND owner_user_id=$2`,[req.params.id,req.user.id]); if(!result.rowCount)return res.status(404).json({error:"campaign_not_found"}); res.json({ok:true}); });
  app.get(`${ROOT}/campaigns/:id/analytics`, requireAuth, async (req,res)=>{ const row=await campaignOwned(req.params.id,req.user.id); if(!row)return res.status(404).json({error:"campaign_not_found"}); res.json(await analyticsFor(row.id)); });
  app.get(`${ROOT}/campaigns/:id/fans`, requireAuth, async (req,res)=>{ const row=await campaignOwned(req.params.id,req.user.id); if(!row)return res.status(404).json({error:"campaign_not_found"}); const {rows}=await pool.query(`SELECT id,email,consent,source,provider,created_at FROM promotion_fans WHERE campaign_id=$1 ORDER BY created_at DESC LIMIT 1000`,[row.id]); res.json({fans:rows.map(r=>({id:String(r.id),email:r.email,consent:!!r.consent,source:r.source,provider:r.provider,createdAt:r.created_at}))}); });

  app.post(`${ROOT}/campaigns/:id/seo-refresh`, requireAuth, async (req,res)=>{
    const row=await campaignOwned(req.params.id,req.user.id); if(!row)return res.status(404).json({error:"campaign_not_found"}); const query=String(req.body?.query||row.seo_query||`${row.artist_name} ${row.title} ${row.genre}`).trim().slice(0,300); if(!query)return res.status(400).json({error:"seo_query_required"});
    try{ const report=await buildLiveIntel(query); await pool.query(`UPDATE promotion_campaigns SET seo_query=$3,seo_snapshot=$4::jsonb,updated_at=now() WHERE id=$1 AND owner_user_id=$2`,[row.id,req.user.id,query,JSON.stringify(report)]); res.json({query,report}); }catch(e){ console.error("promotion seo",e);res.status(502).json({error:"seo_analysis_failed",message:e.message}); }
  });

  app.get(`${ROOT}/meta/status`, requireAuth, async (req,res)=>{ const connections=await listMetaConnections(req.user.id); res.json({configured:metaConfigured(),graphVersion:META_GRAPH_VERSION,connections}); });
  app.post(`${ROOT}/meta/oauth/start`, requireAuth, async (req,res)=>{ try{res.json({url:await createMetaOAuthUrl(req.user.id,req)});}catch(e){res.status(503).json({error:e.message||"meta_oauth_unavailable"});} });
  app.get(`${ROOT}/meta/oauth/callback`, async (req,res)=>{ try{ if(req.query.error) throw new Error(String(req.query.error_description||req.query.error)); const result=await completeMetaOAuth({code:req.query.code,state:req.query.state,req}); res.type("html").send(oauthCallbackHtml(true,`Connected ${result.pageCount} managed Meta Page${result.pageCount===1?"":"s"}.`)); }catch(e){console.error("Meta OAuth callback",e);res.status(400).type("html").send(oauthCallbackHtml(false,e.message||"OAuth failed."));} });
  app.post(`${ROOT}/meta/select`, requireAuth, async (req,res)=>{ try{await selectMetaConnection(req.user.id,String(req.body?.connectionId||""));res.json({ok:true,connections:await listMetaConnections(req.user.id)});}catch(e){res.status(400).json({error:e.message||"meta_select_failed"});} });
  app.post(`${ROOT}/meta/disconnect`, requireAuth, async (req,res)=>{ await disconnectMeta(req.user.id,req.body?.connectionId||null);res.json({ok:true,connections:await listMetaConnections(req.user.id)}); });
  app.post(`${ROOT}/campaigns/:id/meta-publish`, requireAuth, async (req,res)=>{
    const row=await campaignOwned(req.params.id,req.user.id); if(!row)return res.status(404).json({error:"campaign_not_found"}); if(row.status!=="active")return res.status(409).json({error:"campaign_must_be_active"}); const channel=String(req.body?.channel||""); const trackedLink=`${landingUrl(row.slug)}?${new URLSearchParams({utm_source:channel,utm_medium:"social",utm_campaign:row.slug}).toString()}`; const supplied=String(req.body?.message||""); const message=(supplied?supplied.replaceAll(landingUrl(row.slug),trackedLink):`${row.artist_name} — ${row.title}\n${trackedLink}`).slice(0,4000); const publicApi=apiBase(req); if(!isPublicHttpUrl(webBase()))return res.status(409).json({error:"meta_requires_public_campaign_url",message:"Meta publishing requires PROMOTION_WEB_BASE_URL to be a public HTTPS YSong URL."}); if(channel==="instagram"&&!isPublicHttpUrl(publicApi))return res.status(409).json({error:"meta_requires_public_api_url",message:"Instagram must fetch campaign artwork from a public HTTPS YSong API URL."});
    try{ const result=await publishToMeta({userId:req.user.id,channel,message,linkUrl:trackedLink,imageUrl:row.artwork_object_key?`${publicApi}/api/promotion/public/${encodeURIComponent(row.slug)}/artwork`:""}); await recordEvent(row.id,"meta_publish",req,{metadata:{channel,...result}}); res.json({ok:true,result}); }catch(e){console.error("Meta publish",e);res.status(502).json({error:e.message||"meta_publish_failed",meta:e.meta||undefined});}
  });

  app.get(`/api/promotion/public/:slug`, async (req,res)=>{ const row=await campaignPublic(String(req.params.slug||"")); if(!row)return res.status(404).json({error:"campaign_not_found"}); res.setHeader("Cache-Control","public, max-age=60"); res.json({campaign:mapCampaign(row,await campaignDestinations(row.id,true)),qrUrl:`${apiBase(req)}/api/promotion/public/${encodeURIComponent(row.slug)}/qr.svg`}); });
  app.get(`/api/promotion/public/:slug/artwork`, async (req,res)=>{ try{const row=await campaignPublic(String(req.params.slug||"")); if(!row||!row.artwork_object_key)return res.status(404).end(); const file=objectPath(row.artwork_object_key); const meta=await readObjectMetadata(row.artwork_object_key); await fs.promises.access(file,fs.constants.R_OK); res.setHeader("Content-Type",meta.contentType||"application/octet-stream"); res.setHeader("Cache-Control","public, max-age=3600"); fs.createReadStream(file).pipe(res);}catch{return res.status(404).end();} });
  app.get(`/api/promotion/public/:slug/qr.svg`, async (req,res)=>{ const row=await campaignPublic(String(req.params.slug||"")); if(!row)return res.status(404).end(); try{const svg=qrSvg(landingUrl(row.slug));res.setHeader("Content-Type","image/svg+xml; charset=utf-8");res.setHeader("Cache-Control","public, max-age=3600");res.send(svg);}catch(e){res.status(500).json({error:"qr_generation_failed",message:e.message});} });
  app.post(`/api/promotion/public/:slug/events`, async (req,res)=>{ try{const row=await campaignPublic(String(req.params.slug||"")); if(!row)return res.status(404).json({error:"campaign_not_found"}); const input=EventSchema.parse(req.body||{}); await recordEvent(row.id,input.eventType,req,{destinationId:input.destinationId||null,visitorId:input.visitorId,metadata:input.metadata}); res.status(202).json({ok:true});}catch(e){if(e instanceof z.ZodError)return res.status(400).json({error:"invalid_event"});res.status(500).json({error:"event_failed"});} });
  app.post(`/api/promotion/public/:slug/fans`, async (req,res)=>{ try{const row=await campaignPublic(String(req.params.slug||"")); if(!row)return res.status(404).json({error:"campaign_not_found"}); const input=FanSchema.parse(req.body||{}); const attribution={adCampaignId:input.adCampaignId||"",creativeId:input.creativeId||"",utmSource:input.utmSource||"",utmMedium:input.utmMedium||"",utmCampaign:input.utmCampaign||"",utmContent:input.utmContent||""}; await pool.query(`INSERT INTO promotion_fans(id,campaign_id,email,consent,source,provider,metadata) VALUES($1,$2,$3,true,$4,$5,$6::jsonb) ON CONFLICT (campaign_id, (lower(email))) DO UPDATE SET consent=true,source=EXCLUDED.source,provider=EXCLUDED.provider,metadata=promotion_fans.metadata||EXCLUDED.metadata`,[crypto.randomUUID(),row.id,input.email.trim().toLowerCase(),input.source,input.provider,JSON.stringify({visitorId:input.visitorId,...attribution})]); await recordEvent(row.id,"email_capture",req,{visitorId:input.visitorId,metadata:{provider:input.provider,...attribution}}); res.status(201).json({ok:true});}catch(e){if(e instanceof z.ZodError)return res.status(400).json({error:"invalid_fan_capture"});console.error("fan capture",e);res.status(500).json({error:"fan_capture_failed"});} });
  app.get(`/api/promotion/r/:slug/:destinationId`, async (req,res)=>{ const row=await campaignPublic(String(req.params.slug||"")); if(!row)return res.status(404).send("Campaign not found"); const {rows}=await pool.query(`SELECT * FROM promotion_destinations WHERE id=$1 AND campaign_id=$2 AND enabled=true LIMIT 1`,[req.params.destinationId,row.id]); const d=rows[0]; if(!d)return res.status(404).send("Destination not found"); const attribution={adCampaignId:String(req.query.ac||""),creativeId:String(req.query.cr||"")}; await recordEvent(row.id,"click",req,{destinationId:d.id,visitorId:String(req.query.v||""),metadata:attribution}); if(d.destination_kind==="presave") await recordEvent(row.id,"presave_intent",req,{destinationId:d.id,visitorId:String(req.query.v||""),metadata:attribution}); res.redirect(302,d.url); });
}
