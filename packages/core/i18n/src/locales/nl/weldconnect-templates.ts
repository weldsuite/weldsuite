/**
 * Teksten van de WeldConnect-startsjablonen (de ingebouwde workflowsjablonen
 * die elke workspace in de sjabloongalerij ziet). Zie
 * `../en/weldconnect-templates.ts`: alleen connect-api importeert dit bestand.
 * Behoud bij het vertalen elke `{naam}`-placeholder.
 */
export const weldconnectTemplates = {
  leadFollowUp: {
    name: 'Nieuwe leads opvolgen',
    description: 'Maak bij elke nieuwe lead een opvolgtaak aan in een WeldFlow-project en stuur jezelf een melding.',
    steps: {
      task: 'Opvolgtaak aanmaken',
      notify: 'Mij een melding sturen',
    },
    text: {
      taskTitle: '{name} opvolgen',
      taskDescription: 'Nieuwe lead van {company}. E-mail: {email}, telefoon: {phone}.',
      notifyTitle: 'Nieuwe lead: {name}',
      notifyBody: 'Er is een opvolgtaak aangemaakt: {task}',
    },
  },
  dealWonAnnouncement: {
    name: 'Gewonnen deals vieren',
    description: 'Kondig een gewonnen deal aan in een WeldChat-kanaal en leg een notitie vast bij de deal.',
    steps: {
      announce: 'Aankondigen in WeldChat',
      log: 'Notitie vastleggen',
    },
    text: {
      message: 'Deal gewonnen: {deal} ({amount}).',
      activitySubject: 'Deal gewonnen: {deal}',
      activityDescription: 'Door een workflow aangekondigd in WeldChat.',
    },
  },
  weeklyKickoff: {
    name: 'Wekelijkse kick-offmail met AI',
    description: 'Laat elke maandag om 08:00 AI een korte kick-off voor de week schrijven en mail die naar je team.',
    steps: {
      write: 'Kick-off schrijven met AI',
      email: 'Het team mailen',
    },
    text: {
      prompt:
        'Schrijf een korte, vriendelijke kick-off voor het team voor de week die begint op {date}. Geef drie praktische focustips. Houd het onder de 150 woorden en schrijf platte tekst.',
      subject: 'Kick-off van de week',
    },
  },
  webhookToContact: {
    name: 'Webformulier naar contact en Slack',
    description: 'Ontvang formulierinzendingen op een webhook-URL, voeg de afzender toe als contact en plaats een bericht in een Slack-kanaal.',
    steps: {
      contact: 'Contact aanmaken',
      slack: 'Plaatsen in Slack',
    },
    text: {
      slackText: 'Nieuw contact via het webformulier: {name} ({email})',
    },
  },
  contactApproval: {
    name: 'Nieuwe contacten beoordelen',
    description: 'Vraag om goedkeuring wanneer een contact wordt toegevoegd. Goedgekeurde contacten krijgen het label "geverifieerd" en over afgewezen contacten krijg je een melding.',
    steps: {
      review: 'Om goedkeuring vragen',
      check: 'Goedgekeurd?',
      tag: 'Label geverifieerd toevoegen',
      notify: 'Melden dat het is afgewezen',
    },
    text: {
      reviewTitle: 'Nieuw contact {name} beoordelen',
      reviewDescription: 'Controleer {name} ({email}) en keur goed om het contact als geverifieerd te markeren.',
      tag: 'geverifieerd',
      notifyTitle: 'Contact niet goedgekeurd: {name}',
      notifyBody: 'Opmerking: {comment}',
    },
  },
  companyToSheet: {
    name: 'Nieuwe bedrijven bijhouden in Google Sheets',
    description: 'Voeg een rij toe aan een Google Sheet voor elk nieuw bedrijf in WeldCRM.',
    steps: {
      row: 'Rij toevoegen',
    },
    text: {
      columnName: 'Naam',
      columnWebsite: 'Website',
      columnIndustry: 'Branche',
      columnEmail: 'E-mail',
      columnPhone: 'Telefoon',
    },
  },
  workflowFailureAlert: {
    name: 'Melding als een workflow mislukt',
    description: 'Krijg een melding zodra een run van een andere workflow mislukt, met een link naar die run.',
    steps: {
      notify: 'Mij een melding sturen',
    },
    text: {
      title: 'Workflow mislukt: {workflow}',
      body: 'Een run van {workflow} is niet voltooid. Open de run om te zien wat er misging.',
    },
  },
  aiLeadTriage: {
    name: 'Nieuwe leads sorteren met AI',
    description: 'Laat AI elke nieuwe lead beoordelen als warm, lauw of koud en krijg direct een melding over de warme leads.',
    steps: {
      classify: 'Lead beoordelen met AI',
      check: 'Warme lead?',
      notify: 'Mij een melding sturen',
    },
    text: {
      classifyText: 'Lead: {name}, {title} bij {company} ({website}). Bron: {source}.',
      hot: 'Warm',
      warm: 'Lauw',
      cold: 'Koud',
      notifyTitle: 'Warme lead: {name}',
      notifyBody: '{company} lijkt goed te passen. Volg snel op.',
    },
  },
  welcomeEmail: {
    name: 'Welkomstmail voor nieuwe contacten',
    description: 'Stuur een contact een dag na het toevoegen een welkomstmail vanuit je standaard WeldMail-account.',
    steps: {
      wait: 'Een dag wachten',
      check: 'Heeft een e-mailadres?',
      email: 'Welkomstmail versturen',
    },
    text: {
      subject: 'Welkom, {firstName}',
      body: '<p>Hoi {firstName},</p><p>Bedankt voor je bericht. Fijn dat je er bent, we nemen snel contact met je op.</p><p>Met vriendelijke groet</p>',
    },
  },
};
