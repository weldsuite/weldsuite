import { StyleSheet } from 'react-native';

export const styles = StyleSheet.create({
  splitContainer: {
    flex: 1,
    flexDirection: 'row',
  },
  container: {
    flex: 1,
  },
  centerContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  listRegion: {
    flex: 1,
  },
  listControls: {
    gap: 10,
    paddingBottom: 4,
  },
  searchTap: {
    // SearchBar is not editable here — opening /search is the action.
  },
  chipsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  listContainer: {
    paddingBottom: 32,
  },
  sectionHeader: {
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 6,
  },
  sectionHeaderText: {
    fontSize: 13,
    fontWeight: '600',
    letterSpacing: -0.1,
  },
  emailItem: {
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  emailRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  avatarWrap: {
    position: 'relative',
    marginTop: 2,
    flexShrink: 0,
  },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
  },
  avatarText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  unreadDot: {
    position: 'absolute',
    top: '50%',
    marginTop: -3,
    left: -10,
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  emailContent: {
    flex: 1,
    minWidth: 0,
  },
  emailTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
  },
  senderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    minWidth: 0,
    gap: 6,
  },
  senderName: {
    fontSize: 16,
    lineHeight: 20,
    letterSpacing: -0.2,
    flexShrink: 1,
  },
  threadCountBadge: {
    height: 18,
    minWidth: 18,
    paddingHorizontal: 4,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  threadCountText: {
    fontSize: 10,
    fontWeight: '500',
    fontFamily: 'Menlo',
  },
  emailMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexShrink: 0,
  },
  emailTime: {
    fontSize: 12,
    lineHeight: 14,
    fontWeight: '400',
  },
  subject: {
    fontSize: 14,
    lineHeight: 20,
    marginTop: 2,
  },
  preview: {
    fontSize: 13,
    lineHeight: 18,
    marginTop: 2,
    fontWeight: '400',
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingTop: 80,
    paddingHorizontal: 32,
    minHeight: 320,
  },
  snackbar: {
    position: 'absolute',
    left: 16,
    right: 16,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#111827',
    borderRadius: 14,
    paddingVertical: 16,
    paddingHorizontal: 20,
    gap: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.2,
    shadowRadius: 16,
    elevation: 10,
    zIndex: 10,
  },
  snackbarText: {
    flex: 1,
    color: '#F3F4F6',
    fontSize: 15,
    fontWeight: '500',
    letterSpacing: -0.1,
  },
  snackbarAction: {
    fontSize: 15,
    fontWeight: '600',
    letterSpacing: -0.1,
  },
  swipeActionsContainer: {
    flexDirection: 'row',
    alignItems: 'stretch',
  },
  swipeAction: {
    justifyContent: 'center',
    alignItems: 'center',
    width: 76,
    paddingHorizontal: 8,
  },
  swipeActionText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '500',
    marginTop: 4,
  },
  labelBadgeRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
    marginTop: 8,
  },
  labelBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
  },
  labelBadgeText: {
    fontSize: 12,
    fontWeight: '500',
  },
  labelOverflow: {
    fontSize: 10,
    alignSelf: 'center',
  },
  headerAvatar: {
    width: 28,
    height: 28,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerAvatarText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '600',
  },
});
