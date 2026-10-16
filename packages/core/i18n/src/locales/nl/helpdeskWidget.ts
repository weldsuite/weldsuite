/**
 * Chatwidget-voorbeeld (WeldDesk > Chatwidget): de voorbeeldwidget in de editor.
 */
export const helpdeskWidget = {
  nav: {
    home: 'Home',
    chat: 'Chat',
    help: 'Help',
    status: 'Status',
    changelog: 'Changelog',
    news: 'Nieuws',
    book: 'Boeken',
    announce: 'Meldingen',
    events: 'Events',
    track: 'Volgen',
  },
  common: {
    close: 'Sluiten',
    back: 'Terug',
  },
  announcements: {
    title: 'Aankondigingen',
    highPriority: 'Hoge prioriteit',
    items: {
      maintenance: {
        title: 'Gepland onderhoud',
        description: 'Ons platform wordt op 20 december van 02:00 tot 04:00 uur UTC onderhouden. In die tijd zijn sommige diensten mogelijk tijdelijk niet beschikbaar.',
        date: '15 december 2024',
      },
      featureLaunch: {
        title: 'Nieuwe functie: geavanceerde analyses',
        description: 'We zijn blij de lancering van ons dashboard voor geavanceerde analyses aan te kondigen. Krijg meer inzicht in je gegevens met aanpasbare rapporten en realtime statistieken.',
        date: '12 december 2024',
      },
      securityUpdate: {
        title: 'Beveiligingsupdate afgerond',
        description: 'We hebben onze nieuwste beveiligingsupdate succesvol afgerond. Alle systemen draaien nu met sterkere versleuteling en verbeterde authenticatieprotocollen.',
        date: '8 december 2024',
      },
      holidayHours: {
        title: 'Openingstijden support tijdens de feestdagen',
        description: 'Let op: ons supportteam is van 24 december tot en met 2 januari beperkt bereikbaar. Op 3 januari zijn we weer op de gewone tijden bereikbaar.',
        date: '5 december 2024',
      },
    },
  },
  appointments: {
    title: 'Afspraak boeken',
    appointmentType: 'Type afspraak',
    videoCall: 'Videogesprek',
    phoneCall: 'Telefoongesprek',
    selectDate: 'Kies een datum',
    selectTime: 'Kies een tijd',
    weekdaysShort: ['Z', 'M', 'D', 'W', 'D', 'V', 'Z'],
    name: 'Naam',
    namePlaceholder: 'Jan de Vries',
    email: 'E-mail',
    notesOptional: 'Opmerkingen (optioneel)',
    notesPlaceholder: 'Waarover wil je praten?',
    bookAppointment: 'Afspraak boeken',
    booked: 'Afspraak geboekt!',
    scheduledFor: 'Je {type} staat gepland op:',
    typeVideo: 'videogesprek',
    typePhone: 'telefoongesprek',
    confirmationNotice: 'Je ontvangt zo meteen een bevestiging per e-mail',
  },
  article: {
    sections: {
      overview: 'Overzicht',
      gettingStarted: 'Aan de slag',
      keyFeatures: 'Belangrijkste functies',
      advancedUsage: 'Geavanceerd gebruik',
      troubleshooting: 'Problemen oplossen',
    },
    minimize: 'Verkleinen',
    expand: 'Vergroten',
    subtitle: 'Lees meer over elke functie voor klantenservice.',
    writtenBy: 'Geschreven door {author}',
    updated: 'Bijgewerkt {when}',
    defaultUpdatedAt: 'meer dan 4 maanden geleden',
    tableOfContents: 'Inhoudsopgave',
    body: {
      heading: 'Customer Service Suite',
      intro: 'De Customer Service Suite combineert de beste AI-agent voor klantondersteuning met een Helpdesk van de volgende generatie, gebouwd op één platform dat de efficiëntie van je team maximaliseert en betere service levert.',
      screenshot: 'Productscreenshot',
      aiAgentHeading: 'Functies van de AI-agent',
      aiAgentText: 'Onze AI is de best presterende AI-agent in klantenservice. Hij lost complexe vraagstukken op met veilige, nauwkeurige antwoorden in gewone gespreksvorm, zonder vaste scripts.',
      benefitsHeading: 'Belangrijkste voordelen',
      benefits: {
        instant: 'Direct antwoord op veelgestelde vragen',
        availability: '24/7 beschikbaar voor klantenservice',
        handoff: 'Naadloze overdracht aan medewerkers wanneer nodig',
        learning: 'Blijft leren van gesprekken',
      },
      gettingStartedHeading: 'Aan de slag',
      gettingStartedText: 'Volg deze eenvoudige stappen om onze klantenservicefuncties te gebruiken:',
      steps: {
        connect: 'Koppel je communicatiekanalen (e-mail, chat, social)',
        configure: 'Stel je AI-agent en kennisbank in',
        roles: 'Stel teamrollen en rechten in',
        customize: 'Pas het uiterlijk van je chatwidget aan',
      },
    },
  },
  changelog: {
    title: 'Changelog',
    tags: {
      newFeature: 'Nieuwe functie',
      automation: 'Automatisering',
      security: 'Beveiliging',
      update: 'Update',
    },
    items: {
      trainFin: {
        title: 'Train Fin om belangrijke kenmerken in elk gesprek te herkennen',
        description: 'Fin kan nu automatisch de kenmerken herkennen die jij definieert, zoals het type probleem,...',
        date: '13 december 2024',
      },
      smartAutomation: {
        title: 'Nieuw: Smart Automation-workflows',
        description: 'Stel complexe automatiseringen met meerdere stappen in met onze visuele builder en door AI voorgestelde optimalisaties.',
        date: '5 december 2024',
      },
      security: {
        title: 'Uitgebreidere beveiligings- en compliancefuncties',
        description: 'Beveiliging op enterprise-niveau met SOC 2 Type II-compliance en geavanceerde versleuteling.',
        date: '28 november 2024',
      },
    },
  },
  events: {
    title: 'Aankomende evenementen',
    categories: {
      webinar: 'webinar',
      workshop: 'workshop',
      conference: 'conferentie',
      meetup: 'meetup',
    },
    online: 'Online',
    attendees: '{count} / {max} deelnemers',
    spotsLeft: 'nog {count} plekken!',
    registered: 'Aangemeld',
    registerNow: 'Nu aanmelden',
    items: {
      roadmapWebinar: {
        title: 'Productroadmap-webinar Q1 2025',
        description: 'Kijk met ons mee naar wat er in Q1 2025 aankomt. Ontdek nieuwe functies en verbeteringen en krijg live antwoord op je vragen.',
        date: '15 januari 2025',
        time: '10:00 - 11:30 PST',
      },
      analyticsWorkshop: {
        title: 'Workshop geavanceerde analyses',
        description: 'Duik diep in ons analyseplatform. Leer best practices, geavanceerde technieken en hoe je eigen dashboards bouwt.',
        date: '22 januari 2025',
        time: '14:00 - 16:00 PST',
      },
      successSummit: {
        title: 'Customer Success Summit 2025',
        description: 'Netwerk met andere gebruikers, deel succesverhalen en leer van experts uit de branche tijdens onze jaarlijkse top.',
        date: '5-6 februari 2025',
        time: '9:00 - 17:00 PST',
      },
      nycMeetup: {
        title: 'Lokale gebruikersmeetup - NYC',
        description: 'Ontmoet andere gebruikers in de regio New York. Informeel netwerken, pizza en gesprekken over het product.',
        date: '30 januari 2025',
        time: '18:00 - 20:00 EST',
      },
    },
  },
  chat: {
    escalation: {
      humanRequested: 'Klant vroeg om hulp van een medewerker',
      aiCannotHelp: 'De AI kan hier niet bij helpen',
      aiDisabled: 'De AI-assistent is niet ingeschakeld. Wil je met een medewerker praten?',
      connectionError: 'Verbindingsfout. Wil je met een medewerker praten?',
      requestedHuman: 'Klant vroeg om met een medewerker te praten',
      forwarded: 'Je verzoek is doorgestuurd naar ons supportteam. Een medewerker helpt je zo snel mogelijk verder.',
    },
    talkToHumanTitle: 'Praat met een medewerker',
    talkToHuman: 'Praat met een mens',
    connectToHuman: 'Verbind met een medewerker',
    continueWithAi: 'Doorgaan met AI',
    createTicketTitle: 'Een supportticket aanmaken?',
    createTicketDescription: 'Hiermee maak je een ticket aan zodat ons team het kan onderzoeken en contact met je opneemt.',
    createTicket: 'Ticket aanmaken',
    notNow: 'Niet nu',
    sendMessage: 'Bericht versturen',
    messagePlaceholder: 'Typ een bericht...',
    launcherAlt: 'Chat',
  },
  faq: {
    title: 'Help',
    searchPlaceholder: 'Zoek hulp...',
    noResults: 'Geen collecties gevonden voor je zoekopdracht',
    articleCount: '{count} artikelen',
    articlePlaceholder: {
      intro: 'Hier verschijnt de volledige inhoud van het artikel. Het artikel bevat gedetailleerde informatie over {title}.',
      details: "Je kunt stapsgewijze instructies, screenshots, video's en andere handige bronnen toevoegen om gebruikers door het proces te leiden.",
      help: 'Heb je extra hulp nodig? Start gerust een gesprek met ons supportteam.',
    },
    collections: {
      gettingStarted: {
        title: 'Aan de slag',
        description: 'Alles wat je moet weten om met ons platform te beginnen.',
        articles: {
          article1: {
            title: 'Je eerste project aanmaken',
            description: 'Leer hoe je je eerste project opzet en configureert.',
          },
          article2: {
            title: 'Teamleden uitnodigen',
            description: 'Voeg medewerkers toe aan je werkruimte.',
          },
          article3: {
            title: 'Het dashboard begrijpen',
            description: 'Navigeer door je hoofddashboard en pas het aan.',
          },
          article4: {
            title: 'Meldingen instellen',
            description: 'Stel waarschuwingen en meldingsvoorkeuren in.',
          },
        },
      },
      accountBilling: {
        title: 'Account en facturatie',
        description: 'Beheer je accountinstellingen, abonnementen en betaalmethoden.',
        articles: {
          article1: {
            title: 'Je profiel bijwerken',
            description: 'Wijzig je naam, e-mailadres en profielfoto.',
          },
          article2: {
            title: 'Abonnementen beheren',
            description: 'Upgrade, downgrade of beëindig je abonnement.',
          },
          article3: {
            title: 'Betaalmethoden',
            description: 'Voeg je betaalgegevens toe of werk ze bij.',
          },
          article4: {
            title: 'Facturen bekijken',
            description: 'Bekijk en download je factuurgeschiedenis.',
          },
        },
      },
      featuresTools: {
        title: 'Functies en tools',
        description: 'Leer hoe je alle beschikbare functies en tools gebruikt.',
        articles: {
          article1: {
            title: 'De chatwidget gebruiken',
            description: 'Configureer en pas je chatwidget aan.',
          },
          article2: {
            title: 'Automatiseringen instellen',
            description: 'Maak geautomatiseerde workflows en antwoorden.',
          },
          article3: {
            title: 'Analyses en rapportage',
            description: 'Volg prestaties en maak rapporten.',
          },
          article4: {
            title: 'Kennisbank opzetten',
            description: 'Maak en organiseer helpartikelen.',
          },
        },
      },
      integrations: {
        title: 'Integraties',
        description: 'Koppel externe tools en diensten.',
        articles: {
          article1: {
            title: 'Slack-integratie',
            description: 'Koppel je werkruimte aan Slack.',
          },
          article2: {
            title: 'Zapier-workflows',
            description: 'Automatiseer taken met Zapier.',
          },
          article3: {
            title: 'CRM-koppelingen',
            description: 'Synchroniseer met Salesforce, HubSpot en meer.',
          },
          article4: {
            title: 'API-documentatie',
            description: 'Bouw eigen integraties met onze API.',
          },
        },
      },
      troubleshooting: {
        title: 'Problemen oplossen',
        description: 'Vind oplossingen voor veelvoorkomende problemen.',
        articles: {
          article1: {
            title: 'Verbindingsproblemen',
            description: 'Los verbindings- en synchronisatieproblemen op.',
          },
          article2: {
            title: 'Inlogproblemen',
            description: 'Los problemen met inloggen en toegang op.',
          },
          article3: {
            title: 'Prestaties optimaliseren',
            description: 'Maak je werkruimte sneller.',
          },
          article4: {
            title: 'Foutmeldingen uitgelegd',
            description: 'Begrijp veelvoorkomende fouten en los ze op.',
          },
        },
      },
    },
  },
  messages: {
    title: 'Berichten',
    emptyTitle: 'Nog geen gesprekken',
    emptyDescription: 'Start een nieuw gesprek met ons supportteam',
    newConversation: 'Nieuw gesprek',
    noResultsTitle: 'Geen resultaten gevonden',
    noResultsDescription: 'Probeer andere zoekwoorden',
    searchPlaceholder: 'Zoek in gesprekken...',
    sendNewMessage: 'Nieuw bericht versturen',
    samples: {
      first: {
        title: 'Third',
        preview: 'Hoi 👋 Waarmee kan ik je helpen?',
        time: '6 dagen geleden',
      },
      second: {
        title: 'Support',
        preview: 'Je probleem is opgelost. Controleer het en bevestig.',
        time: '2 weken geleden',
      },
      third: {
        title: 'Facturatie',
        preview: 'Je factuur voor deze maand staat klaar ter controle.',
        time: '1 maand geleden',
      },
    },
  },
  news: {
    title: 'Nieuws',
    items: {
      funding: {
        title: 'We hebben $50 miljoen opgehaald in onze Series B-ronde',
        description: 'We zijn blij onze Series B-financieringsronde aan te kondigen, geleid door toonaangevende investeerders.',
      },
      enterprise: {
        title: 'Introductie van ons nieuwe Enterprise-abonnement',
        description: 'Het Enterprise-abonnement bevat geavanceerde beveiligingsfuncties, persoonlijke ondersteuning en maatwerkintegraties.',
      },
      g2: {
        title: 'Erkend als leider in het G2 Grid Report',
        description: 'We zijn trots dat we zijn uitgeroepen tot leider in het G2 Winter 2024 Grid Report voor klantenservicesoftware.',
      },
    },
  },
  parcelTracking: {
    goBack: 'Terug',
    trackingDetails: 'Trackinggegevens',
    trackParcel: 'Pakket volgen',
    tracking: 'Bezig met volgen...',
    companyLogoAlt: 'Bedrijfslogo',
    trackingNumberPlaceholder: 'Voer trackingnummer in...',
    enterTrackingNumber: 'Voer een trackingnummer in',
    estimatedDelivery: 'Verwachte levering: {date}',
    trackingHistory: 'Trackinggeschiedenis',
    viewFullDetails: 'Alle details bekijken',
    statuses: {
      delivered: 'Bezorgd',
      in_transit: 'Onderweg',
      pending: 'In afwachting',
      exception: 'Uitzondering',
      unknown: 'Onbekend',
    },
    mock: {
      locations: {
        amsterdam: 'Distributiecentrum Amsterdam',
        rotterdam: 'Hub Rotterdam',
        origin: 'Magazijn van herkomst',
      },
      eventStatuses: {
        departed: 'Vertrokken',
        received: 'Ontvangen',
        pickedUp: 'Opgehaald',
      },
      events: {
        processing: 'Pakket wordt verwerkt in het distributiecentrum',
        departed: 'Pakket is vertrokken uit het depot',
        received: 'Pakket ontvangen in het sorteercentrum',
        pickedUp: 'Pakket opgehaald bij de afzender',
      },
    },
  },
  status: {
    title: 'Systeemstatus',
    allOperational: 'Alle systemen operationeel',
    systemStatusLabel: 'Systeemstatus',
    systemStatus: 'Systeemstatus',
    previousPeriod: 'Vorige periode',
    nextPeriod: 'Volgende periode',
    serviceOperational: '{name} operationeel',
    uptime: '{percentage} uptime',
    levels: {
      operational: 'Operationeel',
      minor: 'Lichte verstoring',
      moderate: 'Gedeeltelijke verstoring',
      major: 'Grote storing',
    },
    services: {
      cloud: 'Attio Cloud',
      webClient: 'Attio Webclient',
      backgroundTasks: 'Achtergrondtaken',
      cloudStorage: 'Attio Cloudopslag',
      helpdesk: 'Klantenhelpdesk',
    },
  },
  home: {
    logoAlt: 'Logo',
    heading: 'Waarmee kunnen we helpen?',
    searchPlaceholder: 'Zoek hulp...',
    sendMessageTitle: 'Stuur ons een bericht',
    sendMessageDescription: 'We reageren zo snel mogelijk',
    helpCenterTitle: 'Helpcentrum',
    helpCenterDescription: 'Vind antwoorden in onze artikelen',
    trackOrderTitle: 'Bestelling volgen',
    trackOrderDescription: 'Bekijk de status van je levering',
    updates: 'Updates',
    updatesTab: 'Updates',
    updateItems: {
      aiFeatures: 'Nieuwe functies met AI',
      aiFeaturesDate: '5 dec',
      performance: 'Prestatieverbeteringen',
      performanceDate: '28 nov',
    },
    quickLinks: 'Snelle links',
    quickLinkItems: {
      gettingStarted: 'Aan de slag',
      accountSettings: 'Accountinstellingen',
      billing: 'Facturatie en abonnementen',
    },
  },
};
