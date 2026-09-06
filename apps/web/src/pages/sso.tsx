import { useEffect } from 'react';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useAuth } from '../lib/providers';
import { Skeleton } from '../components/ui';
import { AuthLayout } from './login';

export function SsoSuccessPage(): React.JSX.Element {
  const navigate = useNavigate();
  const { user, loading, refresh } = useAuth();

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!loading && user) {
      void navigate({ to: '/' });
    }
  }, [loading, user, navigate]);

  return (
    <AuthLayout title="Completing sign-in">
      <Skeleton className="h-12 w-full" />
      {!loading && !user && (
        <p role="alert" className="text-sm text-danger">
          Sign-in did not complete. The session may have expired — try again from the login page.
        </p>
      )}
    </AuthLayout>
  );
}

export function SsoErrorPage(): React.JSX.Element {
  const search = useSearch({ strict: false }) as { code?: string };
  return (
    <AuthLayout title="Single sign-on failed">
      <p role="alert" className="text-sm text-danger">
        {friendlySsoError(search.code)}
      </p>
      <Link to="/login" className="text-sm text-accent hover:underline">
        Back to sign in
      </Link>
    </AuthLayout>
  );
}

function friendlySsoError(code: string | undefined): string {
  switch (code) {
    case 'access_denied':
      return 'Your identity provider denied the request.';
    case 'email_not_verified':
      return 'Your identity provider did not confirm a verified email address.';
    case 'account_suspended':
      return 'This account has been suspended. Contact your workspace admin.';
    case 'invalid_session':
    case 'missing_parameters':
      return 'The sign-in session expired. Start again from the login page.';
    default:
      return 'Something went wrong completing sign-in. Try again, and contact your admin if it persists.';
  }
}
