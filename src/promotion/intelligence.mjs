const EPS = 1e-9;

function num(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}
function ratio(a, b) { return num(b) > 0 ? num(a) / num(b) : 0; }
function moneyPer(spend, outcome) { return num(outcome) > 0 ? num(spend) / num(outcome) : null; }
function median(values) {
  const xs = values.map(num).filter(Number.isFinite).sort((a,b)=>a-b);
  if (!xs.length) return 0;
  const m = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[m] : (xs[m-1] + xs[m]) / 2;
}
function round(value, digits=4) {
  const p = 10 ** digits;
  return Math.round(num(value) * p) / p;
}
function confidenceFor(sample, spend=0) {
  const s = num(sample), d = num(spend);
  if (s >= 100 && d >= 20) return "high";
  if (s >= 30 && d >= 5) return "medium";
  return "low";
}
function confidenceRank(value) { return value === "high" ? 3 : value === "medium" ? 2 : 1; }
function priorityRank(value) { return value === "high" ? 3 : value === "medium" ? 2 : 1; }
function recommendation({id,kind="opportunity",priority="medium",confidence="low",entityType="campaign",entityId="",title,summary,action,evidence=[],why=""}) {
  return { id, kind, priority, confidence, entityType, entityId, title, summary, action, evidence, why };
}
function objectiveDefinition(ad, ysongTotals={}) {
  const goal = String(ad?.goal || "song_growth");
  if (goal === "fan_growth") return { key:"emailCaptures", label:"fan email captures", fallbackKey:"clicks", fallbackLabel:"platform clicks", fallback: num(ysongTotals.emailCaptures) <= 0 };
  if (goal === "presave") return { key:"conversions", label:"confirmed conversions", fallbackKey:"emailCaptures", fallbackLabel:"fan email captures", fallback: num(ysongTotals.conversions) <= 0 };
  return { key:"clicks", label:"platform clicks", fallbackKey:"views", fallbackLabel:"Smart Link visits", fallback:false };
}
function metricValue(creative, objective) {
  const y = creative?.ysong || {};
  const primary = num(y[objective.key]);
  if (!objective.fallback || primary > 0) return { value:primary, key:objective.key, label:objective.label };
  return { value:num(y[objective.fallbackKey]), key:objective.fallbackKey, label:objective.fallbackLabel };
}
function sumMeta(rows) {
  const out={spend:0,impressions:0,reach:0,clicks:0,linkClicks:0,outboundClicks:0,videoPlays:0,video25:0,video50:0,video75:0,video100:0,thruPlays:0};
  for (const row of rows || []) for (const key of Object.keys(out)) out[key]+=num(row?.[key]);
  return out;
}
function aggregateCreatives(creatives, keyFn, labelFn, objective) {
  const groups = new Map();
  for (const c of creatives || []) {
    const key=String(keyFn(c));
    if (!groups.has(key)) groups.set(key,{id:key,label:labelFn(c),creativeIds:[],spend:0,impressions:0,outboundClicks:0,views:0,clicks:0,emailCaptures:0,conversions:0,outcome:0});
    const g=groups.get(key); const y=c.ysong||{}, m=c.meta||{};
    g.creativeIds.push(c.id); g.spend+=num(m.spend); g.impressions+=num(m.impressions); g.outboundClicks+=num(m.outboundClicks||m.linkClicks); g.views+=num(y.views); g.clicks+=num(y.clicks); g.emailCaptures+=num(y.emailCaptures); g.conversions+=num(y.conversions);
    g.outcome += metricValue(c,objective).value;
  }
  return [...groups.values()].map(g=>({...g,costPerOutcome:moneyPer(g.spend,g.outcome),engagement:ratio(g.clicks,g.views),confidence:confidenceFor(g.outcome,g.spend)}));
}
function qualifiedCostRows(rows,{minOutcome=8,minSpend=1}={}) {
  return (rows||[]).filter(r=>num(r.outcome)>=minOutcome && num(r.spend)>=minSpend && r.costPerOutcome!=null && Number.isFinite(r.costPerOutcome));
}
function comparativeRecommendation(rows,{entityType,titlePrefix,idPrefix,objective,currency}) {
  const qualified=qualifiedCostRows(rows);
  if (qualified.length < 2) return [];
  const med=median(qualified.map(r=>r.costPerOutcome));
  const sorted=[...qualified].sort((a,b)=>a.costPerOutcome-b.costPerOutcome || b.outcome-a.outcome);
  const best=sorted[0], worst=sorted[sorted.length-1]; const out=[];
  if (best.costPerOutcome <= Math.max(EPS,med*0.82)) out.push(recommendation({
    id:`${idPrefix}_winner_${best.id}`,kind:"winner",priority:"medium",confidence:best.confidence,entityType,entityId:best.id,
    title:`${titlePrefix} winner: ${best.label}`,
    summary:`${best.label} is producing ${objective.label} at about ${Math.round((1-best.costPerOutcome/Math.max(med,EPS))*100)}% lower cost than the qualified ${titlePrefix.toLowerCase()} median.`,
    action:`Consider making ${best.label} the basis of the next controlled creative test. Keep the current campaign settings unchanged until you intentionally approve a new test.`,
    why:"This comparison uses downstream YSong outcomes, not Meta clicks alone.",
    evidence:[{label:"Outcome",value:best.outcome},{label:"Spend",value:round(best.spend,2),unit:currency},{label:`Cost / ${objective.label}`,value:round(best.costPerOutcome,4),unit:currency},{label:"Qualified median",value:round(med,4),unit:currency}]
  }));
  if (worst.costPerOutcome >= med*1.45 && worst.costPerOutcome >= best.costPerOutcome*1.6) out.push(recommendation({
    id:`${idPrefix}_underperformer_${worst.id}`,kind:"watch",priority:"medium",confidence:worst.confidence,entityType,entityId:worst.id,
    title:`${titlePrefix} to watch: ${worst.label}`,
    summary:`${worst.label} is costing materially more per ${objective.label} than the stronger qualified alternatives.`,
    action:`Consider excluding ${worst.label} from the next test or pairing it with a different ${entityType==="snippet"?"background":"audio snippet"}. Do not change the live campaign automatically.`,
    why:"YSong only flags this after a minimum downstream-outcome sample is present.",
    evidence:[{label:"Outcome",value:worst.outcome},{label:"Spend",value:round(worst.spend,2),unit:currency},{label:`Cost / ${objective.label}`,value:round(worst.costPerOutcome,4),unit:currency},{label:"Best qualified cost",value:round(best.costPerOutcome,4),unit:currency}]
  }));
  return out;
}
function performanceRows(rows, identity, minClicks=8) {
  return (rows||[]).map((r,i)=>{
    const clicks=num(r.outboundClicks||r.linkClicks); const spend=num(r.spend);
    return {id:identity(r,i),label:identity(r,i),spend,clicks,impressions:num(r.impressions),reach:num(r.reach),costPerClick:moneyPer(spend,clicks),ctr:num(r.ctr),frequency:num(r.frequency),raw:r};
  }).filter(r=>r.clicks>=minClicks&&r.spend>0&&r.costPerClick!=null);
}
function metaComparison(rows,{entityType,titlePrefix,idPrefix,currency}) {
  if (rows.length<2) return [];
  const med=median(rows.map(r=>r.costPerClick)); const sorted=[...rows].sort((a,b)=>a.costPerClick-b.costPerClick||b.clicks-a.clicks); const best=sorted[0],worst=sorted[sorted.length-1]; const out=[];
  if(best.costPerClick<=med*0.82)out.push(recommendation({id:`${idPrefix}_efficient_${best.id}`,kind:"opportunity",priority:"low",confidence:confidenceFor(best.clicks,best.spend),entityType,entityId:best.id,title:`Efficient ${titlePrefix.toLowerCase()}: ${best.label}`,summary:`Meta is delivering outbound clicks from ${best.label} below the qualified ${titlePrefix.toLowerCase()} median cost.`,action:`Consider testing a deliberately larger share of a future campaign on ${best.label}. This is a Meta-side delivery signal; it does not prove downstream streaming quality by itself.`,why:"Placement/country reporting is Meta-side and cannot be joined to an individual streaming destination with the current attribution granularity.",evidence:[{label:"Outbound clicks",value:best.clicks},{label:"Spend",value:round(best.spend,2),unit:currency},{label:"Meta cost / outbound",value:round(best.costPerClick,4),unit:currency},{label:"Qualified median",value:round(med,4),unit:currency}]}));
  if(worst.costPerClick>=med*1.5&&worst.costPerClick>=best.costPerClick*1.7)out.push(recommendation({id:`${idPrefix}_expensive_${worst.id}`,kind:"watch",priority:"low",confidence:confidenceFor(worst.clicks,worst.spend),entityType,entityId:worst.id,title:`Expensive ${titlePrefix.toLowerCase()}: ${worst.label}`,summary:`${worst.label} is costing substantially more per Meta outbound click than the strongest qualified ${titlePrefix.toLowerCase()} in this date range.`,action:`Consider a controlled future test with ${worst.label} reduced or isolated. Do not infer that its listeners are lower quality without downstream attribution.`,why:"This recommendation intentionally stops at Meta outbound efficiency.",evidence:[{label:"Outbound clicks",value:worst.clicks},{label:"Spend",value:round(worst.spend,2),unit:currency},{label:"Meta cost / outbound",value:round(worst.costPerClick,4),unit:currency},{label:"Best qualified cost",value:round(best.costPerClick,4),unit:currency}]}));
  return out;
}
function trendRecommendation(meta, currency) {
  const daily=(meta?.daily||[]).filter(r=>num(r.impressions)>0).sort((a,b)=>String(a.dateStart||"").localeCompare(String(b.dateStart||"")));
  if(daily.length<4)return null;
  const chunk=Math.min(3,Math.floor(daily.length/2)); const early=daily.slice(0,chunk), late=daily.slice(-chunk);
  const e=sumMeta(early),l=sumMeta(late); const eCtr=ratio(e.outboundClicks||e.linkClicks,e.impressions),lCtr=ratio(l.outboundClicks||l.linkClicks,l.impressions); const eCpc=moneyPer(e.spend,e.outboundClicks||e.linkClicks),lCpc=moneyPer(l.spend,l.outboundClicks||l.linkClicks); const frequency=num(meta?.summary?.frequency);
  if(e.outboundClicks<8||l.outboundClicks<8)return null;
  if((frequency>=3&&lCtr<eCtr*0.75)||(eCpc!=null&&lCpc!=null&&lCpc>eCpc*1.45&&lCtr<eCtr*0.85))return recommendation({id:"campaign_fatigue_watch",kind:"watch",priority:"medium",confidence:confidenceFor(l.outboundClicks,l.spend),entityType:"campaign",title:"Possible creative fatigue",summary:"Recent Meta click efficiency is weaker than the campaign's opening days, and the available delivery signals are consistent with audience/creative fatigue.",action:"Consider preparing fresh creative variants or a new controlled audience test. YSong will not rotate creatives or change budget automatically.",why:"Fatigue is an inference from trend and frequency, not a definitive diagnosis.",evidence:[{label:"Early outbound CTR",value:round(eCtr*100,2),unit:"%"},{label:"Recent outbound CTR",value:round(lCtr*100,2),unit:"%"},{label:"Frequency",value:round(frequency,2)},{label:"Recent cost / outbound",value:round(lCpc||0,4),unit:currency}]});
  return null;
}

