const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function normalizeArtistName(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

// The current catalog's control boundary is owner_user_id. Saved releases,
// follows and matching display names never confer ownership or delegation.
export function registerReleaseLinking(app, {pool, requireAuth}) {
  app.get('/api/artists/release-candidates', requireAuth, async (req, res) => {
    const name = String(req.query.name ?? '').trim();
    const offset = Number(req.query.offset ?? 0);
    if (name.length > 180 || !Number.isSafeInteger(offset) || offset < 0) return res.status(400).json({error:'invalid_candidates_query'});
    try {
      const {rows} = await pool.query(`SELECT r.id,r.title,r.artist_name,r.release_type,r.published_at,
        (r.artwork_object_key IS NOT NULL) AS has_artwork,
        (SELECT t.id FROM world_tracks t WHERE t.release_id=r.id ORDER BY t.track_number,t.id LIMIT 1) AS cover_track_id
        FROM world_releases r WHERE r.owner_user_id=$1 AND r.artist_id IS NULL
        ORDER BY r.published_at DESC,r.id`, [req.user.id]);
      const normalized = normalizeArtistName(name);
      const matches = name ? rows.filter(r => normalized && normalizeArtistName(r.artist_name) === normalized) : rows;
      const page = matches.slice(offset, offset + 100);
      res.json({releases:page.map(r => ({id:r.id,title:r.title,artistName:r.artist_name,releaseType:r.release_type,
        publishedAt:r.published_at,hasArtwork:r.has_artwork,coverTrackId:r.cover_track_id})),
        nextOffset:offset + page.length < matches.length ? offset + page.length : null});
    } catch { res.status(503).json({error:'release_candidates_unavailable'}); }
  });

  app.post('/api/artists/:id/link-releases', requireAuth, async (req, res) => {
    const ids = req.body?.releaseIds;
    if (!uuid.test(req.params.id) || !Array.isArray(ids) || ids.length > 100 || ids.some(id => typeof id !== 'string' || !uuid.test(id))) return res.status(400).json({error:'invalid_release_selection'});
    const artistId = req.params.id.toLowerCase();
    let artist;
    try { artist = (await pool.query('SELECT id FROM artists WHERE id=$1 AND owner_user_id=$2', [artistId,req.user.id])).rows[0]; }
    catch { return res.status(503).json({error:'release_linking_unavailable'}); }
    if (!artist) return res.status(403).json({error:'artist_not_owned'});
    const results = [];
    // One atomic release+tracks transaction per selected release. A bad selection
    // cannot roll back the already-created Band or other successful selections.
    for (const id of [...new Set(ids)]) {
      let c;
      try {
        c = await pool.connect();
        await c.query('BEGIN');
        const ownedArtist = (await c.query('SELECT id FROM artists WHERE id=$1 AND owner_user_id=$2 FOR SHARE', [artistId,req.user.id])).rows[0];
        if (!ownedArtist) throw new Error('artist_not_owned');
        const r = (await c.query('SELECT id,artist_id FROM world_releases WHERE id=$1 AND owner_user_id=$2 FOR UPDATE', [id,req.user.id])).rows[0];
        if (!r) throw new Error('release_not_owned');
        if (r.artist_id && r.artist_id !== artistId) throw new Error('release_already_linked');
        const tracks = (await c.query('SELECT owner_user_id,artist_id FROM world_tracks WHERE release_id=$1 ORDER BY id FOR UPDATE', [id])).rows;
        if (tracks.some(t => t.owner_user_id !== req.user.id || (t.artist_id && t.artist_id !== artistId))) throw new Error('release_tracks_conflict');
        await c.query('UPDATE world_releases SET artist_id=$1 WHERE id=$2 AND owner_user_id=$3', [artistId,id,req.user.id]);
        await c.query('UPDATE world_tracks SET artist_id=$1 WHERE release_id=$2 AND owner_user_id=$3', [artistId,id,req.user.id]);
        await c.query('COMMIT');
        results.push({id,linked:true});
      } catch (e) {
        if (c) await c.query('ROLLBACK').catch(() => {});
        const allowed = ['artist_not_owned','release_not_owned','release_already_linked','release_tracks_conflict'];
        results.push({id,linked:false,error:allowed.includes(e.message) ? e.message : 'release_link_failed'});
      } finally { c?.release(); }
    }
    res.json({artistId,results});
  });
}
