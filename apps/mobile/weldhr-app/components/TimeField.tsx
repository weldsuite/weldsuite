/**
 * A time input that opens the day's quarter hours in a sheet, one line per
 * hour, scrolled to the chosen one. Plain JS like DateField, so it needs no
 * native picker in the build; the same field under the same label.
 */

import { useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Clock3 } from 'lucide-react-native';
import { Sheet } from '@weldsuite/mobile-ui/components/Sheet';

import { BRAND } from '@/constants/brand';
import { FormLabel, useFieldBox } from './Form';

interface TimeFieldProps {
  label: string;
  /** "HH:MM". */
  value: string;
  onChange: (time: string) => void;
  testID?: string;
}

const HOUR_ROW = 52;
const QUARTERS = [0, 15, 30, 45];
const pad = (n: number) => String(n).padStart(2, '0');

export function TimeField({ label, value, onChange, testID }: Readonly<TimeFieldProps>) {
  const { colors, box, value: valueStyle } = useFieldBox();
  const [open, setOpen] = useState(false);
  const list = useRef<ScrollView>(null);
  // Open with the chosen hour in view, two lines down from the top. Scrolled
  // once the lines are laid out: the sheet mounts before its content has a size.
  const hour = Number(value.slice(0, 2)) || 0;
  const scrollToChosen = () => list.current?.scrollTo({ y: Math.max(0, hour - 2) * HOUR_ROW, animated: false });

  return (
    <View>
      <FormLabel>{label}</FormLabel>
      <Pressable
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${value}`}
        testID={testID}
        style={({ pressed }) => [box, pressed && styles.pressed]}
      >
        <Text style={valueStyle}>{value}</Text>
        <Clock3 size={18} color={colors.mutedForeground} />
      </Pressable>
      {open ? (
        <Sheet visible={open} onClose={() => setOpen(false)} title={label} heightRatio={0.62}>
          <ScrollView
            ref={list}
            style={styles.hours}
            onContentSizeChange={scrollToChosen}
            showsVerticalScrollIndicator={false}
            nestedScrollEnabled
          >
            {Array.from({ length: 24 }, (_, h) => (
              <View key={h} style={styles.hour}>
                {QUARTERS.map((m) => {
                  const time = `${pad(h)}:${pad(m)}`;
                  const selected = time === value;
                  return (
                    <Pressable
                      key={time}
                      onPress={() => {
                        onChange(time);
                        setOpen(false);
                      }}
                      accessibilityRole="button"
                      accessibilityState={{ selected }}
                      style={({ pressed }) => [
                        styles.slot,
                        selected && { backgroundColor: BRAND },
                        !selected && pressed && { backgroundColor: colors.inputBackground },
                      ]}
                    >
                      <Text style={[styles.slotText, { color: selected ? '#FFFFFF' : colors.text }, selected && styles.slotTextSelected]}>
                        {time}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            ))}
          </ScrollView>
        </Sheet>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  pressed: { opacity: 0.8 },
  // Seven hours in view. A height of its own, so it scrolls itself inside the
  // sheet's scroll view (which would otherwise grow to fit all 24).
  hours: { height: HOUR_ROW * 7 },
  hour: { height: HOUR_ROW, flexDirection: 'row', alignItems: 'center', gap: 8 },
  slot: { flex: 1, height: 40, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  slotText: { fontSize: 16, fontVariant: ['tabular-nums'] },
  slotTextSelected: { fontWeight: '700' },
});
