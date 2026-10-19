
import { ReactNode } from 'react';
import { Info } from 'lucide-react';
import { BreadcrumbProvider } from '@/contexts/breadcrumb-context';
import { ConnectHeader } from './connect-header';
import { ModuleContent } from '@/components/layout/module-content';
import { Link, usePathname } from '@/lib/router';
import { useI18n } from '@/lib/i18n/provider';
import { cn } from '@/lib/utils';
import { WELDCONNECT_OUT_OF_SCOPE_SECTIONS } from '../mvp';

/** Shown above pages that are outside the MVP scope (see `WELDCONNECT_OUT_OF_SCOPE_SECTIONS`). */
function OutOfScopeNotice() {
  const { t } = useI18n();
  const section = usePathname().split('/').filter(Boolean)[1];
  if (!(WELDCONNECT_OUT_OF_SCOPE_SECTIONS as readonly string[]).includes(section ?? '')) return null;
  const copy = t.weldconnect.outOfScope;
  return (
    <div
      role="status"
      className="mb-3 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300"
    >
      <Info className="mt-0.5 h-4 w-4 flex-shrink-0" />
      <div className="min-w-0 text-sm">
        <p className="font-medium">{copy.title}</p>
        <p className="text-xs">
          {copy.description}{' '}
          <Link href="/weldconnect" className="underline underline-offset-2">{copy.back}</Link>
        </p>
      </div>
    </div>
  );
}

/** List pages run edge to edge like every other platform list; the rest keep the page padding. */
const LIST_PAGES = new Set([
  '/weldconnect/workflows',
  '/weldconnect/executions',
  '/weldconnect/templates',
  '/weldconnect/variables',
  '/weldconnect/webhooks',
]);

interface ConnectLayoutClientProps {
  children: ReactNode;
}

export function ConnectLayoutClient({ children }: Readonly<ConnectLayoutClientProps>) {
  const isListPage = LIST_PAGES.has(usePathname().replace(/\/$/, ''));
  return (
    <BreadcrumbProvider>
      <div className="flex-1 flex flex-col w-full min-h-0 h-full overflow-hidden">
        <ConnectHeader />
        <ModuleContent
          className={cn(
            'overflow-y-auto overflow-x-hidden subtle-scrollbar',
            !isListPage && 'px-3 md:px-4 pt-3 md:pt-4',
          )}
        >
          <OutOfScopeNotice />
          {children}
        </ModuleContent>
      </div>
    </BreadcrumbProvider>
  );
}
