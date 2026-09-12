import {
  normalizeInstrumentCandidates,
  normalizeSoundContext,
  normalizeSoundParameters,
  parseSoundPlanResponse,
  parseSoundStepResponse,
  soundPlanPrompt,
  soundStepPrompt,
  SOUND_DESIGNER_LIMITS,
} from './engine.mjs';

function configured() {
  const provider = String(process.env.AI_PROVIDER || (process.env.OPENAI_API_KEY ? 'openai' : 'none')).toLowerCase();
  return provider === 'openai' && Boolean(process.env.OPENAI_API_KEY);
}
function errorStatus(error) { return Number.isFinite(Number(error?.statusCode)) ? Number(error.statusCode) : 500; }

export function registerSoundDesignerRoutes(app, { requireAuth, callOpenAI }) {
  app.get('/api/sound-designer/status', requireAuth, (_req, res) => res.json({
    configured: configured(), provider: configured() ? 'openai' : 'none', model: process.env.OPENAI_MODEL || 'gpt-5.6',
    learnedModel: configured(), bridgeOwnsAi: false, auditionEvaluation: 'deterministic-dsp-metrics-plus-server-model-reasoning',
    directAudioModel: false, snapshotsRequired: true, ...SOUND_DESIGNER_LIMITS,
  }));

  app.post('/api/sound-designer/plan', requireAuth, async (req, res) => {
    if (!configured()) return res.status(503).json({ error: 'sound_designer_ai_not_configured', message: 'Configure the server AI provider before asking YSong to design a sound.' });
    try {
      const context = normalizeSoundContext(req.body?.context || {});
      const candidates = normalizeInstrumentCandidates(req.body?.candidates || []);
      const answer = await callOpenAI([{ role: 'developer', content: soundPlanPrompt(context, candidates) }], { maxOutputTokens: 3000 });
      const plan = parseSoundPlanResponse(answer.text, candidates);
      return res.json({ plan, provider: 'openai', model: process.env.OPENAI_MODEL || 'gpt-5.6' });
    } catch (error) {
      console.error('POST /api/sound-designer/plan ERROR', error);
      return res.status(errorStatus(error)).json({ error: String(error?.message || 'sound_designer_plan_failed'), message: error?.message || 'Could not create a sound-design plan.' });
    }
  });

  app.post('/api/sound-designer/step', requireAuth, async (req, res) => {
    if (!configured()) return res.status(503).json({ error: 'sound_designer_ai_not_configured', message: 'Configure the server AI provider before asking YSong to change instrument parameters.' });
    try {
      if (!req.body?.snapshotConfirmed) return res.status(409).json({ error: 'sound_designer_snapshot_required', message: 'Capture a restorable instrument snapshot before autonomous parameter changes.' });
      const context = normalizeSoundContext(req.body?.context || {});
      const parameters = normalizeSoundParameters(req.body?.parameters || []);
      const answer = await callOpenAI([{ role: 'developer', content: soundStepPrompt({ context, instrument: req.body?.instrument || {}, parameters, audition: req.body?.audition || null, history: req.body?.history || [] }) }], { maxOutputTokens: 5000 });
      const step = parseSoundStepResponse(answer.text, parameters, req.body?.audition || null);
      return res.json({ step, provider: 'openai', model: process.env.OPENAI_MODEL || 'gpt-5.6' });
    } catch (error) {
      console.error('POST /api/sound-designer/step ERROR', error);
      return res.status(errorStatus(error)).json({ error: String(error?.message || 'sound_designer_step_failed'), message: error?.message || 'Could not create a sound-design iteration.' });
    }
  });
}
