/**
 * Opens a record chat's record in its own app (WeldCRM, WeldFlow) through the
 * app's URL scheme. No install check up front (that needs the schemes listed
 * in the native config): the open fails when the app is missing, and then
 * says so.
 */

import { useCallback } from 'react';
import { Alert, Linking } from 'react-native';

import { useI18n } from '@/lib/i18n';
import { linkNeedsDetail, recordAppFor, recordAppLink } from '@/lib/record-chats/app-links';
import { appApi } from '@/services/app-api';

export function useOpenRecordInApp() {
  const { t, format } = useI18n();

  return useCallback(
    async (entityType: string, entityId: string) => {
      const app = recordAppFor(entityType);
      if (!app) return;

      let detail: { projectId?: string | null } | null = null;
      if (linkNeedsDetail(entityType)) {
        try {
          const res = await appApi.chatEntityChannels.getDetail(entityType, entityId);
          detail = (res.data ?? null) as { projectId?: string | null } | null;
        } catch {
          detail = null;
        }
      }

      const link = recordAppLink(entityType, entityId, detail);
      if (!link) {
        Alert.alert(format(t.recordChats.openFailed, { app }));
        return;
      }
      try {
        await Linking.openURL(link.url);
      } catch {
        Alert.alert(
          format(t.recordChats.appMissingTitle, { app }),
          format(t.recordChats.appMissingBody, { app }),
        );
      }
    },
    [t, format],
  );
}
