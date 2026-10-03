export async function validateReleaseMetadata(body, userId, {assertOwnedObjectKey, readObjectMetadata}) {
  const patch = {};
  const invalid = message => Object.assign(new Error(message), {statusCode:400});
  if (body.releaseDate !== undefined) {
    const value = body.releaseDate;
    if (value !== null && value !== '') {
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.slice(0,4)==='0000') throw invalid('invalid_release_date');
      const date = new Date(value+'T00:00:00.000Z');
      if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0,10)!==value) throw invalid('invalid_release_date');
    }
    patch.releaseDate = value || null;
  }
  if (body.recordLabel !== undefined) {
    if (typeof body.recordLabel !== 'string' || body.recordLabel.length > 180) throw invalid('invalid_record_label');
    patch.recordLabel = body.recordLabel.trim();
  }
  if (body.artworkObjectKey !== undefined) {
    if (typeof body.artworkObjectKey !== 'string' || !body.artworkObjectKey) throw invalid('image_file_required');
    patch.artworkObjectKey = assertOwnedObjectKey(userId,body.artworkObjectKey,{uploadOnly:true});
    const meta = await readObjectMetadata(patch.artworkObjectKey);
    if (!String(meta.contentType || '').startsWith('image/')) throw invalid('image_file_required');
  }
  return patch;
}

// Uses the caller's transaction. Omitted fields preserve existing values; cover,
// date and label are release metadata shared by all tracks on the album.
export async function applyReleaseMetadata(client, releaseId, userId, patch) {
  if (!Object.keys(patch).length) return;
  const r = await client.query(`UPDATE world_releases SET
    release_date=CASE WHEN $3 THEN $4::date ELSE release_date END,
    record_label=CASE WHEN $5 THEN $6 ELSE record_label END,
    artwork_object_key=CASE WHEN $7 THEN $8 ELSE artwork_object_key END
    WHERE id=$1 AND owner_user_id=$2 RETURNING id`, [releaseId,userId,
    'releaseDate' in patch,patch.releaseDate??null,'recordLabel' in patch,patch.recordLabel??'',
    'artworkObjectKey' in patch,patch.artworkObjectKey??null]);
  if (!r.rows.length) throw Object.assign(new Error('release_not_owned'),{statusCode:403});
}
