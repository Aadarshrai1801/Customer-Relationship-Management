import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';

export interface BreadcrumbItem {
  label: string;
  to?: string;
}

export function Breadcrumbs({ items }: { items: BreadcrumbItem[] }): React.JSX.Element {
  return (
    <nav aria-label="Breadcrumb" className="flex items-center text-xs text-text-secondary">
      <ol className="flex items-center gap-1.5">
        {items.map((item, index) => {
          const isLast = index === items.length - 1;
          return (
            <li key={index} className="flex items-center gap-1.5">
              {index > 0 && <span aria-hidden className="text-border-strong">/</span>}
              {isLast || !item.to ? (
                <span
                  aria-current={isLast ? 'page' : undefined}
                  className={isLast ? 'font-medium text-text-primary' : 'text-text-secondary'}
                >
                  {item.label}
                </span>
              ) : (
                <Link to={item.to} className="hover:text-text-primary hover:underline">
                  {item.label}
                </Link>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
