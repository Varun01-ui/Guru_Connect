-- Seed: settings read by the mobile app and starter help-centre FAQs. Idempotent. Run after the admin seeds 001–003.
BEGIN;
INSERT INTO system_settings (key, group_name, value, value_type, label, description, is_public, is_editable) VALUES
 ('app.maintenance_message','app_versions','"We are upgrading GuruConnect. Please try again in a little while."','string','Maintenance message','Shown on the maintenance screen',true,true),
 ('app.maintenance_ends_at','app_versions','null','json','Maintenance expected end','ISO time or null; shown as "Back by 6:30 PM"',true,true),
 ('app.update_message','app_versions','"A new version of GuruConnect is available with improvements and fixes."','string','Update prompt text','Shown on optional and forced update screens',true,true),
 ('app.store_url_android','app_versions','"https://play.google.com/store/apps/details?id=in.guruconnect.app"','url','Play Store link',NULL,true,true),
 ('app.store_url_ios','app_versions','"https://apps.apple.com/in/app/guruconnect/id0000000000"','url','App Store link','[TO CONFIRM] after the App Store listing is created',true,true),
 ('app.onboarding_version','app_versions','1','number','Onboarding version','Increase to show the onboarding slides again to existing installs',true,true),
 ('auth.otp_length','limits','6','number','OTP length',NULL,false,false),
 ('auth.otp_ttl_seconds','limits','300','number','OTP validity (seconds)',NULL,false,true),
 ('auth.otp_resend_after_seconds','limits','30','number','OTP resend cooldown (seconds)',NULL,true,true),
 ('auth.otp_max_per_hour','limits','5','number','OTP requests per phone per hour',NULL,false,true),
 ('auth.email_login_enabled','general','true','boolean','Email login enabled',NULL,true,true),
 ('auth.google_login_enabled','general','true','boolean','Google login enabled',NULL,true,true),
 ('students.min_age_without_consent','limits','18','number','Age from which students sign up without parental consent','Under this age a parent must approve by OTP (DPDP Act)',true,false),
 ('search.default_radius_km','limits','10','number','Default search radius (km)',NULL,true,true),
 ('search.max_radius_km','limits','50','number','Maximum search radius (km)',NULL,true,true),
 ('recommendations.weights','limits','{"subject_match":0.30,"class_match":0.20,"distance":0.20,"trust":0.15,"rating":0.10,"search_affinity":0.05}','json','Recommendation weights','Rule-based ranking weights (must add up to 1)',false,true),
 ('reviews.edit_window_days','limits','90','number','Days a review can be edited',NULL,true,true),
 ('leads.daily_limit','limits','10','number','New leads per requester per day',NULL,true,true),
 ('demos.max_open_per_requester','limits','3','number','Open demo requests per requester',NULL,true,true),
 ('messages.enabled','general','true','boolean','In-app lead messages enabled',NULL,true,true),
 ('notifications.quiet_hours','limits','{"start":"21:30","end":"08:00"}','json','Default quiet hours (IST)','Non-urgent pushes wait until the end of quiet hours',false,true),
 ('wallet.max_redeem_percent','limits','50','number','Max % of a payment payable from wallet',NULL,true,true),
 ('account.deletion_grace_days','limits','30','number','Account deletion grace period (days)',NULL,true,false),
 ('support.whatsapp_number','contact','"+918047182200"','phone','Support WhatsApp','[TO CONFIRM]',true,true)
ON CONFLICT (key) DO NOTHING;

INSERT INTO faqs (audience, category, question, answer_md, sort_order)
SELECT v.* FROM (VALUES
 ('all','getting_started','What is GuruConnect?','GuruConnect helps parents and students find **verified** teachers and coaching institutes near them, see honest reviews and a Trust Score, and book a free demo class.',1),
 ('parent','getting_started','Why do you ask for my children''s classes?','We use each child''s class, board and subjects to recommend teachers who teach exactly what they need. You can add up to 3 children and change them any time.',2),
 ('teacher','verification','How long does verification take?','Most teachers are verified within **48 hours** after uploading Aadhaar, PAN and at least one certificate. You will get a notification when your status changes.',1),
 ('teacher','verification','Why was I asked to re-upload a document?','The reviewer could not read or match the document. Open **Verification status** to see the reason, then upload a clear photo or PDF of the same document.',2),
 ('all','payments','How do I get an invoice?','Open **Profile → Payment history**, choose the payment and tap **Download invoice**. Invoices include GST.',1),
 ('all','payments','I paid but my plan is not active','Payments can take up to 5 minutes to confirm. If it is still not active, open **Help → Contact support** and choose the payment — we will fix it or refund you.',2),
 ('all','safety','How do I report someone?','Open their profile or your conversation, tap **⋮ → Report**. Our safety team reviews every report; urgent reports within 4 hours.',1),
 ('all','privacy','How do I delete my account?','Go to **Settings → Delete account**. Your account is deleted after 30 days; sign in before then to cancel.',1)
) AS v(audience, category, question, answer_md, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM faqs f WHERE f.question = v.question);
COMMIT;
