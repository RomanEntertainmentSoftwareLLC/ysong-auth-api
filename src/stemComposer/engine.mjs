import crypto from 'node:crypto';

export const STEM_ROLES = ['drums','bass','piano','strings','lead','vocals','guitar','choir','atmosphere','percussion','fx'];
export const STEM_MODES = ['midi','audio'];
export const STEM_PREFERRED_MODE = {
  drums:'midi', bass:'midi', piano:'midi', strings:'midi', lead:'midi', vocals:'audio', guitar:'audio', choir:'audio', atmosphere:'audio', percussion:'audio', fx:'audio',
};
const SCALE_IDS = new Set(['chromatic','major','natural-minor','dorian','phrygian','lydian','mixolydian','locrian','harmonic-minor','melodic-minor','phrygian-dominant','major-pentatonic','minor-pentatonic','blues']);
const SCALE_INTERVALS = {
  chromatic:[0,1,2,3,4,5,6,7,8,9,10,11], major:[0,2,4,5,7,9,11], 'natural-minor':[0,2,3,5,7,8,10], dorian:[0,2,3,5,7,9,10],
  phrygian:[0,1,3,5,7,8,10], lydian:[0,2,4,6,7,9,11], mixolydian:[0,2,4,5,7,9,10], locrian:[0,1,3,5,6,8,10],
  'harmonic-minor':[0,2,3,5,7,8,11], 'melodic-minor':[0,2,3,5,7,9,11], 'phrygian-dominant':[0,1,4,5,7,8,10],
  'major-pentatonic':[0,2,4,7,9], 'minor-pentatonic':[0,3,5,7,10], blues:[0,3,5,6,7,10],
};
const ROLE_RANGES = { drums:[35,81], bass:[24,60], piano:[28,100], strings:[36,96], lead:[48,100], vocals:[48,96], guitar:[36,96], choir:[36,96], atmosphere:[24,108], percussion:[35,81], fx:[24,108] };

