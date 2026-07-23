import { StyleSheet } from 'react-native';

export const styles = StyleSheet.create({
  container: { flex: 1 },
  centerContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  emptyText: { fontSize: 14 },

  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingBottom: 10,
    borderBottomWidth: 1,
  },
  headerIconButton: {
    width: 32,
    height: 32,
    borderRadius: 6,
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerCenter: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 4,
  },
  headerAvatar: {
    width: 28,
    height: 28,
    borderRadius: 8,
    backgroundColor: '#D1FAE5',
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerName: {
    fontSize: 16,
    fontWeight: '600',
    flex: 1,
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },

  // Tabs
  tabBar: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    paddingLeft: 8,
  },
  tab: {
    paddingHorizontal: 10,
  },
  tabInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 12,
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  tabInnerActive: {
    borderBottomColor: '#000000',
  },
  tabText: {
    fontSize: 14,
    fontWeight: '500',
  },
  tabTextActive: {
    fontWeight: '600',
  },

  // Content
  content: { flex: 1 },

  // Section
  sectionWrapper: {
    paddingHorizontal: 16,
    paddingTop: 16,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 4,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: '600',
  },

  // Fields
  fieldsContainer: {
    marginTop: 8,
  },
  fieldRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 36,
    gap: 12,
  },
  fieldLabel: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    width: 110,
    flexShrink: 0,
  },
  fieldLabelText: {
    fontSize: 14,
  },
  fieldValue: {
    flex: 1,
  },
  fieldValueTouchable: {
    minHeight: 32,
    justifyContent: 'center',
  },
  fieldValueText: {
    fontSize: 14,
  },
  fieldValueLink: {
    textDecorationLine: 'underline',
  },
  fieldInput: {
    fontSize: 14,
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    minHeight: 36,
  },

  // Comments
  commentsContainer: { flex: 1 },
  commentsEmpty: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 6,
    paddingBottom: 60,
  },
  commentsEmptyTitle: {
    fontSize: 14,
    fontWeight: '500',
    marginTop: 4,
  },
  commentsEmptySubtitle: {
    fontSize: 13,
  },
});
