import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';
import { api, type AuthResponse, type MeResponse } from './api';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      staleTime: 30_000,
    },
  },
});

export function AppProviders({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>{children}</AuthProvider>
    </QueryClientProvider>
  );
}

interface AuthState {
  user: MeResponse['user'] | null;
  org: MeResponse['org'] | null;
  loading: boolean;
  refresh: () => Promise<void>;
  setSession: (auth: AuthResponse) => void;
  clear: () => void;
}

const AuthContext = createContext<AuthState>({
  user: null,
  org: null,
  loading: true,
  refresh: async () => undefined,
  setSession: () => undefined,
  clear: () => undefined,
});

export function useAuth(): AuthState {
  return useContext(AuthContext);
}

function AuthProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const meQuery = useQuery<MeResponse>({
    queryKey: ['me'],
    queryFn: () => api<MeResponse>('/auth/me'),
    retry: false,
  });

  const refresh = useCallback(async () => {
    await meQuery.refetch();
  }, [meQuery]);

  const setSession = useCallback((auth: AuthResponse) => {
    queryClient.setQueryData<MeResponse>(['me'], { user: auth.user, org: auth.org });
  }, []);

  const clear = useCallback(() => {
    queryClient.setQueryData<MeResponse | null>(['me'], null);
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      user: meQuery.data?.user ?? null,
      org: meQuery.data?.org ?? null,
      loading: meQuery.isLoading,
      refresh,
      setSession,
      clear,
    }),
    [meQuery.data, meQuery.isLoading, refresh, setSession, clear],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
