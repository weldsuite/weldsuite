import React from 'react';
import { Image, ImageStyle, StyleProp } from 'react-native';

const APP_ICONS: Record<string, any> = {
  crm: require('@/assets/images/app-icons/crm.png'),
  helpdesk: require('@/assets/images/app-icons/helpdesk.png'),
  task: require('@/assets/images/app-icons/task.png'),
  mail: require('@/assets/images/app-icons/mail.png'),
  host: require('@/assets/images/app-icons/host.png'),
  projects: require('@/assets/images/app-icons/projects.png'),
  agent: require('@/assets/images/app-icons/agent.png'),
};

// Apps with custom logos (used for filtering)
export const APPS_WITH_LOGOS = Object.keys(APP_ICONS);

interface AppIconProps {
  appCode: string;
  size?: number;
  style?: StyleProp<ImageStyle>;
}

export function AppIcon({ appCode, size = 24, style }: AppIconProps) {
  const iconSource = APP_ICONS[appCode];
  if (!iconSource) return null;

  return (
    <Image
      source={iconSource}
      style={[{ width: size, height: size }, style]}
      resizeMode="contain"
    />
  );
}

export function hasCustomIcon(appCode: string): boolean {
  return appCode in APP_ICONS;
}
