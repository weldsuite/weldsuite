/**
 * WeldHR — mededelingen: nieuws dat het HR-team voor medewerkers plaatst.
 * Wordt samengevoegd tot `weldhr` door ./weldhr.ts (sleutels zijn `weldhr.announcements.*`).
 */
export const weldhrAnnouncements = {
  announcements: {
    title: 'Mededelingen',
    loadFailed: 'De mededelingen konden niet worden geladen.',
    add: 'Nieuwe mededeling',
    addTitle: 'Nieuwe mededeling',
    editTitle: 'Mededeling bewerken',
    searchPlaceholder: 'Mededelingen zoeken',
    pinned: 'Vastgepind',
    groups: {
      pinned: 'Vastgepind',
      other: 'Mededelingen',
    },
    table: {
      title: 'Mededeling',
      audience: 'Doelgroep',
      read: 'Gelezen door',
      published: 'Geplaatst',
    },
    everyone: 'Iedereen',
    readOf: '{read} van {total}',
    pushSent: 'Pushmelding verstuurd',
    empty: {
      title: 'Nog geen mededelingen',
      description: 'Plaats nieuws voor je medewerkers. Ze zien het in Mijn HR en in de WeldHR-app.',
    },
    form: {
      title: 'Titel',
      titlePlaceholder: 'Waar gaat het over?',
      body: 'Bericht',
      bodyPlaceholder: 'Schrijf je mededeling. Regeleinden blijven behouden.',
      pinned: 'Bovenaan vastpinnen',
      pinnedHint: 'Vastgepinde mededelingen blijven boven nieuwere staan.',
      audience: 'Doelgroep',
      audienceHint: 'Laat op iedereen staan, of kies afdelingen. Hun onderliggende afdelingen horen erbij.',
      selectDepartments: 'Kies afdelingen',
      searchDepartments: 'Afdelingen zoeken',
      noDepartments: 'Geen afdelingen gevonden.',
      notify: 'Een pushmelding versturen',
      notifyHint: 'Meldt de doelgroep één keer in de WeldHR-app. Als je de mededeling later aanpast, volgt er geen nieuwe melding.',
      save: 'Opslaan',
      saving: 'Opslaan…',
      create: 'Mededeling plaatsen',
      cancel: 'Annuleren',
      failed: 'Deze mededeling kon niet worden opgeslagen.',
    },
    delete: {
      title: 'Deze mededeling verwijderen?',
      description: '"{title}" verwijderen? Medewerkers zien deze dan niet meer.',
      failed: 'Deze mededeling kon niet worden verwijderd.',
    },
    reads: {
      title: 'Gelezen door',
      summary: '{read} van {total} medewerkers hebben dit gelezen.',
      readTab: 'Gelezen ({count})',
      notReadTab: 'Niet gelezen ({count})',
      readAt: 'Gelezen {date}',
      emptyRead: 'Niemand heeft dit nog gelezen.',
      emptyNotRead: 'Iedereen heeft dit gelezen.',
      loadFailed: 'Kon niet laden wie dit heeft gelezen.',
    },
  },
};
