-- Seed: reference data (countries, states, cities, areas, classes, subjects, boards, teaching modes, teacher categories). Idempotent.
BEGIN;
INSERT INTO countries (name, iso2, iso3, phone_code, currency_code, sort_order)
SELECT 'India','IN','IND','+91','INR',1 WHERE NOT EXISTS (SELECT 1 FROM countries WHERE iso2='IN' AND deleted_at IS NULL);

INSERT INTO states (country_id, name, code, type, sort_order)
SELECT c.id, s.name, s.code, s.type, s.ord FROM countries c,
(VALUES ('Karnataka','KA','state',1),('Maharashtra','MH','state',2),('Delhi','DL','union_territory',3),('Telangana','TG','state',4),
        ('Tamil Nadu','TN','state',5),('West Bengal','WB','state',6),('Rajasthan','RJ','state',7),('Uttar Pradesh','UP','state',8),
        ('Madhya Pradesh','MP','state',9),('Bihar','BR','state',10),('Chandigarh','CH','union_territory',11),('Gujarat','GJ','state',12),('Kerala','KL','state',13))
AS s(name, code, type, ord)
WHERE c.iso2='IN' AND NOT EXISTS (SELECT 1 FROM states x WHERE x.country_id=c.id AND x.code=s.code AND x.deleted_at IS NULL);

INSERT INTO cities (state_id, name, slug, latitude, longitude, tier, is_serviceable, sort_order)
SELECT st.id, v.name, v.slug, v.lat, v.lng, v.tier, true, v.ord FROM states st
JOIN (VALUES ('KA','Bengaluru','bengaluru',12.971599,77.594566,1,1),('MH','Mumbai','mumbai',19.076090,72.877426,1,2),('DL','Delhi','delhi',28.613939,77.209023,1,3),
             ('MH','Pune','pune',18.520430,73.856743,1,4),('TG','Hyderabad','hyderabad',17.385044,78.486671,1,5),('RJ','Jaipur','jaipur',26.912434,75.787270,2,6),
             ('UP','Lucknow','lucknow',26.846695,80.946167,2,7),('WB','Kolkata','kolkata',22.572645,88.363892,1,8),('TN','Chennai','chennai',13.082680,80.270718,1,9),
             ('MP','Indore','indore',22.719568,75.857727,2,10),('BR','Patna','patna',25.594095,85.137566,2,11),('CH','Chandigarh','chandigarh',30.733315,76.779419,2,12))
AS v(state_code, name, slug, lat, lng, tier, ord) ON v.state_code = st.code
WHERE NOT EXISTS (SELECT 1 FROM cities x WHERE x.slug=v.slug AND x.deleted_at IS NULL);

INSERT INTO areas (city_id, name, slug, pincodes, sort_order)
SELECT ci.id, a.name, a.slug, a.pins, a.ord FROM cities ci,
(VALUES ('Koramangala','koramangala',ARRAY['560034','560095'],1),('HSR Layout','hsr-layout',ARRAY['560102'],2),('Indiranagar','indiranagar',ARRAY['560038'],3),
        ('Jayanagar','jayanagar',ARRAY['560011','560041'],4),('Whitefield','whitefield',ARRAY['560066'],5),('BTM Layout','btm-layout',ARRAY['560076'],6))
AS a(name, slug, pins, ord)
WHERE ci.slug='bengaluru' AND NOT EXISTS (SELECT 1 FROM areas x WHERE x.city_id=ci.id AND x.slug=a.slug AND x.deleted_at IS NULL);

INSERT INTO classes (name, code, stage, level_order)
SELECT v.name, v.code, v.stage, v.lo FROM (VALUES
 ('Class 1','CLASS_1','primary',1),('Class 2','CLASS_2','primary',2),('Class 3','CLASS_3','primary',3),('Class 4','CLASS_4','primary',4),('Class 5','CLASS_5','primary',5),
 ('Class 6','CLASS_6','middle',6),('Class 7','CLASS_7','middle',7),('Class 8','CLASS_8','middle',8),('Class 9','CLASS_9','secondary',9),('Class 10','CLASS_10','secondary',10),
 ('Class 11','CLASS_11','senior_secondary',11),('Class 12','CLASS_12','senior_secondary',12),('Undergraduate','UG','undergraduate',13),('Postgraduate','PG','postgraduate',14),
 ('Competitive exam preparation','COMPETITIVE','competitive',15),('Adult learners','ADULT','adult',16)) AS v(name, code, stage, lo)
WHERE NOT EXISTS (SELECT 1 FROM classes x WHERE x.code=v.code AND x.deleted_at IS NULL);

