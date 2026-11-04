-- Provider rails, idempotency keys and provider webhook dedupe.
UPDATE tenants SET rail_settings = '{"stripe_card":{"env":"sandbox"},"stripe_ach":{"env":"sandbox"},"circle_usdc":{"env":"sandbox"},"onchain_usdc":{"env":"sandbox"}}';
CREATE TABLE IF NOT EXISTS idempotency_keys (key TEXT PRIMARY KEY, intent_id TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS provider_events (provider TEXT NOT NULL, event_id TEXT NOT NULL, type TEXT, intent_id TEXT, received_at TEXT NOT NULL, PRIMARY KEY (provider, event_id));
