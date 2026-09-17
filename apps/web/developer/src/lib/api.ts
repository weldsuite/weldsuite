import { useAuth } from '@clerk/clerk-react';
import { useCallback, useRef } from 'react';
import { createClientApi } from '@weldsuite/api-client/client';
import type { ClientApi } from '@weldsuite/api-client/types';
import { getAppApiUrl } from '@/lib/public-env';

const APP_API_URL = getAppApiUrl();

/** Token-aware ClientApi aimed at app-api `/api/*`. */
export function useAppApiClient() {
  const { getToken } = useAuth();
  const clientRef = useRef<ClientApi | null>(null);
  const tokenRef = useRef<string | null>(null);

  const getClient = useCallback(async () => {
    const token = await getToken();
    if (token !== tokenRef.current || !clientRef.current) {
      tokenRef.current = token;
      clientRef.current = createClientApi({
        getToken: async () => token,
        baseUrl: APP_API_URL,
      });
    }
    return clientRef.current;
  }, [getToken]);

  return { getClient };
}
