export const journal = {
    title: 'Diario',
    entries: 'Asientos contables',
    entry: 'Asiento contable',
    entryNumber: 'Número de asiento',
    entryDate: 'Fecha del asiento',
    entryType: 'Tipo de asiento',
    debit: 'Debe',
    credit: 'Haber',
    account: 'Cuenta',
    memo: 'Memo',
    attachment: 'Adjunto',
    posted: 'Contabilizado',
    balanced: 'Cuadrado',
    unbalanced: 'Descuadrado',
    difference: 'Diferencia',

    // Form sections
    sections: {
      entryInformation: 'Información del asiento',
      journalLines: 'Líneas del diario',
      additionalNotes: 'Notas adicionales',
    },

    // Form labels
    description: 'Descripción',
    date: 'Fecha',
    type: 'Tipo de asiento',
    reference: 'Número de referencia',
    referenceNumber: 'Número de referencia',
    notes: 'Notas',
    lines: 'Líneas',
    totalDebits: 'Total debe',
    totalCredits: 'Total haber',
    totals: 'Totales',

    // Placeholders
    placeholders: {
      description: 'p. ej., Pago mensual de alquiler',
      selectDate: 'Selecciona una fecha',
      reference: 'Número de referencia opcional',
      notes: 'Notas adicionales o comentarios sobre este asiento contable',
      selectAccount: 'Selecciona una cuenta',
      lineDescription: 'Descripción de la línea',
      debit: '0.00',
      credit: '0.00',
    },

    // Entry types
    types: {
      manual: 'Manual',
      adjustment: 'Ajuste',
      closing: 'Cierre',
      automatic: 'Automático'
    },

    // Type descriptions
    typeDescriptions: {
      manual: 'Asientos contables creados manualmente para transacciones regulares',
      adjustment: 'Asientos de ajuste de fin de período para devengos, diferimientos o correcciones',
      closing: 'Asientos de cierre de ejercicio o período para resetear cuentas temporales',
    },

    // Column headers
    columns: {
      account: 'Cuenta',
      description: 'Descripción',
      debit: 'Debe',
      credit: 'Haber',
    },

    // Info texts
    infoTexts: {
      balancedEntry: 'Un asiento cuadrado significa que el total del debe es igual al total del haber. Este es un principio fundamental de la contabilidad por partida doble.',
      debitTooltip: 'Lado izquierdo del asiento. Aumenta los activos y gastos, disminuye los pasivos, el patrimonio neto y los ingresos.',
      creditTooltip: 'Lado derecho del asiento. Aumenta los pasivos, el patrimonio neto y los ingresos, disminuye los activos y gastos.',
      entryTypes: 'Tipos de asientos contables',
    },

    // Status messages
    status: {
      balanced: '¡El asiento está cuadrado! El debe y el haber son iguales.',
      unbalanced: 'El asiento está descuadrado. Diferencia: ',
      notBalanced: 'El asiento no está cuadrado. El debe debe ser igual al haber.',
    },

    // Buttons
    buttons: {
      addLine: 'Añadir línea',
      removeLine: 'Eliminar línea',
      saveAsDraft: 'Guardar como borrador',
      saveChanges: 'Guardar cambios',
      backToJournal: 'Volver a los asientos contables',
    },

    // Validation
    validation: {
      descriptionRequired: 'La descripción es obligatoria',
      entryMustBeBalanced: 'El asiento debe estar cuadrado (el debe debe ser igual al haber)',
      minimumTwoLines: 'Se requieren al menos dos líneas de diario',
      validationError: 'Error de validación',
    },

    // Summary
    summary: {
      entrySummary: 'Resumen del asiento',
      untitledEntry: 'Asiento sin título',
      linesCount: '{count} líneas',
      yes: 'Sí',
      no: 'No',
    },

    actions: {
      newEntry: 'Nuevo asiento',
      postEntry: 'Contabilizar asiento',
      reverseEntry: 'Revertir asiento',
      copyEntry: 'Copiar asiento',
      viewEntry: 'Ver asiento',
      createNewEntry: 'Crear nuevo asiento contable',
      editEntry: 'Editar asiento contable',
      editing: 'Editando',
    },

    messages: {
      entryPosted: 'Asiento contable contabilizado correctamente',
      entryReversed: 'Asiento contable revertido correctamente',
      mustBalance: 'El total del debe debe ser igual al total del haber',
      minimumTwoLines: 'El asiento contable debe tener al menos 2 líneas',
      entrySaved: '¡Asiento contable guardado correctamente!',
      entrySavedDesc: '{description} se ha guardado como borrador.',
      error: 'Error',
      failedToSave: 'No se pudo guardar el asiento contable',
    }
  };
