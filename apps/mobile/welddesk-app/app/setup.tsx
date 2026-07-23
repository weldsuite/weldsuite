import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  ScrollView, KeyboardAvoidingView, Platform, ActivityIndicator,
  Animated, FlatList, Modal,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useOrganizationList } from '@clerk/expo';
import {
  ArrowLeft, Bell, BellOff, Check, ChevronDown, Inbox,
  Loader2, Shield, Database, Zap,
} from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useClerkAuth } from '@weldsuite/mobile-ui/contexts/ClerkAuthContext';
import storage from '@weldsuite/mobile-ui/utils/storage';
import api from '@/services/api';
import { useNotifications } from '@/contexts/NotificationContext';
import {
  type SetupMode, type SetupFormData, type ProfileData, type WorkspaceData,
  COUNTRIES, STEP_COUNT_NEW, STEP_COUNT_EXISTING,
  DEFAULT_FORM_DATA, STORAGE_KEYS, generateSlug,
} from '@/types/setup';

// ============================================================================
// Progress Dots
// ============================================================================

function ProgressDots({ current, total, colors }: { current: number; total: number; colors: any }) {
  return (
    <View style={progressStyles.container}>
      <View style={progressStyles.dotsRow}>
        {Array.from({ length: total }, (_, i) => (
          <View
            key={i}
            style={[
              progressStyles.dot,
              {
                backgroundColor: i + 1 <= current ? '#3B82F6' : colors.border,
                width: i + 1 === current ? 24 : 8,
              },
            ]}
          />
        ))}
      </View>
      <Text style={[progressStyles.counter, { color: colors.muted }]}>
        {current} of {total}
      </Text>
    </View>
  );
}

const progressStyles = StyleSheet.create({
  container: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 24, paddingVertical: 12 },
  dotsRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { height: 8, borderRadius: 4 },
  counter: { fontSize: 13 },
});

// ============================================================================
// Step Header
// ============================================================================

function StepHeader({ onBack, showBack, current, total, colors }: {
  onBack: () => void; showBack: boolean; current: number; total: number; colors: any;
}) {
  return (
    <View style={headerStyles.container}>
      <View style={headerStyles.backArea}>
        {showBack && (
          <TouchableOpacity onPress={onBack} hitSlop={10} style={headerStyles.backButton}>
            <ArrowLeft size={20} color={colors.text} />
            <Text style={[headerStyles.backText, { color: colors.text }]}>Back</Text>
          </TouchableOpacity>
        )}
      </View>
      <ProgressDots current={current} total={total} colors={colors} />
    </View>
  );
}

const headerStyles = StyleSheet.create({
  container: {},
  backArea: { height: 44, justifyContent: 'center', paddingHorizontal: 16 },
  backButton: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  backText: { fontSize: 15 },
});

// ============================================================================
// Profile Step
// ============================================================================

function ProfileStep({ data, onNext, isLoading, colors }: {
  data: ProfileData; onNext: (data: ProfileData) => void; isLoading: boolean; colors: any;
}) {
  const [firstName, setFirstName] = useState(data.firstName);
  const [lastName, setLastName] = useState(data.lastName);
  const [phone, setPhone] = useState(data.phone);
  const [jobTitle, setJobTitle] = useState(data.jobTitle);
  const [error, setError] = useState('');

  const handleNext = () => {
    if (!firstName.trim()) { setError('First name is required'); return; }
    if (!lastName.trim()) { setError('Last name is required'); return; }
    setError('');
    onNext({ firstName: firstName.trim(), lastName: lastName.trim(), phone: phone.trim(), jobTitle: jobTitle.trim() });
  };

  return (
    <ScrollView style={stepStyles.scroll} contentContainerStyle={stepStyles.scrollContent} keyboardShouldPersistTaps="handled">
      <Text style={[stepStyles.title, { color: colors.text }]}>Set up your profile</Text>
      <Text style={[stepStyles.subtitle, { color: colors.muted }]}>
        Tell us a bit about yourself so your team knows who you are.
      </Text>

      <Text style={[stepStyles.label, { color: colors.text }]}>First name</Text>
      <TextInput
        style={[stepStyles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.card }]}
        value={firstName}
        onChangeText={setFirstName}
        placeholder="Your first name"
        placeholderTextColor={colors.muted}
        autoCapitalize="words"
        autoFocus
      />

      <Text style={[stepStyles.label, { color: colors.text }]}>Last name</Text>
      <TextInput
        style={[stepStyles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.card }]}
        value={lastName}
        onChangeText={setLastName}
        placeholder="Your last name"
        placeholderTextColor={colors.muted}
        autoCapitalize="words"
      />

      <Text style={[stepStyles.label, { color: colors.text }]}>Phone number <Text style={{ color: colors.muted, fontWeight: '400' }}>(optional)</Text></Text>
      <TextInput
        style={[stepStyles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.card }]}
        value={phone}
        onChangeText={setPhone}
        placeholder="+1 234 567 8900"
        placeholderTextColor={colors.muted}
        keyboardType="phone-pad"
      />

      <Text style={[stepStyles.label, { color: colors.text }]}>Job title <Text style={{ color: colors.muted, fontWeight: '400' }}>(optional)</Text></Text>
      <TextInput
        style={[stepStyles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.card }]}
        value={jobTitle}
        onChangeText={setJobTitle}
        placeholder="e.g. Support Agent"
        placeholderTextColor={colors.muted}
        autoCapitalize="words"
      />

      {error ? <Text style={stepStyles.error}>{error}</Text> : null}

      <TouchableOpacity
        style={[stepStyles.primaryButton, isLoading && stepStyles.buttonDisabled]}
        onPress={handleNext}
        disabled={isLoading}
      >
        {isLoading ? <ActivityIndicator color="#fff" /> : <Text style={stepStyles.primaryButtonText}>Continue</Text>}
      </TouchableOpacity>
    </ScrollView>
  );
}

