import * as Haptics from 'expo-haptics';
import { Platform } from 'react-native';

export const haptics = {
  light: () =>
    Platform.OS === 'ios' &&
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light),
  medium: () =>
    Platform.OS === 'ios' &&
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium),
  success: () =>
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success),
  error: () =>
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error),
  selection: () => Haptics.selectionAsync(),
};
