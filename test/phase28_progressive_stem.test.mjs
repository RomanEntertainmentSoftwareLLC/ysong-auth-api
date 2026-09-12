import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  findStaleDependents, makeAudioStemManifest, normalizeStemRequest, normalizeStemUniverse,
  parseMidiStemResponse, stemUniverseHash,
} from '../src/stemComposer/engine.mjs';
import { normalizeGeneratedAudioFile } from '../src/stemComposer/routes.mjs';

const baseUniverse={songId:'song-1',generationFamily:'family-a',generationSeed:'seed-a',bpm:120,keyRoot:9,keyLabel:'A Natural Minor',scaleId:'natural-minor',sigNum:4,sigDen:4,totalBars:8,sampleRate:48000,sectionMap:[{name:'Verse',startBar:1,endBar:4},{name:'Chorus',startBar:5,endBar:8}],chordMap:[{atBar:1,symbol:'Am',durationBars:2},{atBar:3,symbol:'F',durationBars:2}],locked:true};

test('locks immutable universe with stable hash and exact duration',()=>{
  const a=normalizeStemUniverse(baseUniverse); const b=normalizeStemUniverse({...baseUniverse});
  assert.equal(a.universeHash,b.universeHash); assert.equal(a.universeHash,stemUniverseHash(a));
  assert.equal(a.exactDurationSec,16); assert.equal(a.totalBars,8); assert.equal(a.sampleRate,48000);
});

test('rejects dependency from another song universe',()=>{
  const u=normalizeStemUniverse(baseUniverse);
  assert.throws(()=>normalizeStemRequest({universe:u,targetRole:'bass',mode:'midi',dependencies:[{nodeId:'drums',role:'drums',mode:'midi',version:1,universeHash:'wrong'}]}),/stem_dependency_universe_mismatch/);
});

test('MIDI response is target-only, full timeline, and scale normalized',()=>{
  const u=normalizeStemUniverse(baseUniverse);
  const request={universe:u,targetRole:'bass',mode:'midi',desired:'dark bass',dependencies:[{nodeId:'drums',role:'drums',mode:'midi',version:1,universeHash:u.universeHash,notes:[{pitch:36,startBars:0,lengthBars:.25,velocity:100}]}],version:1,generationSeed:'seed-a:bass:1'};
  const proposal=parseMidiStemResponse(JSON.stringify({role:'bass',label:'Bass',notes:[{pitch:61,startBars:0,lengthBars:.5,velocity:90},{pitch:40,startBars:7.9,lengthBars:2,velocity:100}],explanation:'locks to drums'}),request);
  assert.equal(proposal.role,'bass'); assert.equal(proposal.mode,'midi'); assert.equal(proposal.startBar,1); assert.equal(proposal.lengthBars,8); assert.equal(proposal.exactDurationSec,16);
  assert.equal(proposal.dependsOn.length,1); assert.ok(proposal.notes.every(n=>n.startBars>=0&&n.startBars<8)); assert.ok(proposal.notes.every(n=>n.lengthBars<=8-n.startBars+1e-9));
  const pcs=new Set([9,11,0,2,4,5,7]); assert.ok(proposal.notes.every(n=>pcs.has(((n.pitch%12)+12)%12)));
  assert.throws(()=>parseMidiStemResponse(JSON.stringify({role:'lead',notes:[{pitch:60,startBars:0,lengthBars:1,velocity:90}]}),request),/stem_composer_wrong_target_role/);
});

test('audio manifest demands target-only exact-timeline output',()=>{
  const u=normalizeStemUniverse(baseUniverse);
  const manifest=makeAudioStemManifest({universe:u,targetRole:'choir',mode:'audio',desired:'dark choir',negative:['bright'],dependencies:[],version:1,generationSeed:'seed-a:choir:1'});
  assert.equal(manifest.task,'generate_target_stem'); assert.equal(manifest.target.role,'choir'); assert.equal(manifest.output.stemOnly,true); assert.equal(manifest.output.exactDurationSec,16); assert.equal(manifest.output.sampleRate,48000); assert.match(manifest.target.negative.join(' '),/Do not include a full mix/);
});

test('dependency graph marks descendants stale when parent version changes',()=>{
  const nodes=[
    {nodeId:'drums',version:1,dependsOn:[]},
    {nodeId:'bass',version:1,dependsOn:[{nodeId:'drums',version:1}]},
    {nodeId:'piano',version:1,dependsOn:[{nodeId:'drums',version:1},{nodeId:'bass',version:1}]},
    {nodeId:'strings',version:1,dependsOn:[{nodeId:'piano',version:1}]},
  ];
  const stale=findStaleDependents(nodes,'bass',2);
  assert.ok(stale.includes('piano')); assert.ok(stale.includes('strings')); assert.ok(!stale.includes('drums'));
});

test('audio normalization enforces exact duration, stereo, and sample rate',async()=>{
  const tmp=await fs.promises.mkdtemp(path.join(os.tmpdir(),'ysong-phase28-test-'));
  try{
    const input=path.join(tmp,'input.wav'),output=path.join(tmp,'output.wav');
    const ff=spawnSync('ffmpeg',['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','sine=frequency=440:sample_rate=44100:duration=1.75','-ac','1',input],{encoding:'utf8'});
    assert.equal(ff.status,0,ff.stderr);
    const info=await normalizeGeneratedAudioFile(input,output,{exactDurationSec:3,sampleRate:48000});
    assert.equal(info.sampleRate,48000); assert.equal(info.channels,2); assert.ok(Math.abs(info.durationSec-3)<.05); assert.ok(fs.existsSync(output));
  }finally{await fs.promises.rm(tmp,{recursive:true,force:true});}
});
