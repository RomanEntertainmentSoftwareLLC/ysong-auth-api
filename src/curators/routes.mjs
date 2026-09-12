import crypto from "crypto";
import { z } from "zod";
import { pool } from "../db.js";
import { buildLiveIntel } from "../musicSeo/analyze.mjs";
import { curatorStats, normalizeMatchContext, scoreCuratorMatch } from "./matching.mjs";

const ROOT="/api/curators";
const STARTER_CREDITS=Math.max(0,Math.min(100,Number(process.env.CURATOR_BETA_STARTER_CREDITS ?? 10)||0));
const CURATOR_TYPES=["playlist","blog","radio","youtube","influencer","music_media"];
const PLACEMENT_STATUSES=["none","planned","published","declined"];
const DECISIONS=["accepted","rejected"];
const text=(v,max=1000)=>String(v??"").trim().slice(0,max);
const list=(v,max=40)=>Array.isArray(v)?[...new Set(v.map(x=>text(x,100)).filter(Boolean))].slice(0,max):[];
const safeUrl=(v)=>{const s=text(v,1000);if(!s)return "";try{const u=new URL(s);return ["http:","https:"].includes(u.protocol)?u.toString():"";}catch{return "";}};
const n=(v,d=0)=>Number.isFinite(Number(v))?Number(v):d;

const ProfileSchema=z.object({
  displayName:z.string().trim().min(1).max(120), organization:z.string().trim().max(160).optional().default(""),
  curatorType:z.enum(CURATOR_TYPES), bio:z.string().trim().max(2400).optional().default(""), websiteUrl:z.string().trim().max(1000).optional().default(""),
  status:z.enum(["draft","active","paused"]).optional().default("draft"), editorialIndependenceAck:z.boolean().optional().default(false),
});
const ChannelSchema=z.object({
  name:z.string().trim().min(1).max(180), platform:z.string().trim().min(1).max(120), url:z.string().trim().max(1000).optional().default(""), description:z.string().trim().max(2400).optional().default(""),
  genres:z.array(z.string().trim().min(1).max(100)).max(40).optional().default([]), moods:z.array(z.string().trim().min(1).max(100)).max(40).optional().default([]), sonicTags:z.array(z.string().trim().min(1).max(100)).max(60).optional().default([]),
  languages:z.array(z.string().trim().min(1).max(40)).max(30).optional().default(["en"]), countries:z.array(z.string().trim().min(2).max(80)).max(100).optional().default([]),
  minBpm:z.number().min(20).max(400).nullable().optional(), maxBpm:z.number().min(20).max(400).nullable().optional(), acceptsExplicit:z.boolean().optional().default(true),
  submissionCostCredits:z.number().int().min(0).max(100).optional().default(0), responseDays:z.number().int().min(1).max(30).optional().default(7), audienceSize:z.number().int().min(0).max(10_000_000_000).optional().default(0), active:z.boolean().optional().default(true),
});

function profileRow(r){return {id:String(r.id),displayName:r.display_name,organization:r.organization,curatorType:r.curator_type,bio:r.bio,websiteUrl:r.website_url,status:r.status,editorialIndependenceAck:!!r.editorial_independence_ack,verified:!!r.verified,metadata:r.metadata||{},createdAt:r.created_at,updatedAt:r.updated_at};}
function channelRow(r){return {id:String(r.id),curatorProfileId:String(r.curator_profile_id),name:r.name,platform:r.platform,url:r.url,description:r.description,genres:r.genres||[],moods:r.moods||[],sonicTags:r.sonic_tags||[],languages:r.languages||[],countries:r.countries||[],minBpm:r.min_bpm==null?null:Number(r.min_bpm),maxBpm:r.max_bpm==null?null:Number(r.max_bpm),acceptsExplicit:!!r.accepts_explicit,submissionCostCredits:Number(r.submission_cost_credits||0),responseDays:Number(r.response_days||7),audienceSize:Number(r.audience_size||0),active:!!r.active,metadata:r.metadata||{},createdAt:r.created_at,updatedAt:r.updated_at};}
function submissionRow(r){return {id:String(r.id),artistUserId:String(r.artist_user_id),curatorProfileId:String(r.curator_profile_id),curatorChannelId:String(r.curator_channel_id),releaseId:String(r.release_id),trackId:r.track_id?String(r.track_id):null,matchContextId:r.match_context_id?String(r.match_context_id):null,pitch:r.pitch,status:r.status,creditsSpent:Number(r.credits_spent||0),matchSnapshot:r.match_snapshot||{},releaseSnapshot:r.release_snapshot||{},feedback:r.feedback||{},placementStatus:r.placement_status,placementUrl:r.placement_url,submittedAt:r.submitted_at,openedAt:r.opened_at,respondedAt:r.responded_at,expiresAt:r.expires_at,updatedAt:r.updated_at};}

