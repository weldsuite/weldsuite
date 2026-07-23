
import { useEffect, useState } from 'react';
import { PageLoader } from '@/components/page-loader';
import { FeedbackClient } from './feedback-client';
import { useAppApiClient } from '@/lib/api/use-app-api';

export default function FeedbackSettingsPage() {
  const { getClient } = useAppApiClient();
  const [requests, setRequests] = useState<any[]>([]);
  const [stats, setStats] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadData() {
      try {
        const client = await getClient();
        const [requestsResult, statsResult] = await Promise.all([
          client.get<{ data?: any[] }>('/feature-requests?sortBy=votes'),
          client.get<{ data?: any }>('/feature-requests/stats'),
        ]);

        if (requestsResult.data) {
          setRequests(requestsResult.data);
        }
        if (statsResult.data) {
          setStats(statsResult.data);
        }
      } catch (error) {
        console.error('Failed to load feedback data:', error);
      } finally {
        setLoading(false);
      }
    }

    loadData();
  }, [getClient]);

  if (loading) {
    return <PageLoader fullScreen={false} />;
  }

  return <FeedbackClient initialRequests={requests} initialStats={stats} />;
}