export function buildPromotionIntelligence(analytics) {
  const ad=analytics?.adCampaign||{}; const meta=analytics?.meta||{}; const ysong=analytics?.ysong||{totals:{},creatives:[],destinations:[]}; const derived=analytics?.derived||{}; const currency=String(derived.currency||ad.currency||"USD");
  const objective=objectiveDefinition(ad,ysong.totals||{}); const recommendations=[];
  const impressions=num(meta?.summary?.impressions), outbound=num(meta?.summary?.outboundClicks||meta?.summary?.linkClicks), smartViews=num(ysong?.totals?.views), platformClicks=num(ysong?.totals?.clicks), spend=num(derived.spend);
  const evidenceState={impressions,outboundClicks:outbound,smartLinkVisits:smartViews,platformClicks,emailCaptures:num(ysong?.totals?.emailCaptures),conversions:num(ysong?.totals?.conversions),spend:round(spend,2),currency};
  const sufficient=impressions>=1000&&outbound>=20&&smartViews>=20;
  if(!sufficient)recommendations.push(recommendation({id:"learning_phase",kind:"learning",priority:"high",confidence:"low",entityType:"campaign",title:"Still in the learning phase",summary:"There is not enough paid-delivery and downstream YSong traffic yet for strong optimization claims.",action:"Keep collecting data. Avoid declaring winners or moving budget based on tiny samples.",why:"YSong requires minimum evidence before comparative recommendations are promoted above low confidence.",evidence:[{label:"Impressions",value:impressions},{label:"Meta outbound clicks",value:outbound},{label:"Smart Link visits",value:smartViews},{label:"Platform clicks",value:platformClicks}]}));

  if(outbound>=20&&smartViews>=10){const arrival=ratio(smartViews,outbound);if(arrival<0.62)recommendations.push(recommendation({id:"funnel_meta_to_smartlink",kind:"warning",priority:"high",confidence:confidenceFor(outbound,spend),entityType:"funnel",title:"Large drop between Meta and the Smart Link",summary:`Only about ${Math.round(arrival*100)}% of measured Meta outbound clicks became YSong Smart Link visits in this range.`,action:"Inspect landing-page load speed, URL/redirect behavior, in-app browser compatibility, and attribution parameters before changing the audience or creative.",why:"Some click-to-visit loss is normal; this flags unusually large measured loss without assigning a single cause.",evidence:[{label:"Meta outbound",value:outbound},{label:"Smart Link visits",value:smartViews},{label:"Arrival rate",value:round(arrival*100,1),unit:"%"}]}));}
  if(smartViews>=30){const engage=ratio(platformClicks,smartViews);if(engage<0.18)recommendations.push(recommendation({id:"funnel_smartlink_engagement",kind:"warning",priority:"medium",confidence:confidenceFor(smartViews,spend),entityType:"funnel",title:"Smart Link engagement is weak",summary:`About ${Math.round(engage*100)}% of Smart Link visits continued to a listening destination.`,action:"Review destination ordering, artwork/copy clarity, page speed, and whether the ad promise matches the landing page. Test one landing-page change at a time.",why:"This uses YSong-owned landing behavior and does not depend on Meta's conversion modeling.",evidence:[{label:"Smart Link visits",value:smartViews},{label:"Platform clicks",value:platformClicks},{label:"Engagement",value:round(engage*100,1),unit:"%"}]}));else if(engage>=0.45)recommendations.push(recommendation({id:"funnel_smartlink_strength",kind:"winner",priority:"low",confidence:confidenceFor(smartViews,spend),entityType:"funnel",title:"Smart Link is converting strongly",summary:`About ${Math.round(engage*100)}% of visits continue to a music destination.`,action:"Preserve the current Smart Link structure while testing ad creatives so landing-page changes do not muddy the experiment.",why:"Holding the landing page stable makes creative comparisons easier to interpret.",evidence:[{label:"Smart Link visits",value:smartViews},{label:"Platform clicks",value:platformClicks},{label:"Engagement",value:round(engage*100,1),unit:"%"}]}));}

  const creatives=(derived.creatives||[]).map(c=>{const m=metricValue(c,objective);return {...c,spend:num(c.meta?.spend),outcome:m.value,outcomeLabel:m.label,costPerOutcome:moneyPer(c.meta?.spend,m.value),confidence:confidenceFor(m.value,c.meta?.spend)};});
  const qualified=qualifiedCostRows(creatives);
  if(qualified.length>=2){const med=median(qualified.map(c=>c.costPerOutcome));const sorted=[...qualified].sort((a,b)=>a.costPerOutcome-b.costPerOutcome||b.outcome-a.outcome);const best=sorted[0],worst=sorted[sorted.length-1];if(best.costPerOutcome<=med*0.82)recommendations.push(recommendation({id:`creative_winner_${best.id}`,kind:"winner",priority:"high",confidence:best.confidence,entityType:"creative",entityId:best.id,title:`Creative winner: ${best.snippetLabel||best.backgroundName||best.id.slice(0,8)}`,summary:`This creative is producing ${best.outcomeLabel} below the qualified creative median cost.`,action:"Use its audio/background combination as the control for the next creative test. Do not automatically increase spend.",why:"This is the strongest available end-to-end creative comparison because it joins Meta spend to YSong downstream outcomes.",evidence:[{label:best.outcomeLabel,value:best.outcome},{label:"Spend",value:round(best.meta?.spend,2),unit:currency},{label:`Cost / ${best.outcomeLabel}`,value:round(best.costPerOutcome,4),unit:currency},{label:"Qualified creative median",value:round(med,4),unit:currency}]}));if(worst.costPerOutcome>=med*1.5&&worst.costPerOutcome>=best.costPerOutcome*1.7)recommendations.push(recommendation({id:`creative_watch_${worst.id}`,kind:"watch",priority:"high",confidence:worst.confidence,entityType:"creative",entityId:worst.id,title:`Creative underperformer: ${worst.snippetLabel||worst.backgroundName||worst.id.slice(0,8)}`,summary:`This creative is materially more expensive per ${worst.outcomeLabel} than stronger qualified creatives.`,action:"Consider pausing it manually or excluding it from the next campaign test after reviewing the evidence. YSong will not pause it for you.",why:"The recommendation is based on downstream outcomes and a minimum sample threshold, not raw impressions.",evidence:[{label:worst.outcomeLabel,value:worst.outcome},{label:"Spend",value:round(worst.meta?.spend,2),unit:currency},{label:`Cost / ${worst.outcomeLabel}`,value:round(worst.costPerOutcome,4),unit:currency},{label:"Best qualified cost",value:round(best.costPerOutcome,4),unit:currency}]}));}

  const snippetGroups=aggregateCreatives(creatives,c=>String(c.audioSnippetId||`${round(c.snippetStartSeconds,3)}:${round(c.snippetDurationSeconds,3)}`),c=>c.snippetLabel||`${round(c.snippetStartSeconds,1)}s–${round(c.snippetStartSeconds+c.snippetDurationSeconds,1)}s`,objective);
  const bgGroups=aggregateCreatives(creatives,c=>String(c.backgroundVideoId||c.backgroundMetadata?.providerVideoId||c.backgroundName||c.id),c=>c.backgroundName||"Background video",objective);
  recommendations.push(...comparativeRecommendation(snippetGroups,{entityType:"snippet",titlePrefix:"Audio snippet",idPrefix:"snippet",objective,currency}));
  recommendations.push(...comparativeRecommendation(bgGroups,{entityType:"background",titlePrefix:"Background",idPrefix:"background",objective,currency}));

  const placementRows=performanceRows(meta.placements||[],r=>`${r.publisherPlatform||"meta"} · ${r.platformPosition||"unknown"}`,8);
  const countryRows=performanceRows(meta.countries||[],r=>String(r.country||"unknown"),12);
  recommendations.push(...metaComparison(placementRows,{entityType:"placement",titlePrefix:"Placement",idPrefix:"placement",currency}));
  recommendations.push(...metaComparison(countryRows,{entityType:"country",titlePrefix:"Country",idPrefix:"country",currency}));

  const destinationRows=[...(derived.destinations||[])].sort((a,b)=>num(b.clicks)-num(a.clicks));
  if(platformClicks>=30&&destinationRows[0]&&ratio(destinationRows[0].clicks,platformClicks)>=0.45)recommendations.push(recommendation({id:`destination_affinity_${destinationRows[0].id}`,kind:"insight",priority:"low",confidence:confidenceFor(platformClicks,spend),entityType:"destination",entityId:destinationRows[0].id,title:`Fans strongly prefer ${destinationRows[0].label}`,summary:`${destinationRows[0].label} accounts for about ${Math.round(ratio(destinationRows[0].clicks,platformClicks)*100)}% of attributed listening-destination clicks.`,action:`Keep that destination prominent on the Smart Link. Consider destination-specific messaging in a future controlled campaign, but do not remove alternatives just because one service leads.`,why:"This measures fan choice after the ad; it does not prove the service caused the conversion.",evidence:[{label:`${destinationRows[0].label} clicks`,value:destinationRows[0].clicks},{label:"All platform clicks",value:platformClicks},{label:"Share",value:round(ratio(destinationRows[0].clicks,platformClicks)*100,1),unit:"%"}]}));

  const fatigue=trendRecommendation(meta,currency); if(fatigue)recommendations.push(fatigue);
  const sortedRecommendations=recommendations.sort((a,b)=>priorityRank(b.priority)-priorityRank(a.priority)||confidenceRank(b.confidence)-confidenceRank(a.confidence)||String(a.title).localeCompare(String(b.title)));
  const strongCount=sortedRecommendations.filter(r=>r.confidence!=="low"&&["winner","warning","watch","opportunity"].includes(r.kind)).length;
  return {
    engine:{name:"YSong Promotion Intelligence",version:"23.6-deterministic-v1",learnedModel:false,description:"Deterministic advisory analysis over Meta Insights and YSong-owned attribution. It does not change campaign settings or spend."},
    range:analytics?.range||null, objective:{goal:String(ad.goal||"song_growth"),metric:objective.fallback?objective.fallbackKey:objective.key,label:objective.fallback?objective.fallbackLabel:objective.label,fallbackUsed:objective.fallback},
    evidenceState:{...evidenceState,sufficientForStrongComparisons:sufficient,strongRecommendationCount:strongCount},
    recommendations:sortedRecommendations,
    rankings:{creatives:creatives.map(c=>({id:c.id,label:c.snippetLabel||c.backgroundName||c.id.slice(0,8),outcome:c.outcome,outcomeLabel:c.outcomeLabel,spend:round(c.meta?.spend,2),costPerOutcome:c.costPerOutcome==null?null:round(c.costPerOutcome,4),confidence:c.confidence})).sort((a,b)=>(a.costPerOutcome??Infinity)-(b.costPerOutcome??Infinity)),snippets:snippetGroups.sort((a,b)=>(a.costPerOutcome??Infinity)-(b.costPerOutcome??Infinity)),backgrounds:bgGroups.sort((a,b)=>(a.costPerOutcome??Infinity)-(b.costPerOutcome??Infinity)),placements:placementRows.sort((a,b)=>a.costPerClick-b.costPerClick),countries:countryRows.sort((a,b)=>a.costPerClick-b.costPerClick)},
    guardrails:["Advisory only: YSong does not automatically pause ads, alter audiences, move budget, or change placements.","Low-sample recommendations remain low confidence and should not be treated as winners.","Meta placement/country efficiency is Meta-side evidence; YSong does not claim it identifies which streaming service those people later chose.","Recommendations describe observed campaign behavior and controlled tests, not guaranteed future performance."]
  };
}
