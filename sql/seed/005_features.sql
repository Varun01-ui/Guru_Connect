-- Seed: feature flags read by the backend. Idempotent. Run after the earlier seeds.
BEGIN;
INSERT INTO system_settings (key, group_name, value, value_type, label, description, is_public, is_editable) VALUES
 ('features.wallet_enabled','general','false','boolean','Wallet enabled','Lets users pay part of a purchase from their wallet balance. Off until wallet top-ups ship.',true,true)
ON CONFLICT (key) DO NOTHING;
COMMIT;
