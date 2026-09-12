import { pool } from "../db.js";

export async function ensureCuratorSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS curator_profiles (
      id uuid PRIMARY KEY,
      owner_user_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      display_name text NOT NULL DEFAULT '',
      organization text NOT NULL DEFAULT '',
      curator_type text NOT NULL DEFAULT 'playlist' CHECK (curator_type IN ('playlist','blog','radio','youtube','influencer','music_media')),
      bio text NOT NULL DEFAULT '',
      website_url text NOT NULL DEFAULT '',
      status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','paused','suspended')),
      editorial_independence_ack boolean NOT NULL DEFAULT false,
      verified boolean NOT NULL DEFAULT false,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS curator_profiles_status_idx ON curator_profiles(status, updated_at DESC);

    CREATE TABLE IF NOT EXISTS curator_channels (
      id uuid PRIMARY KEY,
      curator_profile_id uuid NOT NULL REFERENCES curator_profiles(id) ON DELETE CASCADE,
      name text NOT NULL,
      platform text NOT NULL DEFAULT '',
      url text NOT NULL DEFAULT '',
      description text NOT NULL DEFAULT '',
      genres jsonb NOT NULL DEFAULT '[]'::jsonb,
      moods jsonb NOT NULL DEFAULT '[]'::jsonb,
      sonic_tags jsonb NOT NULL DEFAULT '[]'::jsonb,
      languages jsonb NOT NULL DEFAULT '["en"]'::jsonb,
      countries jsonb NOT NULL DEFAULT '[]'::jsonb,
      min_bpm double precision,
      max_bpm double precision,
      accepts_explicit boolean NOT NULL DEFAULT true,
      submission_cost_credits integer NOT NULL DEFAULT 0 CHECK (submission_cost_credits BETWEEN 0 AND 100),
      response_days integer NOT NULL DEFAULT 7 CHECK (response_days BETWEEN 1 AND 30),
      audience_size bigint NOT NULL DEFAULT 0,
      active boolean NOT NULL DEFAULT true,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS curator_channels_profile_idx ON curator_channels(curator_profile_id, active DESC, updated_at DESC);
    CREATE INDEX IF NOT EXISTS curator_channels_active_idx ON curator_channels(active, updated_at DESC);

    CREATE TABLE IF NOT EXISTS curator_wallets (
      owner_user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      balance integer NOT NULL DEFAULT 0 CHECK (balance >= 0),
      lifetime_granted integer NOT NULL DEFAULT 0,
      lifetime_spent integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS curator_credit_ledger (
      id uuid PRIMARY KEY,
      owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      amount integer NOT NULL,
      reason text NOT NULL,
      reference_type text NOT NULL DEFAULT '',
      reference_id uuid,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS curator_credit_ledger_owner_idx ON curator_credit_ledger(owner_user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS curator_match_contexts (
      id uuid PRIMARY KEY,
      owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      release_id uuid NOT NULL REFERENCES world_releases(id) ON DELETE CASCADE,
      track_id uuid REFERENCES world_tracks(id) ON DELETE CASCADE,
      audio_intelligence jsonb NOT NULL DEFAULT '{}'::jsonb,
      seo_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
      normalized jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(owner_user_id, release_id, track_id)
    );
    CREATE INDEX IF NOT EXISTS curator_match_contexts_owner_idx ON curator_match_contexts(owner_user_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS curator_submissions (
      id uuid PRIMARY KEY,
      artist_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      curator_profile_id uuid NOT NULL REFERENCES curator_profiles(id) ON DELETE CASCADE,
      curator_channel_id uuid NOT NULL REFERENCES curator_channels(id) ON DELETE CASCADE,
      release_id uuid NOT NULL REFERENCES world_releases(id) ON DELETE CASCADE,
      track_id uuid REFERENCES world_tracks(id) ON DELETE SET NULL,
      match_context_id uuid REFERENCES curator_match_contexts(id) ON DELETE SET NULL,
      pitch text NOT NULL DEFAULT '',
      status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_review','accepted','rejected','withdrawn','expired')),
      credits_spent integer NOT NULL DEFAULT 0,
      match_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
      release_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
      feedback jsonb NOT NULL DEFAULT '{}'::jsonb,
      placement_status text NOT NULL DEFAULT 'none' CHECK (placement_status IN ('none','planned','published','declined')),
      placement_url text NOT NULL DEFAULT '',
      submitted_at timestamptz NOT NULL DEFAULT now(),
      opened_at timestamptz,
      responded_at timestamptz,
      expires_at timestamptz,
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(artist_user_id, curator_channel_id, release_id, track_id)
    );
    CREATE INDEX IF NOT EXISTS curator_submissions_artist_idx ON curator_submissions(artist_user_id, submitted_at DESC);
    CREATE INDEX IF NOT EXISTS curator_submissions_curator_idx ON curator_submissions(curator_profile_id, status, submitted_at ASC);
    CREATE INDEX IF NOT EXISTS curator_submissions_channel_idx ON curator_submissions(curator_channel_id, submitted_at DESC);

    CREATE TABLE IF NOT EXISTS curator_reports (
      id uuid PRIMARY KEY,
      reporter_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      curator_profile_id uuid NOT NULL REFERENCES curator_profiles(id) ON DELETE CASCADE,
      submission_id uuid REFERENCES curator_submissions(id) ON DELETE SET NULL,
      reason text NOT NULL,
      detail text NOT NULL DEFAULT '',
      status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','reviewed','dismissed','actioned')),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS curator_reports_curator_idx ON curator_reports(curator_profile_id, status, created_at DESC);
  `);
}
