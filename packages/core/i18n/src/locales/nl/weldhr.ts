/**
 * WeldHR — personeelsbeheer en het medewerkersportaal.
 *
 * Per onderdeel opgesplitst, zie en/weldhr.ts voor de indeling.
 */
import { weldhrAdmin } from './weldhr-admin';
import { weldhrDeclarations } from './weldhr-declarations';
import { weldhrPayroll } from './weldhr-payroll';
import { weldhrPeople } from './weldhr-people';
import { weldhrSelf } from './weldhr-self';
import { weldhrTime } from './weldhr-time';

export const weldhr = {
  title: 'WeldHR',

  common: {
    selectEmployee: 'Kies een medewerker',
    selectClient: 'Kies een klantaccount',
    selectContact: 'Kies een contactpersoon',
    noResults: 'Geen resultaten',
    save: 'Opslaan',
    saving: 'Opslaan…',
    cancel: 'Annuleren',
    create: 'Aanmaken',
    add: 'Toevoegen',
    edit: 'Bewerken',
    delete: 'Verwijderen',
    search: 'Zoeken',
    all: 'Alle',
    none: 'Geen',
    yes: 'Ja',
    no: 'Nee',
    client: 'Klantaccount',
    date: 'Datum',
    from: 'Van',
    to: 'Tot',
    status: 'Status',
    notes: 'Notities',
    actions: 'Acties',
    loadFailed: 'Deze gegevens konden niet worden geladen.',
    saveFailed: 'Je wijzigingen konden niet worden opgeslagen.',
    deleteFailed: 'Dit item kon niet worden verwijderd.',
    internalOnly: 'Alleen intern',
    noPermission: 'Je hebt geen toegang tot deze gegevens.',
  },

  status: {
    employee: {
      onboarding: 'Onboarding',
      active: 'Actief',
      on_leave: 'Met verlof',
      offboarding: 'Uitdiensttreding',
      terminated: 'Uit dienst',
    },
    employmentType: {
      full_time: 'Voltijd',
      part_time: 'Deeltijd',
      contractor: 'Freelancer',
      intern: 'Stagiair',
      temporary: 'Tijdelijk',
    },
    attendance: {
      present: 'Aanwezig',
      late: 'Te laat',
      absent: 'Afwezig',
      excused: 'Afgemeld',
      remote: 'Op afstand',
      half_day: 'Halve dag',
    },
    absence: {
      ongoing: 'Ziek',
      completed: 'Hersteld',
    },
    leave: {
      pending: 'In afwachting',
      approved: 'Goedgekeurd',
      rejected: 'Afgewezen',
      cancelled: 'Geannuleerd',
    },
    declaration: {
      pending: 'In afwachting',
      approved: 'Goedgekeurd',
      rejected: 'Afgewezen',
      paid: 'Uitbetaald',
      cancelled: 'Geannuleerd',
    },
    coaching: {
      open: 'Open',
      acknowledged: 'Bevestigd',
      closed: 'Gesloten',
    },
    coachingCategory: {
      performance: 'Prestaties',
      quality: 'Kwaliteit',
      behavior: 'Gedrag',
      attendance: 'Aanwezigheid',
      development: 'Ontwikkeling',
      recognition: 'Waardering',
    },
    visibility: {
      internal: 'Alleen intern',
      employee: 'Medewerker',
      client: 'Medewerker en klant',
    },
    evaluation: {
      draft: 'Concept',
      submitted: 'Ingediend',
      acknowledged: 'Bevestigd',
    },
    milestone: {
      planned: 'Gepland',
      in_progress: 'Bezig',
      achieved: 'Behaald',
      missed: 'Gemist',
    },
    milestoneType: {
      goal: 'Doel',
      milestone: 'Mijlpaal',
      certification: 'Certificering',
    },
    checklist: {
      in_progress: 'Bezig',
      completed: 'Afgerond',
      cancelled: 'Geannuleerd',
    },
    checklistKind: {
      onboarding: 'Onboarding',
      offboarding: 'Uitdiensttreding',
    },
    assigneeRole: {
      hr: 'HR',
      manager: 'Leidinggevende',
      it: 'IT',
      employee: 'Medewerker',
      other: 'Overig',
    },
    portalAccess: {
      invited: 'Uitgenodigd',
      active: 'Actief',
      revoked: 'Ingetrokken',
    },
    kpiUnit: {
      number: 'Getal',
      percent: 'Procent',
      seconds: 'Seconden',
      minutes: 'Minuten',
      currency: 'Valuta',
    },
    kpiDirection: {
      higher_better: 'Hoger is beter',
      lower_better: 'Lager is beter',
    },
  },

  ...weldhrPeople,
  ...weldhrTime,
  ...weldhrDeclarations,
  ...weldhrPayroll,
  ...weldhrAdmin,
  ...weldhrSelf,
};
