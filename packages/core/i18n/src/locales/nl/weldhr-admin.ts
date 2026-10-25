/**
 * WeldHR — admin screens. Composed into `weldhr` by ./weldhr.ts.
 */
export const weldhrAdmin = {
  settings: {
    title: 'WeldHR-instellingen',
    subtitle: 'Afdelingen, verloftypes en wat medewerkers zelf kunnen in Mijn HR.',
    tabs: {
      departments: 'Afdelingen',
      leaveTypes: 'Verloftypes',
      selfService: 'Zelfservice',
    },

    selfService: {
      title: 'Zelfservice in Mijn HR',
      description: 'Wat medewerkers zelf kunnen doen in Mijn HR. Ziekmelden kan altijd.',
      clockIn: 'Medewerkers kunnen in- en uitklokken',
      leaveRequests: 'Medewerkers kunnen verlof aanvragen',
      declarations: 'Medewerkers kunnen declaraties indienen',
      saved: 'Zelfservice-instellingen opgeslagen',
    },

    departments: {
      subtitle: 'Afdelingen in het organogram, elk met optioneel een bovenliggende afdeling en een hoofd.',
      add: 'Afdeling toevoegen',
      addTitle: 'Afdeling toevoegen',
      editTitle: 'Afdeling bewerken',
      name: 'Naam',
      description: 'Omschrijving',
      parent: 'Bovenliggende afdeling',
      head: 'Afdelingshoofd',
      headAssigned: 'Toegewezen',
      color: 'Kleur',
      employeeCount: 'Medewerkers',
      emptyTitle: 'Nog geen afdelingen',
      emptyDescription: 'Voeg je eerste afdeling toe om de organisatie in te richten.',
      deleteTitle: 'Afdeling verwijderen?',
      deleteDescription:
        '"{name}" verwijderen? Medewerkers in deze afdeling behouden hun toewijzing, maar verliezen de koppeling met de afdeling.',
      deleteMovesChildren: 'De subafdelingen ({count}) komen onder "{parent}" te vallen.',
      deleteMovesChildrenTop: 'De subafdelingen ({count}) worden hoofdafdelingen.',
      nameTaken: 'Er bestaat al een afdeling met deze naam.',
    },

    leaveTypes: {
      subtitle: 'Verlofcategorieën, hun standaard tegoed en of ze goedkeuring vereisen.',
      add: 'Verloftype toevoegen',
      addTitle: 'Verloftype toevoegen',
      editTitle: 'Verloftype bewerken',
      name: 'Naam',
      color: 'Kleur',
      paid: 'Betaald',
      requiresApproval: 'Goedkeuring vereist',
      allowance: 'Standaard tegoed',
      allowanceHint: 'Laat leeg voor een onbeperkt tegoed.',
      blockOverAllowance: 'Aanvragen boven het tegoed blokkeren',
      blockOverAllowanceHint:
        'Als dit aan staat, kan een aanvraag die langer is dan het resterende tegoed niet worden ingediend of goedgekeurd. Staat het uit, dan zien HR en de medewerker alleen een waarschuwing.',
      blocksOverAllowance: 'Niet overschrijden',
      unlimited: 'Onbeperkt',
      daysPerYear: '{count} dag/jaar',
      daysPerYearPlural: '{count} dagen/jaar',
      active: 'Actief',
      inactive: 'Inactief',
      includeInactive: 'Inclusief inactief',
      archivedInstead: '"{name}" heeft aanvragen in de geschiedenis, en is daarom gearchiveerd in plaats van verwijderd.',
      emptyTitle: 'Nog geen verloftypes',
      emptyDescription: 'Voeg een verloftype toe, zoals vakantie of ziekteverlof, om aanvragen bij te houden.',
      deleteTitle: 'Verloftype verwijderen?',
      deleteDescription: '"{name}" verwijderen? Als er aanvragen in de geschiedenis staan, wordt het in plaats daarvan gearchiveerd.',
    },
  },
};
