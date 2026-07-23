export const task = {
    title: 'WeldConnect',
    description: 'Beheer workflows en automatisering',

    dashboard: {
      title: 'Dashboard',
      taskDashboard: 'Taak Dashboard',
      // Action items
      workflowsToReview: '{count} workflows te beoordelen',
      failedExecutions: '{count} mislukte uitvoeringen',
      pendingTasks: '{count} taken in behandeling',
      viewExecutionAnalytics: 'Bekijk uitvoeringsanalyses',
      activeWorkflows: 'Actieve workflows',
    },

    // Workflows
    workflows: {
      title: 'Workflows',
      workflow: 'Workflow',
      newWorkflow: 'Nieuwe Workflow',
      createWorkflow: 'Workflow Aanmaken',
      workflowName: 'Workflow Naam',
      description: 'Beschrijving',
      trigger: 'Trigger',
      actions: 'Acties',
      conditions: 'Voorwaarden',
      active: 'Actief',
      inactive: 'Inactief',
      noWorkflows: 'Geen workflows gevonden',
    },

    // Triggers
    triggers: {
      title: 'Triggers',
      trigger: 'Trigger',
      addTrigger: 'Trigger Toevoegen',
      eventTrigger: 'Event Trigger',
      scheduleTrigger: 'Plannings Trigger',
      webhookTrigger: 'Webhook Trigger',
      manualTrigger: 'Handmatige Trigger',
    },

    // Actions
    actions: {
      title: 'Acties',
      action: 'Actie',
      addAction: 'Actie Toevoegen',
      sendEmail: 'E-mail Verzenden',
      createRecord: 'Record Aanmaken',
      updateRecord: 'Record Bijwerken',
      apiRequest: 'API Verzoek',
      notification: 'Melding Verzenden',
    },

    // Executions
    executions: {
      title: 'Uitvoeringen',
      execution: 'Uitvoering',
      executionHistory: 'Uitvoeringsgeschiedenis',
      status: 'Status',
      startTime: 'Starttijd',
      endTime: 'Eindtijd',
      duration: 'Duur',
      result: 'Resultaat',
      logs: 'Logs',
      noExecutions: 'Geen uitvoeringen gevonden',
      statuses: {
        running: 'Bezig',
        completed: 'Voltooid',
        failed: 'Mislukt',
        cancelled: 'Geannuleerd',
      },
    },

    // Templates
    templates: {
      title: 'Sjablonen',
      template: 'Sjabloon',
      newTemplate: 'Nieuw Sjabloon',
      useTemplate: 'Sjabloon Gebruiken',
      noTemplates: 'Geen sjablonen beschikbaar',
    },

    // Settings
    settings: {
      title: 'Instellingen',
      general: 'Algemene Instellingen',
      notifications: 'Meldingen',
      errorHandling: 'Foutafhandeling',
      retryPolicy: 'Herhalingsbeleid',
      timeout: 'Time-out',
    },

    // Messages
    messages: {
      workflowCreated: 'Workflow succesvol aangemaakt',
      workflowActivated: 'Workflow succesvol geactiveerd',
      workflowDeactivated: 'Workflow succesvol gedeactiveerd',
      executionStarted: 'Uitvoering succesvol gestart',
      executionCancelled: 'Uitvoering succesvol geannuleerd',
    },
  };
