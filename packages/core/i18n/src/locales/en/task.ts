export const task = {
    title: 'WeldConnect',
    description: 'Manage workflows and automation',

    dashboard: {
      title: 'Dashboard',
      taskDashboard: 'Task Dashboard',
      // Action items
      workflowsToReview: '{count} workflows to review',
      failedExecutions: '{count} failed executions',
      pendingTasks: '{count} pending tasks',
      viewExecutionAnalytics: 'View execution analytics',
      activeWorkflows: 'Active workflows',
    },

    // Workflows
    workflows: {
      title: 'Workflows',
      workflow: 'Workflow',
      newWorkflow: 'New Workflow',
      createWorkflow: 'Create Workflow',
      workflowName: 'Workflow Name',
      description: 'Description',
      trigger: 'Trigger',
      actions: 'Actions',
      conditions: 'Conditions',
      active: 'Active',
      inactive: 'Inactive',
      noWorkflows: 'No workflows found',
    },

    // Triggers
    triggers: {
      title: 'Triggers',
      trigger: 'Trigger',
      addTrigger: 'Add Trigger',
      eventTrigger: 'Event Trigger',
      scheduleTrigger: 'Schedule Trigger',
      webhookTrigger: 'Webhook Trigger',
      manualTrigger: 'Manual Trigger',
    },

    // Actions
    actions: {
      title: 'Actions',
      action: 'Action',
      addAction: 'Add Action',
      sendEmail: 'Send Email',
      createRecord: 'Create Record',
      updateRecord: 'Update Record',
      apiRequest: 'API Request',
      notification: 'Send Notification',
    },

    // Executions
    executions: {
      title: 'Executions',
      execution: 'Execution',
      executionHistory: 'Execution History',
      status: 'Status',
      startTime: 'Start Time',
      endTime: 'End Time',
      duration: 'Duration',
      result: 'Result',
      logs: 'Logs',
      noExecutions: 'No executions found',
      statuses: {
        running: 'Running',
        completed: 'Completed',
        failed: 'Failed',
        cancelled: 'Cancelled',
      },
    },

    // Templates
    templates: {
      title: 'Templates',
      template: 'Template',
      newTemplate: 'New Template',
      useTemplate: 'Use Template',
      noTemplates: 'No templates available',
    },

    // Settings
    settings: {
      title: 'Settings',
      general: 'General Settings',
      notifications: 'Notifications',
      errorHandling: 'Error Handling',
      retryPolicy: 'Retry Policy',
      timeout: 'Timeout',
    },

    // Messages
    messages: {
      workflowCreated: 'Workflow created successfully',
      workflowActivated: 'Workflow activated successfully',
      workflowDeactivated: 'Workflow deactivated successfully',
      executionStarted: 'Execution started successfully',
      executionCancelled: 'Execution cancelled successfully',
    },
  };
