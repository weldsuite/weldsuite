import { useEffect, useRef } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { PageLoader } from '@/components/page-loader';
import { getTranslations } from '@/lib/i18n';
import { useCompleteWeldAdsFacebookOAuth } from '@/hooks/queries/use-weldads-queries';

interface CallbackPageProps {
  code: string | undefined;
  state: string | undefined;
  error: string | undefined;
}

export default function WeldAdsConnectCallbackPage({ code, state, error }: CallbackPageProps) {
  const t = getTranslations('weldads').module;
  const navigate = useNavigate();
  const completeOAuth = useCompleteWeldAdsFacebookOAuth();
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    if (error || !code || !state) {
      navigate({ to: '/weldads/accounts' });
      return;
    }

    completeOAuth
      .mutateAsync({ code, state })
      .then(() => navigate({ to: '/weldads/accounts' }))
      .catch(() => navigate({ to: '/weldads/accounts' }));
  }, [code, state, completeOAuth, error, navigate]);

  return (
    <div className="flex flex-col items-center justify-center h-full gap-3">
      <PageLoader />
      <p className="text-muted-foreground">{t.connecting}</p>
    </div>
  );
}
