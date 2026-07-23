import { styles } from './add-account.styles';
import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  StyleSheet,
  View,
  Text,
  TouchableOpacity,
  TextInput,
  ScrollView,
  Alert,
} from 'react-native';
import MaterialSpinner from '@/components/MaterialSpinner';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  X,
  ChevronLeft,
  ChevronRight,
  Mail,
  Globe,
  CheckCircle2,
  AlertCircle,
  ChevronDown,
  Check,
} from 'lucide-react-native';
import Svg, { Path } from 'react-native-svg';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';
import appApi from '@/services/app-api';
import { createMailAccountSchema } from '@weldsuite/app-api-client/schemas/mail-accounts';
import { useMail } from '@/contexts/MailContext';
import { usePermissions } from '@/contexts/PermissionContext';

const ACCENT = '#f6663e';

// WeldMail logo
const WeldMailIcon = ({ size = 24 }: { size?: number }) => (
  <Svg width={size} height={size * (669.01 / 937.21)} viewBox="0 0 937.21 669.01">
    <Path
      d="M787.08,0H150.13C67.22,0,0,67.21,0,150.12v368.76c0,82.91,67.22,150.13,150.13,150.13h636.95c82.91,0,150.13-67.22,150.13-150.13V150.12C937.21,67.21,869.99,0,787.08,0ZM780.05,230.53l-180.95,138.23c-39.2,29.91-86.23,44.87-133.25,44.87s-93.98-14.96-133.19-44.87c-.11-.06-.17-.11-.28-.17l-175.45-136.42c-15.98-12.41-18.87-35.41-6.46-51.38,12.46-15.98,35.46-18.81,51.38-6.41l175.34,136.26c52.29,39.77,125.26,39.77,177.49-.06l180.95-138.23c16.04-12.3,39.04-9.18,51.27,6.85,12.3,16.09,9.24,39.03-6.85,51.33Z"
      fill="#f6663e"
    />
  </Svg>
);

type ScreenState = 'select' | 'weldmail' | 'custom-domain';

