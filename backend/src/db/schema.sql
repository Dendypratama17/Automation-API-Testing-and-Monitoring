-- QA API Automation Tool - Database Schema

CREATE TABLE IF NOT EXISTS environments (
  id SERIAL PRIMARY KEY,
  name VARCHAR(50) NOT NULL UNIQUE,
  base_url VARCHAR(255) NOT NULL,
  variables JSONB DEFAULT '{}',
  is_protected BOOLEAN DEFAULT FALSE,
  -- User-defined display order (drag-to-reorder in Config > Environments) —
  -- independent of id/created_at, which reflect creation order instead.
  sort_order INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Backfill the UNIQUE constraint onto an existing database (fresh installs
-- already get it from the CREATE TABLE above). Without this, the seed INSERT
-- below has nothing to conflict on, so re-running this file duplicates the
-- seed environments every time instead of being a no-op.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'environments_name_key') THEN
    ALTER TABLE environments ADD CONSTRAINT environments_name_key UNIQUE (name);
  END IF;
END $$;

-- Generic folder tree shared by endpoints and flows (kind discriminates the two).
CREATE TABLE IF NOT EXISTS folders (
  id SERIAL PRIMARY KEY,
  kind VARCHAR(20) NOT NULL, -- 'endpoint' | 'flow'
  name VARCHAR(255) NOT NULL,
  parent_id INT REFERENCES folders(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_folders_kind ON folders(kind);

CREATE TABLE IF NOT EXISTS endpoints (
  id SERIAL PRIMARY KEY,
  folder_id INT REFERENCES folders(id) ON DELETE SET NULL,
  name VARCHAR(255) NOT NULL,
  method VARCHAR(10) NOT NULL,
  path_template VARCHAR(255) NOT NULL,
  headers JSONB DEFAULT '{}',
  body_template JSONB DEFAULT '{}',
  body_type VARCHAR(20) DEFAULT 'json', -- 'json' | 'form-data'
  tags VARCHAR(100)[],
  sort_order INT DEFAULT 0, -- drag-to-reorder in Config > Endpoints
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Header template applied to every endpoint (both existing ones and future
-- cURL/Postman imports) — an endpoint's own header always wins on conflict,
-- so this only fills in keys the endpoint doesn't already define. A key can
-- have several rows (several allowed values) — the first one by sort_order is
-- the actual auto-fill default; all of them become that header's dropdown
-- choices in the Flow step / Endpoint editors. sort_order is drag-to-reorder
-- in Config > Default Headers (also how you change which value is "default").
CREATE TABLE IF NOT EXISTS default_headers (
  id SERIAL PRIMARY KEY,
  key VARCHAR(255) NOT NULL,
  value TEXT NOT NULL,
  sort_order INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- A key like X-Token ends up with several near-identical-looking values (one
-- per test account), with nothing about the raw string itself saying which
-- account/environment it belongs to — label + environment_id let the picker
-- show e.g. "CHE7573 (STG)" next to the value instead of just the raw token.
ALTER TABLE default_headers ADD COLUMN IF NOT EXISTS label VARCHAR(255);
ALTER TABLE default_headers ADD COLUMN IF NOT EXISTS environment_id INT REFERENCES environments(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS endpoint_schemas (
  id SERIAL PRIMARY KEY,
  endpoint_id INT REFERENCES endpoints(id) ON DELETE CASCADE,
  schema JSONB NOT NULL,
  version INT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Flow Builder: susun beberapa endpoint jadi satu alur berurutan, dengan
-- kemampuan chaining variable (mis. token login dipakai di step berikutnya)
-- dan assertion opsional per step.
CREATE TABLE IF NOT EXISTS flows (
  id SERIAL PRIMARY KEY,
  folder_id INT REFERENCES folders(id) ON DELETE SET NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  stop_on_failure BOOLEAN DEFAULT TRUE,
  sort_order INT DEFAULT 0, -- drag-to-reorder in the Flow List
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Saved credentials, managed in Config and selectable from any Flow step.
-- type='basic': username/password sent as a Basic auth header.
-- type='web_login': username/password are a real site login (PrivyID/password) —
-- at run time a headless browser actually logs in via login_url and the
-- resulting session token is sent as a Bearer header instead (see
-- src/services/webLogin.js), refreshed on every flow run.
CREATE TABLE IF NOT EXISTS auth_credentials (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  type VARCHAR(20) NOT NULL DEFAULT 'basic',
  username VARCHAR(255) NOT NULL,
  password TEXT NOT NULL, -- encrypted (AES-256-GCM, see src/utils/crypto.js), not plaintext
  login_url VARCHAR(500), -- only used when type='web_login'
  sort_order INT DEFAULT 0, -- drag-to-reorder in Config > Authorization
  -- Purely informational — which environment this credential's username/password
  -- actually belongs to (Dev/Stag/Prod often have separate logins). Optional;
  -- doesn't restrict which environment a Flow step can use it against.
  environment_id INT REFERENCES environments(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Added after auth_credentials since it references it — a flow-wide Web
-- Login credential that, on every run, refreshes the Authorization header
-- of EVERY step that already has one set, with no per-step assignment
-- needed (see flowRunner.js).
ALTER TABLE flows ADD COLUMN IF NOT EXISTS web_login_credential_id INT REFERENCES auth_credentials(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS flow_steps (
  id SERIAL PRIMARY KEY,
  flow_id INT REFERENCES flows(id) ON DELETE CASCADE,
  endpoint_id INT REFERENCES endpoints(id) ON DELETE SET NULL,
  auth_credential_id INT REFERENCES auth_credentials(id) ON DELETE SET NULL,
  step_order INT NOT NULL,
  name VARCHAR(255) NOT NULL,
  method VARCHAR(10) NOT NULL DEFAULT 'GET',
  url_template VARCHAR(500) NOT NULL,
  headers JSONB DEFAULT '{}',
  body_template JSONB,
  body_type VARCHAR(20) DEFAULT 'json', -- 'json' | 'form-data'
  extract JSONB DEFAULT '[]',     -- [{ "variable": "token", "path": "data.access_token" }]
  assertions JSONB DEFAULT '[]',  -- optional: [{ "type": "status_code", "expected": 200 }, ...]
  enabled BOOLEAN NOT NULL DEFAULT TRUE, -- unchecked steps are skipped on a full/batch/scheduled run, but can still be run individually
  delay_ms INT NOT NULL DEFAULT 0, -- waited before this step runs — e.g. giving an async backend process time to finish before the next check
  skip_web_login_refresh BOOLEAN NOT NULL DEFAULT FALSE, -- opt this step out of the flow-level Web Login credential's Authorization refresh (see flowRunner.js) — e.g. a step that intentionally hits a different service with its own Basic/internal auth
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_flow_steps_flow ON flow_steps(flow_id, step_order);
ALTER TABLE flow_steps ADD COLUMN IF NOT EXISTS skip_web_login_refresh BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE flow_steps ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE flow_steps ADD COLUMN IF NOT EXISTS delay_ms INT NOT NULL DEFAULT 0;
-- Runs this step concurrently with the step(s) immediately before it instead
-- of waiting for them to finish first (see flowExecutor.js's groupIntoBatches)
-- — e.g. testing two endpoints that legitimately need to be hit at the same
-- moment, like a sign and a reject racing each other.
ALTER TABLE flow_steps ADD COLUMN IF NOT EXISTS parallel_with_previous BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS flow_runs (
  id SERIAL PRIMARY KEY,
  flow_id INT REFERENCES flows(id) ON DELETE CASCADE,
  -- RESTRICT, not CASCADE: deleting an environment used to silently wipe
  -- every run ever made against it. Force deleting the runs (or moving them)
  -- as a deliberate, separate step instead.
  environment_id INT REFERENCES environments(id) ON DELETE RESTRICT,
  status VARCHAR(20) NOT NULL,
  triggered_by VARCHAR(50) DEFAULT 'manual',
  -- Which schedule (if any) triggered this run — precise attribution so
  -- multiple schedules on the same flow+environment don't share run counts.
  -- No FK constraint: `schedules` is declared later in this file.
  schedule_id INT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS flow_run_steps (
  id SERIAL PRIMARY KEY,
  flow_run_id INT REFERENCES flow_runs(id) ON DELETE CASCADE,
  endpoint_id INT REFERENCES endpoints(id) ON DELETE SET NULL,
  step_order INT NOT NULL,
  name VARCHAR(255),
  status VARCHAR(20) NOT NULL,
  request_method VARCHAR(10),
  request_url TEXT,
  request_id TEXT,
  request_body JSONB,
  request_headers JSONB,
  response_status_code INT,
  response_time_ms INT,
  response_body JSONB,
  error_message TEXT,
  assertion_results JSONB,
  extracted_variables JSONB,
  schema_diffs JSONB DEFAULT '[]',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_flow_run_steps_run ON flow_run_steps(flow_run_id, step_order);
CREATE INDEX IF NOT EXISTS idx_flow_run_steps_endpoint ON flow_run_steps(endpoint_id, created_at);

-- Actually-sent request headers, captured per step run — added after the
-- initial table so existing databases need this backfilled via ALTER
-- (fresh installs get it from the CREATE TABLE above).
ALTER TABLE flow_run_steps ADD COLUMN IF NOT EXISTS request_headers JSONB;
-- Dropped again shortly after being added — response headers turned out not
-- to be needed, only what was actually sent.
ALTER TABLE flow_run_steps DROP COLUMN IF EXISTS response_headers;

CREATE TABLE IF NOT EXISTS schedules (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  cron_expression VARCHAR(100) NOT NULL,   -- e.g. '*/30 * * * *' every 30 minutes
  flow_id INT REFERENCES flows(id) ON DELETE CASCADE,
  -- RESTRICT, not CASCADE: deleting an environment used to silently delete
  -- every schedule pointed at it (and, transitively, its run history).
  environment_id INT REFERENCES environments(id) ON DELETE RESTRICT,
  is_active BOOLEAN DEFAULT TRUE,
  last_run_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  deleted_at TIMESTAMPTZ, -- soft-delete: keeps the row (and its run history) visible instead of erasing it
  auto_stop_at TIMESTAMPTZ -- optional "run for N minutes/hours" cutoff; a watchdog in scheduler.js stops it once reached
);

CREATE TABLE IF NOT EXISTS notifications_log (
  id SERIAL PRIMARY KEY,
  flow_run_id INT REFERENCES flow_runs(id) ON DELETE CASCADE,
  channel VARCHAR(20),
  status VARCHAR(20),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Generic app-wide key/value settings (e.g. Config > Notifications' Telegram
-- on/off toggle) — a missing key means "use the default" (see wherever a
-- setting is read), so this table only ever needs a row once someone
-- actually changes something away from its default.
CREATE TABLE IF NOT EXISTS settings (
  key VARCHAR(100) PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Reusable test files (base64) for form-data "file" fields in Flow steps —
-- pick a saved one (e.g. "Normal PDF", "Corrupt File", "Wrong Format") instead
-- of using the browser's file picker every time a step needs an upload.
CREATE TABLE IF NOT EXISTS test_files (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  file_name VARCHAR(255) NOT NULL,
  mime_type VARCHAR(100),
  data TEXT NOT NULL,
  sort_order INT DEFAULT 0, -- drag-to-reorder in Config > Test Files
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Seed default environments (sesuai pattern privysign Dendy). Conflict target
-- is explicit (name) — without it, "ON CONFLICT DO NOTHING" has nothing to
-- match against and silently inserts a fresh duplicate batch on every re-run
-- of this file (this is what happened; see environments_name_key above).
INSERT INTO environments (name, base_url, variables, is_protected) VALUES
  ('DEV', 'https://public-api-gateway.carstensz.privydev.id/privysign', '{}', FALSE),
  ('STG', 'https://stg-public-api.privy.id/privysign', '{}', FALSE),
  ('PROD', 'https://api-carstensz.privy.id/privysign', '{}', TRUE)
ON CONFLICT (name) DO NOTHING;

-- environment_id previously CASCADEd on both these tables — deleting an
-- environment silently wiped every schedule/run tied to it. RESTRICT forces
-- that to be a deliberate, separate step (delete the runs/schedules first).
ALTER TABLE flow_runs DROP CONSTRAINT IF EXISTS flow_runs_environment_id_fkey;
ALTER TABLE flow_runs ADD CONSTRAINT flow_runs_environment_id_fkey
  FOREIGN KEY (environment_id) REFERENCES environments(id) ON DELETE RESTRICT;

ALTER TABLE schedules DROP CONSTRAINT IF EXISTS schedules_environment_id_fkey;
ALTER TABLE schedules ADD CONSTRAINT schedules_environment_id_fkey
  FOREIGN KEY (environment_id) REFERENCES environments(id) ON DELETE RESTRICT;

-- Response Compare — a baseline response saved per endpoint ("Set as
-- Reference" on any run's response), diffed on demand against a later run's
-- response for that same endpoint. diff_ignore_paths holds dot-paths
-- (e.g. "data.document.id") that are always volatile between runs (ids,
-- tokens, timestamps) and so are skipped when computing a diff, instead of
-- drowning every comparison in expected noise.
ALTER TABLE endpoints ADD COLUMN IF NOT EXISTS diff_reference_response JSONB;
ALTER TABLE endpoints ADD COLUMN IF NOT EXISTS diff_reference_set_at TIMESTAMPTZ;
ALTER TABLE endpoints ADD COLUMN IF NOT EXISTS diff_ignore_paths JSONB NOT NULL DEFAULT '[]';

-- A computed diff is only persisted here when the user explicitly clicks
-- Save — comparing is otherwise a throwaway, on-demand view, not something
-- that piles up in the DB on every run.
CREATE TABLE IF NOT EXISTS endpoint_response_diffs (
  id SERIAL PRIMARY KEY,
  endpoint_id INT REFERENCES endpoints(id) ON DELETE CASCADE,
  flow_run_step_id INT REFERENCES flow_run_steps(id) ON DELETE SET NULL,
  diffs JSONB NOT NULL, -- [{ path, old_value, new_value }, ...]
  note VARCHAR(500),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_endpoint_response_diffs_endpoint ON endpoint_response_diffs(endpoint_id, created_at);

-- Standalone "paste two JSON blobs and compare" tool (Config-independent —
-- not tied to any saved Endpoint) — see routes/jsonDiff.js. Saved the same
-- opt-in way as endpoint_response_diffs: computing a diff doesn't write
-- anything here until the user explicitly clicks Save.
CREATE TABLE IF NOT EXISTS saved_json_diffs (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255),
  json_a JSONB NOT NULL,
  json_b JSONB NOT NULL,
  ignore_paths JSONB NOT NULL DEFAULT '[]',
  diffs JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_saved_json_diffs_created ON saved_json_diffs(created_at);

-- Organizes saved comparisons into folders (kind='json_diff' in the shared
-- folders table, same convention as endpoints/flows).
ALTER TABLE saved_json_diffs ADD COLUMN IF NOT EXISTS folder_id INT REFERENCES folders(id) ON DELETE SET NULL;
