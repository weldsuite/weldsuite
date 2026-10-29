/**
 * The app's create screens (a new announcement, a shift or time off request,
 * a sick report, an expense), all one design after WeldChat's new channel
 * and new category: the sheet header with the screen's action as its pill,
 * small capitals over grey rounded fields, chips for a short choice, rows
 * with a round check for a longer one, and switches straight on the page.
 * One place, so a change shows on every form.
 */

import { Children, forwardRef, Fragment, isValidElement, useMemo, type ReactNode } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Check } from 'lucide-react-native';
import { Switch } from '@weldsuite/mobile-ui/components/Switch';
import type { Colors } from '@weldsuite/mobile-ui/constants/theme';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';

import { useI18n } from '@/lib/i18n';
import { SheetHeader, type SheetHeaderAction } from './SheetHeader';

type ThemeColors = (typeof Colors)['light'];

function useFormStyles() {
  const { colors } = useTheme();
  return { colors, styles: useMemo(() => makeStyles(colors), [colors]) };
}

/** The whole screen: the header (close, title, action pill) over the scrolling form. */
export function FormScreen({
  title,
  action,
  children,
}: Readonly<{ title: string; action?: SheetHeaderAction; children: ReactNode }>) {
  const { styles } = useFormStyles();
  const { t } = useI18n();
  const router = useRouter();
  return (
    <View style={styles.container}>
      <SheetHeader title={title} onLeadingPress={() => router.back()} leadingLabel={t.common.close} action={action} />
      <ScrollView
        contentContainerStyle={styles.body}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        automaticallyAdjustKeyboardInsets
        showsVerticalScrollIndicator={false}
      >
        {children}
      </ScrollView>
    </View>
  );
}

/** The small capitals over a field. */
export function FormLabel({ children }: Readonly<{ children: string }>) {
  const { styles } = useFormStyles();
  return <Text style={styles.label}>{children}</Text>;
}

/** A label, what goes under it, and an optional line of help below. */
export function FormField({
  label,
  hint,
  style,
  children,
}: Readonly<{ label: string; hint?: string | null; style?: StyleProp<ViewStyle>; children: ReactNode }>) {
  return (
    <View style={style}>
      <FormLabel>{label}</FormLabel>
      {children}
      {hint ? <FormHint>{hint}</FormHint> : null}
    </View>
  );
}

/** Fields side by side (from and until). */
export function FormRow({ children }: Readonly<{ children: ReactNode }>) {
  const { styles } = useFormStyles();
  return (
    <View style={styles.row}>
      {Children.map(children, (child) => (
        <View style={styles.rowItem}>{child}</View>
      ))}
    </View>
  );
}

/** The grey field; `multiline` grows it for a few paragraphs. */
export const FormInput = forwardRef<TextInput, TextInputProps>(function FormInput({ style, multiline, ...props }, ref) {
  const { colors, styles } = useFormStyles();
  return (
    <TextInput
      ref={ref}
      style={[styles.field, multiline && styles.multiline, style]}
      placeholderTextColor={colors.muted}
      multiline={multiline}
      textAlignVertical={multiline ? 'top' : 'center'}
      {...props}
    />
  );
});

/** Help under a field, or what went wrong in red. */
export function FormHint({ children, error = false }: Readonly<{ children: ReactNode; error?: boolean }>) {
  const { styles } = useFormStyles();
  return <Text style={[styles.hint, error && styles.hintError]}>{children}</Text>;
}

export interface FormChoiceOption<T extends string> {
  value: T;
  label: string;
}

