/**
 * WeldBooks India: GST op facturen (plaats van levering, HSN/SAC, splitsing
 * CGST/SGST/IGST), het bedrijfsadres van de administratie en het
 * GST-aangifteoverzicht. Plaatshouders staan als `{name}`. Bereikbaar als
 * `t.weldbooksIn`.
 */
export const weldbooksIn = {
  gst: {
    placeOfSupply: 'Plaats van levering',
    placeOfSupplyAuto: 'Automatisch',
    placeOfSupplyAutoWith: 'Automatisch: {place}',
    placeOfSupplyOutside: 'Buiten India (96)',
    placeOfSupplyHelp:
      'De deelstaat waar de levering plaatsvindt. Die bepaalt CGST + SGST (uw eigen deelstaat) of IGST (een andere deelstaat). Standaard volgt het de GSTIN van de klant, daarna de deelstaat van het adres.',
    placeOfSupplyUnknown:
      'Nog niet bekend: kies de plaats van levering of voeg de GSTIN of de deelstaat van het adres van de klant toe. Zonder dit kan de GST niet in CGST + SGST of IGST worden gesplitst en kan de factuur niet worden gefinaliseerd.',
    hsnSac: 'HSN/SAC',
    hsnSacPlaceholder: 'bijv. 998313',
    hsnSacHelp: 'HSN-code (goederen) of SAC-code (diensten) van 4 tot 8 cijfers, afgedrukt op de belastingfactuur.',
    hsnSacInvalid: 'HSN/SAC moet uit 4 tot 8 cijfers bestaan',
    splitTitle: 'GST-splitsing',
    splitRow: '{label} {rate}% over {amount}',
    components: {
      cgst: 'CGST',
      sgst: 'SGST',
      utgst: 'UTGST',
      igst: 'IGST',
      export: 'Export (nultarief)',
      other: 'GST',
    },
  },

  address: {
    title: 'Bedrijfsadres',
    description:
      'Wordt op elke factuur afgedrukt en geldt als uw plaats van levering. Zonder dit adres kan een factuur niet worden gefinaliseerd.',
    required: 'Vul straat, plaats en land in.',
  },

  gstReturn: {
    title: 'GST-aangifte',
    description:
      'Overzicht van GSTR-1 en GSTR-3B over een periode, berekend uit uw belastingadministratie. Controleer de cijfers hier voordat u aangifte doet op het GST-portaal. Er wordt niets vanuit WeldBooks ingediend.',
    periodStart: 'Van',
    periodEnd: 'Tot',
    thisMonth: 'Deze maand',
    lastMonth: 'Vorige maand',
    thisQuarter: 'Dit kwartaal',
    gstin: 'GSTIN',
    stateCode: 'Deelstaatcode',
    loading: 'Overzicht wordt berekend…',
    loadFailed: 'Het GST-overzicht kon niet worden berekend.',
    retry: 'Probeer opnieuw',
    worksheetOnly: 'Alleen een werkblad: het wordt niet bij het GST-portaal ingediend.',
    tabs: {
      gstr3b: 'GSTR-3B-overzicht',
      gstr1: 'GSTR-1 uitgaande leveringen',
      hsn: 'HSN/SAC-overzicht',
    },
    columns: {
      taxableValue: 'Belastbare waarde',
      igst: 'IGST',
      cgst: 'CGST',
      sgst: 'SGST/UTGST',
      cess: 'Cess',
      total: 'Totaal',
      gstin: 'GSTIN',
      customer: 'Klant',
      invoice: 'Factuur',
      date: 'Datum',
      value: 'Factuurwaarde',
      placeOfSupply: 'Plaats van levering',
      rate: 'Tarief',
      hsnSac: 'HSN/SAC',
      unit: 'UQC',
      quantity: 'Aantal',
      originalInvoice: 'Gecrediteerde factuur',
      category: 'Categorie',
      intraRegistered: 'Binnen deelstaat, geregistreerd',
      intraUnregistered: 'Binnen deelstaat, niet geregistreerd',
      interRegistered: 'Tussen deelstaten, geregistreerd',
      interUnregistered: 'Tussen deelstaten, niet geregistreerd',
    },
    gstr3b: {
      outwardTitle: '3.1 Uitgaande leveringen en inkomende leveringen met verlegging',
      outwardTaxable: '(a) Belaste uitgaande leveringen (behalve nultarief, niet belast en vrijgesteld)',
      zeroRated: '(b) Belaste uitgaande leveringen (nultarief)',
      nilExempt: '(c) Overige uitgaande leveringen (niet belast, vrijgesteld)',
      reverseCharge: '(d) Inkomende leveringen met verlegging',
      interStateTitle: '3.2 Leveringen tussen deelstaten aan niet-geregistreerde personen',
      interStateEmpty: 'Geen leveringen tussen deelstaten aan niet-geregistreerde personen in deze periode.',
      itcTitle: '4 Aftrekbare voorbelasting (ITC)',
      itcOther: '(A)(5) Overige ITC',
      itcReverseCharge: '(A)(3) Inkomende leveringen met verlegging',
      itcTotal: 'Totaal beschikbare ITC',
      paymentTitle: '6.1 Betaling van belasting',
      liability: 'Te betalen belasting op uitgaande leveringen',
      reverseChargeLiability: 'Te betalen belasting bij verlegging (alleen contant)',
      creditUsed: 'Betaald met ITC',
      netPayable: 'Netto contant te betalen',
      carryForward: 'Doorgeschoven ITC',
      totalNetPayable: 'Totaal contant te betalen',
    },
    gstr1: {
      b2bTitle: 'B2B-leveringen aan geregistreerde personen (tabel 4)',
      b2bEmpty: 'Geen leveringen aan geregistreerde personen in deze periode.',
      b2cLargeTitle: 'B2C-leveringen tussen deelstaten boven 2,5 lakh (tabel 5)',
      b2cSmallTitle: 'B2C-leveringen per plaats van levering (tabel 7)',
      b2cEmpty: 'Geen leveringen aan niet-geregistreerde personen in deze periode.',
      exportsTitle: 'Export (tabel 6A)',
      exportsEmpty: 'Geen export in deze periode.',
      nilExemptTitle: 'Niet belaste en vrijgestelde leveringen (tabel 8)',
      nilRated: 'Niet belast',
      exempt: 'Vrijgesteld',
      creditNotesTitle: 'Creditnota\'s (tabel 9B)',
      creditNotesEmpty: 'Geen creditnota\'s in deze periode.',
      totalsTitle: 'Totalen van uitgaande leveringen',
    },
    hsn: {
      title: 'HSN/SAC-overzicht van uitgaande leveringen (tabel 12)',
      empty: 'Geen factuurregels in deze periode.',
      notSpecified: 'Niet opgegeven',
    },
    unknownPlace: 'Onbekend',
    warnings: {
      unsplit_tax:
        'Er is {amount} GST geboekt tegen een tarief zonder CGST/SGST/IGST-splitsing, omdat de plaats van levering niet bekend was. Dit staat in geen van de onderstaande rubrieken. Stel de plaats van levering op die facturen in.',
      missing_hsn: '{count} factuurregels hebben geen HSN/SAC-code. Vul de codes in voordat u tabel 12 indient.',
      missing_place_of_supply: '{count} facturen hebben geen plaats van levering.',
      tax_on_other_documents:
        '{count} regels uit de belastingadministratie van journaalposten of andere documenten zitten in de totalen maar niet in de factuurtabellen.',
    },
  },
};
