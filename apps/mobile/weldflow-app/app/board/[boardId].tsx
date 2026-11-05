/**
 * A whiteboard, read only: the board as it is now, drawn by board-api as one
 * SVG (`GET /api/boards/:id/render`), in scroll views with zoom buttons
 * (pinch zoom on a ScrollView is iOS only). Editing stays on the web.
 */

import { useMemo, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { Maximize, Minus, Plus } from 'lucide-react-native';
import { SvgXml } from 'react-native-svg';

import { IconButton } from '@weldsuite/mobile-ui/components/IconButton';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';

import { BRAND } from '@/lib/brand';
import { Screen, ScreenHeader } from '@/components/screen';
import { DetailSkeleton, ErrorState } from '@/components/data-states';
import { useBoardRender } from '@/hooks/use-weldflow';
import { useI18n } from '@/lib/i18n';
import { boardSvgSize, nextZoom } from '@/lib/board-view';

export default function BoardViewerScreen() {
  const { colors } = useTheme();
  const { width: screenWidth } = useWindowDimensions();
  const { boardId, name, legacy } = useLocalSearchParams<{ boardId: string; name?: string; legacy?: string }>();
  const { t, format } = useI18n();
  const render = useBoardRender(boardId, legacy === '1');
  const [zoom, setZoom] = useState(1);

  const size = useMemo(() => (render.data ? boardSvgSize(render.data.svg) : null), [render.data]);
  const width = Math.round(screenWidth * zoom);
  const height = size ? Math.round((width * size.height) / size.width) : 0;

  const header = (
    <ScreenHeader
      title={name || t.boards.title}
      showBack
      actions={
        <View style={styles.actions}>
          <IconButton icon={<Minus size={20} color={colors.text} />} accessibilityLabel={t.boards.zoomOut} onPress={() => setZoom((z) => nextZoom(z, -1))} />
          <IconButton icon={<Maximize size={20} color={colors.text} />} accessibilityLabel={t.boards.fit} onPress={() => setZoom(1)} />
          <IconButton icon={<Plus size={20} color={colors.text} />} accessibilityLabel={t.boards.zoomIn} onPress={() => setZoom((z) => nextZoom(z, 1))} />
        </View>
      }
    />
  );

  if (render.isLoading) {
    return (
      <Screen header={header}>
        <DetailSkeleton />
      </Screen>
    );
  }
  if (render.isError || !render.data || !size) {
    return (
      <Screen header={header}>
        <ErrorState message={t.boards.boardError} onRetry={() => void render.refetch()} />
      </Screen>
    );
  }

  const { svg, drawn, elements } = render.data;
  return (
    <Screen header={header}>
      <Text style={[styles.note, { color: colors.mutedForeground }]}>
        {drawn < elements ? `${t.boards.viewOnly} ${format(t.boards.partial, { drawn, count: elements })}` : t.boards.viewOnly}
      </Text>
      <ScrollView
        refreshControl={<RefreshControl refreshing={render.isRefetching} onRefresh={() => void render.refetch()} tintColor={BRAND} />}
        contentContainerStyle={styles.content}
      >
        <ScrollView horizontal showsHorizontalScrollIndicator={zoom > 1}>
          <View accessible accessibilityRole="image" accessibilityLabel={name || t.boards.title}>
            <SvgXml xml={svg} width={width} height={height} />
          </View>
        </ScrollView>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  actions: { flexDirection: 'row', gap: 2 },
  note: { fontSize: 12, paddingHorizontal: 16, paddingVertical: 8 },
  content: { paddingBottom: 32 },
});