function clamp(v,min,max,fallback=min){const n=Number(v);return Number.isFinite(n)?Math.max(min,Math.min(max,n)):fallback;}
function int(v,min,max,fallback=min){return Math.round(clamp(v,min,max,fallback));}
function text(v,max=400){return String(v??'').trim().slice(0,max);}
function uniq(values,limit=64,max=140){return [...new Set((Array.isArray(values)?values:[]).map(v=>text(v,max)).filter(Boolean))].slice(0,limit);}
function jsonObject(raw){const s=String(raw??'').trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');const a=s.indexOf('{'),b=s.lastIndexOf('}');if(a<0||b<=a)throw Object.assign(new Error('stem_composer_ai_invalid_json'),{statusCode:502});try{return JSON.parse(s.slice(a,b+1));}catch{throw Object.assign(new Error('stem_composer_ai_invalid_json'),{statusCode:502});}}
function scaleId(v){return SCALE_IDS.has(String(v))?String(v):'natural-minor';}
function roleId(v){const r=String(v);return STEM_ROLES.includes(r)?r:'lead';}
function modeId(v,role){const m=String(v);return STEM_MODES.includes(m)?m:STEM_PREFERRED_MODE[roleId(role)];}
function pitchAllowed(pitch,root,scale){const pc=((Math.round(pitch)%12)+12)%12;const rel=((pc-root)%12+12)%12;return SCALE_INTERVALS[scale].includes(rel);}
function nearestAllowed(pitch,root,scale,lo,hi){const p=int(pitch,lo,hi,lo);if(pitchAllowed(p,root,scale))return p;for(let d=1;d<=12;d++){if(p-d>=lo&&pitchAllowed(p-d,root,scale))return p-d;if(p+d<=hi&&pitchAllowed(p+d,root,scale))return p+d;}return p;}

export function exactSongDurationSec(universe){const u=normalizeStemUniverse(universe,{requireLocked:false});const quarterSec=60/u.bpm;const barQuarters=u.sigNum*(4/u.sigDen);return u.totalBars*barQuarters*quarterSec;}

export function normalizeStemUniverse(raw={}, { requireLocked=true }={}) {
  const keyRoot=int(raw.keyRoot,0,11,0); const scale=scaleId(raw.scaleId);
  const totalBars=int(raw.totalBars,1,512,64);
  const u={
    songId:text(raw.songId,160)||`song_${crypto.randomUUID()}`,
    generationFamily:text(raw.generationFamily,160)||`family_${crypto.randomUUID()}`,
    generationSeed:text(raw.generationSeed,160)||crypto.randomBytes(8).toString('hex'),
    bpm:clamp(raw.bpm,20,400,120), keyRoot, keyLabel:text(raw.keyLabel,100)||`root-${keyRoot} ${scale}`, scaleId:scale,
    sigNum:int(raw.sigNum,1,32,4), sigDen:[1,2,4,8,16].includes(Number(raw.sigDen))?Number(raw.sigDen):4,
    totalBars, sampleRate:[44100,48000,88200,96000].includes(Number(raw.sampleRate))?Number(raw.sampleRate):48000,
    sectionMap:(Array.isArray(raw.sectionMap)?raw.sectionMap:[]).slice(0,64).map((s,i)=>({name:text(s?.name,100)||`Section ${i+1}`,startBar:clamp(s?.startBar,1,totalBars,1),endBar:clamp(s?.endBar,1,totalBars,totalBars)})).map(s=>({...s,endBar:Math.max(s.startBar,s.endBar)})),
    chordMap:(Array.isArray(raw.chordMap)?raw.chordMap:[]).slice(0,512).map(c=>({atBar:clamp(c?.atBar,1,totalBars,1),symbol:text(c?.symbol,40),durationBars:clamp(c?.durationBars,.125,totalBars,1)})).filter(c=>c.symbol),
    locked:raw.locked===true,
  };
  u.exactDurationSec=Number(exactDurationSecUnsafe(u).toFixed(6));
  u.universeHash=stemUniverseHash(u);
  if(requireLocked&&!u.locked)throw Object.assign(new Error('stem_universe_not_locked'),{statusCode:409});
  return u;
}
function exactDurationSecUnsafe(u){return u.totalBars*u.sigNum*(4/u.sigDen)*(60/u.bpm);}
export function stemUniverseHash(raw){const canonical={songId:text(raw.songId,160),generationFamily:text(raw.generationFamily,160),generationSeed:text(raw.generationSeed,160),bpm:Number(raw.bpm),keyRoot:Number(raw.keyRoot),keyLabel:text(raw.keyLabel,100),scaleId:text(raw.scaleId,40),sigNum:Number(raw.sigNum),sigDen:Number(raw.sigDen),totalBars:Number(raw.totalBars),sampleRate:Number(raw.sampleRate),sectionMap:raw.sectionMap||[],chordMap:raw.chordMap||[]};return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');}

export function normalizeStemDependencies(raw=[], universeHash='') {
  const seen=new Set(); const out=[];
  for(const dep of (Array.isArray(raw)?raw:[])){
    const nodeId=text(dep?.nodeId,160); if(!nodeId||seen.has(nodeId))continue; seen.add(nodeId);
    const role=roleId(dep?.role); const mode=modeId(dep?.mode,role);
    if(universeHash&&text(dep?.universeHash,128)!==universeHash)throw Object.assign(new Error('stem_dependency_universe_mismatch'),{statusCode:409});
    out.push({nodeId,role,mode,version:int(dep?.version,1,9999,1),universeHash:text(dep?.universeHash,128),label:text(dep?.label,120)||role,notes:(Array.isArray(dep?.notes)?dep.notes:[]).slice(0,2048).map(n=>({pitch:int(n?.pitch,0,127,60),startBars:clamp(n?.startBars,0,512,0),lengthBars:clamp(n?.lengthBars,1/128,512,.25),velocity:int(n?.velocity,1,127,96)})),audioUrl:text(dep?.audioUrl,4000),assetId:text(dep?.assetId,220),summary:text(dep?.summary,600)});
  }
  return out.slice(0,32);
}

export function normalizeStemRequest(raw={}) {
  const universe=normalizeStemUniverse(raw.universe||{}); const role=roleId(raw.targetRole); const mode=modeId(raw.mode,role);
  const dependencies=normalizeStemDependencies(raw.dependencies||[],universe.universeHash).filter(d=>d.role!==role);
  return {universe,targetRole:role,mode,desired:text(raw.desired,1000),negative:uniq(raw.negative,32,120),dependencies,version:int(raw.version,1,9999,1),generationSeed:text(raw.generationSeed,160)||`${universe.generationSeed}:${role}:${int(raw.version,1,9999,1)}`};
}

function compactDependencies(deps){return deps.map(d=>({nodeId:d.nodeId,role:d.role,mode:d.mode,version:d.version,label:d.label,summary:d.summary,notes:d.notes.slice(0,768),hasReferenceAudio:Boolean(d.audioUrl)}));}

export function midiStemPrompt(raw={}) {
  const r=normalizeStemRequest({...raw,mode:'midi'}); const u=r.universe;
  return `YSong PROGRESSIVE AI STEM COMPOSER — TARGET MIDI STEM\nReturn JSON only. Generate ONE requested stem and nothing else.\n\nSACRED SONG UNIVERSE\n${JSON.stringify(u)}\n\nHARD RULES\n- Output ONLY the ${r.targetRole} stem. Never generate another full mix, accompaniment mix, or other stems.\n- Absolute timeline sync is sacred. Clip starts at bar 1 and has exact length ${u.totalBars} bars (${u.exactDurationSec} seconds at the locked tempo/meter).\n- Silence is represented by simply having no notes during that region; do not shorten the clip.\n- Respect locked key/scale except drums/percussion/FX where MIDI pitches may represent articulations.\n- Condition musically on the APPROVED DEPENDENCIES below. Do not rewrite them.\n- generationFamily=${u.generationFamily}; generationSeed=${r.generationSeed}. Seed is lineage metadata; do not claim deterministic reproduction unless the provider supports it.\n- Prefer editable structured MIDI for this target.\n- Do not include audio, prose outside JSON, or multiple roles.\n\nTARGET\nrole=${r.targetRole}\ndirection=${JSON.stringify(r.desired)}\navoid=${JSON.stringify(r.negative)}\n\nAPPROVED DEPENDENCIES\n${JSON.stringify(compactDependencies(r.dependencies))}\n\nRETURN\n{"role":"${r.targetRole}","label":"...","notes":[{"pitch":60,"startBars":0,"lengthBars":0.25,"velocity":96}],"chords":[],"explanation":"how this stem complements the approved dependencies without duplicating them"}`;
}

export function parseMidiStemResponse(raw, requestRaw={}) {
  const req=normalizeStemRequest({...requestRaw,mode:'midi'}); const obj=jsonObject(raw); if(roleId(obj.role)!==req.targetRole)throw Object.assign(new Error('stem_composer_wrong_target_role'),{statusCode:502});
  const [lo,hi]=ROLE_RANGES[req.targetRole]||[0,127]; const tonal=!['drums','percussion','fx'].includes(req.targetRole);
  const notes=(Array.isArray(obj.notes)?obj.notes:[]).slice(0,8192).map(n=>{const rawPitch=int(n?.pitch,0,127,60);const pitch=tonal?nearestAllowed(rawPitch,req.universe.keyRoot,req.universe.scaleId,lo,hi):int(rawPitch,lo,hi,rawPitch);const startBars=clamp(n?.startBars,0,Math.max(0,req.universe.totalBars-1/128),0);return {pitch,startBars,lengthBars:clamp(n?.lengthBars,1/128,Math.max(1/128,req.universe.totalBars-startBars),.25),velocity:int(n?.velocity,1,127,96)};}).sort((a,b)=>a.startBars-b.startBars||a.pitch-b.pitch);
  if(!notes.length)throw Object.assign(new Error('stem_composer_ai_returned_no_notes'),{statusCode:502});
  return {id:`stemidea_${crypto.randomUUID()}`,role:req.targetRole,mode:'midi',label:text(obj.label,120)||req.targetRole,startBar:1,lengthBars:req.universe.totalBars,exactDurationSec:req.universe.exactDurationSec,universeHash:req.universe.universeHash,generationFamily:req.universe.generationFamily,generationSeed:req.generationSeed,version:req.version,dependsOn:req.dependencies.map(d=>({nodeId:d.nodeId,version:d.version,role:d.role})),notes,chords:(Array.isArray(obj.chords)?obj.chords:[]).slice(0,256).map(c=>({atBar:clamp(c?.atBar??c?.atBars,1,req.universe.totalBars,1),symbol:text(c?.symbol,40),durationBars:clamp(c?.durationBars,.125,64,1)})).filter(c=>c.symbol),explanation:text(obj.explanation,1400)};
}

export function makeAudioStemManifest(raw={}) {
  const req=normalizeStemRequest({...raw,mode:'audio'}); const u=req.universe;
  return {task:'generate_target_stem',contractVersion:'ysong-progressive-stem-v1',target:{role:req.targetRole,mode:'audio',desired:req.desired,negative:[...req.negative,`Do not render any non-${req.targetRole} stems`,`Do not include a full mix`,`Do not bake the approved reference stems into the output`]},timeline:{songId:u.songId,bpm:u.bpm,keyRoot:u.keyRoot,keyLabel:u.keyLabel,scaleId:u.scaleId,timeSignature:`${u.sigNum}/${u.sigDen}`,totalBars:u.totalBars,exactDurationSec:u.exactDurationSec,sampleRate:u.sampleRate,sectionMap:u.sectionMap,chordMap:u.chordMap},lineage:{universeHash:u.universeHash,generationFamily:u.generationFamily,generationSeed:req.generationSeed,version:req.version,dependsOn:req.dependencies.map(d=>({nodeId:d.nodeId,role:d.role,version:d.version}))},conditioning:{approvedStems:req.dependencies.map(d=>({nodeId:d.nodeId,role:d.role,mode:d.mode,version:d.version,label:d.label,summary:d.summary,referenceAudioUrl:d.audioUrl||undefined,midiNotes:d.notes.length?d.notes.slice(0,2048):undefined}))},output:{stemOnly:true,startSeconds:0,exactDurationSec:u.exactDurationSec,sampleRate:u.sampleRate,channels:2,preferredFormat:'wav'}};
}

export function findStaleDependents(nodesRaw=[], changedNodeId, changedVersion) {
  const nodes=Array.isArray(nodesRaw)?nodesRaw:[]; const stale=new Set();
  for(const n of nodes){const id=text(n?.nodeId,160);const deps=Array.isArray(n?.dependsOn)?n.dependsOn:[];if(id&&deps.some(d=>text(d?.nodeId,160)===text(changedNodeId,160)&&Number(d?.version)!==Number(changedVersion)))stale.add(id);}
  let changed=true;
  while(changed){changed=false;for(const n of nodes){const id=text(n?.nodeId,160);if(!id||stale.has(id))continue;const deps=Array.isArray(n?.dependsOn)?n.dependsOn:[];if(deps.some(d=>stale.has(text(d?.nodeId,160)))){stale.add(id);changed=true;}}}
  return [...stale];
}
