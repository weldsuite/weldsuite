/**
 * A chart from a `show_chart` spec, drawn with react-native-svg (bar, line,
 * area, pie, donut). Tapping a bar, point or slice asks about it.
 */

import { useState, type ReactNode } from 'react';
import { View, Text, StyleSheet, type LayoutChangeEvent } from 'react-native';
import Svg, { Circle, G, Line, Path, Rect, Text as SvgText } from 'react-native-svg';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { formatVisualNumber, type ChartVisual } from '@weldsuite/app-api-client/schemas/chat-visuals';
import {
  arcPath,
  areaPath,
  linePath,
  linearScale,
  niceTicks,
  pieSlices,
  seriesColor,
  valueRange,
  type Point,
} from '@/lib/visuals';

export interface ChartPick {
  label: string;
  value?: number;
}

interface VisualChartProps {
  visual: ChartVisual;
  locale: string;
  otherLabel: string;
  height?: number;
  onPick?: (pick: ChartPick) => void;
}

const AXIS_WIDTH = 44;
const LABEL_HEIGHT = 20;
const TOP = 8;

function Legend({ items }: Readonly<{ items: { label: string; color: string; value?: string }[] }>) {
  const { colors } = useTheme();
  return (
    <View style={styles.legend}>
      {items.map((item, i) => (
        <View key={`${item.label}-${i}`} style={styles.legendItem}>
          <View style={[styles.swatch, { backgroundColor: item.color }]} />
          <Text style={[styles.legendText, { color: colors.mutedForeground }]} numberOfLines={1}>
            {item.label}
            {item.value ? <Text style={{ color: colors.text }}> {item.value}</Text> : null}
          </Text>
        </View>
      ))}
    </View>
  );
}

