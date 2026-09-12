import assert from 'node:assert/strict';
import {
  normalizeSoundContext, normalizeInstrumentCandidates, normalizeSoundParameters,
  parseSoundPlanResponse, parseSoundStepResponse, soundPlanPrompt, soundStepPrompt, describeSynthSurface,
} from '../src/soundDesigner/engine.mjs';

const candidates=[
  {score:94,matchedTerms:['icy','pluck'],instrument:{id:'inst-vital',name:'Vital',vendor:'Vital Audio',tags:['synth','wavetable','digital','pluck'],category:'Instrument'},bestPresets:[]},
  {score:71,matchedTerms:['digital'],instrument:{id:'inst-reaktor',name:'Reaktor 6',vendor:'Native Instruments',tags:['synth','digital','experimental'],category:'Instrument'},bestPresets:[]},
];
const context=normalizeSoundContext({desired:'icy demonic pluck that does not interfere with the vocal',role:'lead',bpm:138,vocalLowHz:180,vocalHighHz:4200});
assert.equal(context.bpm,138);
assert.equal(normalizeInstrumentCandidates(candidates).length,2);
assert.match(soundPlanPrompt(context,candidates),/installed instrument/i);
const plan=parseSoundPlanResponse(JSON.stringify({instrumentId:'inst-vital',reason:'Best wavetable starting point',targetTraits:['icy','pluck'],avoidTraits:['muddy'],audition:{durationSeconds:3,notes:[{note:60,velocity:100,startSeconds:.05,durationSeconds:.45}]}}),candidates);
assert.equal(plan.instrumentId,'inst-vital');
assert.throws(()=>parseSoundPlanResponse('{"instrumentId":"invented"}',candidates),/unknown_instrument/);

const parameters=[
  {id:1,name:'Filter Cutoff',minValue:0,maxValue:1,defaultValue:.5,currentValue:.2,group:'Filter',tags:['filter','cutoff']},
  {id:2,name:'Resonance',minValue:0,maxValue:1,defaultValue:.2,currentValue:.1,group:'Filter',tags:['filter','resonance']},
  {id:3,name:'Preset Bank',minValue:0,maxValue:127,defaultValue:0,currentValue:0,group:'Other',tags:[]},
  {id:4,name:'Attack',minValue:0,maxValue:1,defaultValue:.1,currentValue:.5,group:'Envelope',tags:['attack']},
];
const safe=normalizeSoundParameters(parameters);
assert.deepEqual(safe.map(x=>x.id),[1,2,4]);
const profile=describeSynthSurface({name:'Massive',vendor:'Native Instruments'},parameters);
assert.equal(profile.mappingMode,'known-family-guidance-plus-live-parameter-inference');
assert.ok(profile.exposedDomains.includes('filter'));
assert.ok(profile.exposedDomains.includes('envelope'));
assert.match(soundStepPrompt({context,instrument:candidates[0].instrument,parameters,audition:{spectralCentroidHz:1400,highEnergyRatio:.12},history:[]}),/35%/);
const step=parseSoundStepResponse(JSON.stringify({evaluation:'Too dark and slow.',score:61,confidence:'high',done:false,changes:[
  {parameterId:1,targetValue:1,reason:'brighter'},
  {parameterId:3,targetValue:127,reason:'unsafe preset change'},
  {parameterId:4,targetValue:0,reason:'faster pluck'},
  {parameterId:999,targetValue:.5,reason:'invented'},
],nextAudition:{durationSeconds:3,notes:[]},nextFocus:'brightness and attack'}),parameters,{spectralCentroidHz:1400,highEnergyRatio:.12});
assert.equal(step.changes.length,2);
const cutoff=step.changes.find(x=>x.parameterId===1);
assert.ok(cutoff);
assert.ok(Math.abs(cutoff.targetValue-.55)<1e-9,'cutoff move should be capped to 35% of full range');
const attack=step.changes.find(x=>x.parameterId===4);
assert.ok(attack);
assert.ok(Math.abs(attack.targetValue-.15)<1e-9,'attack move should be capped down by 35%');
assert.equal(step.evaluationKind,'model-guided-from-dsp-metrics');
assert.equal(step.confidence,'high');
console.log('Phase 27 backend engine tests: PASS');
