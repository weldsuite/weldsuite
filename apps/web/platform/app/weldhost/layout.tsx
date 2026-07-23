
import { useAppAccess } from '@/hooks/use-app-access';
import { HostLayoutClient } from './components/host-layout-client';
import { PageLoader } from '@/components/page-loader';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { Button } from '@weldsuite/ui/components/button';
import { Globe } from 'lucide-react';
import { useI18n } from '@/lib/i18n/provider';

export default function HostLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { isInstalled, isLoading } = useAppAccess('weldhost');
  const { t } = useI18n();
  const th = t.host.notInstalled;

  if (isLoading) return <PageLoader />;
  if (!isInstalled) {
    return (
      <div className="flex items-center justify-center min-h-screen p-6">
        <Card className="max-w-md w-full">
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-md bg-muted">
                <Globe className="h-5 w-5 text-muted-foreground" />
              </div>
              <div>
                <CardTitle>{th.title}</CardTitle>
                <CardDescription>
                  {th.description}
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 sm:flex-row">
            <Button
              className="w-full sm:w-auto"
              onClick={() => { window.location.href = '/appstore/weldhost'; }}
            >
              {th.install}
            </Button>
            <Button
              variant="outline"
              className="w-full sm:w-auto"
              onClick={() => { window.location.href = '/'; }}
            >
              {th.goHome}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <HostLayoutClient>
      {children}
    </HostLayoutClient>
  );
}