export function VisualChart({ visual, locale, otherLabel, height = 200, onPick }: Readonly<VisualChartProps>) {
  const { colors } = useTheme();
  const [width, setWidth] = useState(0);
  const onLayout = (e: LayoutChangeEvent) => setWidth(Math.round(e.nativeEvent.layout.width));
  const format = (v: number, compact = false) => formatVisualNumber(v, visual.format, locale, { compact });
  const single = visual.series.length === 1;
  const pick = (index: number) => {
    if (!onPick || index < 0) return;
    const value = single ? visual.series[0].values[index] : null;
    onPick({ label: visual.labels[index], ...(typeof value === 'number' ? { value } : {}) });
  };

  if (visual.kind === 'pie' || visual.kind === 'donut') {
    const slices = pieSlices(visual, otherLabel);
    const size = Math.min(height, width || height);
    const r = size / 2 - 4;
    const inner = visual.kind === 'donut' ? r * 0.55 : 0;
    return (
      <View onLayout={onLayout}>
        {width > 0 ? (
          <Svg width={width} height={size} accessibilityLabel={visual.title}>
            <G x={(width - size) / 2}>
              {slices.map((slice, i) => (
                <Path
                  key={`${slice.label}-${slice.index}`}
                  d={arcPath(size / 2, size / 2, r, inner, slice.startAngle, slice.endAngle)}
                  fill={seriesColor(i)}
                  stroke={colors.background}
                  strokeWidth={2}
                  onPress={slice.index >= 0 ? () => pick(slice.index) : undefined}
                />
              ))}
            </G>
          </Svg>
        ) : (
          <View style={{ height: size }} />
        )}
        <Legend items={slices.map((s, i) => ({ label: s.label, color: seriesColor(i), value: format(s.value) }))} />
      </View>
    );
  }

  const [min, max] = valueRange(visual);
  const ticks = niceTicks(min, max, 4);
  const plotLeft = AXIS_WIDTH;
  const plotRight = Math.max(plotLeft + 1, width - 4);
  const plotBottom = height - LABEL_HEIGHT;
  const y = linearScale([ticks[0], ticks[ticks.length - 1]], [plotBottom, TOP]);
  const n = visual.labels.length;
  const band = (plotRight - plotLeft) / Math.max(1, n);
  const center = (i: number) => plotLeft + band * i + band / 2;
  // Show at most ~6 x labels so they do not overlap.
  const labelEvery = Math.max(1, Math.ceil(n / Math.max(1, Math.floor((plotRight - plotLeft) / 56))));

  const grid = ticks.map((tick) => (
    <G key={`tick-${tick}`}>
      <Line x1={plotLeft} x2={plotRight} y1={y(tick)} y2={y(tick)} stroke={colors.border} strokeWidth={StyleSheet.hairlineWidth} />
      <SvgText x={plotLeft - 6} y={y(tick) + 4} fontSize={10} fill={colors.mutedForeground} textAnchor="end">
        {format(tick, true)}
      </SvgText>
    </G>
  ));
  const xLabels = visual.labels.map((label, i) =>
    i % labelEvery === 0 ? (
      <SvgText key={`x-${i}`} x={center(i)} y={height - 6} fontSize={10} fill={colors.mutedForeground} textAnchor="middle">
        {label.length > 10 ? `${label.slice(0, 9)}…` : label}
      </SvgText>
    ) : null,
  );

  let marks: ReactNode = null;
  if (visual.kind === 'bar') {
    const groups = visual.stacked ? 1 : visual.series.length;
    const barWidth = Math.max(2, (band * 0.7) / groups);
    marks = visual.labels.map((_, i) => {
      let positive = 0;
      let negative = 0;
      return (
        <G key={`bar-${i}`} onPress={() => pick(i)}>
          {/* A full-height hit area, so short bars are easy to tap. */}
          <Rect x={plotLeft + band * i} y={TOP} width={band} height={plotBottom - TOP} fill="transparent" />
          {visual.series.map((s, j) => {
            const v = s.values[i];
            if (v === null || v === undefined) return null;
            let from = 0;
            if (visual.stacked) {
              from = v >= 0 ? positive : negative;
              if (v >= 0) positive += v;
              else negative += v;
            }
            const y0 = y(from);
            const y1 = y(from + v);
            const x = visual.stacked
              ? center(i) - barWidth / 2
              : plotLeft + band * i + band * 0.15 + barWidth * j;
            return (
              <Rect
                key={s.name}
                x={x}
                y={Math.min(y0, y1)}
                width={barWidth}
                height={Math.max(1, Math.abs(y1 - y0))}
                rx={2}
                fill={seriesColor(j)}
              />
            );
          })}
        </G>
      );
    });
  } else {
    const stacked = visual.kind === 'area' && visual.stacked === true;
    const running = visual.labels.map(() => 0);
    marks = visual.series.map((s, j) => {
      const baseline = running.map((v) => y(v));
      const points: (Point | null)[] = s.values.map((v, i) => {
        if (v === null || v === undefined) return null;
        const top = stacked ? running[i] + v : v;
        return { x: center(i), y: y(top) };
      });
      if (stacked) s.values.forEach((v, i) => (running[i] += v ?? 0));
      return (
        <G key={s.name}>
          {visual.kind === 'area' ? (
            <Path d={areaPath(points, stacked ? baseline : y(0))} fill={seriesColor(j)} fillOpacity={0.2} />
          ) : null}
          <Path d={linePath(points)} stroke={seriesColor(j)} strokeWidth={2} fill="none" />
          {n <= 12
            ? points.map((p, i) =>
                p ? <Circle key={`pt-${i}`} cx={p.x} cy={p.y} r={3} fill={seriesColor(j)} /> : null,
              )
            : null}
        </G>
      );
    });
  }

  // Tapping anywhere above a label picks it (lines and areas have no bars to tap).
  const columns =
    visual.kind === 'bar'
      ? null
      : visual.labels.map((_, i) => (
          <Rect
            key={`hit-${i}`}
            x={plotLeft + band * i}
            y={TOP}
            width={band}
            height={plotBottom - TOP}
            fill="transparent"
            onPress={() => pick(i)}
          />
        ));

  return (
    <View onLayout={onLayout}>
      {width > 0 ? (
        <Svg width={width} height={height} accessibilityLabel={visual.title}>
          {grid}
          {marks}
          {columns}
          {xLabels}
        </Svg>
      ) : (
        <View style={{ height }} />
      )}
      {visual.series.length > 1 ? (
        <Legend items={visual.series.map((s, j) => ({ label: s.name, color: seriesColor(j) }))} />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  legend: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 8, justifyContent: 'center' },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 5, maxWidth: '100%' },
  swatch: { width: 8, height: 8, borderRadius: 2 },
  legendText: { fontSize: 12 },
});
