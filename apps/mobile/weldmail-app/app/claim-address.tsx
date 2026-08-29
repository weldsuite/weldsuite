/**
 * Personal WeldMail — claim a free @weldmail.com address (no workspace).
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Alert,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CheckCircle2, AlertCircle, LogOut } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useClerkAuth } from '@weldsuite/mobile-ui/contexts/ClerkAuthContext';
import MaterialSpinner from '@/components/MaterialSpinner';
import { personalApi } from '@/services/personal-api';
import { BRAND } from '@/lib/brand';

const ACCENT = BRAND;

export default function ClaimAddressScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { signOut } = useClerkAuth();

  const [domain, setDomain] = useState('weldmail.com');
  const [address, setAddress] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [focusedField, setFocusedField] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [availability, setAvailability] = useState<{
    available: boolean;
    message?: string;
  } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const checkTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    void personalApi.weldmail
      .domain()
      .then(({ data }) => {
        if (data?.domain) setDomain(data.domain);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (checkTimerRef.current) clearTimeout(checkTimerRef.current);
    setAvailability(null);

    if (address.length >= 3) {
      setChecking(true);
      checkTimerRef.current = setTimeout(() => {
        void personalApi.weldmail
          .check(address)
          .then(({ data }) => {
            if (data.available) {
              setAvailability({ available: true });
            } else {
              const reason = 'reason' in data ? data.reason : 'taken';
              setAvailability({
                available: false,
                message: reason === 'reserved' ? 'Reserved' : 'Already taken',
              });
            }
          })
          .catch(() => setAvailability(null))
          .finally(() => setChecking(false));
      }, 500);
    } else {
      setChecking(false);
    }

    return () => {
      if (checkTimerRef.current) clearTimeout(checkTimerRef.current);
    };
  }, [address]);

  const handleSubmit = useCallback(async () => {
    if (!address || address.length < 3) {
      Alert.alert('Error', 'Please enter an address with at least 3 characters');
      return;
    }
    if (!availability?.available) {
      Alert.alert('Error', 'This address is not available');
      return;
    }

    setSubmitting(true);
    try {
      const me = (await personalApi.me()).data;
      if (!me.account) {
        await personalApi.onboard({ displayName: displayName || undefined });
      }
      const { data: result } = await personalApi.weldmail.reserve({
        address,
        name: displayName || address,
        displayName: displayName || address,
      });
      Alert.alert('Welcome', `${result.email || `${address}@${domain}`} is yours`);
      router.replace('/');
    } catch (err) {
      Alert.alert('Error', err instanceof Error ? err.message : 'Could not claim address');
    } finally {
      setSubmitting(false);
    }
  }, [address, displayName, availability, domain, router]);

  return (
    <View
      style={[
        styles.container,
        {
          backgroundColor: colors.background,
          paddingTop: insets.top,
          paddingBottom: insets.bottom,
        },
      ]}
    >
      <View style={[styles.header, { borderBottomColor: colors.divider }]}>
        <Text style={[styles.headerTitle, { color: colors.text }]}>Claim address</Text>
        <TouchableOpacity
          style={styles.headerButton}
          onPress={() => signOut().catch(() => router.replace('/authorisation'))}
        >
          <LogOut size={20} color={colors.muted} />
        </TouchableOpacity>
      </View>

      <ScrollView style={styles.scroll} keyboardShouldPersistTaps="handled">
        <View style={styles.content}>
          <Text style={[styles.heroTitle, { color: colors.text }]}>Pick your @weldmail.com</Text>
          <Text style={[styles.heroSubtitle, { color: colors.muted }]}>
            One free personal address to get started — no workspace required.
          </Text>

          <View
            style={[
              styles.previewCard,
              { backgroundColor: ACCENT + '0D', borderColor: ACCENT + '33' },
            ]}
          >
            <Text style={[styles.previewLabel, { color: ACCENT }]}>YOUR ADDRESS</Text>
            <Text
              style={[styles.previewEmail, { color: colors.text }]}
              numberOfLines={1}
              adjustsFontSizeToFit
            >
              {address || 'yourname'}
              <Text style={{ color: colors.muted }}>@{domain}</Text>
            </Text>
          </View>

          <View style={styles.fieldGroup}>
            <Text style={[styles.fieldLabel, { color: colors.text }]}>Address</Text>
            <View
              style={[
                styles.fieldBox,
                {
                  backgroundColor: colors.card,
                  borderColor: focusedField === 'address' ? ACCENT : colors.divider,
                },
              ]}
            >
              <TextInput
                style={[styles.fieldInput, { color: colors.text }]}
                placeholder="yourname"
                placeholderTextColor={colors.muted}
                value={address}
                onChangeText={(v) => setAddress(v.toLowerCase().replace(/[^a-z0-9._-]/g, ''))}
                onFocus={() => setFocusedField('address')}
                onBlur={() => setFocusedField(null)}
                autoCapitalize="none"
                autoCorrect={false}
                autoFocus
              />
              <Text style={[styles.suffixText, { color: colors.muted }]}>@{domain}</Text>
            </View>
            {address.length >= 3 && (
              <View style={styles.availabilityRow}>
                {checking ? (
                  <MaterialSpinner size={16} strokeWidth={2.2} color={colors.muted} spinning />
                ) : availability?.available ? (
                  <>
                    <CheckCircle2 size={16} color="#16A34A" />
                    <Text style={{ color: '#16A34A', fontSize: 13 }}>Available</Text>
                  </>
                ) : availability ? (
                  <>
                    <AlertCircle size={16} color="#DC2626" />
                    <Text style={{ color: '#DC2626', fontSize: 13 }}>
                      {availability.message || 'Not available'}
                    </Text>
                  </>
                ) : null}
              </View>
            )}
          </View>

          <View style={styles.fieldGroup}>
            <Text style={[styles.fieldLabel, { color: colors.text }]}>Display name</Text>
            <View
              style={[
                styles.fieldBox,
                {
                  backgroundColor: colors.card,
                  borderColor: focusedField === 'name' ? ACCENT : colors.divider,
                },
              ]}
            >
              <TextInput
                style={[styles.fieldInput, { color: colors.text }]}
                placeholder="Your name"
                placeholderTextColor={colors.muted}
                value={displayName}
                onChangeText={setDisplayName}
                onFocus={() => setFocusedField('name')}
                onBlur={() => setFocusedField(null)}
              />
            </View>
          </View>

          <TouchableOpacity
            style={[
              styles.submit,
              {
                backgroundColor: ACCENT,
                opacity: submitting || !availability?.available ? 0.55 : 1,
              },
            ]}
            onPress={handleSubmit}
            disabled={submitting || !availability?.available}
          >
            {submitting ? (
              <MaterialSpinner size={20} strokeWidth={2.4} color="#fff" spinning />
            ) : (
              <Text style={styles.submitText}>Claim address</Text>
            )}
          </TouchableOpacity>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingTop: 14,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerButton: { width: 40, alignItems: 'center' },
  headerTitle: { flex: 1, fontSize: 17, fontWeight: '700', textAlign: 'center', marginLeft: 40 },
  scroll: { flex: 1 },
  content: { paddingHorizontal: 20, paddingTop: 24, gap: 18, paddingBottom: 40 },
  heroTitle: { fontSize: 22, fontWeight: '700', letterSpacing: -0.3 },
  heroSubtitle: { fontSize: 14, lineHeight: 20, marginTop: -8 },
  previewCard: {
    borderRadius: 16,
    borderWidth: 1,
    paddingVertical: 18,
    paddingHorizontal: 18,
    gap: 6,
  },
  previewLabel: { fontSize: 11, fontWeight: '700', letterSpacing: 0.6 },
  previewEmail: { fontSize: 22, fontWeight: '700', letterSpacing: -0.4 },
  fieldGroup: { gap: 8 },
  fieldLabel: { fontSize: 14, fontWeight: '600' },
  fieldBox: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 52,
    borderRadius: 14,
    borderWidth: 1.5,
    paddingHorizontal: 14,
  },
  fieldInput: { flex: 1, fontSize: 16, paddingVertical: 12 },
  suffixText: { fontSize: 15, fontWeight: '500', marginLeft: 6 },
  availabilityRow: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 20 },
  submit: {
    marginTop: 8,
    height: 52,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  submitText: { color: '#fff', fontSize: 16, fontWeight: '700' },
});
