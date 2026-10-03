-- Explicit, additive migration. Never run against production on application startup.
CREATE TABLE IF NOT EXISTS ysong_plans (
  id text PRIMARY KEY CHECK (id IN ('free','basic','pro','premium')),
  name text NOT NULL,
  monthly_generation_quota integer CHECK (monthly_generation_quota >= 0),
  capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
  billing_prices jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- Add pricing columns before inserting NEW plans; never fill or overwrite existing catalog rows.
ALTER TABLE ysong_plans ADD COLUMN IF NOT EXISTS monthly_price_cents integer CHECK(monthly_price_cents>=0);
ALTER TABLE ysong_plans ADD COLUMN IF NOT EXISTS upgrade_order integer NOT NULL DEFAULT 0;
-- NULL quota means not configured, NOT unlimited. Configure deliberately before enabling.
INSERT INTO ysong_plans(id,name,monthly_price_cents,upgrade_order) VALUES
 ('free','Free',0,0),('basic','YSong Basic',999,1),
 ('pro','YSong Pro',1999,2),('premium','YSong Premium',2999,3) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS ysong_account_access (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  role text NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin','superadmin')),
  account_status text NOT NULL DEFAULT 'active' CHECK (account_status IN ('active','suspended','banned')),
  generation_disabled boolean NOT NULL DEFAULT false,
  uploads_disabled boolean NOT NULL DEFAULT false,
  sessions_revoked_before timestamptz,
  plan_id text NOT NULL DEFAULT 'free' REFERENCES ysong_plans(id),
  subscription_status text NOT NULL DEFAULT 'none',
  billing_provider text, billing_customer_id text, billing_subscription_id text,
  billing_product_id text, billing_price_id text, billing_live boolean,
  period_start timestamptz, period_end timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  override_plan_id text REFERENCES ysong_plans(id),
  override_quota integer CHECK (override_quota >= 0),
  override_capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
  override_expires_at timestamptz, override_reason text,
  last_billing_event_at bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ysong_billing_customer_unique ON ysong_account_access(billing_provider,billing_live,billing_customer_id) WHERE billing_customer_id IS NOT NULL;
INSERT INTO ysong_account_access(user_id) SELECT id FROM users ON CONFLICT DO NOTHING;
-- Resolve this bootstrap email once into an immutable FK. Requests authorize the stored role.
CREATE TABLE IF NOT EXISTS ysong_saas_bootstrap (
 id text PRIMARY KEY CHECK(id='superadmin'), user_id uuid NOT NULL UNIQUE REFERENCES users(id)
);
DO $$
BEGIN
  IF (SELECT count(*) FROM ysong_account_access WHERE role='superadmin') > 1 THEN
    RAISE EXCEPTION 'Multiple stored superadmin identities';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM ysong_account_access WHERE role='superadmin') THEN
    IF EXISTS (SELECT 1 FROM ysong_saas_bootstrap) OR to_regclass('ysong_saas_migrations') IS NOT NULL THEN
      RAISE EXCEPTION 'Stored superadmin identity missing; manual review required';
    END IF;
    IF (SELECT count(*) FROM users WHERE lower(email::text)='psychopathetica@gmail.com') <> 1 THEN
      RAISE EXCEPTION 'Missing or ambiguous superadmin bootstrap identity';
    END IF;
    UPDATE ysong_account_access SET role='superadmin'
      WHERE user_id IN (SELECT id FROM users WHERE lower(email::text)='psychopathetica@gmail.com');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM ysong_account_access WHERE role='superadmin' AND account_status='active') THEN
    RAISE EXCEPTION 'Stored superadmin must be active';
  END IF;
  INSERT INTO ysong_saas_bootstrap(id,user_id)
    SELECT 'superadmin',user_id FROM ysong_account_access WHERE role='superadmin' ON CONFLICT DO NOTHING;
  IF NOT EXISTS (SELECT 1 FROM ysong_saas_bootstrap b JOIN ysong_account_access a ON a.user_id=b.user_id
    WHERE b.id='superadmin' AND a.role='superadmin') THEN
    RAISE EXCEPTION 'Immutable superadmin identity mismatch';
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS ysong_quota_periods (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id),
  starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL,
  reserved integer NOT NULL DEFAULT 0 CHECK(reserved >= 0),
  used integer NOT NULL DEFAULT 0 CHECK(used >= 0),
  UNIQUE(user_id,starts_at), CHECK(ends_at > starts_at)
);
CREATE TABLE IF NOT EXISTS ysong_generation_batches (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id),
  request_key text NOT NULL, request_hash text NOT NULL,
  quantity integer NOT NULL CHECK(quantity BETWEEN 1 AND 20),
  source jsonb NOT NULL, parent_generation_id uuid,
  quota_period_id uuid REFERENCES ysong_quota_periods(id), charged boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id,request_key)
);
CREATE TABLE IF NOT EXISTS ysong_generation_versions (
  id uuid PRIMARY KEY, batch_id uuid NOT NULL REFERENCES ysong_generation_batches(id),
  user_id uuid NOT NULL REFERENCES users(id), project_id uuid NOT NULL,
  version_index integer NOT NULL CHECK(version_index >= 1),
  state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','planning','generating','processing','finalizing','ready','partially_ready','failed','cancelled')),
  provider text, model text, model_version text,
  result jsonb, error_code text, feedback smallint CHECK(feedback IN (-1,1)),
  reconciliation text NOT NULL DEFAULT 'reserved' CHECK(reconciliation IN ('reserved','consumed','released')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(batch_id,version_index)
);
CREATE INDEX IF NOT EXISTS ysong_generation_owner_history ON ysong_generation_batches(user_id,created_at DESC);
CREATE TABLE IF NOT EXISTS ysong_billing_events (
  provider text NOT NULL, live boolean NOT NULL, event_id text NOT NULL,
  event_type text NOT NULL, event_created bigint NOT NULL,
  transition jsonb,
  processed_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(provider,live,event_id)
);
CREATE TABLE IF NOT EXISTS ysong_admin_audit (
  id uuid PRIMARY KEY, actor_id uuid REFERENCES users(id), target_id uuid REFERENCES users(id),
  action text NOT NULL, reason text NOT NULL, before_state jsonb, after_state jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ysong_provider_controls (
  id text PRIMARY KEY, enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO ysong_provider_controls(id) VALUES ('global'),('openai'),('xai'),('cloudflare'),('audio_cpp'),('http') ON CONFLICT DO NOTHING;
-- Pass 2 durable executor state; existing batch/version and client-state owners remain canonical.
ALTER TABLE ysong_generation_versions ADD COLUMN IF NOT EXISTS execution jsonb;
ALTER TABLE ysong_plans ADD COLUMN IF NOT EXISTS monthly_price_cents integer CHECK(monthly_price_cents>=0);
ALTER TABLE ysong_plans ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'usd';
ALTER TABLE ysong_plans ADD COLUMN IF NOT EXISTS billing_interval text NOT NULL DEFAULT 'month';
ALTER TABLE ysong_plans ADD COLUMN IF NOT EXISTS storage_quota_bytes bigint CHECK(storage_quota_bytes>=0);
ALTER TABLE ysong_plans ADD COLUMN IF NOT EXISTS available boolean NOT NULL DEFAULT false;
ALTER TABLE ysong_plans ADD COLUMN IF NOT EXISTS public_visible boolean NOT NULL DEFAULT true;
ALTER TABLE ysong_plans ADD COLUMN IF NOT EXISTS upgrade_order integer NOT NULL DEFAULT 0;
ALTER TABLE ysong_plans ADD COLUMN IF NOT EXISTS usage_limits jsonb NOT NULL DEFAULT '{}';
CREATE TABLE IF NOT EXISTS ysong_usage_events (
 id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id),request_key text NOT NULL,request_hash text NOT NULL,
 capability text NOT NULL,provider text,model text,units integer NOT NULL DEFAULT 1,admin_exempt boolean NOT NULL,
 state text NOT NULL DEFAULT 'submitted',reported_cost numeric,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(user_id,request_key)
);
CREATE TABLE IF NOT EXISTS ysong_policy_versions (
 policy_id text NOT NULL,version text NOT NULL,url text NOT NULL,approved boolean NOT NULL DEFAULT false,required boolean NOT NULL DEFAULT true,active boolean NOT NULL DEFAULT false,PRIMARY KEY(policy_id,version)
);
CREATE UNIQUE INDEX IF NOT EXISTS ysong_policy_current ON ysong_policy_versions(policy_id) WHERE active;
CREATE TABLE IF NOT EXISTS ysong_policy_acceptances (
 user_id uuid NOT NULL REFERENCES users(id),policy_id text NOT NULL,version text NOT NULL,accepted_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(user_id,policy_id,version),FOREIGN KEY(policy_id,version) REFERENCES ysong_policy_versions(policy_id,version)
);
INSERT INTO ysong_policy_versions(policy_id,version,url) VALUES ('terms','attorney-review-required','/terms-of-service'),('privacy','attorney-review-required','/privacy'),('upload-rights','attorney-review-required','/legal'),('billing','attorney-review-required','/legal'),('generated-output','attorney-review-required','/legal'),('bridge-license','attorney-review-required','/legal') ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS ysong_content_reviews (
 object_key text PRIMARY KEY,owner_user_id uuid NOT NULL REFERENCES users(id),content_hash text NOT NULL,state text NOT NULL CHECK(state IN ('clear','needs_review','restricted','hidden','removed','restored')),
 evidence jsonb NOT NULL DEFAULT '{}',rights_record jsonb,updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ysong_takedown_cases (
 id uuid PRIMARY KEY,claimant_user_id uuid NOT NULL REFERENCES users(id),object_key text NOT NULL REFERENCES ysong_content_reviews(object_key),contact_reference text NOT NULL,claim text NOT NULL,
 state text NOT NULL DEFAULT 'submitted',notification_state text NOT NULL DEFAULT 'pending',counter_notice text,decision_reason text,updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ysong_checkout_attempts (
 user_id uuid PRIMARY KEY REFERENCES users(id),request_key text NOT NULL,plan_id text NOT NULL REFERENCES ysong_plans(id),expires_at timestamptz NOT NULL,session_id text,url text
);
-- Launch preparation: reuse the existing World inbox schema without altering old rows.
CREATE TABLE IF NOT EXISTS ysong_notifications (
 id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,kind text NOT NULL,
 entity_type text,entity_id text,title text NOT NULL,body text NOT NULL DEFAULT '',
 href text NOT NULL DEFAULT '/app',created_at timestamptz NOT NULL DEFAULT now(),read_at timestamptz
);
CREATE INDEX IF NOT EXISTS ysong_notifications_user_idx ON ysong_notifications(user_id,created_at DESC);
CREATE INDEX IF NOT EXISTS ysong_notifications_unread_idx ON ysong_notifications(user_id,read_at) WHERE read_at IS NULL;
ALTER TABLE ysong_plans ADD COLUMN IF NOT EXISTS billing_products jsonb NOT NULL DEFAULT '{}';
CREATE TABLE IF NOT EXISTS ysong_billing_failures (
 live boolean NOT NULL,event_id text NOT NULL,event_type text NOT NULL,error_code text NOT NULL,
 object_id text,first_seen_at timestamptz NOT NULL DEFAULT now(),last_seen_at timestamptz NOT NULL DEFAULT now(),
 resolved_at timestamptz,PRIMARY KEY(live,event_id)
);
ALTER TABLE ysong_takedown_cases ADD COLUMN IF NOT EXISTS notification_evidence jsonb;
ALTER TABLE ysong_policy_versions ADD COLUMN IF NOT EXISTS approval_reference text;
CREATE TABLE IF NOT EXISTS ysong_saas_migrations (id text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now());
INSERT INTO ysong_saas_migrations(id) VALUES('launch-preparation-v1') ON CONFLICT DO NOTHING;
INSERT INTO ysong_saas_migrations(id) VALUES('guarded-migration-v2') ON CONFLICT DO NOTHING;
