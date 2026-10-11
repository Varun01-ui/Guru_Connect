import { createBrowserRouter, RouterProvider } from 'react-router-dom'
import { AppShell } from './AppShell'
import { DashboardPage } from '../features/dashboard/pages/DashboardPage'
import { RequireAuth } from '../features/auth/RequireAuth'
import { ForgotPasswordPage } from '../features/auth/pages/ForgotPasswordPage'
import { AcceptInvitePage } from '../features/auth/pages/AcceptInvitePage'
import { LoginPage } from '../features/auth/pages/LoginPage'
import { ResetPasswordPage } from '../features/auth/pages/ResetPasswordPage'
import { SessionsPage } from '../features/auth/pages/SessionsPage'
import { classesConfig } from '../features/masters/config/classes.config'
import { countriesConfig } from '../features/masters/config/countries.config'
import { teachingModesConfig } from '../features/masters/config/teachingModes.config'
import { MasterListPage } from '../features/masters/pages/MasterListPage'

const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  { path: '/forgot-password', element: <ForgotPasswordPage /> },
  { path: '/reset-password', element: <ResetPasswordPage /> },
  { path: '/accept-invite', element: <AcceptInvitePage /> },
  {
    path: '/',
    element: (
      <RequireAuth>
        <AppShell>
          <DashboardPage />
        </AppShell>
      </RequireAuth>
    ),
  },
  {
    path: '/masters/locations/countries',
    element: (
      <RequireAuth>
        <AppShell>
          <MasterListPage config={countriesConfig} />
        </AppShell>
      </RequireAuth>
    ),
  },
  {
    path: '/masters/education/classes',
    element: (
      <RequireAuth>
        <AppShell>
          <MasterListPage config={classesConfig} />
        </AppShell>
      </RequireAuth>
    ),
  },
  {
    path: '/masters/education/teaching-modes',
    element: (
      <RequireAuth>
        <AppShell>
          <MasterListPage config={teachingModesConfig} />
        </AppShell>
      </RequireAuth>
    ),
  },
  {
    path: '/account/security',
    element: (
      <RequireAuth>
        <AppShell>
          <SessionsPage />
        </AppShell>
      </RequireAuth>
    ),
  },
])

export function AppRouter() {
  return <RouterProvider router={router} />
}
