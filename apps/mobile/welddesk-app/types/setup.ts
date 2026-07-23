// Setup flow types and constants

export interface ProfileData {
  firstName: string;
  lastName: string;
  phone: string;
  jobTitle: string;
}

export interface WorkspaceData {
  name: string;
  slug: string;
  country: string;
}

export interface SetupFormData {
  profile: ProfileData;
  workspace: WorkspaceData;
}

export type SetupMode = 'new' | 'existing';

export interface SetupState {
  currentStep: number;
  formData: SetupFormData;
}

export const STEP_COUNT_NEW = 5;
export const STEP_COUNT_EXISTING = 2;

export const COUNTRIES = [
  { code: 'US', name: 'United States' },
  { code: 'GB', name: 'United Kingdom' },
  { code: 'CA', name: 'Canada' },
  { code: 'AU', name: 'Australia' },
  { code: 'DE', name: 'Germany' },
  { code: 'FR', name: 'France' },
  { code: 'NL', name: 'Netherlands' },
  { code: 'BE', name: 'Belgium' },
  { code: 'ES', name: 'Spain' },
  { code: 'IT', name: 'Italy' },
  { code: 'BR', name: 'Brazil' },
  { code: 'MX', name: 'Mexico' },
  { code: 'JP', name: 'Japan' },
  { code: 'KR', name: 'South Korea' },
  { code: 'IN', name: 'India' },
  { code: 'SG', name: 'Singapore' },
  { code: 'OTHER', name: 'Other' },
] as const;

export const ROLES = [
  { id: 'sales', label: 'Sales', icon: 'TrendingUp' },
  { id: 'marketing', label: 'Marketing', icon: 'Megaphone' },
  { id: 'engineering', label: 'Engineering', icon: 'Code' },
  { id: 'product', label: 'Product', icon: 'Layers' },
  { id: 'design', label: 'Design', icon: 'Palette' },
  { id: 'customer-success', label: 'Customer Success', icon: 'HeartHandshake' },
  { id: 'operations', label: 'Operations', icon: 'Settings' },
  { id: 'finance', label: 'Finance', icon: 'Calculator' },
  { id: 'hr', label: 'Human Resources', icon: 'Users' },
  { id: 'executive', label: 'Executive', icon: 'Crown' },
  { id: 'other', label: 'Other', icon: 'MoreHorizontal' },
] as const;

export function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export const DEFAULT_PROFILE_DATA: ProfileData = {
  firstName: '',
  lastName: '',
  phone: '',
  jobTitle: '',
};

export const DEFAULT_WORKSPACE_DATA: WorkspaceData = {
  name: '',
  slug: '',
  country: '',
};

export const DEFAULT_FORM_DATA: SetupFormData = {
  profile: DEFAULT_PROFILE_DATA,
  workspace: DEFAULT_WORKSPACE_DATA,
};

export const STORAGE_KEYS = {
  formData: 'setup_form_data',
  currentStep: 'setup_current_step',
  completed: 'setup_completed',
  mode: 'setup_mode',
} as const;
