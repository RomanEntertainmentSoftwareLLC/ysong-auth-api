import crypto from "crypto";
import { z } from "zod";

export const DestinationSchema = z.object({
  id: z.string().uuid().optional(),
  platform: z.string().trim().min(1).max(80).optional().default("link"),
  label: z.string().trim().min(1).max(120),
  url: z.string().url().max(2000).refine((value) => /^https?:\/\//i.test(value), "HTTP(S) URL required"),
  kind: z.enum(["stream", "presave", "social", "store", "other"]).optional().default("stream"),
  enabled: z.boolean().optional().default(true),
});

// The array order is the display order. Existing IDs keep redirect URLs and event attribution stable.
export async function saveDestinations(client, campaignId, destinations) {
  const { rows } = await client.query(
    `SELECT id,platform,url FROM promotion_destinations WHERE campaign_id=$1 ORDER BY position ASC,created_at ASC`,
    [campaignId],
  );
  const existing = new Map(rows.map((row) => [String(row.id), row]));
  const used = new Set();
  const resolved = destinations.map((destination) => {
    if (destination.id) {
      if (!existing.has(destination.id) || used.has(destination.id)) throw new Error("invalid_destination_id");
      used.add(destination.id);
      return { ...destination, id: destination.id };
    }
    // Older clients omit IDs. Retain a row when its service and URL still identify it.
    const match = rows.find((row) => !used.has(String(row.id)) && row.platform === destination.platform && row.url === destination.url);
    const id = match ? String(match.id) : crypto.randomUUID();
    used.add(id);
    return { ...destination, id };
  });
  for (let position = 0; position < resolved.length; position++) {
    const destination = resolved[position];
    if (existing.has(destination.id)) {
      await client.query(
        `UPDATE promotion_destinations SET platform=$3,label=$4,url=$5,destination_kind=$6,position=$7,enabled=$8 WHERE id=$1 AND campaign_id=$2`,
        [destination.id, campaignId, destination.platform, destination.label, destination.url, destination.kind, position, destination.enabled],
      );
    } else {
      await client.query(
        `INSERT INTO promotion_destinations(id,campaign_id,platform,label,url,destination_kind,position,enabled) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [destination.id, campaignId, destination.platform, destination.label, destination.url, destination.kind, position, destination.enabled],
      );
    }
  }
  for (const row of rows) {
    if (!used.has(String(row.id))) await client.query(`DELETE FROM promotion_destinations WHERE id=$1 AND campaign_id=$2`, [row.id, campaignId]);
  }
}
