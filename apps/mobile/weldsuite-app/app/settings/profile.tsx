import React, { useState, useEffect } from 'react';
import {
  StyleSheet,
  ScrollView,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/contexts/ThemeContext';
import { useToast } from '@/contexts/ToastContext';
import { useClerkAuth } from '@/contexts/ClerkAuthContext';
import api from '@/services/api';
import { useI18n } from '@weldsuite/i18n/provider';
import {
  languageNames,
  stableLanguages,
  type Language,
} from '@weldsuite/i18n/locales';

interface ProfileData {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
}

export default function ProfileScreen() {
  const { colors } = useTheme();
  const { showToast } = useToast();
  const { user } = useClerkAuth();
  const { language, setLanguage } = useI18n();
  const [profile, setProfile] = useState<ProfileData>({
    firstName: '',
    lastName: '',
    email: '',
    phone: '',
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);
  const [errors, setErrors] = useState<Partial<ProfileData>>({});

  useEffect(() => {
    loadProfile();
  }, [user]);

  const loadProfile = async () => {
    try {
      // Initialize from user token data
      if (user) {
        setProfile({
          firstName: user.firstName || '',
          lastName: user.lastName || '',
          email: user.email || '',
          phone: '',
        });
      }

      // Try to fetch additional profile data from API
      try {
        const response = await api.getProfile();
        if (response.success && response.data) {
          setProfile((prev) => ({
            ...prev,
            firstName: response.data.firstName || prev.firstName,
            lastName: response.data.lastName || prev.lastName,
            phone: response.data.phone || '',
          }));
        }
      } catch (apiError) {
        // API might not be available, use token data
      }
    } catch (error) {
      console.error('Error loading profile:', error);
      showToast('Failed to load profile', 'error');
    } finally {
      setLoading(false);
    }
  };

  const validateProfile = (): boolean => {
    const newErrors: Partial<ProfileData> = {};

    if (!profile.firstName.trim()) {
      newErrors.firstName = 'First name is required';
    }

    if (!profile.lastName.trim()) {
      newErrors.lastName = 'Last name is required';
    }

    if (profile.phone && !/^[+]?[\d\s-()]+$/.test(profile.phone)) {
      newErrors.phone = 'Invalid phone number format';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleChange = (field: keyof ProfileData, value: string) => {
    setProfile((prev) => ({ ...prev, [field]: value }));
    setHasChanges(true);
    // Clear error when user starts typing
    if (errors[field]) {
      setErrors((prev) => ({ ...prev, [field]: undefined }));
    }
  };

  const handleSave = async () => {
    if (!validateProfile()) {
      showToast('Please fix the errors before saving', 'error');
      return;
    }

    setSaving(true);
    try {
      const response = await api.updateProfile({
        firstName: profile.firstName,
        lastName: profile.lastName,
        phone: profile.phone,
      });

      if (response.success) {
        showToast('Profile updated successfully', 'success');
        setHasChanges(false);
      } else {
        showToast(response.error || 'Failed to update profile', 'error');
      }
    } catch (error) {
      console.error('Error updating profile:', error);
      showToast('Failed to update profile', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleChangePassword = () => {
    Alert.alert(
      'Change Password',
      'Password changes must be done through the authentication portal. Would you like to receive a password reset email?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Send Email',
          onPress: async () => {
            try {
              const response = await api.requestPasswordReset(profile.email);
              if (response.success) {
                showToast('Password reset email sent', 'success');
              } else {
                showToast('Failed to send reset email', 'error');
              }
            } catch (error) {
              showToast('Failed to send reset email', 'error');
            }
          },
        },
      ]
    );
  };

  if (loading) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} edges={['bottom']}>
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={colors.text} />
          <Text style={[styles.loadingText, { color: colors.muted }]}>Loading profile...</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} edges={['bottom']}>
      <ScrollView showsVerticalScrollIndicator={false}>
        {/* Avatar Section */}
        <View style={styles.avatarSection}>
          <View style={[styles.avatar, { backgroundColor: colors.divider }]}>
            <Text style={[styles.avatarText, { color: colors.text }]}>
              {profile.firstName.charAt(0).toUpperCase()}
              {profile.lastName.charAt(0).toUpperCase()}
            </Text>
          </View>
          <Text style={[styles.avatarName, { color: colors.text }]}>
            {profile.firstName} {profile.lastName}
          </Text>
          <Text style={[styles.avatarEmail, { color: colors.muted }]}>{profile.email}</Text>
        </View>

        {/* Personal Information */}
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>Personal Information</Text>

          <View style={styles.inputGroup}>
            <Text style={[styles.inputLabel, { color: colors.muted }]}>First Name</Text>
            <TextInput
              style={[
                styles.input,
                { color: colors.text, borderColor: errors.firstName ? '#F44336' : colors.divider },
              ]}
              value={profile.firstName}
              onChangeText={(value) => handleChange('firstName', value)}
              placeholder="Enter first name"
              placeholderTextColor={colors.muted}
              autoCapitalize="words"
            />
            {errors.firstName && (
              <Text style={styles.errorText}>{errors.firstName}</Text>
            )}
          </View>

          <View style={styles.inputGroup}>
            <Text style={[styles.inputLabel, { color: colors.muted }]}>Last Name</Text>
            <TextInput
              style={[
                styles.input,
                { color: colors.text, borderColor: errors.lastName ? '#F44336' : colors.divider },
              ]}
              value={profile.lastName}
              onChangeText={(value) => handleChange('lastName', value)}
              placeholder="Enter last name"
              placeholderTextColor={colors.muted}
              autoCapitalize="words"
            />
            {errors.lastName && (
              <Text style={styles.errorText}>{errors.lastName}</Text>
            )}
          </View>

          <View style={styles.inputGroup}>
            <Text style={[styles.inputLabel, { color: colors.muted }]}>Email</Text>
            <TextInput
              style={[
                styles.input,
                styles.inputDisabled,
                { color: colors.muted, borderColor: colors.divider },
              ]}
              value={profile.email}
              editable={false}
              placeholder="Email address"
              placeholderTextColor={colors.muted}
            />
            <Text style={[styles.inputHint, { color: colors.muted }]}>
              Email cannot be changed
            </Text>
          </View>

          <View style={styles.inputGroup}>
            <Text style={[styles.inputLabel, { color: colors.muted }]}>Phone</Text>
            <TextInput
              style={[
                styles.input,
                { color: colors.text, borderColor: errors.phone ? '#F44336' : colors.divider },
              ]}
              value={profile.phone}
              onChangeText={(value) => handleChange('phone', value)}
              placeholder="Enter phone number"
              placeholderTextColor={colors.muted}
              keyboardType="phone-pad"
            />
            {errors.phone && (
              <Text style={styles.errorText}>{errors.phone}</Text>
            )}
          </View>
        </View>

        {/* Security */}
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>Security</Text>

          <TouchableOpacity
            style={[styles.settingItem, { borderBottomColor: colors.divider }]}
            onPress={handleChangePassword}
          >
            <View style={styles.settingContent}>
              <Ionicons name="lock-closed-outline" size={20} color={colors.text} />
              <Text style={[styles.settingLabel, { color: colors.text }]}>Change Password</Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={colors.muted} />
          </TouchableOpacity>
        </View>

        {/* Language picker */}
        <View style={styles.languageSection}>
          <Text style={[styles.languageLabel, { color: colors.muted }]}>Language</Text>
          <View style={styles.languageRow}>
            {stableLanguages.map((code) => {
              const isActive = code === language;
              return (
                <TouchableOpacity
                  key={code}
                  onPress={() => setLanguage(code as Language)}
                  style={[
                    styles.languageChip,
                    {
                      backgroundColor: isActive ? colors.text : 'transparent',
                      borderColor: isActive ? colors.text : colors.muted,
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.languageChipText,
                      { color: isActive ? colors.background : colors.text },
                    ]}
                  >
                    {languageNames[code]}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        {/* Save Button */}
        {hasChanges && (
          <View style={styles.saveContainer}>
            <TouchableOpacity
              style={[styles.saveButton, { backgroundColor: colors.text }]}
              onPress={handleSave}
              disabled={saving}
            >
              {saving ? (
                <ActivityIndicator size="small" color={colors.background} />
              ) : (
                <Text style={[styles.saveButtonText, { color: colors.background }]}>Save Changes</Text>
              )}
            </TouchableOpacity>
          </View>
        )}

        {/* Bottom spacing */}
        <View style={{ height: 40 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 12,
  },
  loadingText: {
    fontSize: 14,
  },
  avatarSection: {
    alignItems: 'center',
    paddingVertical: 32,
  },
  avatar: {
    width: 80,
    height: 80,
    borderRadius: 40,
    justifyContent: 'center',
    alignItems: 'center',
  },
  avatarText: {
    fontSize: 28,
    fontWeight: '600',
  },
  avatarName: {
    fontSize: 20,
    fontWeight: '600',
    marginTop: 12,
  },
  avatarEmail: {
    fontSize: 14,
    marginTop: 4,
  },
  section: {
    marginTop: 8,
    paddingHorizontal: 16,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 16,
    letterSpacing: 0.3,
    textTransform: 'uppercase',
  },
  inputGroup: {
    marginBottom: 20,
  },
  inputLabel: {
    fontSize: 12,
    marginBottom: 6,
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  input: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
  },
  inputDisabled: {
    opacity: 0.6,
  },
  inputHint: {
    fontSize: 11,
    marginTop: 4,
  },
  errorText: {
    fontSize: 12,
    color: '#F44336',
    marginTop: 4,
  },
  settingItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 14,
    borderBottomWidth: 0.5,
  },
  settingContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  settingLabel: {
    fontSize: 15,
    fontWeight: '400',
  },
  saveContainer: {
    paddingHorizontal: 16,
    paddingTop: 24,
  },
  saveButton: {
    paddingVertical: 14,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  saveButtonText: {
    fontSize: 15,
    fontWeight: '600',
  },
  languageSection: {
    paddingHorizontal: 16,
    paddingTop: 24,
  },
  languageLabel: {
    fontSize: 12,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginBottom: 12,
  },
  languageRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  languageChip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 16,
    borderWidth: 1,
  },
  languageChipText: {
    fontSize: 13,
    fontWeight: '500',
  },
});
