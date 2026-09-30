// Meta's reach estimate is a modeled audience size, never a population count.
export function mapMetaReachEstimate(payload) {
  const row = Array.isArray(payload?.data) ? payload.data[0] : payload;
  if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("meta_reach_response_invalid");
  const users = row.users;
  const finite = (value) => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
  const lower = finite(row.users_lower_bound ?? (typeof users === "object" ? users?.lower_bound : null));
  const upper = finite(row.users_upper_bound ?? (typeof users === "object" ? users?.upper_bound : null));
  const estimate = finite(typeof users === "object" ? null : users);
  if (lower !== null && upper !== null && lower > upper) throw new Error("meta_reach_response_invalid");
  if (row.estimate_ready === true && lower === null && upper === null && estimate === null) throw new Error("meta_reach_response_invalid");
  return {
    source: "meta_reachestimate", kind: "modeled_audience_estimate",
    ready: row.estimate_ready === true ? true : row.estimate_ready === false ? false : lower !== null || upper !== null || estimate !== null,
    estimate, lower, upper,
    targetingStatus: row.targeting_status ?? null,
  };
}

export async function fetchMetaReachEstimate({ graphBase, token, adAccountId, targetingSpec, fetchJson }) {
  const account = String(adAccountId || "").replace(/^act_/, "");
  if (!/^[0-9]+$/.test(account)) throw new Error("meta_ad_account_required");
  const params = new URLSearchParams({ targeting_spec: JSON.stringify(targetingSpec), optimize_for: "IMPRESSIONS" });
  const data = await fetchJson(`${graphBase}/act_${account}/reachestimate?${params}`, { headers: { Authorization: `Bearer ${token}` } });
  return mapMetaReachEstimate(data);
}