// ============================================================================
// Workspace Step
// ============================================================================

function WorkspaceStep({ data, onNext, isLoading, colors }: {
  data: WorkspaceData; onNext: (data: WorkspaceData) => void; isLoading: boolean; colors: any;
}) {
  const [name, setName] = useState(data.name);
  const [slug, setSlug] = useState(data.slug);
  const [country, setCountry] = useState(data.country);
  const [showCountryPicker, setShowCountryPicker] = useState(false);
  const [error, setError] = useState('');

  const handleNameChange = (val: string) => {
    setName(val);
    setSlug(generateSlug(val));
  };

  const handleNext = () => {
    if (!name.trim()) { setError('Workspace name is required'); return; }
    if (!country) { setError('Please select a country'); return; }
    setError('');
    onNext({ name: name.trim(), slug: slug || generateSlug(name.trim()), country });
  };

  const selectedCountry = COUNTRIES.find((c) => c.code === country);

  return (
    <ScrollView style={stepStyles.scroll} contentContainerStyle={stepStyles.scrollContent} keyboardShouldPersistTaps="handled">
      <Text style={[stepStyles.title, { color: colors.text }]}>Create your workspace</Text>
      <Text style={[stepStyles.subtitle, { color: colors.muted }]}>
        This is where your team will manage support tickets and customer conversations.
      </Text>

      <Text style={[stepStyles.label, { color: colors.text }]}>Workspace name</Text>
      <TextInput
        style={[stepStyles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.card }]}
        value={name}
        onChangeText={handleNameChange}
        placeholder="e.g. Acme Support"
        placeholderTextColor={colors.muted}
        autoFocus
      />

      {slug ? (
        <Text style={[stepStyles.slugPreview, { color: colors.muted }]}>
          weldsuite.org/{slug}
        </Text>
      ) : null}

      <Text style={[stepStyles.label, { color: colors.text }]}>Country</Text>
      <TouchableOpacity
        style={[stepStyles.input, stepStyles.selectButton, { borderColor: colors.border, backgroundColor: colors.card }]}
        onPress={() => setShowCountryPicker(true)}
      >
        <Text style={[stepStyles.selectText, { color: selectedCountry ? colors.text : colors.muted }]}>
          {selectedCountry ? selectedCountry.name : 'Select country'}
        </Text>
        <ChevronDown size={16} color={colors.muted} />
      </TouchableOpacity>

      <Modal visible={showCountryPicker} animationType="slide" presentationStyle="pageSheet">
        <View style={[stepStyles.modalContainer, { backgroundColor: colors.background }]}>
          <View style={[stepStyles.modalHeader, { borderBottomColor: colors.divider }]}>
            <Text style={[stepStyles.modalTitle, { color: colors.text }]}>Select Country</Text>
            <TouchableOpacity onPress={() => setShowCountryPicker(false)}>
              <Text style={{ color: '#3B82F6', fontSize: 16, fontWeight: '600' }}>Done</Text>
            </TouchableOpacity>
          </View>
          <FlatList
            data={COUNTRIES}
            keyExtractor={(item) => item.code}
            renderItem={({ item }) => (
              <TouchableOpacity
                style={[stepStyles.countryRow, { borderBottomColor: colors.divider }]}
                onPress={() => { setCountry(item.code); setShowCountryPicker(false); }}
              >
                <Text style={[stepStyles.countryText, { color: colors.text }]}>{item.name}</Text>
                {country === item.code && <Check size={18} color="#3B82F6" />}
              </TouchableOpacity>
            )}
          />
        </View>
      </Modal>

      {error ? <Text style={stepStyles.error}>{error}</Text> : null}

      <TouchableOpacity
        style={[stepStyles.primaryButton, isLoading && stepStyles.buttonDisabled]}
        onPress={handleNext}
        disabled={isLoading}
      >
        {isLoading ? <ActivityIndicator color="#fff" /> : <Text style={stepStyles.primaryButtonText}>Create Workspace</Text>}
      </TouchableOpacity>
    </ScrollView>
  );
}

