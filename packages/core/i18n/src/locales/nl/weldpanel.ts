/**
 * WeldPanel — productanalyse en sessie-opnames.
 *
 * Fase 1 (verzamelen): projecten, hun instellingen en de installatiepagina.
 * Rapporten, funnels en opnames komen in latere fases.
 */
export const weldpanel = {
  title: 'WeldPanel',
  breadcrumb: {
    home: 'WeldPanel',
    projects: 'Projecten',
  },
  noAccess: 'Je hebt geen toegang tot WeldPanel.',
  retry: 'Opnieuw proberen',

  kinds: {
    website: 'Website',
    app: 'Web-app',
  },
  kindHints: {
    website: 'Een bedrijfssite, webshop of blog. Bezoekers zijn meestal anoniem.',
    app: 'Een product waarop mensen inloggen. Die gebruikers kun je later herkennen.',
  },
  statuses: {
    active: 'Actief',
    paused: 'Gepauzeerd',
  },

  validation: {
    nameRequired: 'Vul een naam in.',
    nameTooLong: 'Gebruik maximaal 255 tekens.',
    domainInvalid: 'Vul een host in zoals voorbeeld.nl, shop.voorbeeld.nl of *.voorbeeld.nl.',
    domainDuplicate: 'Dit domein staat al in de lijst.',
    tooManyDomains: 'Voeg maximaal 20 domeinen toe.',
    patternInvalid: 'Begin met een slash, zoals /admin/* of /checkout/bedankt.',
    patternDuplicate: 'Dit patroon staat al in de lijst.',
    tooManyPatterns: 'Voeg maximaal 50 patronen toe.',
  },

  /** The editor behind "allowed domains" and "excluded pages". */
  listEditor: {
    add: 'Toevoegen',
    remove: '{value} verwijderen',
    limitReached: 'Je hebt de limiet van {max} bereikt.',
  },

  home: {
    title: 'Analyse',
    description: 'Zie hoe mensen je website of app gebruiken, en bekijk wat ze deden.',
    newProject: 'Nieuw project',
    emptyTitle: 'Nog geen projecten',
    emptyDescription:
      'Voeg een project toe voor je website of app en plak één scripttag. Verkeer, funnels en sessie-opnames verschijnen binnen een paar minuten.',
    emptyNoCreate: 'Vraag een eigenaar of beheerder van de workspace er een toe te voegen.',
    steps: {
      install: {
        title: 'Voeg het script toe',
        description: 'Eén scripttag op je site, of het npm-pakket in je app.',
      },
      analyse: {
        title: 'Zie waar mensen afhaken',
        description: 'Verkeer, funnels, retentie en klikpaden, uitgesplitst zoals jij wilt.',
      },
      watch: {
        title: 'Bekijk wat er gebeurde',
        description: 'Sessie-opnames en heatmaps, met woedeklikken en fouten gemarkeerd.',
      },
    },
    loadFailed: 'Je projecten konden niet worden geladen.',
    projectLabel: 'Project',
    projectPlaceholder: 'Kies een project',
    allProjects: 'Alle projecten',
    reportsTitle: 'Rapporten zijn de volgende stap',
    reportsDescription:
      'Rapporten over verkeer, pagina’s en bronnen volgen in de volgende fase. Voorlopig verzamelt WeldPanel alleen gebeurtenissen en laat het zien of ze binnenkomen.',
  },

  createDialog: {
    title: 'Nieuw project',
    description: 'Een project is één website of app die je wilt meten. Je kunt er later meer toevoegen.',
    nameLabel: 'Naam',
    namePlaceholder: 'Mijn website',
    kindLabel: 'Soort',
    domainsLabel: 'Toegestane domeinen',
    domainsOptional: 'optioneel',
    domainsHint: 'Alleen gebeurtenissen van deze sites worden geaccepteerd. Laat leeg om gebeurtenissen van elke site te accepteren.',
    submit: 'Project aanmaken',
    creating: 'Aanmaken…',
    cancel: 'Annuleren',
    created: 'Project aangemaakt. Zet het script op je site.',
    createFailed: 'Het project kon niet worden aangemaakt.',
  },

  projects: {
    title: 'Projecten',
    description: 'De websites en apps die je meet.',
    newProject: 'Nieuw project',
    loadFailed: 'Je projecten konden niet worden geladen.',
    emptyTitle: 'Nog geen projecten',
    emptyDescription: 'Voeg een project toe voor je website of app om een script te krijgen dat je kunt plakken.',
    table: {
      name: 'Naam',
      kind: 'Soort',
      status: 'Status',
      domains: 'Domeinen',
      created: 'Aangemaakt',
    },
    anySite: 'Elke site',
    moreDomains: '+{count} meer',
  },

  project: {
    notFound: 'Dit project bestaat niet of is verwijderd.',
    loadFailed: 'Het project kon niet worden geladen.',
    back: 'Alle projecten',
    created: 'Aangemaakt op {date}',
    pausedTitle: 'Verzamelen staat op pauze',
    pausedDescription: 'De collector negeert gebeurtenissen van dit project totdat het verzamelen wordt hervat.',
    tabs: {
      install: 'Installatie',
      general: 'Algemeen',
      privacy: 'Privacy & verzamelen',
      danger: 'Gevarenzone',
    },
  },

  install: {
    statusTitle: 'Installatiestatus',
    waiting: 'Wachten op de eerste gebeurtenis',
    receiving: 'Gebeurtenissen komen binnen',
    paused: 'Verzamelen gepauzeerd',
    lastEvent: 'Laatste gebeurtenis {time}',
    arriving: 'Er komen gebeurtenissen binnen.',
    noEvents: 'Nog geen gebeurtenissen.',
    pausedNote: 'Gebeurtenissen worden genegeerd zolang het verzamelen op pauze staat.',
    pollHint: 'Deze pagina controleert het elke 10 seconden.',
    checklistTitle: 'Ontvang je eerste gebeurtenis',
    steps: {
      paste: 'Zet het script op je site',
      open: 'Open je site in een browser',
      wait: 'Wacht tot de eerste gebeurtenis hier verschijnt',
    },
    loadFailed: 'De installatie kon niet worden gecontroleerd.',
    openProject: 'Installatie-instructies',
    scriptTitle: 'Scripttag',
    scriptDescription: 'Plak hem in de <head> van elke pagina die je wilt meten.',
    npmTitle: 'npm-pakket',
    npmDescription: 'Voor apps die hun code bundelen. Installeer het pakket en initialiseer het één keer, bij het opstarten.',
    tokenLabel: 'Projecttoken',
    tokenHint: 'Veilig om in de paginabron te zetten: hij kan alleen gegevens versturen.',
    copy: 'Kopiëren',
    copied: 'Gekopieerd',
    copyLabel: '{label} kopiëren',
    copyFailed: 'Kopiëren is niet gelukt. Selecteer de tekst en kopieer hem zelf.',
  },

  general: {
    title: 'Algemeen',
    description: 'De naam van het project, wat het is en welke sites gebeurtenissen mogen versturen.',
    nameLabel: 'Naam',
    kindLabel: 'Soort',
    domainsLabel: 'Toegestane domeinen',
    domainsHint:
      'Alleen gebeurtenissen van deze sites worden geaccepteerd. Gebruik *.voorbeeld.nl voor alle subdomeinen. Een lege lijst accepteert gebeurtenissen van elke site.',
    anySite: 'Elke site',
    save: 'Wijzigingen opslaan',
    saving: 'Opslaan…',
    saved: 'Wijzigingen opgeslagen',
    saveFailed: 'De wijzigingen konden niet worden opgeslagen.',
  },

  privacy: {
    title: 'Privacy & verzamelen',
    description: 'Wat het script verzamelt en wanneer het mag beginnen.',
    autocaptureLabel: 'Automatisch vastleggen',
    autocaptureDescription:
      'Leg klikken en verzonden formulieren automatisch vast, met de tekst van het element. Zet dit uit om alleen de gebeurtenissen te versturen die je zelf meet.',
    on: 'Aan',
    off: 'Uit',
    consentLabel: 'Toestemming',
    consent: {
      required: {
        label: 'Wachten op toestemming',
        description:
          'Zolang je site weldpanel.consent.grant() niet aanroept, telt WeldPanel anoniem: alleen paginaweergaven en gebeurtenissen, geen cookies of opslag, geen opnames, geen identiteit. Aanbevolen bij bezoekers uit de EU.',
      },
      none: {
        label: 'Meten zonder toestemming',
        description:
          'Volledig meten begint bij de eerste paginaweergave. Kies dit alleen als je publiek geen toestemming hoeft te geven.',
      },
    },
    maskingLabel: 'Maskering',
    maskingDescription:
      'Wat verborgen wordt. Dit geldt nu voor de tekst van vastgelegde elementen en later voor sessie-opnames, die in een volgende fase komen. Wachtwoordvelden worden altijd gemaskeerd.',
    masking: {
      strict: {
        label: 'Streng',
        description: 'Maskeert alle tekst en invoer en blokkeert afbeeldingen.',
      },
      balanced: {
        label: 'Gebalanceerd',
        description: 'Maskeert alle invoer. Paginatekst blijft zichtbaar.',
      },
      relaxed: {
        label: 'Soepel',
        description: 'Maskeert alleen wachtwoordvelden en velden die jij als gevoelig markeert.',
      },
    },
    excludedLabel: 'Uitgesloten pagina’s',
    excludedDescription:
      'Pagina’s waarvan het pad bij een patroon past, worden niet gemeten. * past bij elke tekenreeks, bijvoorbeeld /admin/* of /checkout/bedankt.',
    excludedPlaceholder: '/admin/*',
    excludedNone: 'Er zijn geen pagina’s uitgesloten.',
    readOnlyNote: 'Alleen mensen die WeldPanel-projecten mogen beheren, kunnen deze instellingen wijzigen.',
    save: 'Instellingen opslaan',
    saving: 'Opslaan…',
    saved: 'Instellingen opgeslagen',
    saveFailed: 'De instellingen konden niet worden opgeslagen.',
  },

  danger: {
    title: 'Gevarenzone',
    pause: {
      title: 'Verzamelen pauzeren',
      description: 'De collector negeert gebeurtenissen van dit project totdat je hervat. Je site blijft gewoon werken.',
      button: 'Verzamelen pauzeren',
      confirmTitle: 'Verzamelen pauzeren?',
      confirmDescription: 'Gebeurtenissen van {name} worden genegeerd zolang het project gepauzeerd is. In die tijd wordt niets verzameld.',
      confirm: 'Pauzeren',
      done: 'Verzamelen gepauzeerd',
      failed: 'Het verzamelen kon niet worden gepauzeerd.',
    },
    resume: {
      title: 'Verzamelen hervatten',
      description: 'Het verzamelen staat op pauze. Hervat het om weer gebeurtenissen van dit project te accepteren.',
      button: 'Verzamelen hervatten',
      done: 'Verzamelen hervat',
      failed: 'Het verzamelen kon niet worden hervat.',
    },
    rotate: {
      title: 'Projecttoken vernieuwen',
      description: 'Geef het project een nieuw token. Het script op je site werkt dan meteen niet meer, dus vervang het direct.',
      button: 'Token vernieuwen',
      confirmTitle: 'Token vernieuwen?',
      confirmDescription:
        'Het script dat nu op {name} staat, werkt meteen niet meer: gebeurtenissen met het oude token worden geweigerd totdat je het nieuwe script plakt.',
      confirm: 'Token vernieuwen',
      done: 'Token vernieuwd. Vervang het script op je site.',
      failed: 'Het token kon niet worden vernieuwd.',
    },
    delete: {
      title: 'Project verwijderen',
      description:
        'De collector accepteert het token van dit project meteen niet meer. Het project verdwijnt uit WeldPanel en kan hier niet worden hersteld.',
      button: 'Project verwijderen',
      dialogTitle: '{name} verwijderen?',
      dialogDescription:
        'Gebeurtenissen van je site worden vanaf nu geweigerd en het project verdwijnt uit WeldPanel. Dit kun je hier niet ongedaan maken.',
      confirmLabel: 'Typ {name} om te bevestigen',
      confirm: 'Project verwijderen',
      cancel: 'Annuleren',
      done: 'Project verwijderd',
      failed: 'Het project kon niet worden verwijderd.',
    },
    cancel: 'Annuleren',
  },
};
