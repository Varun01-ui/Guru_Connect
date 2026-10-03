-- @migration 020 M20 Teacher Location Mapping
-- @table teacher_locations: Cities and areas a teacher serves, with travel radius for home tuition.
CREATE TABLE teacher_locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  teacher_id uuid NOT NULL REFERENCES teachers(id) ON DELETE CASCADE, -- Teacher
  city_id uuid NOT NULL REFERENCES cities(id) ON DELETE RESTRICT, -- City served
  area_id uuid REFERENCES areas(id) ON DELETE RESTRICT, -- Area; NULL = whole city
  is_primary boolean NOT NULL DEFAULT false, -- Home base shown on the profile (max one)
  travel_radius_km smallint CHECK (travel_radius_km BETWEEN 0 AND 50), -- How far the teacher travels for home tuition
  address_line text, -- Teaching address for "at teacher's place" (never shown publicly in full)
  latitude numeric(9,6), -- Geocoded latitude of the address or area
  longitude numeric(9,6), -- Geocoded longitude
  created_by uuid REFERENCES admins(id), -- Set when an admin added it
  created_at timestamptz NOT NULL DEFAULT now() -- Created
);
CREATE UNIQUE INDEX uq_teacher_locations ON teacher_locations (teacher_id, city_id, COALESCE(area_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE UNIQUE INDEX uq_teacher_locations_primary ON teacher_locations (teacher_id) WHERE is_primary;
CREATE INDEX idx_teacher_locations_city_area ON teacher_locations (city_id, area_id);

-- @table teacher_teaching_modes: Teaching modes a teacher offers (Online, Home tuition, …).
CREATE TABLE teacher_teaching_modes (
  teacher_id uuid NOT NULL REFERENCES teachers(id) ON DELETE CASCADE, -- Teacher
  teaching_mode_id uuid NOT NULL REFERENCES teaching_modes(id) ON DELETE RESTRICT, -- Mode offered
  created_at timestamptz NOT NULL DEFAULT now(), -- Created
  PRIMARY KEY (teacher_id, teaching_mode_id)
);
CREATE INDEX idx_teacher_teaching_modes_mode ON teacher_teaching_modes (teaching_mode_id);
