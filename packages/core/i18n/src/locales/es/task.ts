export const task = {
    title: 'WeldConnect',
    description: 'Gestiona flujos de trabajo y automatización',

    dashboard: {
      title: 'Panel',
      taskDashboard: 'Panel de tareas',
      // Action items
      workflowsToReview: '{count} flujos de trabajo para revisar',
      failedExecutions: '{count} ejecuciones fallidas',
      pendingTasks: '{count} tareas pendientes',
      viewExecutionAnalytics: 'Ver analítica de ejecuciones',
      activeWorkflows: 'Flujos de trabajo activos',
    },

    // Workflows
    workflows: {
      title: 'Flujos de trabajo',
      workflow: 'Flujo de trabajo',
      newWorkflow: 'Nuevo flujo de trabajo',
      createWorkflow: 'Crear flujo de trabajo',
      workflowName: 'Nombre del flujo de trabajo',
      description: 'Descripción',
      trigger: 'Disparador',
      actions: 'Acciones',
      conditions: 'Condiciones',
      active: 'Activo',
      inactive: 'Inactivo',
      noWorkflows: 'No se encontraron flujos de trabajo',
    },

    // Triggers
    triggers: {
      title: 'Disparadores',
      trigger: 'Disparador',
      addTrigger: 'Añadir disparador',
      eventTrigger: 'Disparador de evento',
      scheduleTrigger: 'Disparador programado',
      webhookTrigger: 'Disparador webhook',
      manualTrigger: 'Disparador manual',
    },

    // Actions
    actions: {
      title: 'Acciones',
      action: 'Acción',
      addAction: 'Añadir acción',
      sendEmail: 'Enviar correo electrónico',
      createRecord: 'Crear registro',
      updateRecord: 'Actualizar registro',
      apiRequest: 'Solicitud API',
      notification: 'Enviar notificación',
    },

    // Executions
    executions: {
      title: 'Ejecuciones',
      execution: 'Ejecución',
      executionHistory: 'Historial de ejecuciones',
      status: 'Estado',
      startTime: 'Hora de inicio',
      endTime: 'Hora de fin',
      duration: 'Duración',
      result: 'Resultado',
      logs: 'Registros',
      noExecutions: 'No se encontraron ejecuciones',
      statuses: {
        running: 'En ejecución',
        completed: 'Completado',
        failed: 'Fallido',
        cancelled: 'Cancelado',
      },
    },

    // Templates
    templates: {
      title: 'Plantillas',
      template: 'Plantilla',
      newTemplate: 'Nueva plantilla',
      useTemplate: 'Usar plantilla',
      noTemplates: 'No hay plantillas disponibles',
    },

    // Settings
    settings: {
      title: 'Configuración',
      general: 'Configuración general',
      notifications: 'Notificaciones',
      errorHandling: 'Gestión de errores',
      retryPolicy: 'Política de reintentos',
      timeout: 'Tiempo de espera',
    },

    // Messages
    messages: {
      workflowCreated: 'Flujo de trabajo creado correctamente',
      workflowActivated: 'Flujo de trabajo activado correctamente',
      workflowDeactivated: 'Flujo de trabajo desactivado correctamente',
      executionStarted: 'Ejecución iniciada correctamente',
      executionCancelled: 'Ejecución cancelada correctamente',
    },
  };
