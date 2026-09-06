import * as Dialog from '@radix-ui/react-dialog';
import { clsx } from 'clsx';
import type { ReactNode } from 'react';

export function Modal({
  open,
  onOpenChange,
  title,
  description,
  size = 'md',
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  size?: 'sm' | 'md' | 'lg' | 'xl' | '2xl' | '3xl' | '4xl';
  children: ReactNode;
}): React.JSX.Element {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50 backdrop-blur-xs" />
        <Dialog.Content
          className={clsx(
            'fixed left-1/2 top-1/2 z-50 w-full max-h-[90vh] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-border bg-surface p-6 shadow-prominent',
            size === 'sm' && 'max-w-sm',
            size === 'md' && 'max-w-md',
            size === 'lg' && 'max-w-lg',
            size === 'xl' && 'max-w-xl',
            size === '2xl' && 'max-w-2xl',
            size === '3xl' && 'max-w-3xl',
            size === '4xl' && 'max-w-4xl',
          )}
        >
          <Dialog.Title className="text-xl font-semibold">{title}</Dialog.Title>
          {description && (
            <Dialog.Description className="mt-1 text-sm text-text-secondary">
              {description}
            </Dialog.Description>
          )}
          <div className="mt-4">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

