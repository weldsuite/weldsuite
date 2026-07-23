import { Package, type LucideIcon } from 'lucide-react';
import { APP_REGISTRY, getAppIcon } from '@/lib/apps/app-registry';

interface AppIconProps {
  /** App code (e.g. "weldcrm") or Lucide icon name (e.g. "ShoppingCart") for database icons */
  icon: string;
  className?: string;
  fallbackClassName?: string;
}

/**
 * Renders an app icon. Resolution order:
 * 1. Registry image icon (SVG) by app code
 * 2. Registry Lucide icon by app code
 * 3. Emoji (if the string looks like one)
 * 4. Fallback Package icon
 */
export function AppIcon({ icon, className = 'h-6 w-6', fallbackClassName }: AppIconProps) {
  // Check registry for image icon by app code
  const imagePath = getAppIcon(icon);
  if (imagePath) {
    return <img src={imagePath} alt={icon} className={className} />;
  }

  // Check registry for Lucide icon by app code
  const registryEntry = APP_REGISTRY[icon];
  if (registryEntry) {
    const Icon = registryEntry.lucideIcon;
    return <Icon className={className} />;
  }

  // Check if it's an emoji (single character or emoji sequence)
  if (icon.length <= 4 || /\p{Emoji}/u.test(icon)) {
    return <span className={fallbackClassName || className}>{icon}</span>;
  }

  // Fallback
  return <Package className={className} />;
}

/**
 * Get the list of available icon names for selection
 */
function getAvailableIcons(): string[] {
  return Object.keys(APP_REGISTRY);
}
