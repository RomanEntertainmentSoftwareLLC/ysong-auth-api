const SHORT_TERMS = new Set(["ai", "dj", "edm", "dnb", "lofi", "808"]);

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "but", "by", "can", "could", "did", "do", "does", "for", "from", "had", "has", "have", "he", "her", "hers", "him", "his", "how", "i", "if", "in", "into", "is", "it", "its", "just", "me", "more", "my", "no", "not", "of", "on", "or", "our", "ours", "out", "she", "so", "some", "that", "the", "their", "them", "then", "there", "these", "they", "this", "those", "to", "too", "up", "us", "was", "we", "were", "what", "when", "where", "which", "who", "why", "will", "with", "you", "your", "yours",
  "audio", "clip", "clips", "copyright", "cover", "covers", "feat", "featuring", "ft", "hd", "hq", "lyrics", "lyric", "mixes", "music", "official", "original", "provided", "records", "remaster", "remastered", "song", "songs", "topic", "track", "tracks", "upload", "uploads", "video", "videos", "visualizer", "youtube",
]);

const SOURCE_KIND_PRIORITY = {
  tag: 3,
  title: 2,
  album: 2,
  genre: 1,
  description: 0,
};

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function normalizeToken(token) {
  return token
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function tokenize(value) {
  const matches = decodeHtmlEntities(value).match(/[\p{L}\p{N}]+/gu) || [];
  return matches
    .map(normalizeToken)
    .filter((token) => token && !STOP_WORDS.has(token))
    .filter((token) => !/^\d+$/.test(token))
    .filter((token) => token.length >= 3 || SHORT_TERMS.has(token));
}

function phraseKind(tokenCount, tagMentions, totalMentions) {
  if (tagMentions > 0 && tagMentions >= Math.max(1, totalMentions * 0.6)) {
    return "tag";
  }

  return tokenCount === 1 ? "term" : "phrase";
}

function phraseWeight(length) {
  if (length >= 3) {
    return 1.6;
  }

  if (length === 2) {
    return 1.35;
  }

  return 1;
}

function isOnlySeedLanguage(tokens, queryTokens) {
  return tokens.length > 0 && tokens.every((token) => queryTokens.has(token));
}

function buildPhraseCandidates(tokens, queryTokens) {
  const candidates = [];

  for (let size = 1; size <= 3; size += 1) {
    for (let index = 0; index <= tokens.length - size; index += 1) {
      const phraseTokens = tokens.slice(index, index + size);
      if (isOnlySeedLanguage(phraseTokens, queryTokens)) {
        continue;
      }

      const phrase = phraseTokens.join(" ");
      if (!phrase || phrase.length < 3) {
        continue;
      }

      candidates.push({ phrase, tokenCount: size });
    }
  }

  return candidates;
}

function hasEnoughSignal(entry) {
  return entry.mentions >= 2 || entry.providers.size >= 2 || entry.weightedScore >= 8;
}

export function buildObservedKeywords(query, snapshots) {
  const queryTokens = new Set(tokenize(query));
  const phraseMap = new Map();
  const evidenceItems = snapshots.flatMap((snapshot) => snapshot.keywordEvidence || []);

  for (const evidence of evidenceItems) {
    const tokens = tokenize(evidence.text);
    if (tokens.length === 0) {
      continue;
    }

    const candidateMap = new Map();
    for (const candidate of buildPhraseCandidates(tokens, queryTokens)) {
      const previous = candidateMap.get(candidate.phrase);
      if (!previous || candidate.tokenCount > previous.tokenCount) {
        candidateMap.set(candidate.phrase, candidate);
      }
    }

    for (const candidate of candidateMap.values()) {
      const existing = phraseMap.get(candidate.phrase) || {
        phrase: candidate.phrase,
        tokenCount: candidate.tokenCount,
        mentions: 0,
        weightedScore: 0,
        providers: new Set(),
        platformMentions: new Map(),
        tagMentions: 0,
        sourcePriority: -1,
      };

      existing.tokenCount = Math.max(existing.tokenCount, candidate.tokenCount);
      existing.mentions += 1;
      existing.weightedScore += Number(evidence.weight || 1) * phraseWeight(candidate.tokenCount);
      existing.providers.add(evidence.platform);
      existing.platformMentions.set(evidence.platform, (existing.platformMentions.get(evidence.platform) || 0) + 1);
      existing.sourcePriority = Math.max(existing.sourcePriority, SOURCE_KIND_PRIORITY[evidence.source] ?? 0);
      if (evidence.source === "tag") {
        existing.tagMentions += 1;
      }

      phraseMap.set(candidate.phrase, existing);
    }
  }

  return [...phraseMap.values()]
    .filter(hasEnoughSignal)
    .sort((left, right) => {
      if (right.weightedScore !== left.weightedScore) {
        return right.weightedScore - left.weightedScore;
      }

      if (right.providers.size !== left.providers.size) {
        return right.providers.size - left.providers.size;
      }

      if (right.mentions !== left.mentions) {
        return right.mentions - left.mentions;
      }

      if (right.tokenCount !== left.tokenCount) {
        return right.tokenCount - left.tokenCount;
      }

      return left.phrase.localeCompare(right.phrase);
    })
    .slice(0, 24)
    .map((entry) => ({
      phrase: entry.phrase,
      kind: phraseKind(entry.tokenCount, entry.tagMentions, entry.mentions),
      mentions: entry.mentions,
      weightedScore: Math.round(entry.weightedScore * 10) / 10,
      providers: [...entry.providers],
      sourceCounts: [...entry.platformMentions.entries()].map(([platform, mentions]) => ({ platform, mentions })),
    }));
}