async function ensureWallet(userId, client=pool){
  const inserted=await client.query(`INSERT INTO curator_wallets(owner_user_id,balance,lifetime_granted) VALUES($1,$2,$2) ON CONFLICT(owner_user_id) DO NOTHING RETURNING *`,[userId,STARTER_CREDITS]);
  if(inserted.rows[0] && STARTER_CREDITS>0){
    await client.query(`INSERT INTO curator_credit_ledger(id,owner_user_id,amount,reason,metadata) VALUES($1,$2,$3,'beta_starter_credits',$4::jsonb)`,[crypto.randomUUID(),userId,STARTER_CREDITS,JSON.stringify({nonCash:true,label:"YSong beta courtesy credits"})]);
  }
  const {rows}=await client.query(`SELECT * FROM curator_wallets WHERE owner_user_id=$1`,[userId]);
  return rows[0];
}

async function refundSubmission(client, row, reason="expired_refund"){
  if(!row || Number(row.credits_spent||0)<=0) return;
  const existing=await client.query(`SELECT 1 FROM curator_credit_ledger WHERE owner_user_id=$1 AND reference_type='submission_refund' AND reference_id=$2 LIMIT 1`,[row.artist_user_id,row.id]);
  if(existing.rows[0]) return;
  const amount=Number(row.credits_spent);
  await client.query(`UPDATE curator_wallets SET balance=balance+$2,lifetime_spent=GREATEST(0,lifetime_spent-$2),updated_at=now() WHERE owner_user_id=$1`,[row.artist_user_id,amount]);
  await client.query(`INSERT INTO curator_credit_ledger(id,owner_user_id,amount,reason,reference_type,reference_id,metadata) VALUES($1,$2,$3,$4,'submission_refund',$5,$6::jsonb)`,[crypto.randomUUID(),row.artist_user_id,amount,reason,row.id,JSON.stringify({nonCash:true})]);
}

async function expireOverdue(){
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    const {rows}=await client.query(`SELECT * FROM curator_submissions WHERE status IN ('pending','in_review') AND expires_at IS NOT NULL AND expires_at < now() FOR UPDATE`);
    for(const row of rows){
      await client.query(`UPDATE curator_submissions SET status='expired',updated_at=now() WHERE id=$1`,[row.id]);
      await refundSubmission(client,row,"curator_response_deadline_expired");
    }
    await client.query("COMMIT");
  }catch(e){await client.query("ROLLBACK");throw e;}finally{client.release();}
}

async function ownedReleaseContext(userId,releaseId,trackId=null){
  const {rows}=await pool.query(`SELECT r.id AS release_id,r.artist_name,r.title AS release_title,r.release_type,r.genre AS release_genre,r.published_at,r.artwork_object_key,
    t.id AS track_id,t.title AS track_title,t.genre AS track_genre,t.tags,t.explicit,t.duration_seconds,t.isrc
    FROM world_releases r LEFT JOIN world_tracks t ON t.release_id=r.id AND ($3::uuid IS NULL OR t.id=$3::uuid)
    WHERE r.id=$1 AND r.owner_user_id=$2 ORDER BY t.track_number LIMIT 1`,[releaseId,userId,trackId||null]);
  if(!rows[0]) return null;
  const r=rows[0];
  return {release:{id:String(r.release_id),artistName:r.artist_name,title:r.release_title,releaseType:r.release_type,genre:r.release_genre||"",publishedAt:r.published_at,hasArtwork:!!r.artwork_object_key},track:r.track_id?{id:String(r.track_id),title:r.track_title,genre:r.track_genre||"",tags:r.tags||[],explicit:!!r.explicit,durationSeconds:r.duration_seconds==null?null:Number(r.duration_seconds),isrc:r.isrc||null}:null};
}

