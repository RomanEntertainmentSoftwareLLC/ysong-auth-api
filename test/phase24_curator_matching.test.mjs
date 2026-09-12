import test from "node:test";
import assert from "node:assert/strict";
import { curatorStats, normalizeMatchContext, scoreCuratorMatch } from "../src/curators/matching.mjs";

const intelligence={
  genre:{primary_genre:"electronic",primary_subgenre:"gothic symphonic trance",candidates:[{genre:"trance"},{genre:"symphonic trance"}]},
  mood:{candidates:[{label:"dark",relative_strength:.84},{label:"cinematic",relative_strength:.76}]},
  energy:{primary:{label:"high energy"}},
  tempo:{estimated_bpm:138},key:{estimated_key:"D minor"},presence:{vocal:.83,tags:[{label:"female vocal",relative_strength:.91},{label:"orchestral strings",relative_strength:.72}]},
  sonic_fingerprint:{cues:[{name:"supersaw",strength:.81},{name:"orchestral strings",strength:.77}]},explicit_content:{explicit:false},downstream_metadata:{consumer_targets:["trance listeners"]},
};

test("normalizes one reusable Audio Intelligence + SEO match context",()=>{
  const ctx=normalizeMatchContext({release:{genre:"Trance"},track:{genre:"Trance",tags:["gothic"],explicit:false},audioIntelligence:intelligence,seoSnapshot:{scores:{opportunity:72},keywordIdeas:[{term:"gothic trance playlist"}]}});
  assert.equal(ctx.genre,"gothic symphonic trance");
  assert.equal(ctx.bpm,138);
  assert.ok(ctx.moods.includes("dark"));
  assert.ok(ctx.sonicTags.includes("female vocal"));
  assert.ok(ctx.seoKeywords.includes("gothic trance playlist"));
});

test("strong editorial fit scores above weak unrelated channel",()=>{
  const ctx=normalizeMatchContext({release:{genre:"Trance"},track:{genre:"Trance",tags:["gothic"]},audioIntelligence:intelligence,seoSnapshot:{keywordIdeas:[{term:"gothic trance playlist"}]}});
  const stats={responseRate:.92,responded:30,reputation:.85};
  const strong=scoreCuratorMatch(ctx,{genres:["gothic symphonic trance","trance"],moods:["dark","cinematic"],sonicTags:["female vocal","supersaw"],minBpm:130,maxBpm:145,acceptsExplicit:true},stats);
  const weak=scoreCuratorMatch(ctx,{genres:["country","bluegrass"],moods:["sunny"],sonicTags:["banjo"],minBpm:80,maxBpm:110,acceptsExplicit:true},stats);
  assert.ok(strong.score>weak.score+30,{strong,weak});
  assert.equal(strong.eligible,true);
});

test("explicit incompatibility is a hard eligibility block",()=>{
  const ctx={...normalizeMatchContext({audioIntelligence:intelligence}),explicit:true};
  const match=scoreCuratorMatch(ctx,{genres:["trance"],moods:[],sonicTags:[],acceptsExplicit:false},{responseRate:1,responded:100,reputation:1});
  assert.equal(match.eligible,false);
  assert.equal(match.score,0);
});

test("curator stats are descriptive and sample-size-aware",()=>{
  const rows=[
    {status:"accepted",submitted_at:"2026-01-01T00:00:00Z",responded_at:"2026-01-02T00:00:00Z"},
    {status:"rejected",submitted_at:"2026-01-01T00:00:00Z",responded_at:"2026-01-03T00:00:00Z"},
    {status:"pending",submitted_at:"2026-01-04T00:00:00Z",responded_at:null},
  ];
  const s=curatorStats(rows);
  assert.equal(s.total,3); assert.equal(s.responded,2); assert.equal(s.accepted,1);
  assert.equal(s.acceptanceRate,.5); assert.ok(s.responseRate>.66&&s.responseRate<.67);
  assert.ok(s.sampleConfidence<.1);
});
