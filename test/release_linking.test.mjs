import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import express from 'express';
import {normalizeArtistName,registerReleaseLinking} from '../src/artists/releaseLinking.mjs';

test('normalized names suggest spelling variants without inventing ownership',()=>{
  assert.equal(normalizeArtistName('  Angeli et Diaboli '),normalizeArtistName('ANGELI ET DIABOLI'));
  assert.equal(normalizeArtistName('Ａｎｇｅｌｉ – et Diaboli'),normalizeArtistName('Angeli et Diaboli'));
  assert.notEqual(normalizeArtistName('Angeli et Diaboli'),normalizeArtistName('Other Artist'));
});
test('owned release linking against preserved isolated PostgreSQL',{skip:!process.env.TEST_SAAS_DATABASE_URL},async t=>{
  const url=new URL(process.env.TEST_SAAS_DATABASE_URL);
  if(!['127.0.0.1','localhost'].includes(url.hostname)||url.pathname!=='/ysong_saas_validation')throw new Error('Dedicated loopback fixture required');
  const root=new pg.Pool({connectionString:url.href}),schema='links_'+crypto.randomUUID().replaceAll('-','');
  await root.query('CREATE SCHEMA '+schema);
  const pool=new pg.Pool({connectionString:url.href,options:'-c search_path='+schema,max:10});
  t.after(async()=>{await pool.end();await root.end();});
  await pool.query(`CREATE TABLE artists(id uuid PRIMARY KEY,owner_user_id uuid NOT NULL);
    CREATE TABLE world_releases(id uuid PRIMARY KEY,owner_user_id uuid NOT NULL,artist_id uuid REFERENCES artists(id),artist_name text,title text,release_type text,published_at timestamptz DEFAULT now(),artwork_object_key text);
    CREATE TABLE world_tracks(id uuid PRIMARY KEY,release_id uuid REFERENCES world_releases(id),owner_user_id uuid NOT NULL,artist_id uuid REFERENCES artists(id),track_number int DEFAULT 1,audio_object_key text,play_count int DEFAULT 3);
    CREATE TABLE engagement(track_id uuid REFERENCES world_tracks(id),release_id uuid REFERENCES world_releases(id),likes int,comments text,playlist text,analytics text);`);
  const user=crypto.randomUUID(),other=crypto.randomUUID(),band=crypto.randomUUID(),second=crypto.randomUUID(),foreignBand=crypto.randomUUID();
  await pool.query('INSERT INTO artists VALUES($1,$2),($3,$2),($4,$5)',[band,user,second,foreignBand,other]);
  const release=async(owner=user,name='Angeli et Diaboli',artist=null,trackOwner=owner,trackArtist=artist)=>{
    const id=crypto.randomUUID(),track=crypto.randomUUID();
    await pool.query("INSERT INTO world_releases(id,owner_user_id,artist_id,artist_name,title,release_type,artwork_object_key) VALUES($1,$2,$3,$4,'Golden Darkness','album','unchanged-art')",[id,owner,artist,name]);
    await pool.query("INSERT INTO world_tracks(id,release_id,owner_user_id,artist_id,audio_object_key) VALUES($1,$2,$3,$4,'unchanged-audio')",[track,id,trackOwner,trackArtist]);
    await pool.query("INSERT INTO engagement VALUES($1,$2,5,'comments','playlist','analytics')",[track,id]);return{id,track};
  };
  const normal=await release(),foreign=await release(other),linked=await release(user,'Angeli et Diaboli',second),different=await release(user,'Other Artist'),conflict=await release(user,'Angeli et Diaboli',null,other),broken=await release();
  const app=express();app.use(express.json());registerReleaseLinking(app,{pool,requireAuth:(req,res,next)=>{const id=req.get('authorization');if(![user,other].includes(id))return res.sendStatus(401);req.user={id};next();}});
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>new Promise(r=>server.close(r)));const base='http://127.0.0.1:'+server.address().port;
  const request=async(path,body,uid=user)=>{const r=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{authorization:uid,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return{status:r.status,data:await r.json().catch(()=>null)};};
  const path='/api/artists/'+band+'/link-releases';
  await t.test('candidate reads are owner-scoped, normalized, unlinked and never attach automatically',async()=>{
    const r=await request('/api/artists/release-candidates?name='+encodeURIComponent('ANGELI - et Diaboli'));
    assert.equal(r.status,200);const ids=r.data.releases.map(x=>x.id);assert.ok(ids.includes(normal.id));assert.ok(!ids.includes(foreign.id));assert.ok(!ids.includes(linked.id));assert.ok(!ids.includes(different.id));assert.equal(r.data.releases[0].releaseType,'album');
    assert.equal((await pool.query('SELECT artist_id FROM world_releases WHERE id=$1',[normal.id])).rows[0].artist_id,null);
    assert.ok((await request('/api/artists/release-candidates')).data.releases.some(r=>r.id===different.id));
    assert.equal((await request('/api/artists/release-candidates?offset=-1')).status,400);
  });
  await t.test('selected releases link atomically with per-release failure while all existing IDs/media/engagement survive',async()=>{
    const before=await pool.query('SELECT * FROM engagement WHERE release_id=$1',[normal.id]);
    const r=await request(path,{releaseIds:[normal.id,foreign.id,linked.id,conflict.id]});
    assert.equal(r.status,200);assert.equal(r.data.results[0].linked,true);assert.deepEqual(r.data.results.slice(1).map(x=>x.error),['release_not_owned','release_already_linked','release_tracks_conflict']);
    const actual=(await pool.query('SELECT * FROM world_tracks WHERE id=$1',[normal.track])).rows[0];assert.equal(actual.artist_id,band);assert.equal(actual.audio_object_key,'unchanged-audio');assert.equal(actual.play_count,3);assert.equal(actual.release_id,normal.id);
    assert.deepEqual((await pool.query('SELECT * FROM engagement WHERE release_id=$1',[normal.id])).rows,before.rows);
    const row=(await pool.query('SELECT * FROM world_releases WHERE id=$1',[normal.id])).rows[0];assert.equal(row.artwork_object_key,'unchanged-art');assert.equal(row.artist_name,'Angeli et Diaboli');
    assert.equal((await pool.query('SELECT artist_id FROM world_releases WHERE id=$1',[conflict.id])).rows[0].artist_id,null);
    assert.equal((await pool.query('SELECT count(*) FROM artists WHERE id=$1',[band])).rows[0].count,'1');
  });
  await t.test('track-write failure rolls back only that release and retry is idempotent',async()=>{
    await pool.query(`CREATE FUNCTION fail_fixture_link() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${broken.track}'::uuid THEN RAISE EXCEPTION 'fixture'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fixture_track_failure BEFORE UPDATE ON world_tracks FOR EACH ROW EXECUTE FUNCTION fail_fixture_link();`);
    const r=await request(path,{releaseIds:[broken.id,normal.id,normal.id]});assert.equal(r.data.results.length,2);assert.equal(r.data.results[0].error,'release_link_failed');assert.equal(r.data.results[1].linked,true);
    assert.equal((await pool.query('SELECT artist_id FROM world_releases WHERE id=$1',[broken.id])).rows[0].artist_id,null);
  });
  await t.test('unauthorized artists, malformed selections and anonymous requests cannot mutate catalog',async()=>{
    assert.equal((await request('/api/artists/'+foreignBand+'/link-releases',{releaseIds:[normal.id]})).status,403);
    assert.equal((await request(path,{releaseIds:['invalid']})).status,400);
    assert.equal((await request(path,{releaseIds:[different.id]},'')).status,401);
  });
  await t.test('concurrent competing Band links cannot overwrite each other',async()=>{
    const race=await release();const replies=await Promise.all([request(path,{releaseIds:[race.id]}),request('/api/artists/'+second+'/link-releases',{releaseIds:[race.id]})]);
    assert.equal(replies.filter(r=>r.data.results[0].linked).length,1);assert.equal(replies.filter(r=>!r.data.results[0].linked)[0].data.results[0].error,'release_already_linked');
    const r=(await pool.query('SELECT artist_id FROM world_releases WHERE id=$1',[race.id])).rows[0],tr=(await pool.query('SELECT artist_id FROM world_tracks WHERE id=$1',[race.track])).rows[0];assert.equal(r.artist_id,tr.artist_id);
  });
});
