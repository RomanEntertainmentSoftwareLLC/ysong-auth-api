import { pool } from "../db.js";

export async function ensurePromotionSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS promotion_campaigns (
      id uuid PRIMARY KEY,
      owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      source_release_id uuid REFERENCES world_releases(id) ON DELETE SET NULL,
      kind text NOT NULL DEFAULT 'smart_link' CHECK (kind IN ('smart_link','presave','release')),
      status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','archived')),
      slug text NOT NULL,
      title text NOT NULL,
      artist_name text NOT NULL DEFAULT '',
      description text NOT NULL DEFAULT '',
      genre text NOT NULL DEFAULT '',
      release_date timestamptz,
      artwork_object_key text,
      headline text NOT NULL DEFAULT '',
      cta_label text NOT NULL DEFAULT '',
      accent_color text NOT NULL DEFAULT '#8b5cf6',
      seo_query text NOT NULL DEFAULT '',
      seo_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(slug)
    );
    CREATE INDEX IF NOT EXISTS promotion_campaigns_owner_idx ON promotion_campaigns(owner_user_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS promotion_campaigns_status_idx ON promotion_campaigns(status, updated_at DESC);

    CREATE TABLE IF NOT EXISTS promotion_destinations (
      id uuid PRIMARY KEY,
      campaign_id uuid NOT NULL REFERENCES promotion_campaigns(id) ON DELETE CASCADE,
      platform text NOT NULL DEFAULT 'link',
      label text NOT NULL,
      url text NOT NULL,
      destination_kind text NOT NULL DEFAULT 'stream' CHECK (destination_kind IN ('stream','presave','social','store','other')),
      position integer NOT NULL DEFAULT 0,
      enabled boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS promotion_destinations_campaign_idx ON promotion_destinations(campaign_id, position ASC);

    CREATE TABLE IF NOT EXISTS promotion_fans (
      id uuid PRIMARY KEY,
      campaign_id uuid NOT NULL REFERENCES promotion_campaigns(id) ON DELETE CASCADE,
      email text NOT NULL,
      consent boolean NOT NULL DEFAULT false,
      source text NOT NULL DEFAULT 'landing_page',
      provider text NOT NULL DEFAULT '',
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS promotion_fans_campaign_email_idx ON promotion_fans(campaign_id, lower(email));
    CREATE INDEX IF NOT EXISTS promotion_fans_campaign_created_idx ON promotion_fans(campaign_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS promotion_events (
      id bigserial PRIMARY KEY,
      campaign_id uuid NOT NULL REFERENCES promotion_campaigns(id) ON DELETE CASCADE,
      destination_id uuid REFERENCES promotion_destinations(id) ON DELETE SET NULL,
      event_type text NOT NULL,
      visitor_id text NOT NULL DEFAULT '',
      referrer text NOT NULL DEFAULT '',
      user_agent text NOT NULL DEFAULT '',
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS promotion_events_campaign_created_idx ON promotion_events(campaign_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS promotion_events_campaign_type_idx ON promotion_events(campaign_id, event_type, created_at DESC);
    CREATE INDEX IF NOT EXISTS promotion_events_ad_campaign_idx ON promotion_events ((metadata->>'adCampaignId'), created_at DESC);
    CREATE INDEX IF NOT EXISTS promotion_events_creative_idx ON promotion_events ((metadata->>'creativeId'), created_at DESC);

    CREATE TABLE IF NOT EXISTS promotion_meta_connections (
      id uuid PRIMARY KEY,
      owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      page_id text NOT NULL,
      page_name text NOT NULL DEFAULT '',
      page_access_token_ciphertext text NOT NULL,
      ig_user_id text NOT NULL DEFAULT '',
      ig_username text NOT NULL DEFAULT '',
      tasks jsonb NOT NULL DEFAULT '[]'::jsonb,
      scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
      is_active boolean NOT NULL DEFAULT false,
      connected_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(owner_user_id, page_id)
    );
    ALTER TABLE promotion_meta_connections ADD COLUMN IF NOT EXISTS meta_user_id text NOT NULL DEFAULT '';
    ALTER TABLE promotion_meta_connections ADD COLUMN IF NOT EXISTS user_access_token_ciphertext text NOT NULL DEFAULT '';
    CREATE INDEX IF NOT EXISTS promotion_meta_connections_owner_idx ON promotion_meta_connections(owner_user_id, is_active DESC, updated_at DESC);

    CREATE TABLE IF NOT EXISTS promotion_meta_profiles (
      owner_user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      selected_ad_account_id text NOT NULL DEFAULT '',
      selected_pixel_id text NOT NULL DEFAULT '',
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS promotion_oauth_states (
      state_hash text PRIMARY KEY,
      owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS promotion_oauth_states_expiry_idx ON promotion_oauth_states(expires_at);

    CREATE TABLE IF NOT EXISTS promotion_ad_campaigns (
      id uuid PRIMARY KEY,
      owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      campaign_id uuid NOT NULL REFERENCES promotion_campaigns(id) ON DELETE CASCADE,
      source_track_id uuid REFERENCES world_tracks(id) ON DELETE SET NULL,
      name text NOT NULL,
      goal text NOT NULL DEFAULT 'song_growth',
      status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','rendering','ready','publishing','in_review','active','paused','completed','failed','archived')),
      genre text NOT NULL DEFAULT '',
      genre_source text NOT NULL DEFAULT 'ysong',
      daily_budget_minor integer NOT NULL DEFAULT 500,
      currency text NOT NULL DEFAULT 'USD',
      schedule_start timestamptz,
      schedule_end timestamptz,
      timezone text NOT NULL DEFAULT 'UTC',
      placements jsonb NOT NULL DEFAULT '["facebook","instagram"]'::jsonb,
      targeting jsonb NOT NULL DEFAULT '{}'::jsonb,
      ad_text text NOT NULL DEFAULT '',
      ad_headline text NOT NULL DEFAULT '',
      language text NOT NULL DEFAULT 'en',
      cover_art_object_key text,
      meta_connection_id uuid REFERENCES promotion_meta_connections(id) ON DELETE SET NULL,
      meta_ad_account_id text NOT NULL DEFAULT '',
      meta_pixel_id text NOT NULL DEFAULT '',
      dsa_beneficiary text NOT NULL DEFAULT '',
      dsa_payor text NOT NULL DEFAULT '',
      meta_campaign_id text NOT NULL DEFAULT '',
      meta_adset_id text NOT NULL DEFAULT '',
      meta_status text NOT NULL DEFAULT '',
      meta_published_at timestamptz,
      meta_publish_fingerprint text NOT NULL DEFAULT '',
      meta_last_error jsonb NOT NULL DEFAULT '{}'::jsonb,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE promotion_ad_campaigns ADD COLUMN IF NOT EXISTS dsa_beneficiary text NOT NULL DEFAULT '';
    ALTER TABLE promotion_ad_campaigns ADD COLUMN IF NOT EXISTS dsa_payor text NOT NULL DEFAULT '';
    ALTER TABLE promotion_ad_campaigns ADD COLUMN IF NOT EXISTS meta_published_at timestamptz;
    ALTER TABLE promotion_ad_campaigns ADD COLUMN IF NOT EXISTS meta_publish_fingerprint text NOT NULL DEFAULT '';
    CREATE INDEX IF NOT EXISTS promotion_ad_campaigns_owner_idx ON promotion_ad_campaigns(owner_user_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS promotion_ad_campaigns_campaign_idx ON promotion_ad_campaigns(campaign_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS promotion_audio_snippets (
      id uuid PRIMARY KEY,
      ad_campaign_id uuid NOT NULL REFERENCES promotion_ad_campaigns(id) ON DELETE CASCADE,
      source_track_id uuid REFERENCES world_tracks(id) ON DELETE SET NULL,
      source_object_key text NOT NULL,
      label text NOT NULL DEFAULT '',
      start_seconds double precision NOT NULL DEFAULT 0,
      duration_seconds double precision NOT NULL DEFAULT 30,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS promotion_audio_snippets_campaign_idx ON promotion_audio_snippets(ad_campaign_id, created_at ASC);

    CREATE TABLE IF NOT EXISTS promotion_creative_libraries (
      id uuid PRIMARY KEY,
      owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS promotion_creative_libraries_owner_idx ON promotion_creative_libraries(owner_user_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS promotion_background_videos (
      id uuid PRIMARY KEY,
      owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      library_id uuid REFERENCES promotion_creative_libraries(id) ON DELETE SET NULL,
      object_key text NOT NULL,
      original_name text NOT NULL DEFAULT '',
      duration_seconds double precision,
      width integer,
      height integer,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE promotion_background_videos ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;
    CREATE INDEX IF NOT EXISTS promotion_background_videos_owner_idx ON promotion_background_videos(owner_user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS promotion_ad_creatives (
      id uuid PRIMARY KEY,
      owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      ad_campaign_id uuid NOT NULL REFERENCES promotion_ad_campaigns(id) ON DELETE CASCADE,
      library_id uuid REFERENCES promotion_creative_libraries(id) ON DELETE SET NULL,
      audio_snippet_id uuid NOT NULL REFERENCES promotion_audio_snippets(id) ON DELETE CASCADE,
      background_video_id uuid NOT NULL REFERENCES promotion_background_videos(id) ON DELETE CASCADE,
      status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','rendering','ready','failed')),
      selected boolean NOT NULL DEFAULT true,
      object_key_916 text NOT NULL DEFAULT '',
      object_key_43 text NOT NULL DEFAULT '',
      duration_seconds double precision,
      render_error text NOT NULL DEFAULT '',
      meta_video_id_916 text NOT NULL DEFAULT '',
      meta_video_id_43 text NOT NULL DEFAULT '',
      meta_ad_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(ad_campaign_id, audio_snippet_id, background_video_id)
    );
    CREATE INDEX IF NOT EXISTS promotion_ad_creatives_campaign_idx ON promotion_ad_creatives(ad_campaign_id, selected DESC, created_at ASC);
    CREATE INDEX IF NOT EXISTS promotion_ad_creatives_library_idx ON promotion_ad_creatives(library_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS promotion_meta_insights (
      id bigserial PRIMARY KEY,
      ad_campaign_id uuid NOT NULL REFERENCES promotion_ad_campaigns(id) ON DELETE CASCADE,
      level text NOT NULL DEFAULT 'campaign',
      object_id text NOT NULL DEFAULT '',
      date_start date,
      date_stop date,
      snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
      captured_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS promotion_meta_insights_campaign_idx ON promotion_meta_insights(ad_campaign_id, captured_at DESC);
    CREATE INDEX IF NOT EXISTS promotion_meta_insights_level_idx ON promotion_meta_insights(ad_campaign_id, level, captured_at DESC);
  `);
}
