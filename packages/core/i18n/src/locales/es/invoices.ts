export const invoices = {
    title: 'Facturas',
    invoice: 'Factura',
    invoiceNumber: 'Número de factura',
    customer: 'Cliente',
    issueDate: 'Fecha de emisión',
    dueDate: 'Fecha de vencimiento',
    paymentTerms: 'Condiciones de pago',
    items: 'Líneas',
    item: 'Línea',
    quantity: 'Cantidad',
    unitPrice: 'Precio unitario',
    discount: 'Descuento',
    lineTotal: 'Total de línea',
    subtotal: 'Subtotal',
    tax: 'Impuesto',
    total: 'Total',
    balanceDue: 'Saldo pendiente',
    paidAmount: 'Importe pagado',
    paymentMethod: 'Método de pago',
    actions: {
      newInvoice: 'Nueva factura',
      importInvoice: 'Importar factura',
      editInvoice: 'Editar factura',
      deleteInvoice: 'Eliminar factura',
      sendInvoice: 'Enviar factura',
      printInvoice: 'Imprimir factura',
      duplicateInvoice: 'Duplicar factura',
      convertToCredit: 'Convertir en nota de crédito',
      recordPayment: 'Registrar pago',
      viewInvoice: 'Ver factura'
    },
    status: {
      draft: 'Borrador',
      sent: 'Enviada',
      viewed: 'Vista',
      paid: 'Pagada',
      partiallyPaid: 'Parcialmente pagada',
      overdue: 'Vencida',
      cancelled: 'Cancelada'
    },

    // Stats
    stats: {
      totalInvoices: 'Total de facturas',
      totalInvoicesDesc: 'Todas las facturas',
      overdue: 'Vencidas',
      overdueDesc: 'Con fecha vencida',
      paidLabel: 'Pagadas',
      paidDesc: 'Total pagado',
      pending: 'Pendientes',
      pendingDesc: 'Pendientes de pago',
    },

    // Filters
    filters: {
      all: 'Todas',
      draft: 'Borrador',
      sent: 'Enviadas',
      unpaid: 'Sin pagar',
      paid: 'Pagadas',
      overdue: 'Vencidas',
    },

    // Table headers
    table: {
      invoiceNumber: 'Factura n.º',
      customer: 'Cliente',
      issueDate: 'Fecha de emisión',
      dueDate: 'Fecha de vencimiento',
      status: 'Estado',
      total: 'Total',
      balanceDue: 'Saldo pendiente',
      unknownCustomer: 'Cliente desconocido',
    },

    // Actions menu
    actionsMenu: {
      openMenu: 'Abrir menú',
      actions: 'Acciones',
      viewInvoice: 'Ver factura',
      sendByEmail: 'Enviar por correo electrónico',
      duplicate: 'Duplicar',
      downloadPdf: 'Descargar PDF',
      recordPayment: 'Registrar pago',
      duplicateFeature: 'Función de duplicar próximamente',
      pdfDownloadFeature: 'Función de descarga PDF próximamente',
      paymentRecordingFeature: 'Función de registro de pago próximamente',
    },

    // Loading and empty states
    loadingInvoices: 'Cargando facturas...',
    selectAdministration: 'Selecciona una administración para ver las facturas.',

    messages: {
      invoiceCreated: 'Factura creada correctamente',
      invoiceSent: 'Factura enviada correctamente',
      invoiceStatusUpdated: 'Factura {status} correctamente',
      paymentRecorded: 'Pago registrado correctamente',
      cannotEditSent: 'No se puede editar una factura que ya ha sido enviada',
      confirmSend: '¿Estás seguro de que quieres enviar esta factura?',
      updateFailed: 'No se pudo actualizar la factura',
    }
  };
