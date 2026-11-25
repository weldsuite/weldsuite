/**
 * WeldFlow agile werken, de delen die elk agile scherm deelt: itemtypes,
 * werkwijzen, sprintstatussen, de weergaveschakelaars en de projectinstellingen
 * (Werkwijze, Itemtypes). De strings van de Backlog, het taakpaneel en de
 * epicpagina staan in `flowAgileBacklog`; die van de Pipeline, de sprintpagina,
 * Analyse › Sprints en Gantt › Fasen in `flowAgileSprints`.
 *
 * Tellingen als "1 punt" / "2 punten" zijn meervoudsobjecten: kies er een met
 * `plural(count, forms)`.
 */
export const flowAgile = {
  itemTypes: {
    epic: 'Epic',
    feature: 'Feature',
    /** Een story heet per project een PBI of een user story. */
    story: { pbi: 'PBI', story: 'User story' },
    bug: 'Bug',
    task: 'Taak',
    spike: 'Spike',
    subtask: 'Subtaak',
  },

  itemTypeDescriptions: {
    epic: 'Een groot stuk werk dat items bevat. Verwijder je het, dan blijven de items bestaan.',
    feature: 'Zit tussen een epic en zijn items, als het featureniveau aan staat.',
    story: 'Iets van waarde voor de gebruiker, geschat in punten.',
    bug: 'Iets dat niet werkt zoals het hoort.',
    task: 'Werk dat gedaan moet worden, zonder eigen waarde voor de gebruiker.',
    spike: 'Onderzoek met een vaste tijd dat eindigt in een antwoord, niet in code.',
    subtask: 'Een stap van één item. Gaat met zijn bovenliggende item mee de sprint in.',
  },

  approaches: {
    tasklist: {
      name: 'Takenlijst',
      description: 'Taken met fases, datums en toegewezen personen. WeldFlow zoals het altijd was.',
    },
    predictive: {
      name: 'Voorspellend',
      description: 'Vooraf plannen: fasen met poorten, een baseline en een Gantt-diagram.',
    },
    scrum: {
      name: 'Scrum',
      description: 'Werk in sprints vanuit een geordende backlog, met reviews en retro’s.',
    },
    kanban: {
      name: 'Kanban',
      description: 'Een doorlopende stroom met WIP-limieten op het bord, zonder sprints.',
    },
    hybrid: {
      name: 'Hybride',
      description: 'Fasen en poorten voor de planning, sprints voor de bouw.',
    },
  },

  sprintStatus: {
    planned: 'Gepland',
    active: 'Actief',
    completed: 'Afgerond',
    cancelled: 'Geannuleerd',
  },

  points: { one: '{count} punt', other: '{count} punten' },
  pointsShort: '{count} ptn',
  noEstimate: 'Geen schatting',

  routeLabels: { epics: 'Epics' },

  views: {
    list: 'Lijst',
    backlog: 'Backlog',
    sprints: 'Sprints',
    customReports: 'Eigen rapporten',
    board: 'Bord',
    report: 'Rapport',
    retro: 'Retro',
  },

  shared: {
    save: 'Opslaan',
    saving: 'Opslaan…',
    saved: 'Opgeslagen',
    cancel: 'Annuleren',
    delete: 'Verwijderen',
    open: 'Openen',
    none: 'Geen',
    retry: 'Opnieuw proberen',
    loadFailed: 'Dit kon niet worden geladen.',
    saveFailed: 'Dit kon niet worden opgeslagen. Probeer het opnieuw.',
  },

  // ── Instellingen › Werkwijze ──────────────────────────────────────────────
  delivery: {
    navLabel: 'Werkwijze',
    title: 'Werkwijze',
    description:
      'Hoe dit project oplevert. Het zet alleen standaarden: waarop Taken opent, wat de Pipeline laat zien en welke itemtypes je kunt kiezen. Je taken blijven zoals ze zijn.',
    approachLabel: 'Werkwijze',
    changesTitle: 'Wat dit verandert in het project',
    changes: {
      tasksOpensOnList: 'Taken opent op de lijst',
      tasksOpensOnBacklog: 'Taken opent op de backlog',
      pipelineShowsAll: 'De Pipeline laat al het open werk zien',
      pipelineShowsSprint: 'De Pipeline laat de actieve sprint zien',
      pipelineShowsWip: 'De Pipeline laat WIP-limieten per kolom zien',
      itemTypesOn: 'Items krijgen een type: epics, PBI’s, bugs en meer',
      itemTypesOff: 'Geen itemtypes',
      sprintsOn: 'Sprints met planning, rapporten en retro’s',
      phasesOn: 'Gantt › Fasen plant de fasen en poorten',
      phasesWithSprints: 'Gantt › Fasen laat de sprints binnen elke fase zien',
      nothing: 'Er verandert niets: zo werkt WeldFlow nu.',
    },
    showSuggestedTabs: 'Laat ook de tabbladen zien die bij deze werkwijze passen',
    showSuggestedTabsHint: 'Verbergt de andere tabbladen voor iedereen. Je kunt dit altijd aanpassen onder Tabbladen.',
    sprintsTitle: 'Sprints',
    sprintLength: 'Sprintlengte',
    sprintLengthOption: { one: '{count} week', other: '{count} weken' },
    sprintLengthDays: { one: '{count} dag', other: '{count} dagen' },
    wipTitle: 'WIP-limieten',
    wipDescription:
      'Het maximale aantal items in een Pipeline-kolom. De kolom wordt oranje bij de limiet; er wordt niets geweigerd.',
    wipNone: 'Geen limiet',
    wipNoStages: 'Dit project heeft nog geen pipelinefases.',
    dodTitle: 'Definition of Done',
    dodDescription: 'Waar elke PBI en bug aan moet voldoen voordat hij als klaar telt. Staat bij het item.',
    dodPlaceholder: 'Voeg een criterium toe',
    dodAdd: 'Toevoegen',
    dodRemove: '“{text}” verwijderen',
    dodEmpty: 'Nog geen criteria.',
    managersOnly: 'Alleen projectmanagers kunnen de werkwijze wijzigen.',
  },

  // ── Instellingen › Itemtypes ──────────────────────────────────────────────
  itemTypesSettings: {
    navLabel: 'Itemtypes',
    title: 'Itemtypes',
    description: 'De soorten items die dit project gebruikt. Stel het type van een item in via het taakpaneel of de backlog.',
    notAgile: 'Itemtypes horen bij de werkwijzen Scrum, Kanban en Hybride. Kies er een onder Werkwijze.',
    namingTitle: 'Hoe noem je een story?',
    naming: { pbi: 'PBI (product backlog item)', story: 'User story' },
    featureLevelTitle: 'Featureniveau',
    featureLevelDescription: 'Epics bevatten features en features bevatten items. Uit: epics bevatten de items zelf.',
    typesTitle: 'Types',
    typeColumn: 'Type',
    meaningColumn: 'Wat het is',
    enabledColumn: 'Aan',
    alwaysOn: 'Altijd aan',
    rulesTitle: 'Regels',
    rules: {
      epicDelete: 'Verwijder je een epic, dan blijven de items bestaan: ze staan zonder epic in de backlog.',
      subtaskSprint: 'Een subtaak gaat met zijn bovenliggende item mee de sprint in.',
      typeChange: 'Maak je van een epic een ander type, dan gaan de items eruit.',
    },
  },
};
