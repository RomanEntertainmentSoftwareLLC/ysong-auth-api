const MAX_CANDIDATES = 12;
const MAX_PARAMETERS = 320;
const MAX_CHANGES = 8;
const MAX_HISTORY = 8;
const UNSAFE_PARAMETER_PATTERNS = [
  /\bprogram\b/i, /\bpreset\b/i, /\bbank\b/i, /\bbypass\b/i, /\bpower\b/i,
  /\bpanic\b/i, /\bmidi\b/i, /\bchannel\b/i, /\boversampl/i, /\bquality\b/i,
];

const KNOWN_SYNTH_PROFILES = [
  { match: /\bmassive(?: x)?\b/i, family: 'Native Instruments Massive family', priorities: ['oscillator','filter','envelope','lfo','unison','drive','effects'] },
  { match: /\bserum\b/i, family: 'Xfer Serum family', priorities: ['oscillator','filter','envelope','lfo','unison','drive','effects'] },
  { match: /\bvital\b/i, family: 'Vital wavetable family', priorities: ['oscillator','filter','envelope','lfo','unison','drive','effects'] },
  { match: /\brea?ktor\b/i, family: 'Native Instruments Reaktor family', priorities: ['oscillator','filter','envelope','lfo','modulation','drive','effects'] },
];
const CANONICAL_DOMAINS = ['oscillator','filter','envelope','lfo','modulation','unison','width','drive','distortion','chorus','delay','reverb','effects'];