// ============================================================================
// Provisioning Step
// ============================================================================

function ProvisioningStep({ onComplete, colors }: {
  onComplete: () => void; colors: any;
}) {
  const [currentPhase, setCurrentPhase] = useState(0);
  const [pollCount, setPollCount] = useState(0);
  const [failed, setFailed] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const phases = [
    { label: 'Creating your database', icon: Database },
    { label: 'Setting up security', icon: Shield },
    { label: 'Enabling features', icon: Zap },
  ];

  const poll = useCallback(async () => {
    try {
      const response = await api.getOnboardingDatabaseStatus();
      if (response.data?.provisioned && response.data?.migrated) {
        if (intervalRef.current) clearInterval(intervalRef.current);
        setCurrentPhase(3);

        // Finalize
        try {
          await api.finalizeOnboarding();
        } catch {
          // Non-critical — continue anyway
        }

        // Small delay for visual polish
        setTimeout(() => onComplete(), 800);
        return;
      }
    } catch {
      // Network error — keep polling
    }

    setPollCount((c) => {
      const next = c + 1;
      // Simulate phase progression based on poll count
      if (next >= 6) setCurrentPhase(2);
      else if (next >= 3) setCurrentPhase(1);

      if (next >= 90) {
        if (intervalRef.current) clearInterval(intervalRef.current);
        setFailed(true);
      }
      return next;
    });
  }, [onComplete]);

  useEffect(() => {
    intervalRef.current = setInterval(poll, 2000);
    poll(); // Initial poll
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [poll]);

  const handleRetry = () => {
    setFailed(false);
    setPollCount(0);
    setCurrentPhase(0);
    intervalRef.current = setInterval(poll, 2000);
    poll();
  };

  return (
    <View style={provisionStyles.container}>
      <Text style={[stepStyles.title, { color: colors.text, textAlign: 'center' }]}>
        Setting up your workspace
      </Text>
      <Text style={[stepStyles.subtitle, { color: colors.muted, textAlign: 'center', marginBottom: 40 }]}>
        This usually takes less than a minute.
      </Text>

      {phases.map((phase, index) => {
        const Icon = phase.icon;
        const isComplete = index < currentPhase;
        const isActive = index === currentPhase && !failed;

        return (
          <View key={index} style={provisionStyles.phaseRow}>
            <View style={[
              provisionStyles.iconCircle,
              {
                backgroundColor: isComplete ? '#10B981' : isActive ? '#3B82F6' : colors.border,
              },
            ]}>
              {isComplete ? (
                <Check size={16} color="#fff" />
              ) : isActive ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Icon size={16} color={colors.muted} />
              )}
            </View>
            <Text style={[
              provisionStyles.phaseLabel,
              { color: isComplete || isActive ? colors.text : colors.muted },
              isActive && { fontWeight: '600' },
            ]}>
              {phase.label}
            </Text>
          </View>
        );
      })}

      {failed && (
        <View style={provisionStyles.failedContainer}>
          <Text style={[provisionStyles.failedText, { color: colors.muted }]}>
            Taking longer than expected.
          </Text>
          <TouchableOpacity style={stepStyles.primaryButton} onPress={handleRetry}>
            <Text style={stepStyles.primaryButtonText}>Retry</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

const provisionStyles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', paddingHorizontal: 32 },
  phaseRow: { flexDirection: 'row', alignItems: 'center', gap: 16, marginBottom: 24 },
  iconCircle: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  phaseLabel: { fontSize: 16 },
  failedContainer: { marginTop: 32, alignItems: 'center', gap: 16 },
  failedText: { fontSize: 14, textAlign: 'center' },
});

// ============================================================================
// Notification Step
// ============================================================================

function NotificationStep({ onNext, colors }: {
  onNext: () => void; colors: any;
}) {
  const { requestPermissions, isPermissionGranted } = useNotifications();
  const [loading, setLoading] = useState(false);

  const handleEnable = async () => {
    setLoading(true);
    try {
      await requestPermissions();
    } catch {
      // Continue regardless
    }
    setLoading(false);
    onNext();
  };

  return (
    <View style={notifStyles.container}>
      <View style={notifStyles.iconContainer}>
        <Bell size={48} color="#3B82F6" />
      </View>

      <Text style={[stepStyles.title, { color: colors.text, textAlign: 'center' }]}>
        Never miss a ticket
      </Text>
      <Text style={[stepStyles.subtitle, { color: colors.muted, textAlign: 'center', marginBottom: 32 }]}>
        Get notified when customers need your help. Push notifications keep you in the loop even when the app is closed.
      </Text>

      <View style={notifStyles.benefitList}>
        <View style={notifStyles.benefitRow}>
          <Inbox size={18} color="#3B82F6" />
          <Text style={[notifStyles.benefitText, { color: colors.text }]}>New conversations assigned to you</Text>
        </View>
        <View style={notifStyles.benefitRow}>
          <Bell size={18} color="#3B82F6" />
          <Text style={[notifStyles.benefitText, { color: colors.text }]}>Customer replies to your tickets</Text>
        </View>
        <View style={notifStyles.benefitRow}>
          <Zap size={18} color="#3B82F6" />
          <Text style={[notifStyles.benefitText, { color: colors.text }]}>Urgent tickets that need attention</Text>
        </View>
      </View>

      <TouchableOpacity
        style={[stepStyles.primaryButton, loading && stepStyles.buttonDisabled]}
        onPress={handleEnable}
        disabled={loading}
      >
        {loading ? <ActivityIndicator color="#fff" /> : <Text style={stepStyles.primaryButtonText}>Enable Notifications</Text>}
      </TouchableOpacity>

      <TouchableOpacity style={notifStyles.skipButton} onPress={onNext}>
        <Text style={[notifStyles.skipText, { color: colors.muted }]}>Skip for now</Text>
      </TouchableOpacity>
    </View>
  );
}

const notifStyles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', paddingHorizontal: 32 },
  iconContainer: { alignItems: 'center', marginBottom: 24 },
  benefitList: { gap: 16, marginBottom: 32 },
  benefitRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  benefitText: { fontSize: 15, flex: 1 },
  skipButton: { alignItems: 'center', marginTop: 16, paddingVertical: 8 },
  skipText: { fontSize: 15 },
});

