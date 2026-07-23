import { StyleSheet } from 'react-native';

const DRAWER_WIDTH = 340;
const MINI_WIDTH = 68;

export const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 0, 0, 0.35)',
  },
  drawer: {
    position: 'absolute',
    top: 0,
    left: 0,
    bottom: 0,
    width: DRAWER_WIDTH,
    shadowColor: '#000',
    shadowOffset: { width: 4, height: 0 },
    shadowOpacity: 0.1,
    shadowRadius: 20,
    elevation: 12,
  },
  drawerInner: {
    flex: 1,
    flexDirection: 'row',
  },
  labelPanel: {
    flex: 1,
  },
  drawerHeader: {
    paddingHorizontal: 18,
    paddingBottom: 13,
    borderBottomWidth: 0.5,
    borderBottomColor: '#E5E7EB', // overridden inline for dark
    marginBottom: 4,
  },
  drawerHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  drawerHeaderAvatar: {
    width: 42,
    height: 42,
    borderRadius: 14,
    justifyContent: 'center',
    alignItems: 'center',
  },
  drawerHeaderAvatarText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
  drawerHeaderInfo: {
    flex: 1,
  },
  drawerTitle: {
    fontSize: 17,
    fontWeight: '600',
  },
  drawerSubtitle: {
    fontSize: 13,
    marginTop: 2,
  },
  labelList: {
    flex: 1,
    paddingHorizontal: 8,
    paddingTop: 8,
  },
  drawerItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 11,
    gap: 14,
    borderRadius: 12,
    marginVertical: 1,
  },
  drawerItemActive: {
    backgroundColor: '#E8F0FE',
  },
  drawerItemText: {
    fontSize: 14,
    fontWeight: '500',
    flex: 1,
    color: '#202124',
  },
  drawerItemCount: {
    fontSize: 12,
    fontWeight: '600',
    color: '#5F6368',
    fontFamily: 'Menlo',
  },
  sectionDivider: {
    height: StyleSheet.hairlineWidth,
    marginHorizontal: 14,
    marginVertical: 10,
  },
  sectionHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingRight: 14,
  },
  sectionHeader: {
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    paddingHorizontal: 14,
    paddingVertical: 8,
    color: '#9CA3AF',
  },
  createLabelButton: {
    padding: 8,
    borderRadius: 20,
  },
  labelBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
  },
  labelBadgeText: {
    fontSize: 13,
    fontWeight: '500',
  },
  // Mini sidebar
  miniSidebar: {
    width: MINI_WIDTH,
    borderRightWidth: StyleSheet.hairlineWidth,
    flexDirection: 'column',
  },
  miniContent: {
    flex: 1,
  },
  miniItem: {
    alignItems: 'center',
    paddingVertical: 5,
    position: 'relative',
  },
  miniAvatar: {
    width: 42,
    height: 42,
    borderRadius: 14,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#F1F3F4',
  },
  miniAvatarActive: {
    backgroundColor: '#FEF0EC',
  },
  miniAddButton: {
    backgroundColor: 'transparent',
    borderWidth: 1.5,
    borderColor: '#DADCE0',
    borderStyle: 'dashed',
  },
  miniAvatarRing: {
    borderWidth: 2.5,
    borderColor: '#4D94F8',
    elevation: 3,
  },
  miniAvatarText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
  activeIndicator: {
    position: 'absolute',
    left: 0,
    top: 10,
    bottom: 10,
    width: 3,
    borderTopRightRadius: 3,
    borderBottomRightRadius: 3,
    backgroundColor: '#4D94F8',
  },
  miniDivider: {
    height: 0.5,
    marginHorizontal: 13,
    marginVertical: 8,
    opacity: 0.55,
  },
  miniBottom: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 8,
  },
  miniSettingsIcon: {
    width: 42,
    height: 42,
    borderRadius: 14,
    justifyContent: 'center',
    alignItems: 'center',
  },
});