async function statsForProfiles(profileIds){
  if(!profileIds.length) return new Map();
  const {rows}=await pool.query(`SELECT curator_profile_id,status,submitted_at,responded_at FROM curator_submissions WHERE curator_profile_id=ANY($1::uuid[])`,[profileIds]);
  const map=new Map();
  for(const id of profileIds) map.set(String(id),[]);
  for(const r of rows) map.get(String(r.curator_profile_id))?.push(r);
  return new Map([...map].map(([id,rs])=>[id,curatorStats(rs)]));
}

export function registerCuratorRoutes(app,{requireAuth}){
  app.get(`${ROOT}/health`,requireAuth,(_req,res)=>res.json({ok:true,service:"YSong Curator Marketplace",phase:"24",placementGuarantee:false,credits:{mode:"internal-ledger",starterCredits:STARTER_CREDITS,purchaseProviderConfigured:false}}));
  app.get(`${ROOT}/catalog`,requireAuth,(_req,res)=>res.json({curatorTypes:CURATOR_TYPES,placementStatuses:PLACEMENT_STATUSES,decisionPolicy:"Paid credits purchase review consideration only. Curators retain independent acceptance/rejection control. No guaranteed placement."}));

  app.get(`${ROOT}/wallet`,requireAuth,async(req,res)=>{
    const wallet=await ensureWallet(req.user.id); const {rows}=await pool.query(`SELECT id,amount,reason,reference_type,reference_id,metadata,created_at FROM curator_credit_ledger WHERE owner_user_id=$1 ORDER BY created_at DESC LIMIT 100`,[req.user.id]);
    res.json({wallet:{balance:Number(wallet.balance),lifetimeGranted:Number(wallet.lifetime_granted),lifetimeSpent:Number(wallet.lifetime_spent),purchaseProviderConfigured:false},ledger:rows.map(r=>({id:String(r.id),amount:Number(r.amount),reason:r.reason,referenceType:r.reference_type,referenceId:r.reference_id?String(r.reference_id):null,metadata:r.metadata||{},createdAt:r.created_at}))});
  });

  app.get(`${ROOT}/releases`,requireAuth,async(req,res)=>{
    const {rows}=await pool.query(`SELECT r.id,r.artist_name,r.title,r.release_type,r.genre,r.published_at,(r.artwork_object_key IS NOT NULL) AS has_artwork,COALESCE(json_agg(json_build_object('id',t.id,'title',t.title,'genre',t.genre,'tags',t.tags,'explicit',t.explicit,'durationSeconds',t.duration_seconds,'isrc',t.isrc) ORDER BY t.track_number) FILTER(WHERE t.id IS NOT NULL),'[]'::json) tracks FROM world_releases r LEFT JOIN world_tracks t ON t.release_id=r.id WHERE r.owner_user_id=$1 GROUP BY r.id ORDER BY r.published_at DESC`,[req.user.id]);
    res.json({releases:rows.map(r=>({id:String(r.id),artistName:r.artist_name,title:r.title,releaseType:r.release_type,genre:r.genre||"",publishedAt:r.published_at,hasArtwork:!!r.has_artwork,tracks:r.tracks||[]}))});
  });

  app.get(`${ROOT}/profile`,requireAuth,async(req,res)=>{
    const p=await pool.query(`SELECT * FROM curator_profiles WHERE owner_user_id=$1 LIMIT 1`,[req.user.id]);
    if(!p.rows[0]) return res.json({profile:null,channels:[],stats:curatorStats([])});
    const c=await pool.query(`SELECT * FROM curator_channels WHERE curator_profile_id=$1 ORDER BY updated_at DESC`,[p.rows[0].id]);
    const s=await pool.query(`SELECT status,submitted_at,responded_at FROM curator_submissions WHERE curator_profile_id=$1`,[p.rows[0].id]);
    res.json({profile:profileRow(p.rows[0]),channels:c.rows.map(channelRow),stats:curatorStats(s.rows)});
  });

  app.put(`${ROOT}/profile`,requireAuth,async(req,res)=>{
    const parsed=ProfileSchema.safeParse(req.body||{}); if(!parsed.success)return res.status(400).json({error:"invalid_curator_profile",issues:parsed.error.issues});
    const b=parsed.data; if(b.status==="active"&&!b.editorialIndependenceAck)return res.status(400).json({error:"editorial_independence_ack_required"});
    const website=b.websiteUrl?safeUrl(b.websiteUrl):""; if(b.websiteUrl&&!website)return res.status(400).json({error:"invalid_website_url"});
    const id=crypto.randomUUID();
    const {rows}=await pool.query(`INSERT INTO curator_profiles(id,owner_user_id,display_name,organization,curator_type,bio,website_url,status,editorial_independence_ack) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT(owner_user_id) DO UPDATE SET display_name=EXCLUDED.display_name,organization=EXCLUDED.organization,curator_type=EXCLUDED.curator_type,bio=EXCLUDED.bio,website_url=EXCLUDED.website_url,status=EXCLUDED.status,editorial_independence_ack=EXCLUDED.editorial_independence_ack,updated_at=now() RETURNING *`,[id,req.user.id,b.displayName,b.organization,b.curatorType,b.bio,website,b.status,b.editorialIndependenceAck]);
    res.json({profile:profileRow(rows[0])});
  });

  app.post(`${ROOT}/channels`,requireAuth,async(req,res)=>{
    const parsed=ChannelSchema.safeParse(req.body||{});if(!parsed.success)return res.status(400).json({error:"invalid_curator_channel",issues:parsed.error.issues});
    const p=await pool.query(`SELECT * FROM curator_profiles WHERE owner_user_id=$1 LIMIT 1`,[req.user.id]);if(!p.rows[0])return res.status(400).json({error:"curator_profile_required"});
    const b=parsed.data;if(b.minBpm&&b.maxBpm&&b.maxBpm<b.minBpm)return res.status(400).json({error:"invalid_bpm_range"}); const url=b.url?safeUrl(b.url):"";if(b.url&&!url)return res.status(400).json({error:"invalid_channel_url"});
    const {rows}=await pool.query(`INSERT INTO curator_channels(id,curator_profile_id,name,platform,url,description,genres,moods,sonic_tags,languages,countries,min_bpm,max_bpm,accepts_explicit,submission_cost_credits,response_days,audience_size,active) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,[crypto.randomUUID(),p.rows[0].id,b.name,b.platform,url,b.description,JSON.stringify(list(b.genres)),JSON.stringify(list(b.moods)),JSON.stringify(list(b.sonicTags,60)),JSON.stringify(list(b.languages,30)),JSON.stringify(list(b.countries,100)),b.minBpm??null,b.maxBpm??null,b.acceptsExplicit,b.submissionCostCredits,b.responseDays,b.audienceSize,b.active]);
    res.status(201).json({channel:channelRow(rows[0])});
  });

  app.patch(`${ROOT}/channels/:id`,requireAuth,async(req,res)=>{
    const current=await pool.query(`SELECT c.* FROM curator_channels c JOIN curator_profiles p ON p.id=c.curator_profile_id WHERE c.id=$1 AND p.owner_user_id=$2 LIMIT 1`,[req.params.id,req.user.id]);if(!current.rows[0])return res.status(404).json({error:"channel_not_found"});
    const merged={...channelRow(current.rows[0]),...(req.body||{})};const parsed=ChannelSchema.safeParse(merged);if(!parsed.success)return res.status(400).json({error:"invalid_curator_channel",issues:parsed.error.issues}); const b=parsed.data;if(b.minBpm&&b.maxBpm&&b.maxBpm<b.minBpm)return res.status(400).json({error:"invalid_bpm_range"});
    const url=b.url?safeUrl(b.url):"";if(b.url&&!url)return res.status(400).json({error:"invalid_channel_url"});
    const {rows}=await pool.query(`UPDATE curator_channels SET name=$3,platform=$4,url=$5,description=$6,genres=$7::jsonb,moods=$8::jsonb,sonic_tags=$9::jsonb,languages=$10::jsonb,countries=$11::jsonb,min_bpm=$12,max_bpm=$13,accepts_explicit=$14,submission_cost_credits=$15,response_days=$16,audience_size=$17,active=$18,updated_at=now() WHERE id=$1 AND curator_profile_id=$2 RETURNING *`,[current.rows[0].id,current.rows[0].curator_profile_id,b.name,b.platform,url,b.description,JSON.stringify(list(b.genres)),JSON.stringify(list(b.moods)),JSON.stringify(list(b.sonicTags,60)),JSON.stringify(list(b.languages,30)),JSON.stringify(list(b.countries,100)),b.minBpm??null,b.maxBpm??null,b.acceptsExplicit,b.submissionCostCredits,b.responseDays,b.audienceSize,b.active]);
    res.json({channel:channelRow(rows[0])});
  });

  app.delete(`${ROOT}/channels/:id`,requireAuth,async(req,res)=>{
    const used=await pool.query(`SELECT 1 FROM curator_submissions s JOIN curator_profiles p ON p.id=s.curator_profile_id WHERE s.curator_channel_id=$1 AND p.owner_user_id=$2 LIMIT 1`,[req.params.id,req.user.id]);
    if(used.rows[0]){await pool.query(`UPDATE curator_channels c SET active=false,updated_at=now() FROM curator_profiles p WHERE c.id=$1 AND c.curator_profile_id=p.id AND p.owner_user_id=$2`,[req.params.id,req.user.id]);return res.json({ok:true,archived:true});}
    await pool.query(`DELETE FROM curator_channels c USING curator_profiles p WHERE c.id=$1 AND c.curator_profile_id=p.id AND p.owner_user_id=$2`,[req.params.id,req.user.id]);res.json({ok:true,archived:false});
  });

  app.post(`${ROOT}/match-context`,requireAuth,async(req,res)=>{
    const releaseId=text(req.body?.releaseId,80),trackId=text(req.body?.trackId,80)||null;if(!releaseId)return res.status(400).json({error:"release_required"});
    const owned=await ownedReleaseContext(req.user.id,releaseId,trackId);if(!owned)return res.status(404).json({error:"release_or_track_not_found"});
    const audio=req.body?.audioIntelligence && typeof req.body.audioIntelligence==="object" ? req.body.audioIntelligence : {};
    const seoQuery=text(req.body?.seoQuery,160)||`${owned.track?.genre||owned.release.genre} ${owned.release.artistName}`.trim();
    let seo={}; if(req.body?.refreshSeo!==false && seoQuery){try{seo=await buildLiveIntel(seoQuery);}catch(e){seo={error:"seo_unavailable",detail:String(e?.message||e),query:seoQuery};}}
    const normalized=normalizeMatchContext({release:owned.release,track:owned.track,audioIntelligence:audio,seoSnapshot:seo});
    const existing=await pool.query(`SELECT id FROM curator_match_contexts WHERE owner_user_id=$1 AND release_id=$2 AND track_id IS NOT DISTINCT FROM $3::uuid ORDER BY updated_at DESC LIMIT 1`,[req.user.id,releaseId,trackId]);
    const {rows}=existing.rows[0]
      ? await pool.query(`UPDATE curator_match_contexts SET audio_intelligence=$2::jsonb,seo_snapshot=$3::jsonb,normalized=$4::jsonb,updated_at=now() WHERE id=$1 RETURNING *`,[existing.rows[0].id,JSON.stringify(audio),JSON.stringify(seo),JSON.stringify(normalized)])
      : await pool.query(`INSERT INTO curator_match_contexts(id,owner_user_id,release_id,track_id,audio_intelligence,seo_snapshot,normalized) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb) RETURNING *`,[crypto.randomUUID(),req.user.id,releaseId,trackId,JSON.stringify(audio),JSON.stringify(seo),JSON.stringify(normalized)]);
    res.json({context:{id:String(rows[0].id),releaseId,trackId,audioIntelligence:rows[0].audio_intelligence,seoSnapshot:rows[0].seo_snapshot,normalized:rows[0].normalized,updatedAt:rows[0].updated_at},release:owned.release,track:owned.track});
  });

  app.get(`${ROOT}/recommendations`,requireAuth,async(req,res)=>{
    await expireOverdue();const releaseId=text(req.query.releaseId,80),trackId=text(req.query.trackId,80)||null;const limit=Math.max(1,Math.min(100,n(req.query.limit,30)));if(!releaseId)return res.status(400).json({error:"release_required"});
    const owned=await ownedReleaseContext(req.user.id,releaseId,trackId);if(!owned)return res.status(404).json({error:"release_or_track_not_found"});
    const ctx=await pool.query(`SELECT * FROM curator_match_contexts WHERE owner_user_id=$1 AND release_id=$2 AND track_id IS NOT DISTINCT FROM $3::uuid ORDER BY updated_at DESC LIMIT 1`,[req.user.id,releaseId,trackId]);
    const normalized=ctx.rows[0]?.normalized||normalizeMatchContext({release:owned.release,track:owned.track});
    const {rows}=await pool.query(`SELECT c.*,p.display_name,p.organization,p.curator_type,p.bio AS curator_bio,p.website_url,p.verified,p.id AS profile_id FROM curator_channels c JOIN curator_profiles p ON p.id=c.curator_profile_id WHERE p.status='active' AND c.active=true AND p.owner_user_id<>$1`,[req.user.id]);
    const statsMap=await statsForProfiles([...new Set(rows.map(r=>String(r.profile_id)))]);
    const results=rows.map(r=>{const channel=channelRow(r),stats=statsMap.get(String(r.profile_id))||curatorStats([]);const match=scoreCuratorMatch(normalized,channel,stats);return {profile:{id:String(r.profile_id),displayName:r.display_name,organization:r.organization,curatorType:r.curator_type,bio:r.curator_bio,websiteUrl:r.website_url,verified:!!r.verified},channel,stats,match};}).filter(x=>x.match.eligible).sort((a,b)=>b.match.score-a.match.score||b.stats.responseRate-a.stats.responseRate).slice(0,limit);
    res.json({context:{id:ctx.rows[0]?String(ctx.rows[0].id):null,normalized},release:owned.release,track:owned.track,recommendations:results,policy:"Match score estimates editorial fit only. It is not an acceptance probability and never guarantees placement."});
  });

  app.get(`${ROOT}/explore`,requireAuth,async(req,res)=>{
    const q=text(req.query.q,100).toLowerCase(); const params=[req.user.id];let where=`p.status='active' AND c.active=true AND p.owner_user_id<>$1`;
    if(q){params.push(`%${q}%`);where+=` AND (lower(c.name) LIKE $2 OR lower(c.platform) LIKE $2 OR lower(p.display_name) LIKE $2 OR lower(c.description) LIKE $2 OR lower(c.genres::text) LIKE $2)`;}
    const {rows}=await pool.query(`SELECT c.*,p.id AS profile_id,p.display_name,p.organization,p.curator_type,p.bio AS curator_bio,p.website_url,p.verified FROM curator_channels c JOIN curator_profiles p ON p.id=c.curator_profile_id WHERE ${where} ORDER BY p.verified DESC,c.audience_size DESC,c.updated_at DESC LIMIT 100`,params);
    const statsMap=await statsForProfiles([...new Set(rows.map(r=>String(r.profile_id)))]);res.json({channels:rows.map(r=>({profile:{id:String(r.profile_id),displayName:r.display_name,organization:r.organization,curatorType:r.curator_type,bio:r.curator_bio,websiteUrl:r.website_url,verified:!!r.verified},channel:channelRow(r),stats:statsMap.get(String(r.profile_id))||curatorStats([])}))});
  });

  app.post(`${ROOT}/submissions`,requireAuth,async(req,res)=>{
    await expireOverdue();const channelId=text(req.body?.channelId,80),releaseId=text(req.body?.releaseId,80),trackId=text(req.body?.trackId,80)||null,pitch=text(req.body?.pitch,3000);if(!channelId||!releaseId)return res.status(400).json({error:"channel_and_release_required"});
    const owned=await ownedReleaseContext(req.user.id,releaseId,trackId);if(!owned)return res.status(404).json({error:"release_or_track_not_found"});
    const channelQ=await pool.query(`SELECT c.*,p.id AS profile_id,p.owner_user_id,p.status AS profile_status,p.display_name,p.organization,p.curator_type FROM curator_channels c JOIN curator_profiles p ON p.id=c.curator_profile_id WHERE c.id=$1 AND c.active=true AND p.status='active' LIMIT 1`,[channelId]);const ch=channelQ.rows[0];if(!ch)return res.status(404).json({error:"curator_channel_not_available"});if(String(ch.owner_user_id)===String(req.user.id))return res.status(400).json({error:"cannot_submit_to_self"});
    const ctxQ=await pool.query(`SELECT * FROM curator_match_contexts WHERE owner_user_id=$1 AND release_id=$2 AND track_id IS NOT DISTINCT FROM $3::uuid ORDER BY updated_at DESC LIMIT 1`,[req.user.id,releaseId,trackId]);const normalized=ctxQ.rows[0]?.normalized||normalizeMatchContext({release:owned.release,track:owned.track});
    const statsRows=await pool.query(`SELECT status,submitted_at,responded_at FROM curator_submissions WHERE curator_profile_id=$1`,[ch.profile_id]);const stats=curatorStats(statsRows.rows);const match=scoreCuratorMatch(normalized,channelRow(ch),stats);if(!match.eligible)return res.status(400).json({error:"submission_not_eligible",detail:match.misses?.[0]||"Not eligible"});
    const client=await pool.connect();try{await client.query("BEGIN");const wallet=await ensureWallet(req.user.id,client);const cost=Number(ch.submission_cost_credits||0);if(Number(wallet.balance)<cost){await client.query("ROLLBACK");return res.status(402).json({error:"insufficient_curator_credits",balance:Number(wallet.balance),required:cost,purchaseProviderConfigured:false});}
      const existing=await client.query(`SELECT 1 FROM curator_submissions WHERE artist_user_id=$1 AND curator_channel_id=$2 AND release_id=$3 AND track_id IS NOT DISTINCT FROM $4::uuid LIMIT 1`,[req.user.id,channelId,releaseId,trackId]);if(existing.rows[0]){await client.query("ROLLBACK");return res.status(409).json({error:"submission_already_exists"});}
      if(cost>0){await client.query(`UPDATE curator_wallets SET balance=balance-$2,lifetime_spent=lifetime_spent+$2,updated_at=now() WHERE owner_user_id=$1`,[req.user.id,cost]);}
      const id=crypto.randomUUID(),expires=new Date(Date.now()+Number(ch.response_days||7)*86400000);const snap={...owned,curator:{profileId:String(ch.profile_id),displayName:ch.display_name,channelId:String(ch.id),channelName:ch.name,platform:ch.platform},policy:"Credits purchase review consideration only; acceptance and placement remain independent editorial decisions."};
      const ins=await client.query(`INSERT INTO curator_submissions(id,artist_user_id,curator_profile_id,curator_channel_id,release_id,track_id,match_context_id,pitch,credits_spent,match_snapshot,release_snapshot,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12) RETURNING *`,[id,req.user.id,ch.profile_id,ch.id,releaseId,trackId,ctxQ.rows[0]?.id||null,pitch,cost,JSON.stringify(match),JSON.stringify(snap),expires]);
      if(cost>0)await client.query(`INSERT INTO curator_credit_ledger(id,owner_user_id,amount,reason,reference_type,reference_id,metadata) VALUES($1,$2,$3,'submission_review_credit','submission',$4,$5::jsonb)`,[crypto.randomUUID(),req.user.id,-cost,id,JSON.stringify({channelName:ch.name,nonCash:STARTER_CREDITS>0})]);
      await client.query("COMMIT");res.status(201).json({submission:submissionRow(ins.rows[0]),policy:snap.policy});
    }catch(e){await client.query("ROLLBACK");throw e;}finally{client.release();}
  });

  app.get(`${ROOT}/submissions`,requireAuth,async(req,res)=>{await expireOverdue();const {rows}=await pool.query(`SELECT s.*,p.display_name,p.organization,p.curator_type,c.name AS channel_name,c.platform AS channel_platform FROM curator_submissions s JOIN curator_profiles p ON p.id=s.curator_profile_id JOIN curator_channels c ON c.id=s.curator_channel_id WHERE s.artist_user_id=$1 ORDER BY s.submitted_at DESC`,[req.user.id]);res.json({submissions:rows.map(r=>({...submissionRow(r),curator:{displayName:r.display_name,organization:r.organization,curatorType:r.curator_type,channelName:r.channel_name,platform:r.channel_platform}}))});});

  app.post(`${ROOT}/submissions/:id/withdraw`,requireAuth,async(req,res)=>{const client=await pool.connect();try{await client.query("BEGIN");const q=await client.query(`SELECT * FROM curator_submissions WHERE id=$1 AND artist_user_id=$2 FOR UPDATE`,[req.params.id,req.user.id]);const row=q.rows[0];if(!row){await client.query("ROLLBACK");return res.status(404).json({error:"submission_not_found"});}if(!["pending"].includes(row.status)){await client.query("ROLLBACK");return res.status(409).json({error:"submission_already_opened_or_resolved"});}await client.query(`UPDATE curator_submissions SET status='withdrawn',updated_at=now() WHERE id=$1`,[row.id]);await refundSubmission(client,row,"artist_withdrawn_before_review");await client.query("COMMIT");res.json({ok:true,refunded:Number(row.credits_spent||0)});}catch(e){await client.query("ROLLBACK");throw e;}finally{client.release();}});

  app.get(`${ROOT}/desk/submissions`,requireAuth,async(req,res)=>{await expireOverdue();const p=await pool.query(`SELECT * FROM curator_profiles WHERE owner_user_id=$1 LIMIT 1`,[req.user.id]);if(!p.rows[0])return res.json({profile:null,submissions:[],stats:curatorStats([])});const {rows}=await pool.query(`SELECT s.*,c.name AS channel_name,c.platform AS channel_platform FROM curator_submissions s JOIN curator_channels c ON c.id=s.curator_channel_id WHERE s.curator_profile_id=$1 ORDER BY CASE s.status WHEN 'pending' THEN 0 WHEN 'in_review' THEN 1 ELSE 2 END,s.submitted_at ASC`,[p.rows[0].id]);res.json({profile:profileRow(p.rows[0]),submissions:rows.map(r=>({...submissionRow(r),channel:{name:r.channel_name,platform:r.channel_platform}})),stats:curatorStats(rows)});});

  app.post(`${ROOT}/desk/submissions/:id/open`,requireAuth,async(req,res)=>{const {rows}=await pool.query(`UPDATE curator_submissions s SET status=CASE WHEN s.status='pending' THEN 'in_review' ELSE s.status END,opened_at=COALESCE(s.opened_at,now()),updated_at=now() FROM curator_profiles p WHERE s.id=$1 AND s.curator_profile_id=p.id AND p.owner_user_id=$2 AND s.status IN ('pending','in_review') RETURNING s.*`,[req.params.id,req.user.id]);if(!rows[0])return res.status(404).json({error:"submission_not_openable"});res.json({submission:submissionRow(rows[0])});});

  app.post(`${ROOT}/desk/submissions/:id/respond`,requireAuth,async(req,res)=>{const decision=text(req.body?.decision,30);if(!DECISIONS.includes(decision))return res.status(400).json({error:"invalid_decision"});const feedback={summary:text(req.body?.summary,3000),fit:text(req.body?.fit,1000),production:text(req.body?.production,1000),originality:text(req.body?.originality,1000),reasonCode:text(req.body?.reasonCode,80),privateNote:text(req.body?.privateNote,2000)};const {rows}=await pool.query(`UPDATE curator_submissions s SET status=$3,feedback=$4::jsonb,opened_at=COALESCE(s.opened_at,now()),responded_at=now(),updated_at=now() FROM curator_profiles p WHERE s.id=$1 AND s.curator_profile_id=p.id AND p.owner_user_id=$2 AND s.status IN ('pending','in_review') RETURNING s.*`,[req.params.id,req.user.id,decision,JSON.stringify(feedback)]);if(!rows[0])return res.status(404).json({error:"submission_not_respondable"});res.json({submission:submissionRow(rows[0]),policy:"Decision is editorial. No fee or credit guarantees acceptance or placement."});});

  app.post(`${ROOT}/desk/submissions/:id/placement`,requireAuth,async(req,res)=>{const status=text(req.body?.status,30);if(!PLACEMENT_STATUSES.includes(status))return res.status(400).json({error:"invalid_placement_status"});const url=req.body?.url?safeUrl(req.body.url):"";if(status==="published"&&!url)return res.status(400).json({error:"published_placement_url_required"});const {rows}=await pool.query(`UPDATE curator_submissions s SET placement_status=$3,placement_url=$4,updated_at=now() FROM curator_profiles p WHERE s.id=$1 AND s.curator_profile_id=p.id AND p.owner_user_id=$2 AND s.status='accepted' RETURNING s.*`,[req.params.id,req.user.id,status,url]);if(!rows[0])return res.status(404).json({error:"accepted_submission_not_found"});res.json({submission:submissionRow(rows[0])});});

  app.post(`${ROOT}/reports`,requireAuth,async(req,res)=>{const curatorProfileId=text(req.body?.curatorProfileId,80),submissionId=text(req.body?.submissionId,80)||null,reason=text(req.body?.reason,120),detail=text(req.body?.detail,3000);if(!curatorProfileId||!reason)return res.status(400).json({error:"curator_and_reason_required"});const {rows}=await pool.query(`INSERT INTO curator_reports(id,reporter_user_id,curator_profile_id,submission_id,reason,detail) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[crypto.randomUUID(),req.user.id,curatorProfileId,submissionId,reason,detail]);res.status(201).json({report:{id:String(rows[0].id),status:rows[0].status,createdAt:rows[0].created_at}});});
}
