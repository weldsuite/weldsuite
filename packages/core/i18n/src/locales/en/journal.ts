export const journal = {
    title: 'Journal',
    entries: 'Journal Entries',
    entry: 'Journal Entry',
    entryNumber: 'Entry Number',
    entryDate: 'Entry Date',
    entryType: 'Entry Type',
    debit: 'Debit',
    credit: 'Credit',
    account: 'Account',
    memo: 'Memo',
    attachment: 'Attachment',
    posted: 'Posted',
    balanced: 'Balanced',
    unbalanced: 'Unbalanced',
    difference: 'Difference',

    // Form sections
    sections: {
      entryInformation: 'Entry Information',
      journalLines: 'Journal Lines',
      additionalNotes: 'Additional Notes',
    },

    // Form labels
    description: 'Description',
    date: 'Date',
    type: 'Entry Type',
    reference: 'Reference Number',
    referenceNumber: 'Reference Number',
    notes: 'Notes',
    lines: 'Lines',
    totalDebits: 'Total Debits',
    totalCredits: 'Total Credits',
    totals: 'Totals',

    // Placeholders
    placeholders: {
      description: 'e.g., Monthly rent payment',
      selectDate: 'Select date',
      reference: 'Optional reference number',
      notes: 'Additional notes or comments about this journal entry',
      selectAccount: 'Select account',
      lineDescription: 'Line description',
      debit: '0.00',
      credit: '0.00',
    },

    // Entry types
    types: {
      manual: 'Manual',
      adjustment: 'Adjustment',
      closing: 'Closing',
      automatic: 'Automatic'
    },

    // Type descriptions
    typeDescriptions: {
      manual: 'Manually created journal entries for regular transactions',
      adjustment: 'End-of-period adjusting entries for accruals, deferrals, or corrections',
      closing: 'Year-end or period-end closing entries to reset temporary accounts',
    },

    // Column headers
    columns: {
      account: 'Account',
      description: 'Description',
      debit: 'Debit',
      credit: 'Credit',
    },

    // Info texts
    infoTexts: {
      balancedEntry: 'A balanced entry means the total debits equal the total credits. This is a fundamental principle of double-entry bookkeeping.',
      debitTooltip: 'Left side of the entry. Increases Assets and Expenses, decreases Liabilities, Equity, and Revenue.',
      creditTooltip: 'Right side of the entry. Increases Liabilities, Equity, and Revenue, decreases Assets and Expenses.',
      entryTypes: 'Journal Entry Types',
    },

    // Status messages
    status: {
      balanced: 'Entry is balanced! Debits and credits are equal.',
      unbalanced: 'Entry is unbalanced. Difference: ',
      notBalanced: 'Entry is not balanced. Debits must equal credits.',
    },

    // Buttons
    buttons: {
      addLine: 'Add Line',
      removeLine: 'Remove Line',
      saveAsDraft: 'Save as Draft',
      saveChanges: 'Save Changes',
      backToJournal: 'Back to journal entries',
    },

    // Validation
    validation: {
      descriptionRequired: 'Description is required',
      entryMustBeBalanced: 'Entry must be balanced (debits must equal credits)',
      minimumTwoLines: 'At least two journal lines are required',
      validationError: 'Validation error',
    },

    // Summary
    summary: {
      entrySummary: 'Entry Summary',
      untitledEntry: 'Untitled Entry',
      linesCount: '{count} lines',
      yes: 'Yes',
      no: 'No',
    },

    actions: {
      newEntry: 'New Entry',
      postEntry: 'Post Entry',
      reverseEntry: 'Reverse Entry',
      copyEntry: 'Copy Entry',
      viewEntry: 'View Entry',
      createNewEntry: 'Create New Journal Entry',
      editEntry: 'Edit Journal Entry',
      editing: 'Editing',
    },

    messages: {
      entryPosted: 'Journal entry posted successfully',
      entryReversed: 'Journal entry reversed successfully',
      mustBalance: 'Total debits must equal total credits',
      minimumTwoLines: 'Journal entry must have at least 2 lines',
      entrySaved: 'Journal entry saved successfully!',
      entrySavedDesc: '{description} has been saved as a draft.',
      error: 'Error',
      failedToSave: 'Failed to save journal entry',
    }
  };
