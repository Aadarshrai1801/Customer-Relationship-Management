import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { clsx } from 'clsx';

interface Toast {
  id: number;
  kind: 'success' | 'error';
  message: string;
}

const ToastContext = createContext<{ notify: (kind: Toast['kind'], message: string) => void }>({
  notify: () => undefined,
});

export function useToast(): { notify: (kind: Toast['kind'], message: string) => void } {
  return useContext(ToastContext);
}

let nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const notify = useCallback((kind: Toast['kind'], message: string) => {
    const id = nextId++;
    setToasts((current) => [...current, { id, kind, message }]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((t) => t.id !== id));
    }, 5000);
  }, []);

  const value = useMemo(() => ({ notify }), [notify]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2"
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            role="status"
            className={clsx(
              'pointer-events-auto rounded-lg border px-4 py-3 text-sm shadow-prominent',
              toast.kind === 'success'
                ? 'border-success bg-success-soft text-success'
                : 'border-danger bg-danger-soft text-danger',
            )}
          >
            {toast.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
