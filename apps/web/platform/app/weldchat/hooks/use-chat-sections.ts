import { useCallback, useEffect, useRef, useMemo } from 'react';
import {
  useSections,
  useCreateSection,
  useUpdateSection,
  useDeleteSection,
  useAssignChannelToSection,
  useRemoveChannelFromSection,
  useChannels,
} from '@/hooks/queries/use-weldchat-queries';

const LEGACY_SECTIONS_KEY = 'weldchat-sections';
const LEGACY_CHANNEL_SECTIONS_KEY = 'weldchat-channel-sections';

export interface ChatSection {
  id: string;
  name: string;
}

/** `/chat-sections` row as `useSections()` projects it — only `id`/`name` read here. */
interface RawSectionRow {
  id: string;
  name?: string;
}

export function useChatSections() {
  const { data: sectionsData } = useSections();
  const { data: channelsData } = useChannels();
  const createSectionMutation = useCreateSection();
  const updateSectionMutation = useUpdateSection();
  const deleteSectionMutation = useDeleteSection();
  const assignMutation = useAssignChannelToSection();
  const removeMutation = useRemoveChannelFromSection();

  const sections: ChatSection[] = useMemo(
    () => ((sectionsData?.data ?? []) as RawSectionRow[]).map((s) => ({ id: s.id, name: s.name ?? '' })),
    [sectionsData],
  );

  // Derive channelSectionMap from channel data (each channel has sectionId)
  const channelSectionMap: Record<string, string> = useMemo(() => {
    const map: Record<string, string> = {};
    const channels = channelsData?.data || [];
    for (const ch of channels) {
      if (ch.sectionId) {
        map[ch.id] = ch.sectionId;
      }
    }
    return map;
  }, [channelsData]);

  // Migrate localStorage data to DB on first load
  const migratedRef = useRef(false);
  useEffect(() => {
    if (migratedRef.current) return;
    if (sectionsData === undefined) return; // still loading

    const legacySections = localStorage.getItem(LEGACY_SECTIONS_KEY);
    if (!legacySections) {
      migratedRef.current = true;
      return;
    }

    try {
      const parsed: Array<{ id: string; name: string }> = JSON.parse(legacySections);
      if (parsed.length === 0 || (sectionsData?.data?.length ?? 0) > 0) {
        // Nothing to migrate or DB already has sections
        localStorage.removeItem(LEGACY_SECTIONS_KEY);
        localStorage.removeItem(LEGACY_CHANNEL_SECTIONS_KEY);
        migratedRef.current = true;
        return;
      }

      // Migrate sections
      const legacyChannelMap: Record<string, string> = JSON.parse(
        localStorage.getItem(LEGACY_CHANNEL_SECTIONS_KEY) || '{}',
      );

      (async () => {
        const idMap: Record<string, string> = {}; // old localStorage id → new DB id
        for (let i = 0; i < parsed.length; i++) {
          try {
            const result = await createSectionMutation.mutateAsync({
              name: parsed[i].name,
              position: i,
            });
            if (result?.data?.id) {
              idMap[parsed[i].id] = result.data.id;
            }
          } catch {
            // Skip failed sections
          }
        }

        // Migrate channel assignments
        for (const [channelId, oldSectionId] of Object.entries(legacyChannelMap)) {
          const newSectionId = idMap[oldSectionId];
          if (newSectionId) {
            try {
              await assignMutation.mutateAsync({ sectionId: newSectionId, channelId });
            } catch {
              // Skip failed assignments
            }
          }
        }

        localStorage.removeItem(LEGACY_SECTIONS_KEY);
        localStorage.removeItem(LEGACY_CHANNEL_SECTIONS_KEY);
      })();
    } catch {
      localStorage.removeItem(LEGACY_SECTIONS_KEY);
      localStorage.removeItem(LEGACY_CHANNEL_SECTIONS_KEY);
    }

    migratedRef.current = true;
  }, [sectionsData, createSectionMutation, assignMutation]);

  const createSection = useCallback(
    (name: string) => {
      createSectionMutation.mutate({ name });
      return ''; // no longer returning sync id
    },
    [createSectionMutation],
  );

  const deleteSection = useCallback(
    (sectionId: string) => {
      deleteSectionMutation.mutate(sectionId);
    },
    [deleteSectionMutation],
  );

  const renameSection = useCallback(
    (sectionId: string, name: string) => {
      updateSectionMutation.mutate({ sectionId, name });
    },
    [updateSectionMutation],
  );

  const moveChannelToSection = useCallback(
    (channelId: string, sectionId: string | null) => {
      if (sectionId) {
        assignMutation.mutate({ sectionId, channelId });
      } else {
        // Find current section to remove from
        const currentSectionId = channelSectionMap[channelId];
        if (currentSectionId) {
          removeMutation.mutate({ sectionId: currentSectionId, channelId });
        }
      }
    },
    [assignMutation, removeMutation, channelSectionMap],
  );

  const getChannelSection = useCallback(
    (channelId: string): string | null => {
      return channelSectionMap[channelId] || null;
    },
    [channelSectionMap],
  );

  return {
    sections,
    channelSectionMap,
    createSection,
    deleteSection,
    renameSection,
    moveChannelToSection,
    getChannelSection,
  };
}
