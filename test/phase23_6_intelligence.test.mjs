import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPromotionIntelligence } from '../src/promotion/intelligence.mjs';

function creative(id,label,bg,spend,outcome,views=80){return {id,snippetLabel:label,snippetStartSeconds:id==='a'?30:90,snippetDurationSeconds:30,backgroundName:bg,backgroundMetadata:{},ysong:{views,clicks:outcome,emailCaptures:0,conversions:0},meta:{spend,impressions:5000,outboundClicks:120}};}
const analytics={
  adCampaign:{goal:'song_growth',currency:'USD'}, range:{since:'2026-09-01',until:'2026-09-10'},
  meta:{summary:{impressions:20000,outboundClicks:500,frequency:2.2,spend:100},daily:[
    {dateStart:'2026-09-01',impressions:3000,outboundClicks:100,spend:15},{dateStart:'2026-09-02',impressions:3000,outboundClicks:100,spend:15},
    {dateStart:'2026-09-09',impressions:3000,outboundClicks:70,spend:18},{dateStart:'2026-09-10',impressions:3000,outboundClicks:65,spend:18}],
    placements:[{publisherPlatform:'instagram',platformPosition:'reels',outboundClicks:100,spend:10,impressions:6000},{publisherPlatform:'facebook',platformPosition:'feed',outboundClicks:50,spend:20,impressions:4000}],
    countries:[{country:'DE',outboundClicks:80,spend:8,impressions:5000},{country:'FR',outboundClicks:30,spend:18,impressions:3000}]},
  ysong:{totals:{views:420,clicks:180,emailCaptures:8,conversions:3},destinations:[{id:'spotify',label:'Spotify',platform:'spotify',clicks:100,visitors:90},{id:'apple',label:'Apple Music',platform:'apple',clicks:40,visitors:38}],creatives:[]},
  derived:{currency:'USD',spend:100,destinations:[{id:'spotify',label:'Spotify',platform:'spotify',clicks:100,visitors:90},{id:'apple',label:'Apple Music',platform:'apple',clicks:40,visitors:38}],creatives:[creative('a','Chorus','neon.mp4',10,60),creative('b','Verse','neon.mp4',30,15),creative('c','Chorus','cathedral.mp4',12,55),creative('d','Verse','cathedral.mp4',28,14)]}
};
analytics.ysong.creatives=analytics.derived.creatives;

test('promotion intelligence remains advisory and deterministic',()=>{
  const out=buildPromotionIntelligence(analytics);
  assert.equal(out.engine.learnedModel,false);
  assert.match(out.engine.version,/23\.6/);
  assert.ok(out.guardrails.some(x=>x.includes('does not automatically')));
  assert.ok(out.recommendations.some(x=>x.entityType==='creative'&&x.kind==='winner'));
  assert.ok(out.recommendations.some(x=>x.entityType==='snippet'));
  assert.ok(out.recommendations.some(x=>x.entityType==='placement'));
});

test('tiny samples are not promoted as winners',()=>{
  const small=structuredClone(analytics);
  small.meta.summary={impressions:80,outboundClicks:3,spend:1};
  small.ysong.totals={views:3,clicks:1,emailCaptures:0,conversions:0};
  small.derived.creatives=small.derived.creatives.map(c=>({...c,meta:{...c.meta,spend:.2},ysong:{...c.ysong,views:1,clicks:c.id==='a'?1:0}}));
  small.ysong.creatives=small.derived.creatives;
  const out=buildPromotionIntelligence(small);
  assert.ok(out.recommendations.some(x=>x.kind==='learning'));
  assert.equal(out.recommendations.some(x=>x.kind==='winner'&&x.entityType==='creative'),false);
});
