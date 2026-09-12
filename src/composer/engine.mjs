const SCALE_INTERVALS = {
  chromatic: [0,1,2,3,4,5,6,7,8,9,10,11],
  major: [0,2,4,5,7,9,11],
  'natural-minor': [0,2,3,5,7,8,10],
  dorian: [0,2,3,5,7,9,10],
  phrygian: [0,1,3,5,7,8,10],
  lydian: [0,2,4,6,7,9,11],
  mixolydian: [0,2,4,5,7,9,10],
  locrian: [0,1,3,5,6,8,10],
  'harmonic-minor': [0,2,3,5,7,8,11],
  'melodic-minor': [0,2,3,5,7,9,11],
  'phrygian-dominant': [0,1,4,5,7,8,10],
  'major-pentatonic': [0,2,4,7,9],
  'minor-pentatonic': [0,3,5,7,10],
  blues: [0,3,5,6,7,10],
};

export const COMPOSER_ROLES = [
  'melody','chords','bassline','arpeggio','countermelody','drums','strings','piano','atmosphere','harmony',
];
export const COMPOSER_ACTIONS = [
  'generate','regenerate','variation','simpler','more_melodic','darker','more_aggressive','continue_8_bars','harmony','bass_from_this',
];

const ROLE_RANGES = {
  melody: [60,96], chords: [45,84], bassline: [28,55], arpeggio: [48,96], countermelody: [55,91],
  drums: [35,81], strings: [43,88], piano: [36,96], atmosphere: [36,96], harmony: [55,96],
};

const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];

function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}
function int(value, min, max, fallback=min) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(clamp(n,min,max)) : fallback;
}
function text(value, max=300) { return String(value ?? '').trim().slice(0,max); }
function scaleId(value) { return Object.hasOwn(SCALE_INTERVALS, value) ? value : 'natural-minor'; }
function roleId(value) { return COMPOSER_ROLES.includes(value) ? value : 'melody'; }
function actionId(value) { return COMPOSER_ACTIONS.includes(value) ? value : 'generate'; }
function pitchAllowed(pitch, root, scale) {
  const pc = ((Math.round(pitch) % 12) + 12) % 12;
  const rel = ((pc - root) % 12 + 12) % 12;
  return SCALE_INTERVALS[scale].includes(rel);
}
function nearestAllowed(pitch, root, scale, lo, hi) {
  const p = int(pitch,lo,hi,lo);
  if (pitchAllowed(p,root,scale)) return p;
  for (let d=1; d<=12; d++) {
    const down=p-d, up=p+d;
    if (down>=lo && pitchAllowed(down,root,scale)) return down;
    if (up<=hi && pitchAllowed(up,root,scale)) return up;
  }
  return p;
}
function jsonObject(raw) {
  const source = String(raw ?? '').trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');
  const start=source.indexOf('{'), end=source.lastIndexOf('}');
  if (start<0 || end<=start) throw Object.assign(new Error('composer_ai_invalid_json'), { statusCode: 502 });
  try { return JSON.parse(source.slice(start,end+1)); }
  catch { throw Object.assign(new Error('composer_ai_invalid_json'), { statusCode: 502 }); }
}

export function normalizeComposerControls(raw={}) {
  const root=int(raw.keyRoot,0,11,0);
  const scale=scaleId(raw.scaleId);
  return {
    bpm:int(raw.bpm,20,400,120), keyRoot:root, keyLabel:text(raw.keyLabel,80) || `${NOTE_NAMES[root]} ${scale}`,
    scaleId:scale, sigNum:int(raw.sigNum,1,32,4), sigDen:[1,2,4,8,16].includes(Number(raw.sigDen)) ? Number(raw.sigDen) : 4,
    totalBars:int(raw.totalBars,4,512,64), bars:int(raw.bars,1,64,8), startBar:clamp(raw.startBar ?? 1,1,512),
    complexity:clamp(raw.complexity ?? 0.55,0,1), humanization:clamp(raw.humanization ?? 0.2,0,1),
    mood:text(raw.mood,180), style:text(raw.style,400), role:roleId(raw.role),
  };
}