INSERT INTO subjects (name, slug, category, aliases, min_class_order, max_class_order, is_trending, sort_order)
SELECT v.* FROM (VALUES
 ('Mathematics','mathematics','academic',ARRAY['maths','math'],1,14,true,1),('Science','science','academic',ARRAY['evs science'],3,10,false,2),
 ('Physics','physics','academic',ARRAY[]::text[],9,14,true,3),('Chemistry','chemistry','academic',ARRAY[]::text[],9,14,false,4),('Biology','biology','academic',ARRAY['bio'],9,14,false,5),
 ('English','english','academic',ARRAY[]::text[],1,14,false,6),('Hindi','hindi','language',ARRAY[]::text[],1,12,false,7),('EVS','evs','academic',ARRAY['environmental studies'],1,5,false,8),
 ('Social Science','social-science','academic',ARRAY['sst','social studies'],6,10,false,9),('Accountancy','accountancy','academic',ARRAY['accounts'],11,13,false,10),
 ('Economics','economics','academic',ARRAY['eco'],11,14,false,11),('Computer Science','computer-science','academic',ARRAY['cs'],6,14,false,12),
 ('JEE Main','jee-main','competitive_exam',ARRAY['iit jee'],11,15,true,13),('JEE Advanced','jee-advanced','competitive_exam',ARRAY['iit'],11,15,true,14),
 ('NEET','neet','competitive_exam',ARRAY['medical entrance'],11,15,true,15),('UPSC CSE','upsc-cse','competitive_exam',ARRAY['ias','civil services'],13,16,false,16),
 ('Spoken English','spoken-english','language',ARRAY['english speaking'],1,16,true,17),('IELTS','ielts','language',ARRAY[]::text[],12,16,false,18),
 ('Keyboard','keyboard','music_arts',ARRAY['piano'],1,16,false,19),('Hindustani Vocal','hindustani-vocal','music_arts',ARRAY['singing'],1,16,false,20),
 ('Drawing & Painting','drawing-painting','music_arts',ARRAY['art'],1,16,false,21),('Python','python','coding_skills',ARRAY['coding'],5,16,true,22),('Scratch Coding','scratch-coding','coding_skills',ARRAY[]::text[],3,8,false,23))
 AS v(name, slug, category, aliases, mn, mx, trending, ord)
WHERE NOT EXISTS (SELECT 1 FROM subjects x WHERE x.slug=v.slug AND x.deleted_at IS NULL);

INSERT INTO boards (name, short_name, type, state_id, sort_order)
SELECT v.name, v.short, v.type, (SELECT id FROM states WHERE code=v.state_code AND deleted_at IS NULL), v.ord FROM (VALUES
 ('Central Board of Secondary Education','CBSE','national',NULL,1),('Council for the Indian School Certificate Examinations','ICSE / ISC','national',NULL,2),
 ('International Baccalaureate','IB','international',NULL,3),('Cambridge Assessment International Education','IGCSE','international',NULL,4),
 ('National Institute of Open Schooling','NIOS','national',NULL,5),('Karnataka School Examination and Assessment Board','Karnataka State Board','state','KA',6),
 ('Maharashtra State Board of Secondary and Higher Secondary Education','Maharashtra State Board','state','MH',7),
 ('Telangana Board of Secondary Education','Telangana State Board','state','TG',8),('Tamil Nadu State Board','Tamil Nadu State Board','state','TN',9))
 AS v(name, short, type, state_code, ord)
WHERE NOT EXISTS (SELECT 1 FROM boards x WHERE lower(x.short_name)=lower(v.short) AND x.deleted_at IS NULL);

INSERT INTO teaching_modes (name, code, description, requires_location, sort_order)
SELECT v.* FROM (VALUES
 ('Online','ONLINE','Live video classes',false,1),('At teacher''s place','OFFLINE','Student travels to the teacher or centre',true,2),
 ('Home tuition','HOME_TUITION','Teacher travels to the student''s home',true,3),('Hybrid','HYBRID','Mix of online and in-person classes',true,4),
 ('Group batch','BATCH','Group classes with a fixed schedule',true,5)) AS v(name, code, descr, req, ord)
WHERE NOT EXISTS (SELECT 1 FROM teaching_modes x WHERE x.code=v.code AND x.deleted_at IS NULL);

INSERT INTO teacher_categories (name, slug, description, sort_order)
SELECT v.* FROM (VALUES
 ('Home Tutor','home-tutor','Teaches at the student''s home, usually one-to-one',1),('School Teacher','school-teacher','Teaches school subjects to a board syllabus',2),
 ('Coaching Faculty','coaching-faculty','Teaches batches at a coaching centre',3),('Competitive Exam Faculty','competitive-exam-faculty','JEE, NEET, UPSC and other entrance exams',4),
 ('Language Trainer','language-trainer','Spoken English, IELTS and foreign languages',5),('Music & Arts Teacher','music-arts-teacher','Music, dance, drawing and other arts',6),
 ('Coding & Skills Mentor','coding-skills-mentor','Coding, robotics and other skills',7)) AS v(name, slug, descr, ord)
WHERE NOT EXISTS (SELECT 1 FROM teacher_categories x WHERE x.slug=v.slug AND x.deleted_at IS NULL);
COMMIT;
