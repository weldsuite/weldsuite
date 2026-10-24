/**
 * Signer-facing copy, en + nl. The language is the recipient's locale (set by
 * the sender) once the envelope is loaded; before that the browser's
 * Accept-Language decides. The signer can switch at any time.
 *
 * Dutch uses the informal "je".
 */

export type Locale = 'en' | 'nl';
export const DEFAULT_LOCALE: Locale = 'en';
export const LOCALES: readonly Locale[] = ['en', 'nl'];

const en = {
  metaTitle: 'Sign a document',
  metaDescription: 'Review and sign the document that was sent to you.',
  home: {
    title: 'Sign a document',
    body: 'Open the link in the email you received to review and sign the document.',
  },
  poweredBy: 'Electronic signatures by WeldSign',
  language: 'Language',
  loading: 'Loading',

  opening: {
    title: 'Opening your document',
  },
  notFound: {
    title: 'This link does not work',
    body: 'The link is not valid or is no longer active. Ask the person who sent it to you for a new one.',
  },
  error: {
    title: 'Something went wrong',
    body: 'We could not load your document. Check your connection and try again.',
    retry: 'Try again',
    generic: 'Something went wrong. Please try again.',
    network: 'We could not reach the server. Check your connection and try again.',
  },

  code: {
    emailTitle: 'Enter your code',
    emailBody: (hint: string | null) =>
      hint ? `We sent a code to ${hint}. Enter it to open the document.` : 'We sent a code to your email address. Enter it to open the document.',
    accessTitle: 'Enter the access code',
    accessBody: 'The sender shared an access code with you. Enter it to open the document.',
    label: 'Code',
    submit: 'Continue',
    verifying: 'Checking',
    resend: 'Send a new code',
    resent: 'We sent you a new code.',
    wrongCode: (attemptsLeft: number | null) =>
      attemptsLeft === null
        ? 'That code is not correct.'
        : attemptsLeft === 1
          ? 'That code is not correct. You have 1 attempt left.'
          : `That code is not correct. You have ${attemptsLeft} attempts left.`,
    locked: 'Too many wrong attempts. Ask the sender to send you a new link.',
    tooManyResends: 'You asked for a code a moment ago. Wait a minute and try again.',
  },

  closed: {
    expired: {
      title: 'This request has expired',
      body: 'The time to sign this document has passed. Ask the sender to send it again.',
    },
    voided: {
      title: 'This request was cancelled',
      body: 'The sender cancelled this request, so the document can no longer be signed.',
    },
    declined: {
      title: 'This request was declined',
      body: 'A signer declined to sign, so the document can no longer be signed.',
    },
    youDeclined: {
      title: 'You declined to sign',
      body: 'We told the sender. You can close this page.',
    },
  },

  consent: {
    title: 'Before you sign',
    intro: (sender: string, title: string) => `${sender} asked you to review and sign "${title}".`,
    introNoSender: (title: string) => `You were asked to review and sign "${title}".`,
    disclosureTitle: 'Electronic records and signatures',
    disclosure: [
      'By selecting "I agree" you agree to review and sign this document electronically.',
      'Your electronic signature is as binding as a handwritten signature.',
      'You can download a copy of the signed document once everyone has signed.',
      'You can ask the sender for a paper copy at any time.',
      'You do not have to agree. You can decline to sign instead.',
    ],
    agree: 'I agree',
    agreeing: 'Saving',
    decline: 'Decline to sign',
    review: 'Review the document',
  },

  sign: {
    from: (sender: string) => `From ${sender}`,
    page: (n: number, total: number) => `Page ${n} of ${total}`,
    pdfLoading: 'Loading document',
    pdfFailed: 'We could not show this document.',
    pdfRetry: 'Try again',
    fieldsLeft: (n: number) => (n === 1 ? '1 required field left' : `${n} required fields left`),
    allDone: 'All required fields are filled in',
    next: 'Next field',
    start: 'Start',
    finish: 'Finish',
    finishing: 'Finishing',
    menu: 'More options',
    decline: 'Decline to sign',
    finishFailed: 'We could not finish signing. Check your fields and try again.',
    sessionExpired: 'Your session expired. Open the link again if this keeps happening.',
    signHere: 'Sign here',
    initialHere: 'Initial',
    signatureField: 'Signature field',
    initialsField: 'Initials field',
    changeSignature: 'Change signature',
    changeInitials: 'Change initials',
    textField: 'Text field',
    checkboxField: 'Checkbox',
    autoField: 'Filled in automatically',
    required: 'required',
  },

  adopt: {
    signatureTitle: 'Adopt your signature',
    initialsTitle: 'Adopt your initials',
    description: 'This is used for every field of this kind in the document.',
    tabDraw: 'Draw',
    tabType: 'Type',
    tabUpload: 'Upload',
    drawLabel: 'Draw here with your finger or mouse',
    drawArea: 'Drawing area',
    clear: 'Clear',
    typeLabel: 'Your name',
    typeLabelInitials: 'Your initials',
    typePreview: 'Preview',
    uploadChoose: 'Choose an image',
    uploadReplace: 'Choose another image',
    uploadHint: 'Use a photo or scan of your signature on white paper. PNG or JPG.',
    uploadInvalid: 'That file is not an image we can read.',
    uploadTooBig: 'That image is too large. Choose one under 8 MB.',
    empty: 'Add your signature first.',
    emptyInitials: 'Add your initials first.',
    tooLarge: 'That signature is too detailed. Clear it and try a simpler one.',
    confirm: 'Adopt and use',
    cancel: 'Cancel',
    close: 'Close',
  },

  decline: {
    title: 'Decline to sign',
    body: 'The sender will be told that you declined and why. This cannot be undone.',
    reasonLabel: 'Reason',
    reasonPlaceholder: 'Tell the sender why you are not signing',
    reasonRequired: 'Enter a reason.',
    submit: 'Decline',
    submitting: 'Declining',
    cancel: 'Go back',
    failed: 'We could not send your answer. Please try again.',
  },

  result: {
    signedTitle: 'You have signed',
    signedBody: 'Thank you. We will email you the signed document when everyone has signed.',
    notYetTitle: 'It is not your turn yet',
    notYetBody: 'Other people have to sign first. We will email you when it is your turn.',
    completedTitle: 'Everyone has signed',
    completedBody: 'The document is complete. Download your signed copy below.',
    download: 'Download signed PDF',
    sentBy: (sender: string) => `Sent by ${sender}`,
  },
};

