export const accounts = {
    title: 'Accounts',
    chartOfAccounts: 'Chart of Accounts',
    accountNumber: 'Account Code',
    accountName: 'Account Name',
    accountType: 'Account Type',
    normalBalance: 'Normal Balance',
    currentBalance: 'Current Balance',
    description: 'Manage your financial account structure',
    descriptionField: 'Description',
    subtype: 'Subtype',
    isActive: 'Is Active',
    isCashAccount: 'Cash Account',
    isBankAccount: 'Bank Account',
    types: {
      asset: 'Asset',
      liability: 'Liability',
      equity: 'Equity',
      revenue: 'Revenue',
      expense: 'Expense'
    },
    subtypes: {
      currentAsset: 'Current Asset',
      fixedAsset: 'Fixed Asset',
      currentLiability: 'Current Liability',
      longTermLiability: 'Long-term Liability',
      ownersEquity: "Owner's Equity",
      operatingRevenue: 'Operating Revenue',
      operatingExpense: 'Operating Expense',
      otherRevenue: 'Other Revenue',
      otherExpense: 'Other Expense',
      cash: 'Cash',
      bank: 'Bank',
      cogs: 'Cost of Goods Sold',
      equity: 'Equity'
    },
    actions: {
      newAccount: 'New Account',
      editAccount: 'Edit Account',
      deleteAccount: 'Delete Account',
      activateAccount: 'Activate Account',
      deactivateAccount: 'Deactivate Account'
    },
    messages: {
      accountCreated: 'Account created successfully',
      accountUpdated: 'Account updated successfully',
      accountDeleted: 'Account deleted successfully',
      cannotDeleteUsedAccount: 'Cannot delete account that has been used in transactions',
      accountCodeExists: 'Account code already exists. Please use a different code.'
    },
    help: {
      accountTypes: {
        title: 'Account Types',
        content: 'Asset: Resources owned by the business (cash, inventory, equipment). Liability: Debts owed by the business (loans, accounts payable). Equity: Owner\'s stake in the business. Revenue: Income from business operations. Expense: Costs of running the business.'
      },
      normalBalance: {
        title: 'Normal Balance',
        content: 'Each account type has a normal balance side. Assets and Expenses normally have debit balances, while Liabilities, Equity, and Revenue normally have credit balances.'
      },
      accountCode: {
        title: 'Account Code Format',
        content: 'Use a systematic numbering scheme: 1000-1999 for Assets, 2000-2999 for Liabilities, 3000-3999 for Equity, 4000-4999 for Revenue, 5000-9999 for Expenses.'
      }
    }
  };
