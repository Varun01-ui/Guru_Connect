import type { AdminDetail, AdminRow, PermissionGroup, RoleDetail, RoleSummary } from './api/rbac.api'

// Shared fixtures for the RBAC screen tests.
export const catalogue: PermissionGroup[] = [
  {
    module: 'teachers',
    permissions: [
      { key: 'teachers.read', description: 'View teachers', isSensitive: false },
      { key: 'teachers.update', description: 'Edit teacher profiles', isSensitive: false },
      { key: 'teachers.export', description: 'Export teacher data', isSensitive: true },
    ],
  },
  {
    module: 'locations',
    permissions: [
      { key: 'locations.read', description: 'View locations', isSensitive: false },
      { key: 'locations.manage', description: 'Change locations', isSensitive: false },
    ],
  },
]

const stamp = '2026-09-20T08:11:02.114Z'

export const roleSummaries: RoleSummary[] = [
  { id: 'r-super', code: 'super_admin', name: 'Super Admin', description: 'Everything', isSystem: true, permissionCount: 5, adminCount: 1, updatedAt: stamp },
  { id: 'r-verif', code: 'verification_admin', name: 'Verification Admin', description: 'Reviews teacher documents', isSystem: true, permissionCount: 2, adminCount: 2, updatedAt: stamp },
  { id: 'r-city', code: 'city_launch_admin', name: 'City Launch Admin', description: 'Sets up a new city', isSystem: false, permissionCount: 2, adminCount: 0, updatedAt: stamp },
]

export const verificationRole: RoleDetail = {
  id: 'r-verif',
  code: 'verification_admin',
  name: 'Verification Admin',
  description: 'Reviews teacher documents',
  isSystem: true,
  permissionKeys: ['teachers.read', 'locations.read'],
  admins: [{ id: 'a-anjali', fullName: 'Anjali Menon', email: 'anjali@guruconnect.in' }],
  updatedAt: stamp,
}
export const cityRole: RoleDetail = {
  id: 'r-city',
  code: 'city_launch_admin',
  name: 'City Launch Admin',
  description: 'Sets up a new city',
  isSystem: false,
  permissionKeys: ['locations.read', 'locations.manage'],
  admins: [],
  updatedAt: stamp,
}
export const superRole: RoleDetail = {
  id: 'r-super',
  code: 'super_admin',
  name: 'Super Admin',
  description: 'Everything',
  isSystem: true,
  permissionKeys: ['teachers.read', 'teachers.update', 'teachers.export', 'locations.read', 'locations.manage'],
  admins: [],
  updatedAt: stamp,
}

export const anjali: AdminDetail = {
  id: 'a-anjali',
  email: 'anjali@guruconnect.in',
  fullName: 'Anjali Menon',
  status: 'active',
  isSuperAdmin: false,
  roles: [{ id: 'r-verif', code: 'verification_admin', name: 'Verification Admin' }],
  lastLoginAt: '2026-10-01T09:30:00.000Z',
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: stamp,
  sessionsCount: 2,
}
export const asAdminRow = (a: AdminDetail): AdminRow => ({ id: a.id, email: a.email, fullName: a.fullName, status: a.status, isSuperAdmin: a.isSuperAdmin, roles: a.roles, lastLoginAt: a.lastLoginAt, createdAt: a.createdAt })
