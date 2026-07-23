
import { useRouter } from '@/lib/router';
import { useEffect } from 'react';

export function MailRedirect({ to }: { to: string }) {
  const router = useRouter();

  useEffect(() => {
    router.replace(to);
  }, [router, to]);

  return null;
}
