export const accounts = {
    title: 'Cuentas',
    chartOfAccounts: 'Plan de cuentas',
    accountNumber: 'Código de cuenta',
    accountName: 'Nombre de cuenta',
    accountType: 'Tipo de cuenta',
    normalBalance: 'Saldo normal',
    currentBalance: 'Saldo actual',
    description: 'Gestiona la estructura de tus cuentas financieras',
    descriptionField: 'Descripción',
    subtype: 'Subtipo',
    isActive: 'Activo',
    isCashAccount: 'Cuenta de caja',
    isBankAccount: 'Cuenta bancaria',
    types: {
      asset: 'Activo',
      liability: 'Pasivo',
      equity: 'Patrimonio',
      revenue: 'Ingresos',
      expense: 'Gastos'
    },
    subtypes: {
      currentAsset: 'Activo corriente',
      fixedAsset: 'Inmovilizado',
      currentLiability: 'Pasivo corriente',
      longTermLiability: 'Pasivo a largo plazo',
      ownersEquity: 'Patrimonio neto',
      operatingRevenue: 'Ingresos de explotación',
      operatingExpense: 'Gastos de explotación',
      otherRevenue: 'Otros ingresos',
      otherExpense: 'Otros gastos',
      cash: 'Caja',
      bank: 'Banco',
      cogs: 'Coste de ventas',
      equity: 'Patrimonio'
    },
    actions: {
      newAccount: 'Nueva cuenta',
      editAccount: 'Editar cuenta',
      deleteAccount: 'Eliminar cuenta',
      activateAccount: 'Activar cuenta',
      deactivateAccount: 'Desactivar cuenta'
    },
    messages: {
      accountCreated: 'Cuenta creada correctamente',
      accountUpdated: 'Cuenta actualizada correctamente',
      accountDeleted: 'Cuenta eliminada correctamente',
      cannotDeleteUsedAccount: 'No se puede eliminar una cuenta que ha sido utilizada en transacciones',
      accountCodeExists: 'El código de cuenta ya existe. Por favor, usa un código diferente.'
    },
    help: {
      accountTypes: {
        title: 'Tipos de cuenta',
        content: 'Activo: Recursos que posee la empresa (caja, inventario, equipos). Pasivo: Deudas de la empresa (préstamos, cuentas por pagar). Patrimonio: Participación del propietario en la empresa. Ingresos: Ingresos de las operaciones comerciales. Gastos: Costes de funcionamiento de la empresa.'
      },
      normalBalance: {
        title: 'Saldo normal',
        content: 'Cada tipo de cuenta tiene un lado de saldo normal. Los activos y gastos normalmente tienen saldos deudores, mientras que los pasivos, el patrimonio y los ingresos normalmente tienen saldos acreedores.'
      },
      accountCode: {
        title: 'Formato del código de cuenta',
        content: 'Usa un esquema de numeración sistemático: 1000-1999 para Activos, 2000-2999 para Pasivos, 3000-3999 para Patrimonio, 4000-4999 para Ingresos, 5000-9999 para Gastos.'
      }
    }
  };
