import { useState, useCallback } from 'react';
import { useFocusEffect } from 'expo-router';
import appApi from '@/services/app-api';
import { useChatUserEvents } from './useChatUserEvents';

export function useActivityUnreadCount(): number {
  const [count, setCount] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const res = await appApi.notifications.unreadCount();
      setCount(res.data?.count ?? 0);
    } catch {
      // ignore
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      refresh();
    }, [refresh]),
  );

  useChatUserEvents(refresh);

  return count;
}
