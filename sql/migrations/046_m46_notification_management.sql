-- @migration 046 M46 Notification Management
-- @table notifications: Push / in-app notification campaigns created by admins (transactional pushes are sent by services and not stored here).
CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  title text NOT NULL, -- Max 60 chars
  body text NOT NULL, -- Max 180 chars
  image_file_id uuid REFERENCES files(id) ON DELETE SET NULL, -- Optional rich image
  deep_link text, -- App route opened on tap
  channel text NOT NULL DEFAULT 'push_and_inbox' CHECK (channel IN ('push','inbox','push_and_inbox')), -- Delivery channel
  audience_type text NOT NULL CHECK (audience_type IN ('all','parents','students','teachers','institutes','segment','user_list')), -- Who receives it
  segment jsonb, -- Filters for audience_type = segment, e.g. {"city_ids":[…],"class_ids":[…],"subscription_status":["trial"]}
  user_ids uuid[], -- Explicit recipients for audience_type = user_list (max 10,000)
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','scheduled','sending','sent','failed','cancelled')), -- Lifecycle
  scheduled_at timestamptz, -- Send time (NULL = send now)
  sent_at timestamptz, -- Finished sending
  target_count integer, -- Recipients resolved at send time
  delivered_count integer NOT NULL DEFAULT 0, -- FCM success count
  failed_count integer NOT NULL DEFAULT 0, -- FCM failures
  opened_count integer NOT NULL DEFAULT 0, -- Opens reported by the app
  created_by uuid REFERENCES admins(id), -- Creator
  approved_by uuid REFERENCES admins(id), -- Second admin approval for audiences over 50,000
  created_at timestamptz NOT NULL DEFAULT now(), -- Created
  updated_at timestamptz NOT NULL DEFAULT now(), -- Updated
  deleted_at timestamptz -- Soft delete (drafts only)
);
CREATE INDEX idx_notifications_status ON notifications (status, scheduled_at) WHERE deleted_at IS NULL;
CREATE TRIGGER trg_notifications_updated BEFORE UPDATE ON notifications FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- @table notification_recipients: Per-user delivery record for a campaign. Partition by month at scale.
CREATE TABLE notification_recipients (
  notification_id uuid NOT NULL REFERENCES notifications(id) ON DELETE CASCADE, -- Campaign
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE, -- Recipient
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','failed','opened','no_token')), -- Delivery state
  error_code text, -- FCM error, e.g. UNREGISTERED
  sent_at timestamptz, -- Sent
  opened_at timestamptz, -- Opened
  PRIMARY KEY (notification_id, user_id)
);
CREATE INDEX idx_notification_recipients_user ON notification_recipients (user_id, sent_at DESC);
