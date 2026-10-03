-- Seed: global settings, launch pricing (placeholders to confirm), referral rules and trust weights. Idempotent.
BEGIN;
INSERT INTO system_settings (key, group_name, value, value_type, label, description, is_public, is_editable) VALUES
 ('platform.name','general','"GuruConnect"','string','Platform name','Shown in the app, emails and invoices',true,true),
 ('platform.tagline','general','"Find a teacher you can trust"','string','Tagline','Shown on the welcome screen',true,true),
 ('contact.support_email','contact','"support@guruconnect.in"','email','Support email','Where users send support requests',true,true),
 ('contact.support_phone','contact','"+918047182200"','phone','Support phone','E.164 format',true,true),
 ('contact.support_hours','contact','"Mon–Sat, 9 AM–7 PM"','string','Support hours','Shown under Contact support',true,true),
 ('contact.grievance_officer','contact','{"name":"[TO CONFIRM]","email":"grievance@guruconnect.in"}','json','Grievance officer','Required under the IT Rules, 2021',true,true),
 ('legal.terms_url','legal','"https://guruconnect.in/terms"','url','Terms & conditions URL',NULL,true,true),
 ('legal.privacy_url','legal','"https://guruconnect.in/privacy"','url','Privacy policy URL',NULL,true,true),
 ('legal.refund_url','legal','"https://guruconnect.in/refunds"','url','Refund policy URL',NULL,true,true),
 ('app.android_latest_version','app_versions','"1.0.0"','semver','Latest Android version','Users below this see an update prompt',true,true),
 ('app.android_min_version','app_versions','"1.0.0"','semver','Minimum Android version','Users below this must update',true,true),
 ('app.ios_latest_version','app_versions','"1.0.0"','semver','Latest iOS version',NULL,true,true),
 ('app.ios_min_version','app_versions','"1.0.0"','semver','Minimum iOS version',NULL,true,true),
 ('app.maintenance_mode','app_versions','false','boolean','Maintenance mode','Shows a maintenance screen in the app',true,true),
 ('limits.parent_max_children','limits','3','number','Max children per parent','Used by the children screen',true,true),
 ('limits.institute_max_teachers','limits','25','number','Max teachers per institute','Before an extra fee applies',true,true),
 ('limits.featured_slots_per_city','limits','12','number','Featured teacher slots per city','Max featured teachers per city at a time',false,true),
 ('institutes.rating_weights','limits','{"infrastructure":0.30,"faculty":0.30,"feedback":0.20,"trust":0.20}','json','Institute rating weights','Weights for the suggested overall rating (must add up to 1)',false,true),
 ('institutes.require_second_approver','limits','false','boolean','Second approver for institutes','Require a different admin to approve than the evaluator',false,true),
 ('limits.student_trial_free_contacts','limits','5','number','Free contacts in a student trial',NULL,true,true),
 ('subscriptions.free_access_to_trial_on_enable','limits','true','boolean','Move free-access users to a trial when fees are switched on',NULL,false,true),
 ('limits.review_min_chars','limits','30','number','Minimum review length',NULL,true,true),
 ('reviews.allow_unverified','limits','false','boolean','Allow reviews without a demo or lead','When off, only users who had a demo or lead with the teacher can review',false,true),
 ('reviews.hide_when_flagged','limits','false','boolean','Hide flagged reviews until decided',NULL,false,true),
 ('complaints.safety_keywords','limits','["touch","threat","abuse","unsafe","stalk","blackmail","drunk"]','json','Safety keywords','Complaints containing these words are triaged as critical',false,true),
 ('banners.allowed_domains','limits','["guruconnect.in"]','json','Allowed banner link domains','https links in banners and notifications must use one of these domains',false,true),
 ('notifications.daily_cap','limits','2','number','Campaign pushes per user per day','Extra campaigns go to the inbox only',false,true),
 ('seo.redirects','general','{}','json','Blog redirects','Old slug to new slug, maintained automatically when a published slug changes',false,false)
ON CONFLICT (key) DO NOTHING;

INSERT INTO payment_configurations (fee_code, version, name, description, is_enabled, amount_paise, billing_period, validity_days, trial_days, effective_from, status, change_reason, published_at)
SELECT v.code, 1, v.name, v.descr, v.enabled, v.amt, v.period, v.validity, v.trial, now(), 'active', 'Launch pricing (placeholder, confirm before go-live)', now() FROM (VALUES
 ('TEACHER_REGISTRATION','Teacher registration','Verification, Verified badge and unlimited requests for 12 months',true,49900,'yearly',365,0),
 ('INSTITUTE_REGISTRATION','Institute registration','Verification, evaluation, rating and up to 25 teacher profiles',true,299900,'yearly',365,0),
 ('PARENT_SUBSCRIPTION_MONTHLY','Parent membership · Monthly','Unlimited teacher contacts and free demo bookings',true,29900,'monthly',30,7),
 ('PARENT_SUBSCRIPTION_YEARLY','Parent membership · Yearly','Everything in monthly plus refund guarantee',true,199900,'yearly',365,7),
 ('STUDENT_SUBSCRIPTION_MONTHLY','Student membership · Monthly','Unlimited teacher contacts',true,19900,'monthly',30,7),
 ('STUDENT_SUBSCRIPTION_YEARLY','Student membership · Yearly','Unlimited teacher contacts for a year',true,149900,'yearly',365,7),
 ('PREMIUM_TEACHER','Premium listing','Top positions in search for 30 days',true,99900,'per_30_days',30,0),
 ('FEATURED_TEACHER','Featured teacher','Home-screen Featured rail for 30 days',true,149900,'per_30_days',30,0),
 ('CONTACT_UNLOCK','Contact unlock','Share your request and number with one teacher',false,4900,'per_use',NULL,0))
 AS v(code, name, descr, enabled, amt, period, validity, trial)
WHERE NOT EXISTS (SELECT 1 FROM payment_configurations p WHERE p.fee_code = v.code);

INSERT INTO payment_configuration_history (payment_configuration_id, fee_code, action, new_values, reason)
SELECT p.id, p.fee_code, 'published', jsonb_build_object('amount_paise',p.amount_paise,'is_enabled',p.is_enabled), 'Seed'
FROM payment_configurations p WHERE p.version = 1 AND NOT EXISTS (SELECT 1 FROM payment_configuration_history h WHERE h.payment_configuration_id = p.id);

INSERT INTO referral_settings (program_code, version, is_enabled, referrer_reward_paise, referee_reward_paise, reward_type, qualifying_event, max_rewards_per_month, reward_hold_days, status, change_reason)
SELECT v.* FROM (VALUES
 ('LEARNER_REFERRAL',1,true,10000::bigint,10000::bigint,'wallet_credit','first_payment',20,7,'active','Launch rules'),
 ('TEACHER_REFERRAL',1,true,20000::bigint,0::bigint,'wallet_credit','teacher_approved',10,7,'active','Launch rules'),
 ('INSTITUTE_REFERRAL',1,false,50000::bigint,0::bigint,'wallet_credit','institute_approved',5,14,'active','Off at launch'))
 AS v(code, ver, en, rr, re, rt, qe, mpm, hold, st, reason)
WHERE NOT EXISTS (SELECT 1 FROM referral_settings r WHERE r.program_code = v.code);

INSERT INTO trust_score_weights (version, weights, status, change_reason, activated_at)
SELECT 1, '{"aadhaar":20,"pan":10,"certificates":20,"reviews":25,"complaints":15,"profile_completeness":10}'::jsonb, 'active', 'Launch weights', now()
WHERE NOT EXISTS (SELECT 1 FROM trust_score_weights);
COMMIT;