export function normalizeArrangement(raw, controls) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const totalBars = int(source.totalBars ?? controls.totalBars,4,512,controls.totalBars);
  const sections = (Array.isArray(source.sections) ? source.sections : []).slice(0,32).map((s,i) => {
    const startBar=clamp(s?.startBar ?? 1,1,totalBars);
    const endBar=clamp(s?.endBar ?? Math.min(totalBars,startBar+7),startBar,totalBars);
    return { name:text(s?.name,80) || `Section ${i+1}`, startBar, endBar };
  }).sort((a,b)=>a.startBar-b.startBar);
  const roles = (Array.isArray(source.roles) ? source.roles : []).slice(0,24).map((r,i) => ({
    role:roleId(r?.role), label:text(r?.label,80) || roleId(r?.role), purpose:text(r?.purpose,240),
    entryBar:clamp(r?.entryBar ?? 1,1,totalBars), endBar:clamp(r?.endBar ?? totalBars,1,totalBars), priority:int(r?.priority,1,5,3), order:i,
  })).filter((r,idx,arr)=>arr.findIndex(x=>x.role===r.role)===idx).map(({order,...r})=>r);
  if (!sections.length) throw Object.assign(new Error('composer_arrangement_missing_sections'), { statusCode: 502 });
  if (!roles.length) throw Object.assign(new Error('composer_arrangement_missing_roles'), { statusCode: 502 });
  return {
    id:text(source.id,100) || `arr_${Date.now()}`,
    title:text(source.title,120) || 'Arrangement proposal', totalBars,
    summary:text(source.summary,1000), sections, roles,
  };
}

export function normalizeProposal(raw, controls, requestedAction='generate', sourceProposal=null) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const action=actionId(requestedAction);
  const forcedRole = action==='harmony' ? 'harmony' : action==='bass_from_this' ? 'bassline' : controls.role;
  const role=forcedRole;
  const [lo,hi]=ROLE_RANGES[role] || ROLE_RANGES.melody;
  const isContinue=action==='continue_8_bars';
  const startBar=isContinue && sourceProposal ? clamp(Number(sourceProposal.startBar||1)+Number(sourceProposal.lengthBars||0),1,512) : clamp(source.startBar ?? controls.startBar,1,512);
  const lengthBars=isContinue ? 8 : clamp(source.lengthBars ?? controls.bars,0.25,64);
  const rawNotes=Array.isArray(source.notes) ? source.notes : [];
  const maxNotes=Math.min(4096, Math.max(64, Math.round(lengthBars * (8 + controls.complexity*56))));
  const notes=rawNotes.slice(0,maxNotes).map((n,i)=>{
    const pitchRaw=int(n?.pitch,0,127,60);
    const pitch=role==='drums' ? int(pitchRaw,lo,hi,36) : nearestAllowed(pitchRaw,controls.keyRoot,controls.scaleId,lo,hi);
    const noteStart=clamp(n?.startBars ?? 0,0,Math.max(0,lengthBars-1/128));
    const noteLength=clamp(n?.lengthBars ?? 0.25,1/128,Math.max(1/128,lengthBars-noteStart));
    return { pitch, startBars:noteStart, lengthBars:noteLength, velocity:int(n?.velocity,1,127,96), order:i };
  }).sort((a,b)=>a.startBars-b.startBars || a.pitch-b.pitch).map(({order,...n})=>n);
  if (!notes.length) throw Object.assign(new Error('composer_ai_returned_no_notes'), { statusCode: 502 });
  const chords=(Array.isArray(source.chords)?source.chords:[]).slice(0,128).map(c=>({
    atBars:clamp(c?.atBars ?? 0,0,lengthBars), symbol:text(c?.symbol,32), durationBars:clamp(c?.durationBars ?? 1,0.125,lengthBars),
  })).filter(c=>c.symbol);
  return {
    id:text(source.id,100) || `idea_${Date.now()}`,
    role, label:text(source.label,100) || role, action,
    startBar, lengthBars, keyRoot:controls.keyRoot, keyLabel:controls.keyLabel, scaleId:controls.scaleId,
    bpm:controls.bpm, sigNum:controls.sigNum, sigDen:controls.sigDen,
    complexity:controls.complexity, humanization:controls.humanization,
    notes, chords, explanation:text(source.explanation,1200), generationNotes:text(source.generationNotes,1000),
  };
}

function compactProject(project={}) {
  const tracks=(Array.isArray(project.tracks)?project.tracks:[]).slice(0,32).map(t=>({name:text(t?.name,80), type:text(t?.type,20), clipCount:int(t?.clipCount,0,999,0)}));
  const source=project.source && Array.isArray(project.source.notes) ? {
    trackName:text(project.source.trackName,80), startBar:clamp(project.source.startBar??1,1,512), lengthBars:clamp(project.source.lengthBars??4,0.25,64),
    notes:project.source.notes.slice(0,512).map(n=>({pitch:int(n?.pitch,0,127,60),startBars:clamp(n?.startBars??0,0,64),lengthBars:clamp(n?.lengthBars??0.25,1/128,64),velocity:int(n?.velocity,1,127,96)})),
  } : null;
  return { projectName:text(project.projectName,120), playheadBar:clamp(project.playheadBar??1,1,512), tracks, source };
}

