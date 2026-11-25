/**
 * The item form, for a new item and for an edit. The shape and the rules are
 * the platform's (`@weldsuite/app-api-client/schemas/weldpass-items`): one
 * flat set of values, only the chosen type's fields sent, the server's
 * `itemInputSchema` the authority. A login also lists the Android apps it
 * belongs to, which the phone's autofill matches on the device (PASS-010).
 */

import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { Check, Eye, EyeOff, WandSparkles } from 'lucide-react-native';
import type { WeldPassVault } from '@weldsuite/app-api-client/domains/weldpass-passwords';
import { generatePassword } from '@weldsuite/app-api-client/schemas/weldpass-passwords';
import {
  createItemFormSchema,
  invalidApps,
  parseAppList,
  type ItemFormValues,
} from '@weldsuite/app-api-client/schemas/weldpass-items';
import { Button } from '@weldsuite/mobile-ui/components/Button';
import { Input } from '@weldsuite/mobile-ui/components/Input';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';

import { StrengthMeter } from '@/components/StrengthMeter';
import { brandFor } from '@/lib/brand';
import { useI18n } from '@/lib/i18n';
import { vaultLabel } from '@/lib/vaults';

export function ItemForm({
  initial,
  vaults,
  allowVaultChoice,
  saving,
  onSubmit,
}: Readonly<{
  initial: ItemFormValues;
  /** Vaults the item may go into (editor or manager). */
  vaults: readonly WeldPassVault[];
  /** New items pick a vault; moving an existing one comes in a later version. */
  allowVaultChoice: boolean;
  saving: boolean;
  onSubmit: (values: ItemFormValues) => void;
}>) {
  const { t, format } = useI18n();
  const { colors, theme } = useTheme();
  const [values, setValues] = useState<ItemFormValues>(initial);
  const [appsText, setAppsText] = useState(initial.apps.join('\n'));
  const [showPassword, setShowPassword] = useState(false);
  const [errors, setErrors] = useState<{ title?: string; apps?: string }>({});
  const schema = useMemo(() => createItemFormSchema({ titleRequired: t.form.titleRequired }), [t]);

  const set = <K extends keyof ItemFormValues>(key: K, value: ItemFormValues[K]) =>
    setValues((current) => ({ ...current, [key]: value }));

  const submit = () => {
    const apps = values.type === 'login' ? parseAppList(appsText) : [];
    const next = { ...values, apps };
    const parsed = schema.safeParse(next);
    const titleIssue = parsed.success ? undefined : parsed.error.issues.find((issue) => issue.path[0] === 'title');
    const wrongApps = invalidApps(apps);
    const nextErrors = {
      title: titleIssue?.message,
      apps: wrongApps.length > 0 ? format(t.form.appsInvalid, { apps: wrongApps.join(', ') }) : undefined,
    };
    setErrors(nextErrors);
    if (nextErrors.title || nextErrors.apps || !parsed.success) return;
    onSubmit(next);
  };

  const brand = brandFor(theme);

  return (
    <KeyboardAwareScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" bottomOffset={24}>
      {allowVaultChoice && vaults.length > 1 ? (
        <View style={styles.field}>
          <Text style={[styles.label, { color: colors.text }]}>{t.form.vault}</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
            {vaults.map((vault) => {
              const selected = vault.id === values.vaultId;
              return (
                <Pressable
                  key={vault.id}
                  onPress={() => set('vaultId', vault.id)}
                  accessibilityRole="radio"
                  accessibilityState={{ selected }}
                  style={[
                    styles.chip,
                    { borderColor: selected ? brand : colors.border, backgroundColor: selected ? colors.secondary : 'transparent' },
                  ]}
                >
                  {selected ? <Check size={14} color={brand} /> : null}
                  <Text style={{ color: colors.text }}>{vaultLabel(t, vault)}</Text>
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
      ) : null}

      <Input
        label={t.form.title}
        value={values.title}
        onChangeText={(text) => set('title', text)}
        placeholder={t.form.titlePlaceholder}
        error={errors.title}
        testID="form-title"
      />

      {values.type === 'login' ? (
        <>
          <Input
            label={t.form.url}
            value={values.url}
            onChangeText={(text) => set('url', text)}
            placeholder={t.form.urlPlaceholder}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            testID="form-url"
          />
          <Input
            label={t.form.username}
            value={values.username}
            onChangeText={(text) => set('username', text)}
            autoCapitalize="none"
            autoCorrect={false}
            textContentType="username"
            autoComplete="off"
            testID="form-username"
          />
          <View style={styles.field}>
            <Input
              label={t.form.password}
              value={values.password}
              onChangeText={(text) => set('password', text)}
              secureTextEntry={!showPassword}
              autoCapitalize="none"
              autoCorrect={false}
              textContentType="none"
              autoComplete="off"
              testID="form-password"
              rightElement={
                <Pressable
                  onPress={() => setShowPassword((current) => !current)}
                  accessibilityRole="button"
                  accessibilityLabel={showPassword ? t.item.hide : t.item.show}
                  hitSlop={8}
                >
                  {showPassword ? <EyeOff size={18} color={colors.mutedForeground} /> : <Eye size={18} color={colors.mutedForeground} />}
                </Pressable>
              }
            />
            <StrengthMeter password={values.password} />
            <Button
              title={t.form.generate}
              variant="outline"
              size="sm"
              leftIcon={<WandSparkles size={14} color={colors.text} />}
              onPress={() => {
                set('password', generatePassword());
                setShowPassword(true);
              }}
              style={styles.generate}
              testID="form-generate"
            />
          </View>
          <Input
            label={t.form.totp}
            value={values.totp}
            onChangeText={(text) => set('totp', text)}
            helperText={t.form.totpHelp}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
          />
          <Input
            label={t.form.apps}
            value={appsText}
            onChangeText={setAppsText}
            helperText={errors.apps ? undefined : t.form.appsHelp}
            error={errors.apps}
            autoCapitalize="none"
            autoCorrect={false}
            multiline
            inputStyle={styles.multiline}
          />
        </>
      ) : null}

      {values.type === 'note' ? (
        <Input
          label={t.form.content}
          value={values.content}
          onChangeText={(text) => set('content', text)}
          multiline
          inputStyle={styles.note}
          testID="form-content"
        />
      ) : null}

      {values.type === 'card' ? (
        <>
          <Input label={t.form.cardholder} value={values.cardholder} onChangeText={(text) => set('cardholder', text)} autoComplete="off" />
          <Input
            label={t.form.number}
            value={values.number}
            onChangeText={(text) => set('number', text)}
            keyboardType="number-pad"
            autoComplete="off"
          />
          <View style={styles.row}>
            <Input
              label={t.form.expiry}
              value={values.expiry}
              onChangeText={(text) => set('expiry', text)}
              placeholder="08/29"
              containerStyle={styles.half}
              autoComplete="off"
            />
            <Input
              label={t.form.cvc}
              value={values.cvc}
              onChangeText={(text) => set('cvc', text)}
              keyboardType="number-pad"
              secureTextEntry
              containerStyle={styles.half}
              autoComplete="off"
            />
          </View>
        </>
      ) : null}

      {values.type !== 'note' ? (
        <Input
          label={t.form.notes}
          value={values.notes}
          onChangeText={(text) => set('notes', text)}
          multiline
          inputStyle={styles.multiline}
        />
      ) : null}

      <Button title={saving ? t.common.saving : t.common.save} onPress={submit} loading={saving} fullWidth testID="form-save" />
    </KeyboardAwareScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, gap: 16, paddingBottom: 48 },
  field: { gap: 8 },
  label: { fontSize: 14, fontWeight: '500' },
  chips: { gap: 8 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1, borderRadius: 18, paddingHorizontal: 12, paddingVertical: 7 },
  generate: { alignSelf: 'flex-start' },
  multiline: { minHeight: 80, textAlignVertical: 'top' },
  note: { minHeight: 200, textAlignVertical: 'top' },
  row: { flexDirection: 'row', gap: 12 },
  half: { flex: 1 },
});
