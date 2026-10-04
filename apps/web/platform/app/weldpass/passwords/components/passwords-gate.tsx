/** Keeps the password manager's pages (and their queries) away from members without `passwords:use`. */

import type { ReactNode } from 'react';
import { usePermissions } from '@weldsuite/permissions/react';
import { AccessDeniedEmptyState } from '@/components/access-denied-empty-state';
import { PageLoader } from '@/components/page-loader';
import { usePasswordsT } from '../lib/use-passwords-t';

export function PasswordsGate({
  pageLabel,
  children,
}: Readonly<{ pageLabel: string; children: ReactNode }>) {
  const tp = usePasswordsT();
  const { can, isLoading } = usePermissions();

  if (isLoading) return <PageLoader fullScreen={false} />;
  if (!can('passwords:use')) {
    return (
      <AccessDeniedEmptyState
        description={tp('accessDenied')}
        permission="passwords:use"
        pageLabel={pageLabel}
      />
    );
  }
  return <>{children}</>;
}
