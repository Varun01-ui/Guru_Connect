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
import { teacherCategoriesConfig } from '../features/masters/config/teacherCategories.config'
import { statesConfig } from '../features/masters/config/states.config'
import { boardsConfig } from '../features/masters/config/boards.config'
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
    path: '/masters/education/teacher-categories',
    element: (
      <RequireAuth>
        <AppShell>
          <MasterListPage config={teacherCategoriesConfig} />
        </AppShell>
      </RequireAuth>
    ),
  },
  {
    path: '/masters/locations/states',
    element: (
      <RequireAuth>
        <AppShell>
          <MasterListPage config={statesConfig} />
        </AppShell>
      </RequireAuth>
    ),
  },
  {
    path: '/masters/education/boards',
    element: (
      <RequireAuth>
        <AppShell>
          <MasterListPage config={boardsConfig} />
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
