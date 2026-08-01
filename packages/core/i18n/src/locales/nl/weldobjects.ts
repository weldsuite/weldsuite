/**
 * WeldObjects — door gebruikers gedefinieerde objecten.
 *
 * De placeholders `{object}` / `{objects}` / `{field}` / `{target}` worden bij
 * het renderen vervangen door de labels van de werkruimte zelf. Die labels zijn
 * DATA, geen vertalingen — een werkruimte die een object "Machines" noemt, ziet
 * "Machines" in elke taal.
 */
export const weldobjects = {
  list: {
    nameColumn: 'Naam',
    create: 'Nieuwe {object}',
    created: '{object} aangemaakt',
    notFoundTitle: 'Object niet gevonden',
    notFoundBody: 'Dit object is mogelijk verwijderd of uitgeschakeld.',
    noFieldsTitle: 'Nog geen velden',
    noFieldsBody: 'Voeg minstens één veld toe voordat je een {object} aanmaakt.',
    addFields: 'Velden toevoegen',
  },

  detail: {
    details: 'Gegevens',
    edit: 'Bewerken',
    delete: 'Verwijderen',
    saved: 'Wijzigingen opgeslagen',
    deleted: 'Record verwijderd',
    deleteTitle: 'Deze {object} verwijderen?',
    deleteBody: 'Dit kan niet ongedaan worden gemaakt.',
    notFoundTitle: 'Record niet gevonden',
    backToList: 'Terug naar {objects}',
    noRelated: 'Nog niets gekoppeld',
    unlink: 'Ontkoppelen',
  },

  form: {
    createTitle: 'Nieuwe {object}',
    editTitle: '{object} bewerken',
    requiredField: '{field} is verplicht',
    cancel: 'Annuleren',
    save: 'Opslaan',
    saving: 'Opslaan…',
  },

  create: {
    title: 'Nieuw aangepast object',
    description: 'Definieer een nieuw recordtype voor je werkruimte.',
    pluralLabel: 'Meervoudsnaam',
    pluralPlaceholder: 'Machines',
    singularLabel: 'Enkelvoudsnaam',
    singularPlaceholder: 'Machine',
    slugLabel: 'Identificatie',
    slugHelp:
      'Wordt gebruikt in URL’s en de API (/objects/{slug}). Dit kan later niet worden gewijzigd.',
    descriptionLabel: 'Omschrijving',
    submit: 'Object aanmaken',
    creating: 'Aanmaken…',
  },

  settings: {
    title: 'Aangepaste objecten',
    subtitle: 'Definieer eigen recordtypes met aangepaste velden en relaties.',
    newObject: 'Nieuw object',
    emptyTitle: 'Nog geen aangepaste objecten',
    emptyBody:
      'Maak je eerste object aan om iets bij te houden waar WeldSuite nog niet in voorziet.',
    notFound: 'Object niet gevonden',
    backToObjects: 'Terug naar aangepaste objecten',
    fields: 'Velden',
    records: 'Records',
    relationships: 'Relaties',
    settingsTab: 'Instellingen',
    general: 'Algemeen',
    addField: 'Veld toevoegen',
    editField: 'Bewerken',
    required: 'Verplicht',
    titleField: 'Titelveld',
    titleFieldAuto: 'Automatisch',
    titleFieldHelp: 'Het veld dat als naam van elk record wordt getoond in lijsten en zoekresultaten.',
    noFieldsTitle: 'Nog geen velden',
    noFieldsBody: 'Voeg velden toe om te beschrijven wat dit object opslaat.',
    activate: 'Activeren',
    activateNeedsFields: 'Voeg eerst minstens één veld toe',
    disable: 'Uitschakelen',
    icon: 'Pictogram',
    iconHelp: 'Een Lucide-pictogramnaam, bijv. Box, Wrench, Truck.',
    slugImmutable:
      'De identificatie is permanent — wijzigen zou bestaande records, opgeslagen weergaven en toegekende rechten loskoppelen.',
    integrations: 'Integraties',
    integrationsHelp: 'Kies met welke onderdelen van het platform dit object samenwerkt.',
    integrationEvents: 'Workflows en webhooks',
    integrationEventsHelp:
      'Publiceer gebeurtenissen zodat WeldConnect-workflows op wijzigingen kunnen reageren.',
    integrationSearch: 'Globaal zoeken',
    integrationSearchHelp: 'Neem records op in de zoekresultaten van het platform.',
    integrationAgent: 'AI-tools',
    integrationAgentHelp:
      'Laat WeldAgent en MCP-clients records lezen en aanmaken. Vereist de publieke API, waar de tools doorheen gaan.',
    integrationApi: 'Publieke API',
    integrationApiHelp: 'Stel records beschikbaar via de externe API op api.weldsuite.org.',
    dangerZone: 'Gevarenzone',
    dangerHelp: 'Een object verwijderen wist elk record dat het bevat.',
    deleteObject: '{object} verwijderen',
    deleteObjectTitle: '{object} verwijderen?',
    deleteObjectBody:
      'Dit verwijdert definitief {records} record(s), {fields} veld(en) en {relations} relatie(s).',
    deleteObjectConfirm: 'Alles verwijderen',
    objectDeleted: 'Object verwijderd',
    deleteFieldTitle: 'Veld verwijderen?',
    deleteFieldBody: 'Waarden in “{field}” worden uit elk record verwijderd.',
    status: {
      draft: 'Concept',
      active: 'Actief',
      disabled: 'Uitgeschakeld',
    },
  },

  links: {
    add: 'Relatie toevoegen',
    emptyTitle: 'Nog geen relaties',
    emptyBody:
      'Koppel dit object aan klanten, personen, tickets of een ander aangepast object zodat gerelateerde records aan beide kanten verschijnen.',
    dialogTitle: 'Nieuwe relatie',
    dialogDescription: 'Verbind {object} met een ander recordtype.',
    target: 'Gerelateerd aan',
    targetPlaceholder: 'Kies een recordtype',
    customObject: 'aangepast object',
    cardinalityLabel: 'Soort relatie',
    targetPanelLabel: 'Paneelnaam hier',
    targetPanelHelp: 'Getoond op de records van dit object.',
    sourcePanelLabel: 'Paneelnaam daar',
    sourcePanelHelp: 'Getoond op het gerelateerde record.',
    onDeleteLabel: 'Wanneer het gerelateerde record wordt verwijderd',
    create: 'Relatie aanmaken',
    deleteTitle: 'Relatie verwijderen?',
    deleteBody: 'Bestaande koppelingen via “{link}” worden verwijderd.',
    cardinality: {
      one_to_one: 'Een op een',
      one_to_many: 'Een op veel',
      many_to_one: 'Veel op een',
      many_to_many: 'Veel op veel',
    },
    cardinalityOption: {
      many_to_one: 'Elke {object} hoort bij één {target}',
      one_to_many: 'Elke {object} heeft meerdere {target}',
      many_to_many: 'Veel {object} bij veel {target}',
      one_to_one: 'Elke {object} hoort bij precies één {target}',
    },
    onDelete: {
      set_null: 'ontkoppelen',
      cascade: 'gekoppelde records verwijderen',
      restrict: 'verwijderen blokkeren',
    },
    onDeleteOption: {
      set_null: 'Alleen de koppeling verwijderen',
      cascade: 'De gekoppelde {objects} ook verwijderen',
      restrict: 'Verwijderen voorkomen zolang er koppelingen zijn',
    },
  },

  errors: {
    saveFailed: 'Wijzigingen konden niet worden opgeslagen',
    deleteFailed: 'Verwijderen mislukt',
    updateFailed: 'Record kon niet worden bijgewerkt',
    unlinkFailed: 'Ontkoppelen mislukt',
    createObjectFailed: 'Object kon niet worden aangemaakt',
  },
};
