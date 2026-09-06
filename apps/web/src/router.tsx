import {
  createRootRoute,
  createRoute,
  createRouter,
  Navigate,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { useAuth } from './lib/providers';
import { Shell } from './components/shell';
import { Skeleton } from './components/ui';
import { LoginPage } from './pages/login';
import { SignupPage } from './pages/signup';
import { ResetPasswordPage } from './pages/reset-password';
import { AcceptInvitePage } from './pages/accept-invite';
import { SsoErrorPage, SsoSuccessPage } from './pages/sso';
import { HomePage } from './pages/home';
import { ProfilePage } from './pages/settings/profile';
import { SecurityPage } from './pages/settings/security';
import { UsersPage } from './pages/settings/users';
import { RolesPage } from './pages/settings/roles';
import { SsoPage } from './pages/settings/sso';
import { OrgPage } from './pages/settings/org';
import { AuditPage } from './pages/settings/audit';
import { PrivacyPage } from './pages/settings/privacy';

function ProtectedLayout(): React.JSX.Element {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <main className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-8" aria-label="Loading">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-48 w-full" />
      </main>
    );
  }
  if (!user) {
    return <Navigate to="/login" />;
  }
  return (
    <Shell>
      <Outlet />
    </Shell>
  );
}

const rootRoute = createRootRoute();

const protectedRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'protected',
  component: ProtectedLayout,
});

const homeRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: '/',
  component: HomePage,
});
const profileRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: '/settings/profile',
  component: ProfilePage,
});
const securityRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: '/settings/security',
  component: SecurityPage,
});
const usersRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: '/settings/users',
  component: UsersPage,
});
const rolesRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: '/settings/roles',
  component: RolesPage,
});
const ssoRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: '/settings/sso',
  component: SsoPage,
});
const orgRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: '/settings/org',
  component: OrgPage,
});
const auditRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: '/settings/audit',
  component: AuditPage,
});
const privacyRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: '/settings/privacy',
  component: PrivacyPage,
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  component: LoginPage,
});
const signupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/signup',
  component: SignupPage,
});
const resetRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/reset-password',
  component: ResetPasswordPage,
});
const inviteRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/accept-invite',
  component: AcceptInvitePage,
});
const ssoSuccessRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sso/success',
  component: SsoSuccessPage,
});
const ssoErrorRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sso/error',
  component: SsoErrorPage,
});

const routeTree = rootRoute.addChildren([
  protectedRoute.addChildren([
    homeRoute,
    profileRoute,
    securityRoute,
    usersRoute,
    rolesRoute,
    ssoRoute,
    orgRoute,
    auditRoute,
    privacyRoute,
  ]),
  loginRoute,
  signupRoute,
  resetRoute,
  inviteRoute,
  ssoSuccessRoute,
  ssoErrorRoute,
]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

export function AppRouter(): React.JSX.Element {
  return <RouterProvider router={router} />;
}
