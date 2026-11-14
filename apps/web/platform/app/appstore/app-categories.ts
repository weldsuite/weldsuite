/** The App Store's five category groups, and which one an app falls in (its stored category, or a per-app override). */

// Consolidate categories into broader groups
const CATEGORY_GROUPS: Record<string, string[]> = {
  'Customers': ['sales', 'crm', 'commerce', 'customer', 'support', 'helpdesk', 'marketing'],
  'Communication': ['mail', 'email', 'chat', 'messaging', 'meet', 'video', 'inbox', 'webmail', 'communication'],
  'Work': ['productivity', 'projects', 'tasks', 'task', 'planning', 'collaboration', 'documents', 'notes', 'calendar', 'workflow', 'automation'],
  'Storage': ['drive', 'files', 'storage', 'host', 'hosting', 'dns', 'domains', 'infrastructure'],
  'Finance': ['finance', 'accounting', 'billing', 'invoicing', 'erp', 'books'],
};

// Direct app code to category mapping — wins over keyword matching. Used when
// the app's stored category alone isn't enough to disambiguate (e.g. WeldDrive
// is stored as "Productivity" but belongs in Storage).
const APP_CODE_OVERRIDES: Record<string, string> = {
  'mail': 'Communication',
  'welddrive': 'Storage',
};

export function getConsolidatedCategory(originalCategory: string, appCode?: string): string {
  // Check for direct app code override first
  if (appCode && APP_CODE_OVERRIDES[appCode.toLowerCase()]) {
    return APP_CODE_OVERRIDES[appCode.toLowerCase()];
  }

  const normalizedCategory = originalCategory.toLowerCase();
  for (const [group, keywords] of Object.entries(CATEGORY_GROUPS)) {
    if (keywords.some(keyword => normalizedCategory.includes(keyword.toLowerCase()))) {
      return group;
    }
  }
  return 'Work';
}