// ============================================================================
// Welcome Step
// ============================================================================

function WelcomeStep({ onFinish, isLoading, colors }: {
  onFinish: () => void; isLoading: boolean; colors: any;
}) {
  return (
    <View style={welcomeStyles.container}>
      <View style={welcomeStyles.iconContainer}>
        <View style={welcomeStyles.checkCircle}>
          <Check size={40} color="#fff" />
        </View>
      </View>

      <Text style={[stepStyles.title, { color: colors.text, textAlign: 'center' }]}>
        You're all set!
      </Text>
      <Text style={[stepStyles.subtitle, { color: colors.muted, textAlign: 'center', marginBottom: 32 }]}>
        Your helpdesk is ready to go. Start managing your customer conversations from anywhere.
      </Text>

      <View style={welcomeStyles.tipList}>
        <View style={welcomeStyles.tipRow}>
          <Text style={welcomeStyles.tipEmoji}>{'📥'}</Text>
          <Text style={[welcomeStyles.tipText, { color: colors.text }]}>Your inbox shows all conversations</Text>
        </View>
        <View style={welcomeStyles.tipRow}>
          <Text style={welcomeStyles.tipEmoji}>{'💬'}</Text>
          <Text style={[welcomeStyles.tipText, { color: colors.text }]}>Reply to customers in real-time</Text>
        </View>
        <View style={welcomeStyles.tipRow}>
          <Text style={welcomeStyles.tipEmoji}>{'👥'}</Text>
          <Text style={[welcomeStyles.tipText, { color: colors.text }]}>Look up contacts for quick info</Text>
        </View>
      </View>

      <TouchableOpacity
        style={[stepStyles.primaryButton, isLoading && stepStyles.buttonDisabled]}
        onPress={onFinish}
        disabled={isLoading}
      >
        {isLoading ? <ActivityIndicator color="#fff" /> : <Text style={stepStyles.primaryButtonText}>Go to Inbox</Text>}
      </TouchableOpacity>
    </View>
  );
}

