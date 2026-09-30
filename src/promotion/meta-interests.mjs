export const META_INTEREST_MAX_RESULTS = 50;

export function parseMetaInterestSearch(input = {}) {
  const query = typeof input.q === "string" ? input.q.trim() : "";
  if (query.length < 2 || query.length > 120) throw new Error("meta_interest_query_invalid");
  const rawLimit = input.limit === undefined ? "20" : String(input.limit);
  if (!/^[0-9]+$/.test(rawLimit)) throw new Error("meta_interest_limit_invalid");
  const limit = Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > META_INTEREST_MAX_RESULTS) throw new Error("meta_interest_limit_invalid");
  const connectionId = input.connectionId === undefined ? "" : String(input.connectionId);
  if (connectionId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(connectionId)) throw new Error("meta_interest_connection_invalid");
  return { query, limit, connectionId };
}

function audienceNumber(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

export function mapMetaInterest(row) {
  if (!row || typeof row !== "object") return null;
  const id = String(row.id || "").trim();
  const name = String(row.name || "").trim();
  if (!id || !name) return null;
  const interest = { id, name };
  const lower = audienceNumber(row.audience_size_lower_bound ?? row.audience_size);
  const upper = audienceNumber(row.audience_size_upper_bound ?? row.audience_size);
  if (lower !== undefined) interest.audienceSizeLower = lower;
  if (upper !== undefined) interest.audienceSizeUpper = upper;
  if (Array.isArray(row.path)) interest.path = row.path.filter((part) => typeof part === "string");
  if (typeof row.description === "string" && row.description.trim()) interest.description = row.description.trim();
  return interest;
}

export async function fetchMetaInterests({ graphBase, token, query, limit, fetchJson }) {
  const params = new URLSearchParams({ type: "adinterest", q: query, limit: String(limit) });
  const data = await fetchJson(`${graphBase}/search?${params}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!Array.isArray(data?.data)) throw new Error("meta_interest_response_invalid");
  return data.data.slice(0, limit).map(mapMetaInterest).filter(Boolean);
}
