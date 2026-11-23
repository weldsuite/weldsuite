/**
 * Instellingen → Apps → WeldDesk → BI-koppeling: de OData-feed die Power BI en
 * Excel lezen (apps/web/platform/app/settings/apps/welddesk/bi-connector, TASK-1235).
 */

export const deskBi = {
  title: 'BI-koppeling',
  description: 'Lees je helpdeskgegevens in Power BI of Excel via een OData-feed waarmee je alleen kunt lezen.',
  feed: {
    title: 'Feed-URL',
    description: 'Plak dit adres in Power BI of Excel. Het toont alle tabellen hieronder.',
    label: 'OData-feed-URL',
    copy: 'Kopiëren',
    copied: 'Gekopieerd',
    copyFailed: 'Kopiëren is niet gelukt. Selecteer het adres en kopieer het zelf.',
  },
  key: {
    title: 'API-sleutel',
    description:
      'De feed wordt gelezen met een API-sleutel, die je als wachtwoord meegeeft. Maak een sleutel met de machtiging Rapportages (BI-koppeling): die kan helpdeskgegevens lezen en niets anders.',
    action: 'API-sleutel maken',
  },
  tables: {
    title: 'Tabellen',
    description: 'Elke tabel is alleen-lezen. Berichttekst, bijlagen en gespreksopnames zitten er nooit in.',
    name: 'Tabel',
    contains: 'Bevat',
    items: {
      Conversations: 'Gesprekken met status, kanaal, behandelaar, prioriteit, SLA en tijden',
      Messages: 'Elk bericht, elke notitie en elke gebeurtenis bij een gesprek, zonder de tekst',
      SlaClocks: 'De SLA-klokken per gesprek: doel, verstreken tijd en overschrijdingen',
      Calls: 'Telefoongesprekken met richting, uitkomst, wachttijd en duur',
      Teams: 'Teams en hoe ze zijn ingericht',
      TicketTypes: 'Tickettypes en hun standaardwaarden',
      Agents: 'Leden van de werkruimte en of ze actief zijn',
      Problems: 'Problemen met oorzaak, tijdelijke oplossing en oplossing',
      CatalogItems: 'Onderdelen van de servicecatalogus',
      Articles: 'Helpcentrumartikelen met weergaven en stemmen, zonder de tekst',
    },
  },
  powerBi: {
    title: 'Power BI koppelen',
    steps: [
      'Kies in Power BI Desktop Gegevens ophalen en daarna OData-feed.',
      'Plak de feed-URL en kies OK.',
      'Kies Basis. Vul een willekeurige gebruikersnaam in en de API-sleutel als wachtwoord.',
      'Selecteer de tabellen die je nodig hebt en kies Laden.',
    ],
  },
  excel: {
    title: 'Excel koppelen',
    steps: [
      'Open het tabblad Gegevens en kies Gegevens ophalen, Uit andere bronnen, Uit OData-feed.',
      'Plak de feed-URL en kies OK.',
      'Kies Basis. Vul een willekeurige gebruikersnaam in en de API-sleutel als wachtwoord.',
      'Selecteer de tabellen die je nodig hebt en kies Laden.',
    ],
  },
  refresh: {
    title: 'Vernieuwen in de Power BI-service',
    body: 'Open na het publiceren van een rapport de instellingen van de gegevensset in de Power BI-service, bewerk de referenties van de gegevensbron en kies Basis met dezelfde gebruikersnaam en API-sleutel. Zonder dit mislukt een geplande vernieuwing.',
  },
};
