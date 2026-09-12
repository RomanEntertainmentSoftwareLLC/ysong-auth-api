const norm = (value) => String(value ?? "").trim().toLowerCase();
const arr = (value) => Array.isArray(value) ? value : [];
const uniq = (values) => [...new Set(values.map(norm).filter(Boolean))];
const clamp = (n, lo=0, hi=100) => Math.max(lo, Math.min(hi, Number(n) || 0));

function tokens(values) {
  const out = new Set();
  for (const raw of values) {
    const value = norm(raw).replace(/[_/]+/g, " ");
    if (!value) continue;
    out.add(value);
    for (const token of value.split(/[^a-z0-9+#-]+/i).filter(x => x.length >= 3)) out.add(token);
  }
  return out;
}

function overlapScore(a, b) {
  const aa=tokens(a), bb=tokens(b);
  if (!aa.size || !bb.size) return 0;
  let hits=0;
  for (const v of aa) if (bb.has(v)) hits++;
  return hits / Math.max(1, Math.min(aa.size, bb.size));
}

export function normalizeMatchContext({ release={}, track={}, audioIntelligence={}, seoSnapshot={} }={}) {
  const genreCandidates = arr(audioIntelligence?.genre?.candidates).map(x => x?.genre);
  const moods = arr(audioIntelligence?.mood?.candidates).filter(x => Number(x?.relative_strength ?? x?.relative_confidence ?? 0) >= .35).map(x => x?.label);
  const presence = arr(audioIntelligence?.presence?.tags).filter(x => Number(x?.relative_strength ?? x?.relative_confidence ?? 0) >= .35).map(x => x?.label);
  const cues = arr(audioIntelligence?.sonic_fingerprint?.cues).filter(x => Number(x?.strength ?? 0) >= .35).map(x => x?.name);
  const keywordIdeas = arr(seoSnapshot?.keywordIdeas).map(x => x?.term);
  const downstream = arr(audioIntelligence?.downstream_metadata?.consumer_targets);
  return {
    genre: norm(audioIntelligence?.genre?.primary_subgenre || track?.genre || release?.genre || audioIntelligence?.genre?.primary_genre),
    genreFamily: norm(audioIntelligence?.genre?.primary_genre || release?.genre || track?.genre),
    genreCandidates: uniq([track?.genre, release?.genre, ...genreCandidates]),
    moods: uniq(moods),
    energy: norm(audioIntelligence?.energy?.primary?.label),
    sonicTags: uniq([...presence, ...cues, ...downstream, ...arr(track?.tags)]),
    bpm: Number(audioIntelligence?.tempo?.estimated_bpm) || null,
    key: String(audioIntelligence?.key?.estimated_key || ""),
    vocalPresence: Number(audioIntelligence?.presence?.vocal) || 0,
    explicit: typeof audioIntelligence?.explicit_content?.explicit === "boolean" ? audioIntelligence.explicit_content.explicit : Boolean(track?.explicit),
    seoKeywords: uniq(keywordIdeas),
    seoOpportunity: Number(seoSnapshot?.scores?.opportunity) || 0,
  };
}

export function scoreCuratorMatch(context, channel, stats={}) {
  const reasons=[];
  const misses=[];
  if (context.explicit && channel.acceptsExplicit === false) {
    return { score:0, eligible:false, reasons:[], misses:["Channel does not accept explicit releases."], breakdown:{compatibility:0} };
  }
  let score=0;
  const genreOverlap=overlapScore([context.genre, context.genreFamily, ...arr(context.genreCandidates)], arr(channel.genres));
  const genrePoints=Math.round(42*genreOverlap); score+=genrePoints;
  if (genrePoints >= 20) reasons.push(`Strong genre overlap with ${arr(channel.genres).slice(0,3).join(", ")}.`);
  else if (arr(channel.genres).length) misses.push("Genre overlap is limited.");

  const moodOverlap=overlapScore(arr(context.moods), arr(channel.moods));
  const moodPoints=Math.round(14*moodOverlap); score+=moodPoints;
  if (moodPoints>=5) reasons.push("Mood profile overlaps the curator's preferred lane.");

  const sonicOverlap=overlapScore(arr(context.sonicTags), arr(channel.sonicTags));
  const sonicPoints=Math.round(14*sonicOverlap); score+=sonicPoints;
  if (sonicPoints>=5) reasons.push("Production/instrument cues match the channel profile.");

  let tempoPoints=4;
  if (context.bpm && (channel.minBpm || channel.maxBpm)) {
    const min=Number(channel.minBpm)||0, max=Number(channel.maxBpm)||999;
    tempoPoints=context.bpm>=min && context.bpm<=max ? 8 : 0;
    if (tempoPoints) reasons.push(`Tempo ${Math.round(context.bpm)} BPM is inside the curator's preferred range.`);
    else misses.push(`Tempo ${Math.round(context.bpm)} BPM is outside the preferred range.`);
  }
  score+=tempoPoints;

  const seoOverlap=overlapScore(arr(context.seoKeywords), [...arr(channel.genres), ...arr(channel.moods), ...arr(channel.sonicTags)]);
  const seoPoints=Math.round(8*seoOverlap); score+=seoPoints;
  if (seoPoints>=3) reasons.push("SEO/search language overlaps the curator profile.");

  const responseRate=clamp(stats.responseRate || 0,0,1);
  const responsePoints=Math.round(8*responseRate); score+=responsePoints;
  if (responseRate>=.8) reasons.push(`Curator responds to ${Math.round(responseRate*100)}% of completed submissions.`);

  const completionConfidence=Math.min(1, Number(stats.responded || 0)/20);
  const reputationPoints=Math.round(6*clamp(stats.reputation || 0,0,1)*completionConfidence); score+=reputationPoints;

  if (!arr(channel.genres).length) score=Math.min(score,72);
  score=clamp(score);
  return {
    score,
    eligible:true,
    reasons:reasons.slice(0,5),
    misses:misses.slice(0,4),
    breakdown:{genre:genrePoints,mood:moodPoints,sonic:sonicPoints,tempo:tempoPoints,seo:seoPoints,response:responsePoints,reputation:reputationPoints},
  };
}

export function curatorStats(rows=[]) {
  const total=rows.length;
  const responded=rows.filter(r => r.status === "accepted" || r.status === "rejected");
  const accepted=responded.filter(r => r.status === "accepted").length;
  const responseHours=responded.map(r => {
    const a=new Date(r.submitted_at).getTime(), b=new Date(r.responded_at).getTime();
    return Number.isFinite(a)&&Number.isFinite(b)&&b>=a ? (b-a)/3600000 : null;
  }).filter(v=>v!==null);
  const responseRate=total ? responded.length/total : 0;
  const acceptanceRate=responded.length ? accepted/responded.length : 0;
  const avgResponseHours=responseHours.length ? responseHours.reduce((a,b)=>a+b,0)/responseHours.length : null;
  const sampleConfidence=Math.min(1, responded.length/25);
  const timeliness=avgResponseHours==null ? 0.5 : Math.max(0, Math.min(1, 1-(avgResponseHours/(30*24))));
  const reputation=(responseRate*.7 + timeliness*.3)*sampleConfidence;
  return {total,responded:responded.length,accepted,responseRate,acceptanceRate,avgResponseHours,reputation,sampleConfidence};
}
