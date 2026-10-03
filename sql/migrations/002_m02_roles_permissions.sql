-- @migration 002 M2 Roles & Permissions
-- @table roles: Named bundles of permissions. System roles are seeded and cannot be deleted.
CREATE TABLE roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  code text NOT NULL, -- Stable machine name, e.g. super_admin, finance_admin
  name text NOT NULL, -- Display name, e.g. Finance Admin
  description text, -- What this role is for
  is_system boolean NOT NULL DEFAULT false, -- Seeded roles; name/permissions of super_admin are immutable
  created_by uuid REFERENCES admins(id), -- Creator
  updated_by uuid REFERENCES admins(id), -- Last editor
  created_at timestamptz NOT NULL DEFAULT now(), -- Created
  updated_at timestamptz NOT NULL DEFAULT now(), -- Last updated
  deleted_at timestamptz, -- Soft delete (custom roles only, and only when no admin holds it)
  deleted_by uuid REFERENCES admins(id) -- Who deleted it
);
CREATE UNIQUE INDEX uq_roles_code ON roles (code) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX uq_roles_name ON roles (lower(name)) WHERE deleted_at IS NULL;
CREATE TRIGGER trg_roles_updated BEFORE UPDATE ON roles FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- @table permissions: Catalogue of permission keys. Seeded from code; admins cannot create permissions.
CREATE TABLE permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  key text NOT NULL, -- Dotted key checked by the API, e.g. teachers.approve
  module text NOT NULL, -- Module slug used to group the permission matrix UI
  description text NOT NULL, -- What the permission allows
  is_sensitive boolean NOT NULL DEFAULT false, -- Sensitive permissions (payments, roles, document unmasking) are highlighted in the UI
  created_at timestamptz NOT NULL DEFAULT now() -- Created
);
CREATE UNIQUE INDEX uq_permissions_key ON permissions (key);
CREATE INDEX idx_permissions_module ON permissions (module);

-- @table role_permissions: Which permissions each role grants.
CREATE TABLE role_permissions (
  role_id uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE, -- Role
  permission_id uuid NOT NULL REFERENCES permissions(id) ON DELETE CASCADE, -- Permission granted
  granted_by uuid REFERENCES admins(id), -- Admin who granted it
  granted_at timestamptz NOT NULL DEFAULT now(), -- When granted
  PRIMARY KEY (role_id, permission_id)
);
CREATE INDEX idx_role_permissions_permission ON role_permissions (permission_id);

-- @table admin_roles: Which roles each admin holds. An admin may hold several roles; effective permissions are the union.
CREATE TABLE admin_roles (
  admin_id uuid NOT NULL REFERENCES admins(id) ON DELETE CASCADE, -- Admin
  role_id uuid NOT NULL REFERENCES roles(id) ON DELETE RESTRICT, -- Role held
  assigned_by uuid REFERENCES admins(id), -- Who assigned it
  assigned_at timestamptz NOT NULL DEFAULT now(), -- When assigned
  PRIMARY KEY (admin_id, role_id)
);
CREATE INDEX idx_admin_roles_role ON admin_roles (role_id);