const welcomeStyles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', paddingHorizontal: 32 },
  iconContainer: { alignItems: 'center', marginBottom: 24 },
  checkCircle: { width: 80, height: 80, borderRadius: 40, backgroundColor: '#10B981', alignItems: 'center', justifyContent: 'center' },
  tipList: { gap: 16, marginBottom: 32 },
  tipRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  tipEmoji: { fontSize: 20, width: 28, textAlign: 'center' },
  tipText: { fontSize: 15, flex: 1 },
});

// ============================================================================
// Main Setup Screen
// ============================================================================

export default function SetupScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ mode?: string }>();
  const { user } = useClerkAuth();
  const { setActive } = useOrganizationList();

  const mode: SetupMode = (params.mode === 'new' || params.mode === 'existing') ? params.mode : 'new';
  const totalSteps = mode === 'new' ? STEP_COUNT_NEW : STEP_COUNT_EXISTING;

  const [currentStep, setCurrentStep] = useState(1);
  const [formData, setFormData] = useState<SetupFormData>(DEFAULT_FORM_DATA);
  const [isLoading, setIsLoading] = useState(false);
  const [initialized, setInitialized] = useState(false);

  // Load saved state from storage
  useEffect(() => {
    const loadState = async () => {
      try {
        const [savedStep, savedData] = await Promise.all([
          storage.getItem(STORAGE_KEYS.currentStep),
          storage.getItem(STORAGE_KEYS.formData),
        ]);

        if (savedStep) {
          const step = parseInt(savedStep, 10);
          if (step >= 1 && step <= totalSteps) setCurrentStep(step);
        }

        if (savedData) {
          try {
            const parsed = JSON.parse(savedData);
            setFormData((prev) => ({ ...prev, ...parsed }));
          } catch {
            // Ignore parse errors
          }
        }
      } catch {
        // Storage read failed — start fresh
      }

      // Pre-fill from Clerk user
      if (user) {
        setFormData((prev) => ({
          ...prev,
          profile: {
            ...prev.profile,
            firstName: prev.profile.firstName || (user as any).firstName || '',
            lastName: prev.profile.lastName || (user as any).lastName || '',
          },
        }));
      }

      setInitialized(true);
    };

    loadState();
  }, []);

  // Persist state changes
  useEffect(() => {
    if (!initialized) return;
    storage.setItem(STORAGE_KEYS.currentStep, String(currentStep));
    storage.setItem(STORAGE_KEYS.formData, JSON.stringify(formData));
  }, [currentStep, formData, initialized]);

  const goToStep = (step: number) => {
    setCurrentStep(step);
  };

  // For "existing" mode, map steps: 1 = notification, 2 = welcome
  const getStepComponent = () => {
    if (mode === 'existing') {
      switch (currentStep) {
        case 1: return <NotificationStep onNext={() => goToStep(2)} colors={colors} />;
        case 2: return <WelcomeStep onFinish={handleFinish} isLoading={isLoading} colors={colors} />;
        default: return null;
      }
    }

    // "new" mode: 1=profile, 2=workspace, 3=provisioning, 4=notifications, 5=welcome
    switch (currentStep) {
      case 1:
        return <ProfileStep data={formData.profile} onNext={handleProfileNext} isLoading={isLoading} colors={colors} />;
      case 2:
        return <WorkspaceStep data={formData.workspace} onNext={handleWorkspaceNext} isLoading={isLoading} colors={colors} />;
      case 3:
        return <ProvisioningStep onComplete={() => goToStep(4)} colors={colors} />;
      case 4:
        return <NotificationStep onNext={() => goToStep(5)} colors={colors} />;
      case 5:
        return <WelcomeStep onFinish={handleFinish} isLoading={isLoading} colors={colors} />;
      default:
        return null;
    }
  };

  const canGoBack = () => {
    if (mode === 'existing') return false;
    // Can go back on step 2 only (not on profile, provisioning, notifications, or welcome)
    return currentStep === 2;
  };

  const handleProfileNext = async (profileData: ProfileData) => {
    setIsLoading(true);
    try {
      await api.saveProfile(profileData);
    } catch {
      // Profile save is not critical — continue regardless
    }
    setFormData((prev) => ({ ...prev, profile: profileData }));
    setIsLoading(false);
    goToStep(2);
  };

  const [globalError, setGlobalError] = useState('');

  const handleWorkspaceNext = async (workspaceData: WorkspaceData) => {
    setIsLoading(true);
    setGlobalError('');
    try {
      const response = await api.createWorkspace({
        name: workspaceData.name,
        country: workspaceData.country,
      });

      if (!response.success || !response.data?.organizationId) {
        const msg = (response as any).error?.message || 'Failed to create workspace. Please try again.';
        setGlobalError(msg);
        setIsLoading(false);
        return;
      }

      // Set the new org as active in Clerk
      if (setActive) {
        await setActive({ organization: response.data.organizationId });
      }

      // Update API service with new org
      api.setOrganizationId(response.data.organizationId);

      setFormData((prev) => ({ ...prev, workspace: workspaceData }));
      goToStep(3); // Provisioning
    } catch (err) {
      setGlobalError(err instanceof Error ? err.message : 'An unexpected error occurred');
    }
    setIsLoading(false);
  };

  const handleFinish = async () => {
    setIsLoading(true);
    try {
      // Mark onboarding complete
      if (mode === 'new') {
        await api.completeOnboarding({
          firstName: formData.profile.firstName,
          lastName: formData.profile.lastName,
          organizationName: formData.workspace.name,
          country: formData.workspace.country,
        });
      }

      // Clear setup state and set completed flag
      await Promise.all([
        storage.setItem(STORAGE_KEYS.completed, 'true'),
        storage.removeItem(STORAGE_KEYS.formData),
        storage.removeItem(STORAGE_KEYS.currentStep),
        storage.removeItem(STORAGE_KEYS.mode),
      ]);

      router.replace('/(tabs)');
    } catch {
      // Still navigate — don't block the user
      await storage.setItem(STORAGE_KEYS.completed, 'true');
      router.replace('/(tabs)');
    }
    setIsLoading(false);
  };

  if (!initialized) {
    return (
      <View style={[screenStyles.loadingContainer, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color="#3B82F6" />
      </View>
    );
  }

  // Provisioning step is fullscreen with no header interaction
  const isProvisioningStep = mode === 'new' && currentStep === 3;

  return (
    <KeyboardAvoidingView
      style={[screenStyles.container, { backgroundColor: colors.background }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={{ paddingTop: insets.top }}>
        {!isProvisioningStep && (
          <StepHeader
            onBack={() => goToStep(currentStep - 1)}
            showBack={canGoBack()}
            current={currentStep}
            total={totalSteps}
            colors={colors}
          />
        )}
      </View>

      {globalError ? (
        <View style={screenStyles.errorBanner}>
          <Text style={screenStyles.errorText}>{globalError}</Text>
        </View>
      ) : null}

      <View style={screenStyles.content}>
        {getStepComponent()}
      </View>

      <View style={{ paddingBottom: insets.bottom }} />
    </KeyboardAvoidingView>
  );
}

// ============================================================================
// Shared Step Styles
// ============================================================================

const stepStyles = StyleSheet.create({
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 24, paddingTop: 8, paddingBottom: 40 },
  title: { fontSize: 28, fontWeight: '700', marginBottom: 8 },
  subtitle: { fontSize: 16, lineHeight: 22, marginBottom: 24 },
  label: { fontSize: 14, fontWeight: '600', marginBottom: 6, marginTop: 16 },
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15 },
  selectButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  selectText: { fontSize: 15 },
  slugPreview: { fontSize: 13, marginTop: 4, marginLeft: 2 },
  error: { color: '#EF4444', fontSize: 14, marginTop: 12, textAlign: 'center' },
  primaryButton: { backgroundColor: '#3B82F6', borderRadius: 12, paddingVertical: 14, alignItems: 'center', marginTop: 24 },
  primaryButtonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  buttonDisabled: { opacity: 0.6 },
  modalContainer: { flex: 1 },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 0.5 },
  modalTitle: { fontSize: 17, fontWeight: '600' },
  countryRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 0.5 },
  countryText: { fontSize: 16 },
});

const screenStyles = StyleSheet.create({
  container: { flex: 1 },
  content: { flex: 1 },
  loadingContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  errorBanner: { backgroundColor: '#FEF2F2', borderColor: '#FECACA', borderWidth: 1, marginHorizontal: 16, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10 },
  errorText: { color: '#DC2626', fontSize: 14, textAlign: 'center' },
});
