CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('COLLECTOR','AGGREGATOR','MIDDLEMAN','RECYCLER','ADMIN')),
  name text NOT NULL,
  language text NOT NULL DEFAULT 'en',
  location text NOT NULL DEFAULT '',
  facility_name text NOT NULL DEFAULT '',
  authorization_number text NOT NULL DEFAULT '',
  authorization_status text NOT NULL DEFAULT 'UNVERIFIED',
  materials_accepted jsonb NOT NULL DEFAULT '[]',
  offered_rates jsonb NOT NULL DEFAULT '{}',
  pickup_available boolean NOT NULL DEFAULT false,
  service_area text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS lots (
  id uuid PRIMARY KEY,
  creator_id uuid NOT NULL REFERENCES users(id),
  client_ref text,
  owner_id uuid NOT NULL REFERENCES users(id),
  material text NOT NULL,
  category text NOT NULL DEFAULT '',
  weight_kg numeric NOT NULL CHECK (weight_kg > 0),
  condition text NOT NULL DEFAULT '',
  source_type text NOT NULL DEFAULT '',
  location text NOT NULL DEFAULT '',
  estimated_value numeric NOT NULL DEFAULT 0,
  image_ref text,
  status text NOT NULL DEFAULT 'AVAILABLE',
  batch_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS lots_creator_ref_idx ON lots(creator_id,client_ref) WHERE client_ref IS NOT NULL;
CREATE TABLE IF NOT EXISTS lot_images (
  lot_id uuid PRIMARY KEY REFERENCES lots(id),
  mime_type text NOT NULL,
  image_data bytea NOT NULL
);
CREATE TABLE IF NOT EXISTS batches (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES users(id),
  material text NOT NULL,
  weight_kg numeric NOT NULL CHECK (weight_kg > 0),
  source_lot_ids jsonb NOT NULL,
  status text NOT NULL DEFAULT 'AVAILABLE',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS offers (
  id uuid PRIMARY KEY,
  lot_id uuid REFERENCES lots(id),
  batch_id uuid REFERENCES batches(id),
  buyer_id uuid NOT NULL REFERENCES users(id),
  seller_id uuid NOT NULL REFERENCES users(id),
  buyer_role text NOT NULL,
  rate numeric NOT NULL CHECK (rate > 0),
  original_rate numeric NOT NULL,
  counter_rate numeric,
  unit text NOT NULL DEFAULT 'kg',
  expected_weight numeric NOT NULL CHECK (expected_weight > 0),
  quoted_amount numeric NOT NULL,
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_until timestamptz NOT NULL,
  pickup_available boolean NOT NULL DEFAULT false,
  pickup_terms text NOT NULL DEFAULT '',
  payment_terms text NOT NULL DEFAULT '',
  notes text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'PENDING',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((lot_id IS NULL) <> (batch_id IS NULL))
);
CREATE TABLE IF NOT EXISTS handovers (
  id uuid PRIMARY KEY,
  offer_id uuid NOT NULL UNIQUE REFERENCES offers(id),
  lot_id uuid REFERENCES lots(id),
  batch_id uuid REFERENCES batches(id),
  seller_id uuid NOT NULL REFERENCES users(id),
  buyer_id uuid NOT NULL REFERENCES users(id),
  seller_submitted_weight numeric,
  buyer_measured_weight numeric,
  quoted_rate numeric NOT NULL,
  final_rate numeric,
  quoted_amount numeric NOT NULL,
  final_amount numeric,
  handover_location text NOT NULL DEFAULT '',
  seller_submitted_at timestamptz,
  buyer_confirmed_at timestamptz,
  seller_accepted_at timestamptz,
  status text NOT NULL DEFAULT 'PENDING_HANDOVER',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS payments (
  id uuid PRIMARY KEY,
  handover_id uuid NOT NULL UNIQUE REFERENCES handovers(id),
  payer_id uuid NOT NULL REFERENCES users(id),
  payee_id uuid NOT NULL REFERENCES users(id),
  amount numeric NOT NULL,
  status text NOT NULL DEFAULT 'PENDING',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS disputes (
  id uuid PRIMARY KEY,
  handover_id uuid NOT NULL REFERENCES handovers(id),
  raised_by uuid NOT NULL REFERENCES users(id),
  reason text NOT NULL,
  seller_claim text NOT NULL DEFAULT '',
  buyer_response text NOT NULL DEFAULT '',
  evidence_ref text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'OPEN',
  admin_resolution text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS recycling (
  id uuid PRIMARY KEY,
  lot_id uuid REFERENCES lots(id),
  batch_id uuid REFERENCES batches(id),
  recycler_id uuid NOT NULL REFERENCES users(id),
  status text NOT NULL DEFAULT 'RECEIVED',
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  certificate_id uuid UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((lot_id IS NULL) <> (batch_id IS NULL))
);
CREATE TABLE IF NOT EXISTS trace_events (
  id uuid PRIMARY KEY,
  lot_id uuid REFERENCES lots(id),
  batch_id uuid REFERENCES batches(id),
  actor_id uuid NOT NULL REFERENCES users(id),
  actor_role text NOT NULL,
  event_type text NOT NULL,
  weight_kg numeric,
  location text NOT NULL DEFAULT '',
  evidence_ref text NOT NULL DEFAULT '',
  previous_owner uuid REFERENCES users(id),
  new_owner uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((lot_id IS NULL) <> (batch_id IS NULL))
);
CREATE TABLE IF NOT EXISTS categories (
  id text PRIMARY KEY,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS material_catalog (
  id text PRIMARY KEY,
  category text NOT NULL,
  subcategory text NOT NULL DEFAULT '',
  description text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS price_records (
  id uuid PRIMARY KEY,
  material_id text NOT NULL,
  location text NOT NULL,
  rate numeric NOT NULL CHECK (rate > 0),
  unit text NOT NULL DEFAULT 'kg',
  recorded_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ai_feedback (
  id uuid PRIMARY KEY,
  lot_id uuid NOT NULL REFERENCES lots(id),
  actor_id uuid NOT NULL REFERENCES users(id),
  predicted_material text NOT NULL,
  confirmed_material text NOT NULL,
  confidence numeric,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS dismantling_knowledge (
  id uuid PRIMARY KEY,
  material_id text NOT NULL,
  guidance text NOT NULL,
  updated_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS audit_logs (
  id uuid PRIMARY KEY,
  actor_id uuid NOT NULL REFERENCES users(id),
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lots_owner_idx ON lots(owner_id);
CREATE INDEX IF NOT EXISTS offers_participants_idx ON offers(seller_id, buyer_id);
CREATE INDEX IF NOT EXISTS events_lot_idx ON trace_events(lot_id, created_at);
