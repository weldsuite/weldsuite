/**
 * Pipeline view settings type
 */
export interface PipelineViewSettings {
  // View settings
  showAttributeLabels: boolean;
  visibleAttributes: {
    dealOwner: boolean;
    dealValue: boolean;
    nextDueTask: boolean;
    recordId: boolean;
    dealName: boolean;
    expectedCloseDate: boolean;
    probability: boolean;
    company: boolean;
    contact: boolean;
    tags: boolean;
  };
  groupBy: 'stage' | 'owner' | 'company' | 'none';
  // Pipeline settings
  autoAdvance: boolean;
  rottenDealDays: number;
  showProbability: boolean;
  showExpectedCloseDate: boolean;
  defaultCurrency: string;
  activityReminders: boolean;
  emailNotifications: boolean;
  slackIntegration: boolean;
  // Custom fields
  customFields: Array<{
    id: string;
    name: string;
    type: 'text' | 'number' | 'date' | 'select' | 'textarea';
    required: boolean;
    options?: string[];
  }>;
}

export const DEFAULT_PIPELINE_SETTINGS: PipelineViewSettings = {
  showAttributeLabels: false,
  visibleAttributes: {
    dealOwner: true,
    dealValue: true,
    nextDueTask: true,
    recordId: false,
    dealName: true,
    expectedCloseDate: true,
    probability: true,
    company: true,
    contact: true,
    tags: true,
  },
  groupBy: 'stage',
  autoAdvance: true,
  rottenDealDays: 30,
  showProbability: true,
  showExpectedCloseDate: true,
  defaultCurrency: 'USD',
  activityReminders: true,
  emailNotifications: true,
  slackIntegration: false,
  customFields: [],
};
