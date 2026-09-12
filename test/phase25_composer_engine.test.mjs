import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeComposerControls, normalizeArrangement, normalizeProposal,
  arrangementPrompt, proposalPrompt,
} from '../src/composer/engine.mjs';

test('controls clamp into a stable musical universe',()=>{
  const c=normalizeComposerControls({bpm:999,keyRoot:-1,scaleId:'phrygian',sigNum:4,sigDen:4,totalBars:64,bars:8,complexity:2,humanization:-2,role:'bassline'});
  assert.equal(c.bpm,400);
  assert.equal(c.keyRoot,0);
  assert.equal(c.scaleId,'phrygian');
  assert.equal(c.complexity,1);
  assert.equal(c.humanization,0);
  assert.equal(c.role,'bassline');
});

test('arrangement is proposal-only and accepts known roles',()=>{
  const c=normalizeComposerControls({bpm:138,keyRoot:4,keyLabel:'E Phrygian',scaleId:'phrygian',totalBars:64});
  const a=normalizeArrangement({title:'Dark trance',totalBars:64,summary:'shape',sections:[{name:'Intro',startBar:1,endBar:8},{name:'Drop',startBar:9,endBar:32}],roles:[{role:'drums',label:'Drums',entryBar:1,endBar:64},{role:'bassline',label:'Bass',entryBar:9,endBar:64}]},c);
  assert.equal(a.sections.length,2);
  assert.deepEqual(a.roles.map(x=>x.role),['drums','bassline']);
  assert.match(arrangementPrompt(c,{}),/DO NOT create tracks or audio/);
});

test('tonal proposal notes are snapped into requested scale and range',()=>{
  const c=normalizeComposerControls({bpm:138,keyRoot:4,keyLabel:'E Phrygian',scaleId:'phrygian',role:'melody',bars:8});
  const p=normalizeProposal({label:'Lead',notes:[{pitch:66,startBars:0,lengthBars:.5,velocity:100},{pitch:127,startBars:1,lengthBars:.5,velocity:90}]},c,'generate');
  const allowed=[4,5,7,9,11,0,2];
  for(const note of p.notes){
    assert.ok(note.pitch>=60 && note.pitch<=96);
    assert.ok(allowed.includes(note.pitch%12));
  }
});

test('drum pitches are not scale-snapped',()=>{
  const c=normalizeComposerControls({keyRoot:0,scaleId:'major',role:'drums',bars:4});
  const p=normalizeProposal({notes:[{pitch:36,startBars:0,lengthBars:.25,velocity:110},{pitch:42,startBars:.5,lengthBars:.25,velocity:90}]},c,'generate');
  assert.deepEqual(p.notes.map(x=>x.pitch),[36,42]);
});

test('continue action is exactly eight bars and starts after source',()=>{
  const c=normalizeComposerControls({role:'arpeggio',bars:4,startBar:1});
  const source={role:'arpeggio',startBar:5,lengthBars:4,notes:[{pitch:60,startBars:0,lengthBars:.25,velocity:90}]};
  const p=normalizeProposal({notes:[{pitch:62,startBars:0,lengthBars:.25,velocity:90}]},c,'continue_8_bars',source);
  assert.equal(p.startBar,9);
  assert.equal(p.lengthBars,8);
  assert.match(proposalPrompt({controls:c,arrangement:{sections:[]},action:'continue_8_bars',sourceProposal:source}),/Continue the source naturally for exactly 8 bars/);
});

test('harmony and bass derivation force their target role',()=>{
  const c=normalizeComposerControls({role:'melody',bars:4});
  const source={role:'melody',startBar:1,lengthBars:4,notes:[{pitch:60,startBars:0,lengthBars:1,velocity:90}]};
  assert.equal(normalizeProposal({notes:[{pitch:64,startBars:0,lengthBars:1,velocity:80}]},c,'harmony',source).role,'harmony');
  assert.equal(normalizeProposal({notes:[{pitch:40,startBars:0,lengthBars:1,velocity:90}]},c,'bass_from_this',source).role,'bassline');
});