function clamp(value, min, max, fallback = min) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
function text(value, max = 500) { return String(value ?? '').trim().slice(0, max); }
function jsonObject(raw) {
  const source = String(raw ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = source.indexOf('{');
  const end = source.lastIndexOf('}');
  if (start < 0 || end <= start) throw Object.assign(new Error('sound_designer_ai_invalid_json'), { statusCode: 502 });
  try { return JSON.parse(source.slice(start, end + 1)); }
  catch { throw Object.assign(new Error('sound_designer_ai_invalid_json'), { statusCode: 502 }); }
}
function uniqueText(values, limit = 32, max = 80) {
  return [...new Set((Array.isArray(values) ? values : []).map((v) => text(v, max)).filter(Boolean))].slice(0, limit);
}
function compactCandidate(raw = {}) {
  const instrument = raw.instrument && typeof raw.instrument === 'object' ? raw.instrument : raw;
  return {
    id: text(instrument.id, 140),
    name: text(instrument.name, 180),
    vendor: text(instrument.vendor, 120),
    tags: uniqueText(instrument.tags, 40, 50),
    category: text(instrument.category, 120),
    score: clamp(raw.score, 0, 100, 0),
    matchedTerms: uniqueText(raw.matchedTerms, 32, 60),
    bestPresets: (Array.isArray(raw.bestPresets) ? raw.bestPresets : []).slice(0, 6).map((p) => ({
      id: text(p?.id, 140), name: text(p?.name, 180), source: text(p?.source, 80), loadable: !!p?.loadable,
      tags: uniqueText(p?.tags, 20, 50),
    })),
  };
}
function safeParameter(raw = {}) {
  const name = text(raw.name, 180);
  const minValue = Number(raw.minValue);
  const maxValue = Number(raw.maxValue);
  const currentValue = Number(raw.currentValue);
  const safe = name && Number.isFinite(Number(raw.id)) && Number.isFinite(minValue) && Number.isFinite(maxValue) && maxValue > minValue
    && !UNSAFE_PARAMETER_PATTERNS.some((rx) => rx.test(name));
  if (!safe) return null;
  return {
    id: Math.round(Number(raw.id)), name,
    minValue, maxValue,
    currentValue: clamp(currentValue, minValue, maxValue, minValue),
    defaultValue: clamp(raw.defaultValue, minValue, maxValue, minValue),
    group: text(raw.group, 80) || 'Other',
    tags: uniqueText(raw.tags, 24, 50),
  };
}

export function normalizeSoundContext(raw = {}) {
  const vocalLowHz = clamp(raw.vocalLowHz, 0, 20000, 0);
  const vocalHighHz = clamp(raw.vocalHighHz, 0, 24000, 0);
  const midiRaw = raw.midiPart && typeof raw.midiPart === 'object' ? raw.midiPart : null;
  const midiPart = midiRaw ? {
    trackName: text(midiRaw.trackName, 120),
    startBar: clamp(midiRaw.startBar, 1, 512, 1),
    lengthBars: clamp(midiRaw.lengthBars, 0.125, 128, 4),
    notes: (Array.isArray(midiRaw.notes) ? midiRaw.notes : []).slice(0, 192).map((note) => ({
      pitch: Math.round(clamp(note?.pitch, 0, 127, 60)),
      startBars: clamp(note?.startBars, 0, 128, 0),
      lengthBars: clamp(note?.lengthBars, 1 / 128, 128, 0.25),
      velocity: Math.round(clamp(note?.velocity, 1, 127, 96)),
    })),
  } : null;
  return {
    desired: text(raw.desired, 500),
    role: text(raw.role, 80),
    keyLabel: text(raw.keyLabel, 80),
    bpm: clamp(raw.bpm, 20, 400, 120),
    arrangement: text(raw.arrangement, 1400),
    vocalLowHz: vocalLowHz > 0 ? vocalLowHz : null,
    vocalHighHz: vocalHighHz > vocalLowHz ? vocalHighHz : null,
    notes: text(raw.notes, 1000),
    midiPart,
  };
}

export function normalizeInstrumentCandidates(raw = []) {
  return (Array.isArray(raw) ? raw : []).slice(0, MAX_CANDIDATES).map(compactCandidate).filter((c) => c.id && c.name);
}

export function normalizeSoundParameters(raw = []) {
  return (Array.isArray(raw) ? raw : []).slice(0, MAX_PARAMETERS).map(safeParameter).filter(Boolean);
}

export function normalizeAuditionMetrics(raw = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const metric = (key, min, max) => {
    const n = Number(raw[key]);
    return Number.isFinite(n) ? clamp(n, min, max, n) : null;
  };
  const normalized = {
    durationSeconds: metric('durationSeconds', 0, 10), sampleRate: metric('sampleRate', 8000, 384000),
    peakDbfs: metric('peakDbfs', -160, 6), rmsDbfs: metric('rmsDbfs', -160, 6), crestDb: metric('crestDb', 0, 80),
    spectralCentroidHz: metric('spectralCentroidHz', 0, 48000), spectralFlatness: metric('spectralFlatness', 0, 1),
    lowEnergyRatio: metric('lowEnergyRatio', 0, 1), midEnergyRatio: metric('midEnergyRatio', 0, 1), highEnergyRatio: metric('highEnergyRatio', 0, 1),
    stereoCorrelation: metric('stereoCorrelation', -1, 1), stereoWidth: metric('stereoWidth', 0, 4),
    attackMs: metric('attackMs', 0, 5000), tailRmsDbfs: metric('tailRmsDbfs', -160, 6), zeroCrossingRate: metric('zeroCrossingRate', 0, 1),
    vocalBandEnergyRatio: metric('vocalBandEnergyRatio', 0, 1),
  };
  return Object.values(normalized).some((v) => v != null) ? normalized : null;
}

export function soundPlanPrompt(contextRaw, candidatesRaw) {
  const context = normalizeSoundContext(contextRaw);
  const candidates = normalizeInstrumentCandidates(candidatesRaw);
  if (!context.desired) throw Object.assign(new Error('desired_timbre_required'), { statusCode: 400 });
  if (!candidates.length) throw Object.assign(new Error('instrument_candidates_required'), { statusCode: 400 });
  return `YSong AI SOUND DESIGNER — INSTRUMENT PLAN\nReturn JSON only.\n\nARCHITECTURE\n- AI is the brain outside Bridge. Bridge is deterministic hands/ears only.\n- You may choose ONLY one installed instrument ID from the candidate list below.\n- Do not claim a preset was loaded unless the candidate explicitly says loadable=true.\n- This is a plan only. No parameter may be changed until the client captures a restorable snapshot.\n- Prefer an instrument that can plausibly reach the target timbre through exposed synthesis parameters, not merely the highest text-match score.\n\nTARGET\n${JSON.stringify(context)}\n\nINSTALLED CANDIDATES\n${JSON.stringify(candidates)}\n\nRETURN\n{"instrumentId":"exact candidate id","reason":"why this installed instrument is the best starting point","targetTraits":["bright","short"],"avoidTraits":["muddy"],"audition":{"durationSeconds":3,"notes":[{"note":60,"velocity":100,"startSeconds":0.05,"durationSeconds":0.45}]}}`;
}

export function parseSoundPlanResponse(raw, candidatesRaw) {
  const obj = jsonObject(raw);
  const candidates = normalizeInstrumentCandidates(candidatesRaw);
  const allowed = new Map(candidates.map((c) => [c.id, c]));
  const instrumentId = text(obj.instrumentId, 140);
  if (!allowed.has(instrumentId)) throw Object.assign(new Error('sound_designer_selected_unknown_instrument'), { statusCode: 502 });
  const notes = (Array.isArray(obj?.audition?.notes) ? obj.audition.notes : []).slice(0, 16).map((n) => ({
    note: Math.round(clamp(n?.note, 0, 127, 60)), velocity: Math.round(clamp(n?.velocity, 1, 127, 100)),
    startSeconds: clamp(n?.startSeconds, 0, 4.9, 0.05), durationSeconds: clamp(n?.durationSeconds, 0.02, 5, 0.45),
    channel: Math.round(clamp(n?.channel, 0, 15, 0)),
  }));
  return {
    instrumentId,
    reason: text(obj.reason, 1200),
    targetTraits: uniqueText(obj.targetTraits, 24, 70),
    avoidTraits: uniqueText(obj.avoidTraits, 24, 70),
    audition: { durationSeconds: clamp(obj?.audition?.durationSeconds, 0.5, 5, 3), notes },
  };
}

export function describeSynthSurface(instrument = {}, parametersRaw = []) {
  const parameters = normalizeSoundParameters(parametersRaw);
  const identity = `${text(instrument?.name, 180)} ${text(instrument?.vendor, 120)}`.trim();
  const known = KNOWN_SYNTH_PROFILES.find((profile) => profile.match.test(identity));
  const exposed = new Set();
  for (const parameter of parameters) {
    const haystack = [parameter.group, ...parameter.tags, parameter.name].join(' ').toLowerCase();
    for (const domain of CANONICAL_DOMAINS) if (haystack.includes(domain)) exposed.add(domain);
    if (/attack|decay|sustain|release/.test(haystack)) exposed.add('envelope');
    if (/cutoff|resonance/.test(haystack)) exposed.add('filter');
    if (/osc|waveform|wavetable/.test(haystack)) exposed.add('oscillator');
    if (/detune|voices?/.test(haystack)) exposed.add('unison');
  }
  return {
    mappingMode: known ? 'known-family-guidance-plus-live-parameter-inference' : 'generic-live-parameter-inference',
    family: known?.family || 'Generic instrument',
    priorityDomains: known?.priorities || ['oscillator','filter','envelope','lfo','unison','drive','effects'],
    exposedDomains: [...exposed].sort(),
    parameterCount: parameters.length,
    truthRule: 'Bridge live parameter IDs/names are authoritative; family guidance never invents a control that is not exposed.',
  };
}

export function soundStepPrompt({ context: contextRaw, instrument = {}, parameters: parametersRaw = [], audition = null, history = [] } = {}) {
  const context = normalizeSoundContext(contextRaw);
  const parameters = normalizeSoundParameters(parametersRaw);
  const metrics = normalizeAuditionMetrics(audition);
  const synthSurface = describeSynthSurface(instrument, parameters);
  if (!context.desired) throw Object.assign(new Error('desired_timbre_required'), { statusCode: 400 });
  if (!parameters.length) throw Object.assign(new Error('sound_designer_parameters_required'), { statusCode: 400 });
  const compactHistory = (Array.isArray(history) ? history : []).slice(-MAX_HISTORY).map((h) => ({
    iteration: Math.round(clamp(h?.iteration, 1, 99, 1)), score: clamp(h?.score, 0, 100, 0),
    evaluation: text(h?.evaluation, 500), changes: (Array.isArray(h?.changes) ? h.changes : []).slice(0, MAX_CHANGES).map((c) => ({ parameterId: Number(c?.parameterId), targetValue: Number(c?.targetValue) })),
    audition: normalizeAuditionMetrics(h?.audition),
  }));
  return `YSong AI SOUND DESIGNER — PARAMETER ITERATION\nReturn JSON only.\n\nHARD SAFETY RULES\n- The client has already captured a restorable pre-design snapshot.\n- You may change ONLY parameter IDs listed in SAFE PARAMETERS.\n- Propose at most ${MAX_CHANGES} changes this iteration.\n- Do not touch preset/program/bank/bypass/power/MIDI/quality controls. Those have already been excluded.\n- Each targetValue must stay inside the listed min/max.\n- Make conservative moves. The server will additionally cap each move to 35% of that parameter's full range per iteration.\n- Do not invent parameter semantics. Use names/groups/tags provided by Bridge.\n- The audition metrics are deterministic DSP measurements of the rendered preview. They are not a learned audio model and are not proof of subjective quality.\n- If a vocal band is supplied, reduce avoidable energy/masking in that range when compatible with the requested timbre.\n- If evidence is ambiguous, change fewer parameters, not more.\n\nTARGET\n${JSON.stringify(context)}\n\nINSTRUMENT\n${JSON.stringify({ id:text(instrument.id,140), name:text(instrument.name,180), vendor:text(instrument.vendor,120), tags:uniqueText(instrument.tags,40,50) })}\n\nSYNTHESIS SURFACE GUIDANCE\n${JSON.stringify(synthSurface)}\n\nSAFE PARAMETERS\n${JSON.stringify(parameters)}\n\nLATEST AUDITION DSP\n${JSON.stringify(metrics)}\n\nITERATION HISTORY\n${JSON.stringify(compactHistory)}\n\nRETURN\n{"evaluation":"what the latest metrics imply relative to the target","score":0,"confidence":"low|medium|high","done":false,"changes":[{"parameterId":123,"targetValue":0.42,"reason":"open cutoff slightly for more brightness"}],"nextAudition":{"durationSeconds":3,"notes":[{"note":60,"velocity":100,"startSeconds":0.05,"durationSeconds":0.45}]},"nextFocus":"what to listen/measure for next"}`;
}

export function parseSoundStepResponse(raw, parametersRaw, auditionRaw = null) {
  const obj = jsonObject(raw);
  const parameters = normalizeSoundParameters(parametersRaw);
  const byId = new Map(parameters.map((p) => [p.id, p]));
  const seen = new Set();
  const changes = [];
  for (const change of (Array.isArray(obj.changes) ? obj.changes : [])) {
    if (changes.length >= MAX_CHANGES) break;
    const id = Math.round(Number(change?.parameterId));
    const parameter = byId.get(id);
    if (!parameter || seen.has(id)) continue;
    seen.add(id);
    const desired = clamp(change?.targetValue, parameter.minValue, parameter.maxValue, parameter.currentValue);
    const span = parameter.maxValue - parameter.minValue;
    const maxMove = span * 0.35;
    const targetValue = clamp(desired, parameter.currentValue - maxMove, parameter.currentValue + maxMove, parameter.currentValue);
    if (Math.abs(targetValue - parameter.currentValue) <= Math.max(span * 0.00001, 1e-9)) continue;
    changes.push({ parameterId: id, parameterName: parameter.name, fromValue: parameter.currentValue, targetValue, reason: text(change?.reason, 500) });
  }
  const notes = (Array.isArray(obj?.nextAudition?.notes) ? obj.nextAudition.notes : []).slice(0, 16).map((n) => ({
    note: Math.round(clamp(n?.note, 0, 127, 60)), velocity: Math.round(clamp(n?.velocity, 1, 127, 100)),
    startSeconds: clamp(n?.startSeconds, 0, 4.9, 0.05), durationSeconds: clamp(n?.durationSeconds, 0.02, 5, 0.45), channel: Math.round(clamp(n?.channel, 0, 15, 0)),
  }));
  const latestMetrics = normalizeAuditionMetrics(auditionRaw);
  const requestedConfidence = ['low','medium','high'].includes(String(obj.confidence)) ? String(obj.confidence) : 'low';
  const confidence = latestMetrics ? requestedConfidence : (requestedConfidence === 'high' ? 'medium' : requestedConfidence);
  return {
    evaluation: text(obj.evaluation, 1400),
    score: clamp(obj.score, 0, 100, 0),
    confidence,
    done: !!obj.done && changes.length === 0,
    changes,
    nextAudition: { durationSeconds: clamp(obj?.nextAudition?.durationSeconds, 0.5, 5, 3), notes },
    nextFocus: text(obj.nextFocus, 800),
    evaluationKind: latestMetrics ? 'model-guided-from-dsp-metrics' : 'model-guided-without-audition-metrics',
  };
}

export const SOUND_DESIGNER_LIMITS = { maxCandidates: MAX_CANDIDATES, maxParameters: MAX_PARAMETERS, maxChangesPerIteration: MAX_CHANGES, maxHistory: MAX_HISTORY };
