import React, { useState, useEffect } from 'react';
import {
  StyleSheet,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Switch,
} from 'react-native';
import {
  Globe,
  Server,
  CheckCircle,
  AlertCircle,
  Copy,
  Check,
  Info,
  ExternalLink,
} from 'lucide-react-native';
import { useTheme } from '@/contexts/ThemeContext';
import { useShouldShowMiniSidebar } from '@/components/layout/MiniSidebar';
import { useCollapsibleHeader } from '@/contexts/CollapsibleHeaderContext';
import { useToast } from '@/contexts/ToastContext';

const WELDHOST_NAMESERVERS = [
  'ns1.weldhost.com',
  'ns2.weldhost.com',
  'ns3.weldhost.com',
  'ns4.weldhost.com',
];

export default function ExternalDomainScreen() {
  const { colors } = useTheme();
  const showMiniSidebar = useShouldShowMiniSidebar();
  const { resetHeader } = useCollapsibleHeader();
  const toast = useToast();

  const [domainName, setDomainName] = useState('');
  const [registrar, setRegistrar] = useState('');
  const [confirmNameservers, setConfirmNameservers] = useState(false);
  const [isPending, setIsPending] = useState(false);
  const [copiedNS, setCopiedNS] = useState<string | null>(null);

  // Reset header when tab becomes active
  useEffect(() => {
    resetHeader();
  }, [resetHeader]);

  const handleCopyNameserver = (ns: string) => {
    setCopiedNS(ns);
    toast.info(ns);
    setTimeout(() => setCopiedNS(null), 2000);
  };

  const handleCopyAll = () => {
    toast.info(WELDHOST_NAMESERVERS.join('\n'));
  };

  const handleSubmit = async () => {
    if (!domainName.trim()) {
      toast.error('Please enter a domain name');
      return;
    }

    if (!confirmNameservers) {
      toast.error('Please confirm you have updated your nameservers');
      return;
    }

    setIsPending(true);

    try {
      // Simulate API call
      await new Promise(resolve => setTimeout(resolve, 1500));

      toast.success(`${domainName} has been added!`);
      setDomainName('');
      setRegistrar('');
      setConfirmNameservers(false);
    } catch (error) {
      toast.error('Failed to add external domain');
    } finally {
      setIsPending(false);
    }
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      style={[styles.container, { backgroundColor: colors.background }]}
    >
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {/* Header */}
        <View style={styles.header}>
          <Text style={[styles.title, { color: colors.text }]}>Add External Domain</Text>
          <Text style={[styles.subtitle, { color: colors.muted }]}>
            Connect a domain registered with another provider to manage it through WeldHost
          </Text>
        </View>

        {/* Domain Information Section */}
        <View style={[styles.section, { backgroundColor: colors.background, borderColor: colors.divider }]}>
          <View style={styles.sectionHeader}>
            <Globe size={18} color={colors.text} strokeWidth={2} />
            <Text style={[styles.sectionTitle, { color: colors.text }]}>Domain Information</Text>
          </View>

          <View style={styles.inputGroup}>
            <Text style={[styles.label, { color: colors.text }]}>Domain Name *</Text>
            <View style={[styles.inputContainer, { borderColor: colors.buttonBorder }]}>
              <Globe size={18} color={colors.muted} strokeWidth={2} />
              <TextInput
                style={[styles.input, { color: colors.text }]}
                placeholder="example.com"
                placeholderTextColor={colors.muted}
                value={domainName}
                onChangeText={setDomainName}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
              />
            </View>
          </View>

          <View style={styles.inputGroup}>
            <Text style={[styles.label, { color: colors.text }]}>Current Registrar (Optional)</Text>
            <View style={[styles.inputContainer, { borderColor: colors.buttonBorder }]}>
              <TextInput
                style={[styles.input, { color: colors.text }]}
                placeholder="e.g., GoDaddy, Namecheap, Cloudflare"
                placeholderTextColor={colors.muted}
                value={registrar}
                onChangeText={setRegistrar}
              />
            </View>
          </View>
        </View>

        {/* Nameserver Setup Section */}
        <View style={[styles.section, { backgroundColor: colors.background, borderColor: colors.divider }]}>
          <View style={styles.sectionHeader}>
            <Server size={18} color={colors.text} strokeWidth={2} />
            <Text style={[styles.sectionTitle, { color: colors.text }]}>Nameserver Setup</Text>
          </View>

          {/* Info Alert */}
          <View style={[styles.alert, { backgroundColor: '#EFF6FF', borderColor: '#BFDBFE' }]}>
            <Info size={16} color="#3B82F6" strokeWidth={2} />
            <View style={styles.alertContent}>
              <Text style={[styles.alertTitle, { color: '#1E40AF' }]}>WeldHost Nameservers</Text>
              <Text style={[styles.alertText, { color: '#1E40AF' }]}>
                Copy and update these nameservers at your current registrar before adding the domain.
              </Text>
            </View>
          </View>

          {/* Nameservers List */}
          <View style={styles.nameserversList}>
            {WELDHOST_NAMESERVERS.map((ns, index) => (
              <View
                key={ns}
                style={[styles.nameserverItem, { backgroundColor: '#F9FAFB', borderColor: colors.divider }]}
              >
                <View style={styles.nameserverInfo}>
                  <Text style={[styles.nameserverLabel, { color: colors.muted }]}>NS{index + 1}</Text>
                  <Text style={[styles.nameserverValue, { color: colors.text }]}>{ns}</Text>
                </View>
                <TouchableOpacity
                  style={styles.copyButton}
                  onPress={() => handleCopyNameserver(ns)}
                >
                  {copiedNS === ns ? (
                    <Check size={18} color="#16A34A" strokeWidth={2} />
                  ) : (
                    <Copy size={18} color={colors.muted} strokeWidth={2} />
                  )}
                </TouchableOpacity>
              </View>
            ))}
          </View>

          <TouchableOpacity
            style={[styles.copyAllButton, { borderColor: colors.buttonBorder }]}
            onPress={handleCopyAll}
          >
            <Copy size={16} color={colors.text} strokeWidth={2} />
            <Text style={[styles.copyAllText, { color: colors.text }]}>Copy All Nameservers</Text>
          </TouchableOpacity>

          {/* Warning Alert */}
          <View style={[styles.alert, { backgroundColor: '#FEF3C7', borderColor: '#FDE68A' }]}>
            <AlertCircle size={16} color="#D97706" strokeWidth={2} />
            <View style={styles.alertContent}>
              <Text style={[styles.alertTitle, { color: '#92400E' }]}>DNS Propagation</Text>
              <Text style={[styles.alertText, { color: '#92400E' }]}>
                After updating nameservers, DNS propagation can take up to 48 hours.
              </Text>
            </View>
          </View>
        </View>

        {/* Confirmation Section */}
        <View style={[styles.section, { backgroundColor: colors.background, borderColor: colors.divider }]}>
          <View style={styles.sectionHeader}>
            <CheckCircle size={18} color={colors.text} strokeWidth={2} />
            <Text style={[styles.sectionTitle, { color: colors.text }]}>Confirmation</Text>
          </View>

          <TouchableOpacity
            style={[styles.confirmationBox, { borderColor: confirmNameservers ? '#3B82F6' : colors.buttonBorder }]}
            onPress={() => setConfirmNameservers(!confirmNameservers)}
            activeOpacity={0.7}
          >
            <View style={[
              styles.checkbox,
              {
                backgroundColor: confirmNameservers ? '#3B82F6' : 'transparent',
                borderColor: confirmNameservers ? '#3B82F6' : colors.buttonBorder,
              }
            ]}>
              {confirmNameservers && <Check size={14} color="#FFFFFF" strokeWidth={3} />}
            </View>
            <View style={styles.confirmationContent}>
              <Text style={[styles.confirmationTitle, { color: colors.text }]}>
                I have updated my nameservers
              </Text>
              <Text style={[styles.confirmationText, { color: colors.muted }]}>
                Confirm that you have updated your domain's nameservers at your registrar to point to WeldHost
              </Text>
            </View>
          </TouchableOpacity>

          {/* Checklist Alert */}
          <View style={[styles.alert, { backgroundColor: '#FEF3C7', borderColor: '#FDE68A' }]}>
            <AlertCircle size={16} color="#D97706" strokeWidth={2} />
            <View style={styles.alertContent}>
              <Text style={[styles.alertTitle, { color: '#92400E' }]}>Before Adding Your Domain</Text>
              <View style={styles.checklist}>
                <Text style={[styles.checklistItem, { color: '#92400E' }]}>
                  • Update nameservers at your current registrar first
                </Text>
                <Text style={[styles.checklistItem, { color: '#92400E' }]}>
                  • Keep your domain registration active at the original registrar
                </Text>
                <Text style={[styles.checklistItem, { color: '#92400E' }]}>
                  • DNS changes may take up to 48 hours to propagate
                </Text>
              </View>
            </View>
          </View>
        </View>

        {/* Submit Button */}
        <TouchableOpacity
          style={[
            styles.submitButton,
            {
              backgroundColor: domainName.trim() && confirmNameservers ? '#1F2937' : '#E5E7EB',
            }
          ]}
          onPress={handleSubmit}
          disabled={isPending || !domainName.trim() || !confirmNameservers}
        >
          {isPending ? (
            <ActivityIndicator size="small" color="#FFFFFF" />
          ) : (
            <>
              <ExternalLink size={18} color={domainName.trim() && confirmNameservers ? '#FFFFFF' : '#9CA3AF'} strokeWidth={2} />
              <Text style={[
                styles.submitButtonText,
                { color: domainName.trim() && confirmNameservers ? '#FFFFFF' : '#9CA3AF' }
              ]}>
                Add External Domain
              </Text>
            </>
          )}
        </TouchableOpacity>

        {/* Info Footer */}
        <View style={styles.footer}>
          <Info size={14} color={colors.muted} strokeWidth={2} />
          <Text style={[styles.footerText, { color: colors.muted }]}>
            Your domain will remain registered with your current registrar. WeldHost will only manage DNS and hosting.
          </Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    padding: 16,
    paddingBottom: 40,
  },
  header: {
    marginBottom: 24,
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    letterSpacing: -0.3,
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 14,
    lineHeight: 20,
  },
  section: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 16,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '600',
  },
  inputGroup: {
    marginBottom: 16,
  },
  label: {
    fontSize: 14,
    fontWeight: '500',
    marginBottom: 8,
  },
  inputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 12,
    gap: 10,
  },
  input: {
    flex: 1,
    fontSize: 15,
  },
  alert: {
    flexDirection: 'row',
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    gap: 10,
    marginBottom: 16,
  },
  alertContent: {
    flex: 1,
  },
  alertTitle: {
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 2,
  },
  alertText: {
    fontSize: 12,
    lineHeight: 18,
  },
  nameserversList: {
    gap: 8,
    marginBottom: 12,
  },
  nameserverItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 12,
    borderWidth: 1,
    borderRadius: 8,
  },
  nameserverInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  nameserverLabel: {
    fontSize: 11,
    fontWeight: '600',
    width: 28,
  },
  nameserverValue: {
    fontSize: 13,
    fontWeight: '500',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  copyButton: {
    padding: 8,
  },
  copyAllButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 10,
    borderWidth: 1,
    borderRadius: 8,
    marginBottom: 16,
  },
  copyAllText: {
    fontSize: 13,
    fontWeight: '500',
  },
  confirmationBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    borderWidth: 1,
    borderRadius: 8,
    padding: 16,
    gap: 12,
    marginBottom: 16,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderWidth: 2,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
  },
  confirmationContent: {
    flex: 1,
  },
  confirmationTitle: {
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 4,
  },
  confirmationText: {
    fontSize: 13,
    lineHeight: 18,
  },
  checklist: {
    marginTop: 8,
    gap: 4,
  },
  checklistItem: {
    fontSize: 12,
    lineHeight: 18,
  },
  submitButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 14,
    borderRadius: 10,
    marginBottom: 16,
  },
  submitButtonText: {
    fontSize: 15,
    fontWeight: '600',
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    paddingHorizontal: 4,
  },
  footerText: {
    flex: 1,
    fontSize: 12,
    lineHeight: 18,
  },
});
