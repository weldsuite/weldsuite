import { StyleSheet } from 'react-native';

const ACCENT = '#f6663e';

export const styles = StyleSheet.create({
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
  headerTitle: { flex: 1, fontSize: 17, fontWeight: '700', textAlign: 'center' },
  scroll: { flex: 1 },
  content: { paddingHorizontal: 20, paddingTop: 20, gap: 18 },

  // Hero
  hero: { alignItems: 'center', gap: 10, paddingVertical: 8 },
  heroIcon: {
    width: 60,
    height: 60,
    borderRadius: 18,
    justifyContent: 'center',
    alignItems: 'center',
  },
  heroTitle: { fontSize: 22, fontWeight: '700', letterSpacing: -0.3 },
  heroSubtitle: { fontSize: 14, lineHeight: 20, textAlign: 'center', paddingHorizontal: 12 },

  // Option cards
  cardList: { gap: 12 },
  optionCard: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
    borderRadius: 16,
    borderWidth: 1,
    gap: 14,
  },
  optionCardLoading: { justifyContent: 'flex-start' },
  optionIcon: {
    width: 46,
    height: 46,
    borderRadius: 14,
    justifyContent: 'center',
    alignItems: 'center',
  },
  optionInfo: { flex: 1, gap: 2 },
  optionTitle: { fontSize: 16, fontWeight: '600', letterSpacing: -0.2 },
  optionSub: { fontSize: 13, lineHeight: 18 },
  footerNote: { fontSize: 12, lineHeight: 17, textAlign: 'center', paddingHorizontal: 24, marginTop: 4 },

  // Preview card
  previewCard: {
    borderRadius: 16,
    borderWidth: 1,
    paddingVertical: 18,
    paddingHorizontal: 18,
    gap: 6,
  },
  previewLabel: { fontSize: 11, fontWeight: '700', letterSpacing: 0.6 },
  previewEmail: { fontSize: 22, fontWeight: '700', letterSpacing: -0.4 },

  // Fields
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
  suffixWrap: { marginLeft: 6 },
  suffixText: { fontSize: 15, fontWeight: '500' },
  hintText: { fontSize: 12, marginLeft: 2 },

  availabilityRow: { flexDirection: 'row', marginTop: 2 },
  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
  },
  statusText: { fontSize: 12.5, fontWeight: '600' },

  // Domain dropdown
  domainDropdown: {
    borderRadius: 14,
    borderWidth: 1,
    overflow: 'hidden',
    marginTop: 2,
  },
  domainOption: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 13,
  },
  domainOptionText: { fontSize: 15, fontWeight: '500' },

  // Footer CTA
  footer: {
    paddingHorizontal: 20,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  submitButton: {
    backgroundColor: ACCENT,
    height: 52,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  submitButtonDisabled: { opacity: 0.45 },
  submitText: { color: '#FFFFFF', fontSize: 16, fontWeight: '700', letterSpacing: -0.2 },
});