export type Dictionary = typeof en;

const nl: Dictionary = {
  metaTitle: 'Document ondertekenen',
  metaDescription: 'Bekijk en onderteken het document dat naar je is gestuurd.',
  home: {
    title: 'Document ondertekenen',
    body: 'Open de link in de e-mail die je hebt ontvangen om het document te bekijken en te ondertekenen.',
  },
  poweredBy: 'Elektronische handtekeningen via WeldSign',
  language: 'Taal',
  loading: 'Laden',

  opening: {
    title: 'Je document wordt geopend',
  },
  notFound: {
    title: 'Deze link werkt niet',
    body: 'De link is niet geldig of niet meer actief. Vraag degene die hem naar je stuurde om een nieuwe.',
  },
  error: {
    title: 'Er ging iets mis',
    body: 'We konden je document niet laden. Controleer je verbinding en probeer het opnieuw.',
    retry: 'Opnieuw proberen',
    generic: 'Er ging iets mis. Probeer het opnieuw.',
    network: 'We konden de server niet bereiken. Controleer je verbinding en probeer het opnieuw.',
  },

  code: {
    emailTitle: 'Vul je code in',
    emailBody: (hint: string | null) =>
      hint ? `We hebben een code gestuurd naar ${hint}. Vul die in om het document te openen.` : 'We hebben een code naar je e-mailadres gestuurd. Vul die in om het document te openen.',
    accessTitle: 'Vul de toegangscode in',
    accessBody: 'De afzender heeft een toegangscode met je gedeeld. Vul die in om het document te openen.',
    label: 'Code',
    submit: 'Doorgaan',
    verifying: 'Controleren',
    resend: 'Stuur een nieuwe code',
    resent: 'We hebben je een nieuwe code gestuurd.',
    wrongCode: (attemptsLeft: number | null) =>
      attemptsLeft === null
        ? 'Die code klopt niet.'
        : attemptsLeft === 1
          ? 'Die code klopt niet. Je hebt nog 1 poging.'
          : `Die code klopt niet. Je hebt nog ${attemptsLeft} pogingen.`,
    locked: 'Te veel foute pogingen. Vraag de afzender om je een nieuwe link te sturen.',
    tooManyResends: 'Je hebt zojuist al een code aangevraagd. Wacht een minuut en probeer het opnieuw.',
  },

  closed: {
    expired: {
      title: 'Dit verzoek is verlopen',
      body: 'De tijd om dit document te ondertekenen is voorbij. Vraag de afzender om het opnieuw te sturen.',
    },
    voided: {
      title: 'Dit verzoek is ingetrokken',
      body: 'De afzender heeft dit verzoek ingetrokken, dus het document kan niet meer worden ondertekend.',
    },
    declined: {
      title: 'Dit verzoek is geweigerd',
      body: 'Een ondertekenaar heeft geweigerd te ondertekenen, dus het document kan niet meer worden ondertekend.',
    },
    youDeclined: {
      title: 'Je hebt geweigerd te ondertekenen',
      body: 'We hebben de afzender op de hoogte gebracht. Je kunt deze pagina sluiten.',
    },
  },

  consent: {
    title: 'Voordat je ondertekent',
    intro: (sender: string, title: string) => `${sender} vraagt je om "${title}" te bekijken en te ondertekenen.`,
    introNoSender: (title: string) => `Je wordt gevraagd om "${title}" te bekijken en te ondertekenen.`,
    disclosureTitle: 'Elektronische documenten en handtekeningen',
    disclosure: [
      'Door op "Ik ga akkoord" te klikken ga je ermee akkoord dit document elektronisch te bekijken en te ondertekenen.',
      'Je elektronische handtekening is even bindend als een handgeschreven handtekening.',
      'Je kunt een kopie van het ondertekende document downloaden zodra iedereen heeft ondertekend.',
      'Je kunt de afzender op elk moment om een papieren exemplaar vragen.',
      'Je hoeft niet akkoord te gaan. Je kunt ook weigeren te ondertekenen.',
    ],
    agree: 'Ik ga akkoord',
    agreeing: 'Opslaan',
    decline: 'Weigeren te ondertekenen',
    review: 'Bekijk het document',
  },

  sign: {
    from: (sender: string) => `Van ${sender}`,
    page: (n: number, total: number) => `Pagina ${n} van ${total}`,
    pdfLoading: 'Document laden',
    pdfFailed: 'We konden dit document niet tonen.',
    pdfRetry: 'Opnieuw proberen',
    fieldsLeft: (n: number) => (n === 1 ? 'Nog 1 verplicht veld' : `Nog ${n} verplichte velden`),
    allDone: 'Alle verplichte velden zijn ingevuld',
    next: 'Volgend veld',
    start: 'Start',
    finish: 'Afronden',
    finishing: 'Afronden',
    menu: 'Meer opties',
    decline: 'Weigeren te ondertekenen',
    finishFailed: 'We konden het ondertekenen niet afronden. Controleer je velden en probeer het opnieuw.',
    sessionExpired: 'Je sessie is verlopen. Open de link opnieuw als dit blijft gebeuren.',
    signHere: 'Teken hier',
    initialHere: 'Paraaf',
    signatureField: 'Handtekeningveld',
    initialsField: 'Paraafveld',
    changeSignature: 'Handtekening wijzigen',
    changeInitials: 'Paraaf wijzigen',
    textField: 'Tekstveld',
    checkboxField: 'Selectievakje',
    autoField: 'Wordt automatisch ingevuld',
    required: 'verplicht',
  },

  adopt: {
    signatureTitle: 'Kies je handtekening',
    initialsTitle: 'Kies je paraaf',
    description: 'Deze wordt gebruikt voor elk veld van dit soort in het document.',
    tabDraw: 'Tekenen',
    tabType: 'Typen',
    tabUpload: 'Uploaden',
    drawLabel: 'Teken hier met je vinger of muis',
    drawArea: 'Tekenvlak',
    clear: 'Wissen',
    typeLabel: 'Je naam',
    typeLabelInitials: 'Je initialen',
    typePreview: 'Voorbeeld',
    uploadChoose: 'Kies een afbeelding',
    uploadReplace: 'Kies een andere afbeelding',
    uploadHint: 'Gebruik een foto of scan van je handtekening op wit papier. PNG of JPG.',
    uploadInvalid: 'Dat bestand is geen afbeelding die we kunnen lezen.',
    uploadTooBig: 'Die afbeelding is te groot. Kies er een van minder dan 8 MB.',
    empty: 'Zet eerst je handtekening.',
    emptyInitials: 'Zet eerst je paraaf.',
    tooLarge: 'Die handtekening is te gedetailleerd. Wis hem en probeer een eenvoudigere.',
    confirm: 'Kiezen en gebruiken',
    cancel: 'Annuleren',
    close: 'Sluiten',
  },

  decline: {
    title: 'Weigeren te ondertekenen',
    body: 'De afzender krijgt te horen dat je hebt geweigerd en waarom. Dit kan niet ongedaan worden gemaakt.',
    reasonLabel: 'Reden',
    reasonPlaceholder: 'Vertel de afzender waarom je niet ondertekent',
    reasonRequired: 'Vul een reden in.',
    submit: 'Weigeren',
    submitting: 'Weigeren',
    cancel: 'Terug',
    failed: 'We konden je antwoord niet versturen. Probeer het opnieuw.',
  },

  result: {
    signedTitle: 'Je hebt ondertekend',
    signedBody: 'Bedankt. We mailen je het ondertekende document zodra iedereen heeft ondertekend.',
    notYetTitle: 'Je bent nog niet aan de beurt',
    notYetBody: 'Anderen moeten eerst ondertekenen. We mailen je zodra je aan de beurt bent.',
    completedTitle: 'Iedereen heeft ondertekend',
    completedBody: 'Het document is compleet. Download hieronder je ondertekende kopie.',
    download: 'Ondertekende PDF downloaden',
    sentBy: (sender: string) => `Verstuurd door ${sender}`,
  },
};

export const dictionaries: Record<Locale, Dictionary> = { en, nl };

export function isLocale(value: unknown): value is Locale {
  return value === 'en' || value === 'nl';
}

/** First supported locale in an `Accept-Language` header, else the default. */
export function localeFromAcceptLanguage(header: string | null | undefined): Locale {
  if (!header) return DEFAULT_LOCALE;
  for (const part of header.split(',')) {
    const lang = part.split(';')[0]?.trim().toLowerCase().split('-')[0];
    if (lang === 'en' || lang === 'nl') return lang;
  }
  return DEFAULT_LOCALE;
}
