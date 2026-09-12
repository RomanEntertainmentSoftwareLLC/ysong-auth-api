export function clampScore(value) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function normalizeQuery(query) {
  return String(query ?? "").trim().replace(/\s+/g, " ");
}

export function median(values) {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const midpoint = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 0) {
    return (sorted[midpoint - 1] + sorted[midpoint]) / 2;
  }

  return sorted[midpoint];
}

export function daysSince(value) {
  if (!value) {
    return undefined;
  }

  const parsedDate = Date.parse(value);
  if (Number.isNaN(parsedDate)) {
    return undefined;
  }

  const deltaMilliseconds = Math.max(0, Date.now() - parsedDate);
  return deltaMilliseconds / (1000 * 60 * 60 * 24);
}

export function buildLogScore(value, multiplier) {
  return clampScore(Math.log10(Math.max(1, value) + 1) * multiplier);
}

export function average(values) {
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((total, value) => total + value, 0) / values.length;
}

export function roundCompact(value) {
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

export async function readJson(response) {
  return response.json();
}