export default function AddAccountScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { showToast } = useToast();
  const { refreshLabels, refreshAccounts } = useMail();
  const { can, isLoading: permissionsLoading } = usePermissions();

  // Defense-in-depth: this route is reachable directly (deep link), so don't
  // rely on the hidden sidebar button alone. Bounce out once we know the user
  // lacks `accounts:create`. The server enforces it too — this is UX only.
  const canCreate = can('accounts:create');
  useEffect(() => {
    if (!permissionsLoading && !canCreate) {
      router.back();
    }
  }, [permissionsLoading, canCreate, router]);

  const [screen, setScreen] = useState<ScreenState>('select');
  const [focusedField, setFocusedField] = useState<string | null>(null);

  // Available custom domains
  const [availableDomains, setAvailableDomains] = useState<string[]>([]);
  const [loadingDomains, setLoadingDomains] = useState(true);

  // WeldMail form state
  const [address, setAddress] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [domain, setDomain] = useState('');
  const [loadingDomain, setLoadingDomain] = useState(false);
  const [checking, setChecking] = useState(false);
  const [availability, setAvailability] = useState<{ available: boolean; message?: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const checkTimerRef = useRef<NodeJS.Timeout>();

  // Custom domain form state
  const [selectedDomain, setSelectedDomain] = useState('');
  const [emailPrefix, setEmailPrefix] = useState('');
  const [customDisplayName, setCustomDisplayName] = useState('');
  const [showDomainPicker, setShowDomainPicker] = useState(false);

  // Fetch available domains on mount
  useEffect(() => {
    setLoadingDomains(true);
    appApi.mailDomains.list()
      .then(({ data }) => {
        const domains = data.map((d) => d.domainName).filter(Boolean);
        setAvailableDomains(domains);
        if (domains.length > 0) setSelectedDomain(domains[0]);
      })
      .catch(() => {})
      .finally(() => setLoadingDomains(false));
  }, []);

  // Fetch WeldMail domain when switching to form
  useEffect(() => {
    if (screen === 'weldmail' && !domain) {
      setLoadingDomain(true);
      appApi.mailWeldmail.domain()
        .then(({ data }) => {
          if (data?.domain) setDomain(data.domain);
        })
        .catch(() => {})
        .finally(() => setLoadingDomain(false));
    }
  }, [screen, domain]);

  // Debounced availability check
  useEffect(() => {
    if (screen !== 'weldmail') return;
    if (checkTimerRef.current) clearTimeout(checkTimerRef.current);
    setAvailability(null);

    if (address.length >= 3) {
      setChecking(true);
      checkTimerRef.current = setTimeout(() => {
        appApi.mailWeldmail.check({ address })
          .then(({ data }) => {
            if (data.available) {
              setAvailability({ available: true });
            } else {
              setAvailability({ available: false, message: (data as any).reason || 'Not available' });
            }
          })
          .catch(() => setAvailability(null))
          .finally(() => setChecking(false));
      }, 500);
    } else {
      setChecking(false);
    }

    return () => { if (checkTimerRef.current) clearTimeout(checkTimerRef.current); };
  }, [address, screen]);

  const handleWeldMailSubmit = useCallback(async () => {
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
      const { data: result } = await appApi.mailWeldmail.reserve({
        address,
        name: displayName || address,
        displayName: displayName || address,
      });
      showToast(`Email address ${result.email || address} created`, 'success');
      await refreshAccounts();
      refreshLabels();
      router.back();
    } catch {
      Alert.alert('Error', 'An unexpected error occurred');
    } finally {
      setSubmitting(false);
    }
  }, [address, displayName, availability, showToast, refreshAccounts, refreshLabels, router]);

  const handleCustomDomainSubmit = useCallback(async () => {
    if (!emailPrefix || !selectedDomain) {
      Alert.alert('Error', 'Please enter an email name and select a domain');
      return;
    }

    setSubmitting(true);
    try {
      const emailAddr = `${emailPrefix}@${selectedDomain}`;
      // parse() fills the schema's server-side defaults (provider, authType,
      // etc.) so the call is fully typed without an `as any` cast.
      await appApi.mailAccounts.create(
        createMailAccountSchema.parse({
          name: customDisplayName || emailPrefix,
          email: emailAddr,
          displayName: customDisplayName || emailPrefix,
        }),
      );
      showToast(`Email account ${emailAddr} created`, 'success');
      await refreshAccounts();
      refreshLabels();
      router.back();
    } catch {
      Alert.alert('Error', 'An unexpected error occurred');
    } finally {
      setSubmitting(false);
    }
  }, [emailPrefix, selectedDomain, customDisplayName, showToast, refreshAccounts, refreshLabels, router]);

  const handleBack = useCallback(() => {
    if (screen !== 'select') {
      setScreen('select');
      setAddress('');
      setDisplayName('');
      setEmailPrefix('');
      setCustomDisplayName('');
      setAvailability(null);
      setShowDomainPicker(false);
      setFocusedField(null);
    } else {
      router.back();
    }
  }, [screen, router]);

  // ---------- Selection ----------
  const renderProviderSelection = () => (
    <View style={styles.content}>
      <View style={styles.hero}>
        <View style={[styles.heroIcon, { backgroundColor: ACCENT + '15' }]}>
          <Mail size={26} color={ACCENT} strokeWidth={2} />
        </View>
        <Text style={[styles.heroTitle, { color: colors.text }]}>Add an email account</Text>
        <Text style={[styles.heroSubtitle, { color: colors.muted }]}>
          Create a new address to send and receive mail right inside WeldMail.
        </Text>
      </View>

      <View style={styles.cardList}>
        <TouchableOpacity
          style={[styles.optionCard, { backgroundColor: colors.card, borderColor: colors.divider }]}
          onPress={() => setScreen('weldmail')}
          activeOpacity={0.7}
        >
          <View style={[styles.optionIcon, { backgroundColor: ACCENT + '15' }]}>
            <WeldMailIcon size={24} />
          </View>
          <View style={styles.optionInfo}>
            <Text style={[styles.optionTitle, { color: colors.text }]}>WeldMail Address</Text>
            <Text style={[styles.optionSub, { color: colors.muted }]}>Get a free @weldmail.com address in seconds</Text>
          </View>
          <ChevronRight size={20} color={colors.muted} />
        </TouchableOpacity>

        {loadingDomains ? (
          <View style={[styles.optionCard, styles.optionCardLoading, { backgroundColor: colors.card, borderColor: colors.divider }]}>
            <MaterialSpinner size={20} strokeWidth={2.4} color={colors.muted} spinning />
            <Text style={[styles.optionSub, { color: colors.muted }]}>Checking your domains…</Text>
          </View>
        ) : availableDomains.length > 0 ? (
          <TouchableOpacity
            style={[styles.optionCard, { backgroundColor: colors.card, borderColor: colors.divider }]}
            onPress={() => setScreen('custom-domain')}
            activeOpacity={0.7}
          >
            <View style={[styles.optionIcon, { backgroundColor: '#3B82F6' + '15' }]}>
              <Globe size={22} color="#3B82F6" strokeWidth={2} />
            </View>
            <View style={styles.optionInfo}>
              <Text style={[styles.optionTitle, { color: colors.text }]}>Custom Domain Email</Text>
              <Text style={[styles.optionSub, { color: colors.muted }]}>Use your own domain · {availableDomains[0]}</Text>
            </View>
            <ChevronRight size={20} color={colors.muted} />
          </TouchableOpacity>
        ) : null}
      </View>

      <Text style={[styles.footerNote, { color: colors.muted }]}>
        You can add as many accounts as you like and switch between them anytime.
      </Text>
    </View>
  );

  // ---------- Live preview card ----------
  const renderPreview = (prefix: string, suffix: string, placeholder: string) => (
    <View style={[styles.previewCard, { backgroundColor: ACCENT + '0D', borderColor: ACCENT + '33' }]}>
      <Text style={[styles.previewLabel, { color: ACCENT }]}>YOUR NEW ADDRESS</Text>
      <Text style={[styles.previewEmail, { color: colors.text }]} numberOfLines={1} adjustsFontSizeToFit>
        {prefix || placeholder}
        <Text style={{ color: colors.muted }}>@{suffix}</Text>
      </Text>
    </View>
  );

  // ---------- WeldMail form ----------
  const renderWeldMailForm = () => (
    <View style={styles.content}>
      {renderPreview(address, domain || 'weldmail.com', 'yourname')}

      <View style={styles.fieldGroup}>
        <Text style={[styles.fieldLabel, { color: colors.text }]}>Choose your address</Text>
        <View
          style={[
            styles.fieldBox,
            { backgroundColor: colors.card, borderColor: focusedField === 'address' ? ACCENT : colors.divider },
          ]}
        >
          <TextInput
            style={[styles.fieldInput, { color: colors.text }]}
            placeholder="yourname"
            placeholderTextColor={colors.muted}
            value={address}
            onChangeText={v => setAddress(v.toLowerCase().replace(/[^a-z0-9._-]/g, ''))}
            onFocus={() => setFocusedField('address')}
            onBlur={() => setFocusedField(null)}
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
          />
          <View style={styles.suffixWrap}>
            {loadingDomain ? (
              <MaterialSpinner size={16} strokeWidth={2.2} color={colors.muted} spinning />
            ) : (
              <Text style={[styles.suffixText, { color: colors.muted }]}>@{domain || 'weldmail.com'}</Text>
            )}
          </View>
        </View>

        {address.length >= 3 && (
          <View style={styles.availabilityRow}>
            {checking ? (
              <View style={[styles.statusPill, { backgroundColor: colors.divider + '55' }]}>
                <MaterialSpinner size={13} strokeWidth={2.2} color={colors.muted} spinning />
                <Text style={[styles.statusText, { color: colors.muted }]}>Checking availability…</Text>
              </View>
            ) : availability ? (
              availability.available ? (
                <View style={[styles.statusPill, { backgroundColor: '#22C55E18' }]}>
                  <CheckCircle2 size={14} color="#16A34A" />
                  <Text style={[styles.statusText, { color: '#16A34A' }]}>Available</Text>
                </View>
              ) : (
                <View style={[styles.statusPill, { backgroundColor: '#EF444418' }]}>
                  <AlertCircle size={14} color="#DC2626" />
                  <Text style={[styles.statusText, { color: '#DC2626' }]}>{availability.message || 'Not available'}</Text>
                </View>
              )
            ) : null}
          </View>
        )}
      </View>

      <View style={styles.fieldGroup}>
        <Text style={[styles.fieldLabel, { color: colors.text }]}>Display name</Text>
        <View
          style={[
            styles.fieldBox,
            { backgroundColor: colors.card, borderColor: focusedField === 'displayName' ? ACCENT : colors.divider },
          ]}
        >
          <TextInput
            style={[styles.fieldInput, { color: colors.text }]}
            placeholder="Your Name"
            placeholderTextColor={colors.muted}
            value={displayName}
            onChangeText={setDisplayName}
            onFocus={() => setFocusedField('displayName')}
            onBlur={() => setFocusedField(null)}
          />
        </View>
        <Text style={[styles.hintText, { color: colors.muted }]}>How your name appears in sent emails.</Text>
      </View>
    </View>
  );

  // ---------- Custom domain form ----------
  const renderCustomDomainForm = () => (
    <View style={styles.content}>
      {renderPreview(emailPrefix, selectedDomain, 'yourname')}

      <View style={styles.fieldGroup}>
        <Text style={[styles.fieldLabel, { color: colors.text }]}>Domain</Text>
        <TouchableOpacity
          style={[
            styles.fieldBox,
            { backgroundColor: colors.card, borderColor: showDomainPicker ? ACCENT : colors.divider },
          ]}
          onPress={() => setShowDomainPicker(!showDomainPicker)}
          activeOpacity={0.7}
        >
          <Text style={[styles.fieldInput, { color: selectedDomain ? colors.text : colors.muted }]}>
            {selectedDomain || 'Choose a domain'}
          </Text>
          <ChevronDown size={18} color={colors.muted} />
        </TouchableOpacity>

        {showDomainPicker && (
          <View style={[styles.domainDropdown, { backgroundColor: colors.card, borderColor: colors.divider }]}>
            {availableDomains.map((d, i) => (
              <TouchableOpacity
                key={d}
                style={[
                  styles.domainOption,
                  i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.divider },
                  d === selectedDomain && { backgroundColor: ACCENT + '12' },
                ]}
                onPress={() => { setSelectedDomain(d); setShowDomainPicker(false); }}
              >
                <Text style={[styles.domainOptionText, { color: colors.text }]}>{d}</Text>
                {d === selectedDomain && <Check size={16} color={ACCENT} />}
              </TouchableOpacity>
            ))}
          </View>
        )}
      </View>

      <View style={styles.fieldGroup}>
        <Text style={[styles.fieldLabel, { color: colors.text }]}>Email name</Text>
        <View
          style={[
            styles.fieldBox,
            { backgroundColor: colors.card, borderColor: focusedField === 'prefix' ? ACCENT : colors.divider },
          ]}
        >
          <TextInput
            style={[styles.fieldInput, { color: colors.text }]}
            placeholder="yourname"
            placeholderTextColor={colors.muted}
            value={emailPrefix}
            onChangeText={v => setEmailPrefix(v.toLowerCase().replace(/[^a-z0-9._-]/g, ''))}
            onFocus={() => setFocusedField('prefix')}
            onBlur={() => setFocusedField(null)}
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
          />
          <View style={styles.suffixWrap}>
            <Text style={[styles.suffixText, { color: colors.muted }]}>@{selectedDomain}</Text>
          </View>
        </View>
      </View>

      <View style={styles.fieldGroup}>
        <Text style={[styles.fieldLabel, { color: colors.text }]}>Display name</Text>
        <View
          style={[
            styles.fieldBox,
            { backgroundColor: colors.card, borderColor: focusedField === 'customName' ? ACCENT : colors.divider },
          ]}
        >
          <TextInput
            style={[styles.fieldInput, { color: colors.text }]}
            placeholder="Your Name"
            placeholderTextColor={colors.muted}
            value={customDisplayName}
            onChangeText={setCustomDisplayName}
            onFocus={() => setFocusedField('customName')}
            onBlur={() => setFocusedField(null)}
          />
        </View>
        <Text style={[styles.hintText, { color: colors.muted }]}>How your name appears in sent emails.</Text>
      </View>
    </View>
  );

  const headerTitle = screen === 'select'
    ? 'Add account'
    : screen === 'weldmail'
    ? 'WeldMail address'
    : 'Custom domain';

  // Footer CTA config per form
  const cta = screen === 'weldmail'
    ? { label: 'Create address', onPress: handleWeldMailSubmit, disabled: !availability?.available || submitting }
    : screen === 'custom-domain'
    ? { label: 'Create email', onPress: handleCustomDomainSubmit, disabled: !emailPrefix || !selectedDomain || submitting }
    : null;

  // Render nothing while we're unsure or the user lacks permission — the
  // effect above redirects out, this just avoids flashing the form first.
  if (permissionsLoading || !canCreate) {
    return <View style={[styles.container, { backgroundColor: colors.background }]} />;
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={[styles.header, { borderBottomColor: colors.divider }]}>
        <TouchableOpacity onPress={handleBack} hitSlop={10} style={styles.headerButton}>
          {screen === 'select' ? (
            <X size={24} color={colors.text} />
          ) : (
            <ChevronLeft size={26} color={colors.text} strokeWidth={2} />
          )}
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.text }]}>{headerTitle}</Text>
        <View style={styles.headerButton} />
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={{ paddingBottom: 24 }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {screen === 'select' && renderProviderSelection()}
        {screen === 'weldmail' && renderWeldMailForm()}
        {screen === 'custom-domain' && renderCustomDomainForm()}
      </ScrollView>

      {/* Sticky CTA */}
      {cta && (
        <View style={[styles.footer, { paddingBottom: insets.bottom + 12, backgroundColor: colors.background, borderTopColor: colors.divider }]}>
          <TouchableOpacity
            style={[styles.submitButton, cta.disabled && styles.submitButtonDisabled]}
            onPress={cta.onPress}
            disabled={cta.disabled}
            activeOpacity={0.85}
          >
            {submitting ? (
              <MaterialSpinner size={18} strokeWidth={2.4} color="#FFFFFF" spinning />
            ) : (
              <Text style={styles.submitText}>{cta.label}</Text>
            )}
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}


