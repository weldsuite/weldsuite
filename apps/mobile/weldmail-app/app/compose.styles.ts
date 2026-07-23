import { StyleSheet } from 'react-native';

export const styles = StyleSheet.create({
  container: { flex: 1 },
  // Header — Outlook style: X | Avatar | (Title \n from-email) | Send arrow
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 56,
    paddingVertical: 8,
    paddingHorizontal: 12,
    gap: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  closeButton: {
    width: 36,
    height: 36,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerAvatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerAvatarText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
  },
  headerTextBlock: {
    flex: 1,
    justifyContent: 'center',
  },
  headerTitle: {
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: -0.2,
  },
  headerFromRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 1,
  },
  headerFromEmail: {
    fontSize: 13,
    flexShrink: 1,
  },
  sendArrow: {
    width: 36,
    height: 36,
    justifyContent: 'center',
    alignItems: 'center',
  },
  // Outlook field row — From etc.
  outlookFieldRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    height: 48,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 12,
  },
  outlookFieldLabel: {
    fontSize: 14,
    fontWeight: '500',
    width: 44,
  },
  outlookFieldValue: {
    flex: 1,
    fontSize: 15,
  },
  // Recipient pill — Outlook style
  recipientPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#DBEAFE',
    paddingLeft: 10,
    paddingRight: 6,
    paddingVertical: 5,
    borderRadius: 14,
  },
  recipientPillText: {
    fontSize: 14,
    color: '#1E40AF',
    fontWeight: '500',
    maxWidth: 220,
  },
  recipientPillX: {
    width: 18,
    height: 18,
    borderRadius: 9,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#BFDBFE',
  },
  // Form
  form: { flex: 1 },
  toChipRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingHorizontal: 16,
    minHeight: 48,
    borderBottomWidth: 0.5,
    gap: 0,
  },
  toChipContainer: {
    flex: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    paddingVertical: 8,
    gap: 6,
  },
  recipientText: {
    fontSize: 15,
    color: '#2563EB',
    paddingVertical: 6,
  },
  toChipInput: {
    fontSize: 15,
    minWidth: 80,
    flex: 1,
    paddingVertical: 6,
  },
  fieldRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    height: 48,
    borderBottomWidth: 0.5,
  },
  fieldLabel: {
    fontSize: 15,
    marginRight: 8,
  },
  fieldInput: {
    flex: 1,
    fontSize: 15,
  },
  ccBccToggle: {
    fontSize: 12,
    fontWeight: '500',
    color: '#3B82F6',
    paddingHorizontal: 7,
    paddingVertical: 4,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#93C5FD',
    borderRadius: 8,
  },
  subjectInput: {
    fontSize: 15,
    fontWeight: '500',
  },
  subjectPlaceholder: {
    position: 'absolute',
    fontSize: 15,
    fontWeight: '500',
    top: 0,
  },
  // Contact suggestions
  suggestionItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 12,
  },
  suggestionAvatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    justifyContent: 'center',
    alignItems: 'center',
  },
  suggestionAvatarText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
  suggestionInfo: {
    flex: 1,
    gap: 1,
  },
  suggestionName: {
    fontSize: 15,
    fontWeight: '500',
  },
  suggestionEmail: {
    fontSize: 13,
  },
  suggestionCompany: {
    fontSize: 12,
    maxWidth: 100,
  },
  createContactItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#E5E7EB',
  },
  createContactIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    justifyContent: 'center',
    alignItems: 'center',
  },
  createContactPlus: {
    fontSize: 18,
    fontWeight: '500',
    color: '#9CA3AF',
    marginTop: -1,
  },
  createContactText: {
    fontSize: 15,
    fontWeight: '500',
  },
  // Attachments
  attachmentsList: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: 16,
    paddingTop: 8,
    gap: 8,
  },
  attachmentChip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 9,
    borderWidth: 1,
    gap: 6,
    maxWidth: '100%',
  },
  attachmentName: {
    fontSize: 13,
    maxWidth: 150,
  },
  // Body
  bodySection: {
    flex: 1,
    paddingHorizontal: 16,
    paddingBottom: 16,
    minHeight: 200,
  },
  bodyInput: {
    fontSize: 15,
    lineHeight: 22,
    minHeight: 200,
    paddingTop: 10,
  },
  editorWebView: {
    minHeight: 200,
    backgroundColor: 'transparent',
    opacity: 0.99,
  },
  // Bottom toolbar — Outlook-style big floating pill, left-aligned
  toolbarBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-start',
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  // The pill's background/border/active colours are applied inline from
  // useTheme() — they used to be hardcoded light values, which left the whole
  // group as a white pill with dark icons in dark mode.
  toolbarPill: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.1,
    shadowRadius: 12,
    elevation: 6,
    paddingVertical: 6,
    paddingHorizontal: 6,
    gap: 3,
  },
  toolbarButton: {
    width: 34,
    height: 34,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
  },
  scheduledChip: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 8,
    gap: 4,
    paddingHorizontal: 10,
  },
  scheduledChipText: {
    fontSize: 12,
    fontWeight: '600',
  },
  toolbarDivider: {
    width: 1,
    height: 18,
    marginHorizontal: 3,
  },
  // Calendar picker
  calendarHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#E5E7EB',
  },
  calendarHeaderTitle: {
    fontSize: 17,
    fontWeight: '600',
  },
  calendarMonthRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 12,
  },
  calendarMonthText: {
    fontSize: 17,
    fontWeight: '600',
  },
  calendarWeekRow: {
    flexDirection: 'row',
    paddingHorizontal: 12,
    marginBottom: 4,
  },
  calendarWeekDay: {
    flex: 1,
    textAlign: 'center',
    fontSize: 13,
    fontWeight: '500',
  },
  calendarGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: 12,
  },
  calendarDayCell: {
    width: '14.28%',
    height: 44,
    justifyContent: 'center',
    alignItems: 'center',
  },
  calendarDayInner: {
    width: 38,
    height: 38,
    borderRadius: 11,
    justifyContent: 'center',
    alignItems: 'center',
  },
  calendarDaySelected: {
    backgroundColor: '#3B82F6',
  },
  calendarDayText: {
    fontSize: 15,
    fontWeight: '400',
  },
  calendarTimeLabel: {
    fontSize: 14,
    fontWeight: '500',
    marginBottom: 10,
  },
  calendarSummary: {
    fontSize: 15,
    fontWeight: '500',
    textAlign: 'center',
  },
  calendarSummaryError: {
    fontSize: 13,
    fontWeight: '500',
    textAlign: 'center',
    marginTop: 6,
  },
  // Custom time stepper. Replaced a native picker spinner that rendered the
  // stock platform clock and ignored the app theme; this control is ours, so
  // colours are applied inline from useTheme().
  timeStepperRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  timeStepper: {
    alignItems: 'center',
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: 6,
    paddingHorizontal: 18,
  },
  timeStepperButton: {
    paddingVertical: 6,
    paddingHorizontal: 10,
  },
  timeStepperValue: {
    fontSize: 30,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
    paddingVertical: 2,
  },
  timeStepperColon: {
    fontSize: 28,
    fontWeight: '600',
    marginBottom: 2,
  },
});
