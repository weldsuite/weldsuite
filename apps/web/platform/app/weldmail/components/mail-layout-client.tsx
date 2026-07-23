
import { ReactNode, lazy, Suspense } from 'react';
import { useI18n } from '@/lib/i18n/provider';
import { PinnedEmailProvider } from '@/contexts/pinned-email-context';
import { PinnedMessagesProvider } from '@/contexts/pinned-messages-context';
import { StarredMessagesProvider } from '@/contexts/starred-messages-context';
import { ComposeProvider } from '@/contexts/compose-context';
import { CustomerPanelProvider } from '@/contexts/customer-panel-context';
import { BreadcrumbProvider } from '@/contexts/breadcrumb-context';
import { MailHeader } from './mail-header';
import { ModuleContent } from '@/components/layout/module-content';
// Lazy + dynamic-only: app-shell also dynamically imports this component (for
// its own global ComposeProvider scope). A static import here made it a mixed
// static+dynamic import, which the CI build folds into the entry chunk and
// breaks app-shell's lazy import(). This render is NOT redundant — it's scoped
// to mail's nested ComposeProvider — so keep it, just import it dynamically.
const FloatingComposePanel = lazy(() =>
  import('./floating-compose-panel').then((m) => ({ default: m.FloatingComposePanel })),
);

interface MailLayoutClientProps {
  children: ReactNode;
}

function MailLayoutContent({ children }: MailLayoutClientProps) {
  return (
    <div className="flex-1 flex flex-col w-full min-h-0 h-full overflow-hidden">
      <MailHeader />
      <ModuleContent className="overflow-auto">{children}</ModuleContent>

      {/* Floating compose panel */}
      <Suspense fallback={null}>
        <FloatingComposePanel />
      </Suspense>
    </div>
  );
}

export function MailLayoutClient({ children }: MailLayoutClientProps) {
  const { t } = useI18n();
  return (
    <BreadcrumbProvider defaultBreadcrumbs={[{ label: t.mail.header.mail, href: '/weldmail' }]}>
      <PinnedEmailProvider>
        <PinnedMessagesProvider>
          <StarredMessagesProvider>
            <ComposeProvider>
              <CustomerPanelProvider>
                <MailLayoutContent>{children}</MailLayoutContent>
              </CustomerPanelProvider>
            </ComposeProvider>
          </StarredMessagesProvider>
        </PinnedMessagesProvider>
      </PinnedEmailProvider>
    </BreadcrumbProvider>
  );
}
