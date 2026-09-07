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
import { WelcomePage } from './pages/welcome';
import { BillingPage } from './pages/settings/billing';
import { SequencesPage } from './pages/sequences/sequences-page';
import { PublicQuotePage } from './pages/quotes/public-quote';
import { NotificationPreferencesPage } from './pages/settings/notifications';
import { WorkflowsPage } from './pages/settings/workflows';
import { ProfilePage } from './pages/settings/profile';
import { SecurityPage } from './pages/settings/security';
import { UsersPage } from './pages/settings/users';
import { RolesPage } from './pages/settings/roles';
import { SsoPage } from './pages/settings/sso';
import { OrgPage } from './pages/settings/org';
import { AuditPage } from './pages/settings/audit';
import { PrivacyPage } from './pages/settings/privacy';
import { CustomFieldsAdminPage } from './pages/settings/custom-fields';
import { ContactsListPage } from './pages/contacts/contacts-list';
import { ContactDetailPage } from './pages/contacts/contact-detail';
import { AccountsListPage } from './pages/accounts/accounts-list';
import { AccountDetailPage } from './pages/accounts/account-detail';
import { DedupQueuePage } from './pages/duplicates/dedup-queue';
import { ImportsWizardPage } from './pages/imports/imports-wizard';
import { LeadsListPage } from './pages/leads/leads-list';
import { LeadDetailPage } from './pages/leads/lead-detail';
import { PipelineBoardPage } from './pages/deals/pipeline-board';
import { DealDetailPage } from './pages/deals/deal-detail';
import { TasksPage } from './pages/tasks/tasks-page';
import { EmailsPage } from './pages/emails/emails-page';
import { ReportsPage } from './pages/reports/reports-page';
import { WebToLeadPage } from './pages/settings/web-to-lead';
import { LeadRoutingPage } from './pages/settings/lead-routing';

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

const welcomeRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: '/welcome',
  component: WelcomePage,
});

const billingRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: '/settings/billing',
  component: BillingPage,
});

const notificationsRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: '/settings/notifications',
  component: NotificationPreferencesPage,
});

const sequencesRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: '/sequences',
  component: SequencesPage,
});

const publicQuoteRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/quotes/$token',
  component: PublicQuotePage,
});

const workflowsRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: '/settings/workflows',
  component: WorkflowsPage,
});

// Module 4 Routes
const dealsRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: '/deals',
  component: PipelineBoardPage,
});
const dealDetailRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: '/deals/$id',
  component: DealDetailPage,
});

// Module 5 Routes
const tasksRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: '/tasks',
  component: TasksPage,
});

// Module 6 Routes
const emailsRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: '/emails',
  component: EmailsPage,
});

// Module 7 Routes
const reportsRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: '/reports',
  component: ReportsPage,
});

// Module 3 Routes
const leadsRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: '/leads',
  component: LeadsListPage,
});

const leadDetailRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: '/leads/$id',
  component: LeadDetailPage,
});

const webToLeadRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: '/settings/web-to-lead',
  component: WebToLeadPage,
});

const leadRoutingRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: '/settings/lead-routing',
  component: LeadRoutingPage,
});

// Module 2 Routes
const contactsRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: '/contacts',
  component: ContactsListPage,
});

const contactDetailRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: '/contacts/$id',
  component: ContactDetailPage,
});

const accountsRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: '/accounts',
  component: AccountsListPage,
});

const accountDetailRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: '/accounts/$id',
  component: AccountDetailPage,
});

const duplicatesRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: '/duplicates',
  component: DedupQueuePage,
});

const importsRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: '/imports',
  component: ImportsWizardPage,
});

const customFieldsRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: '/settings/custom-fields',
  component: CustomFieldsAdminPage,
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
    welcomeRoute,
    billingRoute,
    notificationsRoute,
    sequencesRoute,
    workflowsRoute,
    dealsRoute,
    dealDetailRoute,
    tasksRoute,
    emailsRoute,
    reportsRoute,
    leadsRoute,
    leadDetailRoute,
    contactsRoute,
    contactDetailRoute,
    accountsRoute,
    accountDetailRoute,
    duplicatesRoute,
    importsRoute,
    webToLeadRoute,
    leadRoutingRoute,
    customFieldsRoute,
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
  publicQuoteRoute,
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
