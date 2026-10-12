/**
 * WeldReach — koude e-mailoutreach (alleen op aanvraag). Zie docs/plans/weldreach.md.
 */
export const reach = {
  title: 'WeldReach',
  tagline: 'Koude e-mailoutreach vanuit eigen mailboxen',

  access: {
    requestAccess: 'Toegang aanvragen',
    requestTitle: 'Toegang tot WeldReach aanvragen',
    requestIntro:
      'WeldReach is beschikbaar op aanvraag. Vertel ons hoe je het wilt gebruiken; we beoordelen elke aanvraag zelf en reageren meestal binnen twee werkdagen.',
    onlyAdmins: 'Alleen eigenaren en beheerders van de werkruimte kunnen toegang aanvragen.',
    status: {
      none: 'Niet aangevraagd',
      requested: 'Aanvraag in behandeling',
      approved: 'Goedgekeurd',
      rejected: 'Aanvraag afgewezen',
      suspended: 'Toegang opgeschort',
      revoked: 'Toegang ingetrokken',
    },
    pendingTitle: 'Je aanvraag wordt beoordeeld',
    pendingDescription: 'We mailen je zodra WeldReach voor deze werkruimte aanstaat.',
    rejectedTitle: 'Je aanvraag is niet goedgekeurd',
    rejectedDescription: 'Je kunt je antwoorden aanpassen en opnieuw toegang aanvragen.',
    suspendedTitle: 'WeldReach is opgeschort voor deze werkruimte',
    suspendedDescription: 'Er wordt niets meer verstuurd. Neem contact op met support als je denkt dat dit een vergissing is.',
    reason: 'Reden',
    requestAgain: 'Opnieuw aanvragen',
    submitted: 'Aanvraag verstuurd. We laten per e-mail van ons horen.',
    alreadyPending: 'Er loopt al een aanvraag voor deze werkruimte.',
    form: {
      companyName: 'Officiële bedrijfsnaam',
      website: 'Website',
      contactName: 'Contactpersoon',
      contactEmail: 'E-mailadres contactpersoon',
      useCase: 'Waarvoor ga je WeldReach gebruiken?',
      useCasePlaceholder: 'Wie wil je bereiken, met welk aanbod, en waarom zouden ze van je willen horen?',
      expectedDailySends: 'Verwacht aantal e-mails per dag',
      targetCountries: 'Landen die je gaat mailen',
      targetCountriesPlaceholder: 'Kies landen',
      listSource: 'Waar komen je contactlijsten vandaan?',
      listSources: {
        own_customers: 'Onze eigen klanten en oud-klanten',
        own_research: 'Ons eigen onderzoek (bedrijfswebsites, evenementen, doorverwijzingen)',
        bought_list: 'Een gekochte of gehuurde lijst',
        other: 'Anders',
      },
      listSourceDetails: 'Vertel meer over je lijsten',
      consentNotice:
        'In Nederland en Duitsland is ook voor zakelijke e-mailadressen vooraf toestemming nodig, behalve bij bestaande klanten. Mail die landen alleen als je die toestemming hebt.',
      termsTitle: 'Voordat je gaat versturen',
      termsIntro: 'Vink elke verklaring aan om die te bevestigen.',
      submit: 'Aanvraag versturen',
      submitting: 'Versturen…',
    },
    terms: {
      b2b_only: 'We mailen alleen zakelijke adressen, nooit consumenten.',
      comply_with_law:
        'We houden ons aan de anti-spam- en privacywetgeving (AVG, ePrivacy, CAN-SPAM en andere) in elk land dat we mailen, inclusief voorafgaande toestemming waar die verplicht is.',
      identify_and_opt_out:
        'Elke e-mail maakt duidelijk dat wij de afzender zijn en bevat een werkende afmeldmogelijkheid, en we respecteren afmeldingen voorgoed.',
      lawful_lists: 'We gebruiken geen lijsten die zonder rechtsgrond zijn verzameld.',
      suspension:
        'WeldSuite mag het versturen op elk moment pauzeren of opschorten, bijvoorbeeld na klachten, veel bounces of een juridisch verzoek, en mag onze gegevens delen met autoriteiten als de wet dat vereist.',
      responsible_for_content: 'Wij zijn verantwoordelijk voor de inhoud die we versturen en voor de mensen die we benaderen.',
    },
  },
};
