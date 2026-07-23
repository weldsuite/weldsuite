export const invoices = {
    title: 'Invoices',
    invoice: 'Invoice',
    invoiceNumber: 'Invoice Number',
    customer: 'Customer',
    issueDate: 'Issue Date',
    dueDate: 'Due Date',
    paymentTerms: 'Payment Terms',
    items: 'Items',
    item: 'Item',
    quantity: 'Quantity',
    unitPrice: 'Unit Price',
    discount: 'Discount',
    lineTotal: 'Line Total',
    subtotal: 'Subtotal',
    tax: 'Tax',
    total: 'Total',
    balanceDue: 'Balance Due',
    paidAmount: 'Paid Amount',
    paymentMethod: 'Payment Method',
    actions: {
      newInvoice: 'New Invoice',
      importInvoice: 'Import Invoice',
      editInvoice: 'Edit Invoice',
      deleteInvoice: 'Delete Invoice',
      sendInvoice: 'Send Invoice',
      printInvoice: 'Print Invoice',
      duplicateInvoice: 'Duplicate Invoice',
      convertToCredit: 'Convert to Credit Note',
      recordPayment: 'Record Payment',
      viewInvoice: 'View Invoice'
    },
    status: {
      draft: 'Draft',
      sent: 'Sent',
      viewed: 'Viewed',
      paid: 'Paid',
      partiallyPaid: 'Partially Paid',
      overdue: 'Overdue',
      cancelled: 'Cancelled'
    },

    // Stats
    stats: {
      totalInvoices: 'Total Invoices',
      totalInvoicesDesc: 'All invoices',
      overdue: 'Overdue',
      overdueDesc: 'Past due date',
      paidLabel: 'Paid',
      paidDesc: 'Total paid',
      pending: 'Pending',
      pendingDesc: 'Awaiting payment',
    },

    // Filters
    filters: {
      all: 'All',
      draft: 'Draft',
      sent: 'Sent',
      unpaid: 'Unpaid',
      paid: 'Paid',
      overdue: 'Overdue',
    },

    // Table headers
    table: {
      invoiceNumber: 'Invoice #',
      customer: 'Customer',
      issueDate: 'Issue Date',
      dueDate: 'Due Date',
      status: 'Status',
      total: 'Total',
      balanceDue: 'Balance Due',
      unknownCustomer: 'Unknown Customer',
    },

    // Actions menu
    actionsMenu: {
      openMenu: 'Open menu',
      actions: 'Actions',
      viewInvoice: 'View Invoice',
      sendByEmail: 'Send by Email',
      duplicate: 'Duplicate',
      downloadPdf: 'Download PDF',
      recordPayment: 'Record Payment',
      duplicateFeature: 'Duplicate feature coming soon',
      pdfDownloadFeature: 'PDF download feature coming soon',
      paymentRecordingFeature: 'Payment recording feature coming soon',
    },

    // Loading and empty states
    loadingInvoices: 'Loading invoices...',
    selectAdministration: 'Please select an administration to view invoices.',

    messages: {
      invoiceCreated: 'Invoice created successfully',
      invoiceSent: 'Invoice sent successfully',
      invoiceStatusUpdated: 'Invoice {status} successfully',
      paymentRecorded: 'Payment recorded successfully',
      cannotEditSent: 'Cannot edit invoice that has been sent',
      confirmSend: 'Are you sure you want to send this invoice?',
      updateFailed: 'Failed to update invoice',
    }
  };
