import { 
  Loader2, 
  Github,
  Chrome,
  Facebook,
  Twitter,
  type LucideIcon 
} from 'lucide-react';

export type Icon = LucideIcon;

export const Icons = {
  spinner: Loader2,
  gitHub: Github,
  google: Chrome, // Using Chrome as a placeholder for Google
  facebook: Facebook,
  twitter: Twitter,
} as const;

export type IconName = keyof typeof Icons;