export function arrangementPrompt(controlsRaw, projectRaw={}) {
  const c=normalizeComposerControls(controlsRaw); const p=compactProject(projectRaw);
  return `YSong AI COMPOSER — ARRANGEMENT PROPOSAL\nReturn JSON only. You are proposing structure only; DO NOT create tracks or audio and DO NOT return MIDI notes yet.\n\nRULES\n- Respect exact tempo, key/scale, meter, requested song length and user style.\n- Empty means empty: this response is a proposal and must not mutate a project.\n- Prefer a coherent arrangement with only musically justified roles.\n- Roles may only be: ${COMPOSER_ROLES.join(', ')}.\n- Existing project tracks are context, not permission to overwrite them.\n\nCONTROLS\n${JSON.stringify(c)}\n\nCURRENT PROJECT\n${JSON.stringify(p)}\n\nRETURN\n{"title":"...","summary":"...","totalBars":64,"sections":[{"name":"Intro","startBar":1,"endBar":8}],"roles":[{"role":"chords","label":"Piano Chords","purpose":"harmonic bed","entryBar":1,"endBar":64,"priority":4}]}`;
}

export function proposalPrompt({controls:controlsRaw, arrangement, action='generate', sourceProposal=null, project={}}={}) {
  const c=normalizeComposerControls(controlsRaw); const act=actionId(action); const p=compactProject(project);
  const targetRole=act==='harmony'?'harmony':act==='bass_from_this'?'bassline':c.role;
  const source = sourceProposal ? {
    role:roleId(sourceProposal.role), startBar:clamp(sourceProposal.startBar??1,1,512), lengthBars:clamp(sourceProposal.lengthBars??c.bars,0.25,64),
    notes:(Array.isArray(sourceProposal.notes)?sourceProposal.notes:[]).slice(0,1024), chords:(Array.isArray(sourceProposal.chords)?sourceProposal.chords:[]).slice(0,128),
  } : p.source;
  return `YSong AI COMPOSER — STRUCTURED MIDI IDEA\nReturn JSON only. Generate ONE editable musical role, never a full mix and never multiple tracks. The browser will preview the proposal and the user must explicitly Accept before YSong changes the DAW.\n\nHARD RULES\n- Target role: ${targetRole}.\n- Action: ${act}.\n- Exact tempo ${c.bpm} BPM, key ${c.keyLabel}, scale ${c.scaleId}, meter ${c.sigNum}/${c.sigDen}.\n- Requested phrase length: ${act==='continue_8_bars'?8:c.bars} bars.\n- Notes use startBars relative to the proposed clip and lengthBars in bars.\n- Keep notes playable and musically intentional; use velocity and small timing variation according to humanization=${c.humanization.toFixed(2)}.\n- Complexity=${c.complexity.toFixed(2)}.\n- For drums, MIDI pitches are percussion-lane semantics; for every other role, remain strictly inside the requested scale.\n- Never invent vocals or lyrics.\n- ${act==='simpler'?'Reduce density and rhythmic complexity while preserving the idea.':''}\n- ${act==='more_melodic'?'Increase singable contour and motif coherence, not raw note count.':''}\n- ${act==='darker'?'Make harmonic/melodic choices feel darker while staying in the exact scale.':''}\n- ${act==='more_aggressive'?'Increase rhythmic drive, accents and energy without clipping or changing tempo.':''}\n- ${act==='variation'?'Preserve recognizable motif identity while changing rhythm/contour/orchestration behavior.':''}\n- ${act==='continue_8_bars'?'Continue the source naturally for exactly 8 bars; do not restart it.':''}\n- ${act==='harmony'?'Create a supporting harmony derived from the source, avoiding constant parallel doubling.':''}\n- ${act==='bass_from_this'?'Create a bassline derived from the source harmony/rhythm and avoid masking the source.':''}\n\nCONTROLS\n${JSON.stringify({...c,role:targetRole})}\n\nARRANGEMENT PROPOSAL\n${JSON.stringify(arrangement||{})}\n\nSOURCE IDEA / SELECTED MIDI\n${JSON.stringify(source||null)}\n\nCURRENT PROJECT SUMMARY\n${JSON.stringify(p)}\n\nRETURN\n{"role":"${targetRole}","label":"...","startBar":${act==='continue_8_bars'&&source?Number(source.startBar||1)+Number(source.lengthBars||0):c.startBar},"lengthBars":${act==='continue_8_bars'?8:c.bars},"notes":[{"pitch":60,"startBars":0,"lengthBars":0.5,"velocity":96}],"chords":[{"atBars":0,"symbol":"Cm","durationBars":1}],"explanation":"musical reasoning in plain language","generationNotes":"what changed for this action"}`;
}

export function parseArrangementResponse(raw, controlsRaw) {
  const controls=normalizeComposerControls(controlsRaw);
  return normalizeArrangement(jsonObject(raw), controls);
}
export function parseProposalResponse(raw, controlsRaw, action='generate', sourceProposal=null) {
  const controls=normalizeComposerControls(controlsRaw);
  return normalizeProposal(jsonObject(raw), controls, action, sourceProposal);
}
