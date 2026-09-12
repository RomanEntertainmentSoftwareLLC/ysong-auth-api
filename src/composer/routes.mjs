import { arrangementPrompt, proposalPrompt, parseArrangementResponse, parseProposalResponse, normalizeComposerControls } from './engine.mjs';

function configured() {
  const provider=String(process.env.AI_PROVIDER || (process.env.OPENAI_API_KEY ? 'openai' : 'none')).toLowerCase();
  return provider==='openai' && Boolean(process.env.OPENAI_API_KEY);
}
function errorStatus(error) {
  return Number.isFinite(Number(error?.statusCode)) ? Number(error.statusCode) : 500;
}
export function registerComposerRoutes(app,{requireAuth,callOpenAI}) {
  app.get('/api/composer/status',requireAuth,(_req,res)=>res.json({configured:configured(),provider:configured()?'openai':'none',model:process.env.OPENAI_MODEL||'gpt-5.6',structured:true,learnedModel:configured()}));

  app.post('/api/composer/arrangement',requireAuth,async(req,res)=>{
    if(!configured()) return res.status(503).json({error:'composer_ai_not_configured',message:'Configure the server AI provider before generating composer proposals.'});
    try {
      const controls=normalizeComposerControls(req.body?.controls||{});
      const answer=await callOpenAI([{role:'developer',content:arrangementPrompt(controls,req.body?.project||{})}],{maxOutputTokens:5000});
      const arrangement=parseArrangementResponse(answer.text,controls);
      return res.json({arrangement,provider:'openai',model:process.env.OPENAI_MODEL||'gpt-5.6'});
    } catch(error) {
      console.error('POST /api/composer/arrangement ERROR',error);
      return res.status(errorStatus(error)).json({error:String(error?.message||'composer_arrangement_failed'),message:error?.message||'Could not create arrangement proposal.'});
    }
  });

  app.post('/api/composer/generate',requireAuth,async(req,res)=>{
    if(!configured()) return res.status(503).json({error:'composer_ai_not_configured',message:'Configure the server AI provider before generating composer proposals.'});
    try {
      const controls=normalizeComposerControls(req.body?.controls||{});
      if(!req.body?.arrangement || !Array.isArray(req.body.arrangement.sections)) return res.status(400).json({error:'arrangement_required',message:'Approve or generate an arrangement proposal first.'});
      const action=String(req.body?.action||'generate');
      const answer=await callOpenAI([{role:'developer',content:proposalPrompt({controls,arrangement:req.body.arrangement,action,sourceProposal:req.body?.sourceProposal||null,project:req.body?.project||{}})}],{maxOutputTokens:9000});
      const proposal=parseProposalResponse(answer.text,controls,action,req.body?.sourceProposal||req.body?.project?.source||null);
      return res.json({proposal,provider:'openai',model:process.env.OPENAI_MODEL||'gpt-5.6'});
    } catch(error) {
      console.error('POST /api/composer/generate ERROR',error);
      return res.status(errorStatus(error)).json({error:String(error?.message||'composer_generation_failed'),message:error?.message||'Could not generate structured musical data.'});
    }
  });
}