/** One of a few short options (a currency, a category): WeldChat's chips. */
export function FormChips<T extends string>({
  options,
  value,
  onChange,
}: Readonly<{ options: FormChoiceOption<T>[]; value: T; onChange: (value: T) => void }>) {
  const { styles } = useFormStyles();
  return (
    <View style={styles.chips}>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            onPress={() => onChange(option.value)}
            accessibilityRole="radio"
            accessibilityState={{ selected }}
            style={({ pressed }) => [styles.chip, selected && styles.chipSelected, pressed && !selected && styles.chipPressed]}
          >
            <Text style={[styles.chipText, selected && styles.chipTextSelected]} numberOfLines={1}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Rows straight on the page with a line between them (switches, choices). */
export function FormOptions({ children }: Readonly<{ children: ReactNode }>) {
  const { styles } = useFormStyles();
  const items = Children.toArray(children).filter(isValidElement);
  return (
    <View style={styles.options}>
      {items.map((child, index) => (
        <Fragment key={child.key ?? index}>
          {index > 0 ? <View style={styles.divider} /> : null}
          {child}
        </Fragment>
      ))}
    </View>
  );
}

/** Something to switch on or off; the whole row flips it. */
export function FormSwitch({
  title,
  hint,
  value,
  onChange,
  testID,
}: Readonly<{ title: string; hint?: string; value: boolean; onChange: (value: boolean) => void; testID?: string }>) {
  const { styles } = useFormStyles();
  return (
    <Pressable
      style={styles.option}
      onPress={() => onChange(!value)}
      accessibilityRole="switch"
      accessibilityState={{ checked: value }}
      testID={testID}
    >
      <OptionText title={title} hint={hint} styles={styles} />
      {/* The row handles the tap; a tap on the switch itself would flip it twice. */}
      <View pointerEvents="none">
        <Switch value={value} onValueChange={onChange} />
      </View>
    </Pressable>
  );
}

/** One of a list (a type of leave): a row with a round check, WeldChat's public / private. */
export function FormChoice({
  leading,
  title,
  hint,
  selected,
  onPress,
  testID,
}: Readonly<{
  leading?: ReactNode;
  title: string;
  hint?: string | null;
  selected: boolean;
  onPress: () => void;
  testID?: string;
}>) {
  const { colors, styles } = useFormStyles();
  return (
    <Pressable
      style={styles.option}
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      accessibilityLabel={title}
      testID={testID}
    >
      {leading}
      <OptionText title={title} hint={hint} styles={styles} />
      <View style={[styles.radio, selected && styles.radioSelected]}>
        {selected ? <Check size={13} color={colors.background} strokeWidth={3} /> : null}
      </View>
    </Pressable>
  );
}

function OptionText({
  title,
  hint,
  styles,
}: Readonly<{ title: string; hint?: string | null; styles: ReturnType<typeof makeStyles> }>) {
  return (
    <View style={styles.optionText}>
      <Text style={styles.optionTitle} numberOfLines={1}>
        {title}
      </Text>
      {hint ? <Text style={styles.optionHint}>{hint}</Text> : null}
    </View>
  );
}

/** The grey field's box, for fields that open a picker (DateField, TimeField). */
export function useFieldBox() {
  const { colors, styles } = useFormStyles();
  return { colors, box: styles.fieldBox, value: styles.fieldValue };
}

// The values of WeldChat's new-channel and new-category screens.
const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: c.background },
    body: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 40, gap: 24 },

    label: {
      fontSize: 13,
      fontWeight: '600',
      letterSpacing: 0.4,
      textTransform: 'uppercase',
      color: c.mutedForeground,
      marginBottom: 8,
    },
    hint: { fontSize: 14, lineHeight: 20, color: c.mutedForeground, marginTop: 10 },
    hintError: { color: c.destructive },

    row: { flexDirection: 'row', gap: 12 },
    rowItem: { flex: 1 },

    field: {
      height: 48,
      paddingHorizontal: 14,
      borderRadius: 14,
      borderCurve: 'continuous',
      borderWidth: 1,
      borderColor: 'transparent',
      backgroundColor: c.inputBackground,
      fontSize: 17,
      color: c.text,
    },
    multiline: { height: undefined, minHeight: 120, paddingTop: 13, paddingBottom: 13, lineHeight: 23 },
    // The field's box, its text where a typed field's text starts.
    fieldBox: {
      height: 48,
      paddingHorizontal: 14,
      borderRadius: 14,
      borderCurve: 'continuous',
      borderWidth: 1,
      borderColor: 'transparent',
      backgroundColor: c.inputBackground,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    fieldValue: { fontSize: 17, color: c.text, fontVariant: ['tabular-nums'] },

    chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    chip: {
      height: 34,
      paddingHorizontal: 14,
      borderRadius: 18,
      backgroundColor: c.secondary,
      justifyContent: 'center',
      maxWidth: '100%',
    },
    chipPressed: { opacity: 0.6 },
    chipSelected: { backgroundColor: c.text },
    chipText: { fontSize: 15, fontWeight: '500', color: c.text },
    chipTextSelected: { color: c.background },

    // The rows' own padding is the space above them.
    options: { marginTop: -12 },
    option: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 13 },
    divider: { height: StyleSheet.hairlineWidth, backgroundColor: c.border },
    optionText: { flex: 1, minWidth: 0 },
    optionTitle: { fontSize: 16, fontWeight: '600', color: c.text },
    optionHint: { fontSize: 14, lineHeight: 19, color: c.mutedForeground, marginTop: 2 },
    radio: {
      width: 22,
      height: 22,
      borderRadius: 11,
      borderWidth: 1.5,
      borderColor: c.border,
      alignItems: 'center',
      justifyContent: 'center',
    },
    radioSelected: { backgroundColor: c.text, borderColor: c.text },
  });
