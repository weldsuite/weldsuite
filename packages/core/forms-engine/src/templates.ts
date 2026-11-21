/**
 * The built-in template gallery. Template content is English; the name and
 * description are shown in the gallery in the member's language. Every
 * definition passes `parseDefinition` (templates.test.ts).
 */

import type { FormDefinitionInput } from './definition';

export type TemplateCategory = 'contact' | 'feedback' | 'events' | 'hr' | 'education' | 'sales' | 'operations';

export interface StarterTemplate {
  id: string;
  category: TemplateCategory;
  name: { en: string; nl: string };
  description: { en: string; nl: string };
  definition: FormDefinitionInput;
}

const contactForm: StarterTemplate = {
  id: 'contact-form',
  category: 'contact',
  name: { en: 'Contact form', nl: 'Contactformulier' },
  description: {
    en: 'Let visitors send you a message with their contact details.',
    nl: 'Laat bezoekers een bericht sturen met hun contactgegevens.',
  },
  definition: {
    blocks: [
      {
        id: 'b_contact',
        ref: 'contact',
        type: 'contact_info',
        title: 'How can we reach you?',
        required: true,
        properties: {},
      },
      {
        id: 'b_subject',
        ref: 'subject',
        type: 'short_text',
        title: 'What is your message about?',
        required: true,
        properties: { maxLength: 200 },
      },
      {
        id: 'b_message',
        ref: 'message',
        type: 'long_text',
        title: 'Your message',
        required: true,
        properties: { maxLength: 5000 },
      },
    ],
    endings: [
      {
        id: 'e_thanks',
        ref: 'thank_you',
        title: 'Thanks for getting in touch!',
        description: 'We will get back to you within one working day.',
      },
    ],
  },
};

const customerFeedback: StarterTemplate = {
  id: 'customer-feedback',
  category: 'feedback',
  name: { en: 'Customer feedback (NPS)', nl: 'Klanttevredenheid (NPS)' },
  description: {
    en: 'Measure your Net Promoter Score and ask unhappy customers what went wrong.',
    nl: 'Meet je Net Promoter Score en vraag ontevreden klanten wat er misging.',
  },
  definition: {
    welcome: {
      title: 'Tell us how we did',
      description: 'A few quick questions, it takes about a minute.',
      buttonText: 'Start',
    },
    blocks: [
      {
        id: 'b_nps',
        ref: 'recommend',
        type: 'nps',
        title: 'How likely are you to recommend us to a friend or colleague?',
        required: true,
        properties: { labels: { left: 'Not likely', right: 'Very likely' } },
      },
      {
        id: 'b_liked',
        ref: 'what_went_well',
        type: 'long_text',
        title: 'Great to hear! What do you like most about us?',
        properties: {},
      },
      {
        id: 'b_wrong',
        ref: 'what_went_wrong',
        type: 'long_text',
        title: 'Sorry to hear that. What went wrong?',
        required: true,
        properties: {},
      },
      {
        id: 'b_follow_up',
        ref: 'follow_up',
        type: 'yes_no',
        title: 'May we contact you about your answers?',
        required: true,
        properties: {},
      },
      {
        id: 'b_email',
        ref: 'email',
        type: 'email',
        title: 'What is your email address?',
        required: true,
        properties: {},
      },
    ],
    endings: [{ id: 'e_thanks', ref: 'thank_you', title: 'Thank you for your feedback!' }],
    logic: [
      {
        blockId: 'b_nps',
        jumps: [
          {
            id: 'j_detractor',
            when: {
              op: 'and',
              conditions: [{ left: { type: 'field', id: 'b_nps' }, operator: 'less_or_equal', right: { type: 'constant', value: 6 } }],
            },
            to: { type: 'block', id: 'b_wrong' },
          },
        ],
      },
      { blockId: 'b_liked', otherwise: { type: 'block', id: 'b_follow_up' } },
      {
        blockId: 'b_follow_up',
        jumps: [
          {
            id: 'j_no_contact',
            when: {
              op: 'and',
              conditions: [{ left: { type: 'field', id: 'b_follow_up' }, operator: 'is', right: { type: 'constant', value: false } }],
            },
            to: { type: 'ending', id: 'e_thanks' },
          },
        ],
      },
    ],
  },
};

const eventRegistration: StarterTemplate = {
  id: 'event-registration',
  category: 'events',
  name: { en: 'Event registration', nl: 'Inschrijving evenement' },
  description: {
    en: 'Collect sign-ups with contact details, dietary needs and consent.',
    nl: 'Verzamel inschrijvingen met contactgegevens, dieetwensen en toestemming.',
  },
  definition: {
    blocks: [
      {
        id: 'b_attendee',
        ref: 'attendee',
        type: 'contact_info',
        title: 'Who is coming?',
        required: true,
        properties: { fields: { phone: { enabled: false, required: false } } },
      },
      {
        id: 'b_guests',
        ref: 'guests',
        type: 'number',
        title: 'How many guests are you bringing?',
        properties: { min: 0, max: 5 },
      },
      {
        id: 'b_dietary',
        ref: 'dietary',
        type: 'multiple_choice',
        title: 'Do you have any dietary requirements?',
        required: true,
        properties: {
          choices: [
            { id: 'c_none', label: 'None' },
            { id: 'c_vegetarian', label: 'Vegetarian' },
            { id: 'c_vegan', label: 'Vegan' },
            { id: 'c_gluten_free', label: 'Gluten-free' },
          ],
          multiple: true,
          allowOther: true,
        },
      },
      {
        id: 'b_consent',
        ref: 'consent',
        type: 'legal',
        title: 'I agree that my details are used to organise this event.',
        required: true,
        properties: {},
      },
    ],
    endings: [
      {
        id: 'e_registered',
        ref: 'registered',
        title: "You're on the list!",
        description: 'We look forward to seeing you.',
      },
    ],
  },
};

const jobApplication: StarterTemplate = {
  id: 'job-application',
  category: 'hr',
  name: { en: 'Job application', nl: 'Sollicitatie' },
  description: {
    en: 'Receive applications with a CV, a portfolio link and a motivation.',
    nl: 'Ontvang sollicitaties met cv, portfoliolink en motivatie.',
  },
  definition: {
    blocks: [
      {
        id: 'b_position',
        ref: 'position',
        type: 'dropdown',
        title: 'Which position are you applying for?',
        required: true,
        properties: {
          choices: [
            { id: 'c_engineer', label: 'Software engineer' },
            { id: 'c_designer', label: 'Product designer' },
            { id: 'c_success', label: 'Customer success manager' },
            { id: 'c_open', label: 'Open application' },
          ],
        },
      },
      {
        id: 'b_applicant',
        ref: 'applicant',
        type: 'contact_info',
        title: 'Your details',
        required: true,
        properties: { fields: { company: { enabled: false, required: false } } },
      },
      {
        id: 'b_portfolio',
        ref: 'portfolio',
        type: 'website',
        title: 'A link to your LinkedIn profile or portfolio',
        properties: {},
      },
      {
        id: 'b_cv',
        ref: 'cv',
        type: 'file_upload',
        title: 'Upload your CV',
        required: true,
        properties: { maxFiles: 1, maxSizeMb: 10, accept: 'documents' },
      },
      {
        id: 'b_motivation',
        ref: 'motivation',
        type: 'long_text',
        title: 'Why do you want to join us?',
        required: true,
        properties: { maxLength: 3000 },
      },
    ],
    endings: [
      {
        id: 'e_thanks',
        ref: 'thank_you',
        title: 'Thanks for applying!',
        description: 'We read every application and will get back to you within two weeks.',
      },
    ],
  },
};

const scoreAtLeast = (n: number) => ({
  op: 'and' as const,
  conditions: [{ left: { type: 'variable' as const, name: 'score' }, operator: 'greater_or_equal' as const, right: { type: 'constant' as const, value: n } }],
});

const knowledgeQuiz: StarterTemplate = {
  id: 'knowledge-quiz',
  category: 'education',
  name: { en: 'Knowledge quiz', nl: 'Kennisquiz' },
  description: {
    en: 'A scored quiz that shows the score and the right answers at the end.',
    nl: 'Een quiz met punten die aan het eind de score en de juiste antwoorden toont.',
  },
  definition: {
    welcome: { title: 'How well do you know the solar system?', buttonText: 'Start the quiz' },
    blocks: [
      {
        id: 'b_q1',
        ref: 'closest_planet',
        type: 'multiple_choice',
        title: 'Which planet is closest to the sun?',
        required: true,
        properties: {
          choices: [
            { id: 'c_q1_venus', label: 'Venus', score: 0 },
            { id: 'c_q1_mercury', label: 'Mercury', score: 1, correct: true },
            { id: 'c_q1_mars', label: 'Mars', score: 0 },
          ],
        },
      },
      {
        id: 'b_q2',
        ref: 'planet_count',
        type: 'multiple_choice',
        title: 'How many planets are in the solar system?',
        required: true,
        properties: {
          choices: [
            { id: 'c_q2_seven', label: '7', score: 0 },
            { id: 'c_q2_eight', label: '8', score: 1, correct: true },
            { id: 'c_q2_nine', label: '9', score: 0 },
          ],
        },
      },
      {
        id: 'b_q3',
        ref: 'red_planet',
        type: 'multiple_choice',
        title: 'Which planet is known as the Red Planet?',
        required: true,
        properties: {
          choices: [
            { id: 'c_q3_jupiter', label: 'Jupiter', score: 0 },
            { id: 'c_q3_mars', label: 'Mars', score: 1, correct: true },
            { id: 'c_q3_saturn', label: 'Saturn', score: 0 },
          ],
        },
      },
    ],
    endings: [
      {
        id: 'e_perfect',
        ref: 'perfect',
        title: 'Perfect!',
        description: 'You got {{var:score}} out of 3.',
        showScore: true,
        showAnswers: true,
      },
      {
        id: 'e_good',
        ref: 'good_effort',
        title: 'Good effort!',
        description: 'You got {{var:score}} out of 3.',
        showScore: true,
        showAnswers: true,
      },
      {
        id: 'e_try_again',
        ref: 'try_again',
        title: 'Try again',
        description: 'You got {{var:score}} out of 3. Have another go!',
        showScore: true,
        showAnswers: true,
      },
    ],
    endingRules: [
      { id: 'j_perfect', when: scoreAtLeast(3), endingId: 'e_perfect' },
      { id: 'j_good', when: scoreAtLeast(1), endingId: 'e_good' },
      {
        id: 'j_try_again',
        when: {
          op: 'and',
          conditions: [{ left: { type: 'variable', name: 'score' }, operator: 'less_than', right: { type: 'constant', value: 1 } }],
        },
        endingId: 'e_try_again',
      },
    ],
  },
};

const leadQualification: StarterTemplate = {
  id: 'lead-qualification',
  category: 'sales',
  name: { en: 'Lead qualification', nl: 'Leadkwalificatie' },
  description: {
    en: 'Score leads on company size, budget and timing, and route them to the right ending.',
    nl: 'Scoor leads op bedrijfsgrootte, budget en timing en stuur ze naar het juiste eindscherm.',
  },
  definition: {
    blocks: [
      {
        id: 'b_size',
        ref: 'company_size',
        type: 'multiple_choice',
        title: 'How many people work at your company?',
        required: true,
        properties: {
          choices: [
            { id: 'c_size_1', label: '1 to 10', score: 0 },
            { id: 'c_size_2', label: '11 to 50', score: 1 },
            { id: 'c_size_3', label: '51 to 200', score: 2 },
            { id: 'c_size_4', label: 'More than 200', score: 3 },
          ],
        },
      },
      {
        id: 'b_budget',
        ref: 'budget',
        type: 'multiple_choice',
        title: 'What is your budget for this project?',
        required: true,
        properties: {
          choices: [
            { id: 'c_budget_1', label: 'Under 1,000 euros', score: 0 },
            { id: 'c_budget_2', label: '1,000 to 10,000 euros', score: 2 },
            { id: 'c_budget_3', label: 'Over 10,000 euros', score: 3 },
            { id: 'c_budget_4', label: 'Not sure yet', score: 1 },
          ],
        },
      },
      {
        id: 'b_timeline',
        ref: 'timeline',
        type: 'multiple_choice',
        title: 'When would you like to start?',
        required: true,
        properties: {
          choices: [
            { id: 'c_time_now', label: 'Right away', score: 2 },
            { id: 'c_time_quarter', label: 'Within three months', score: 1 },
            { id: 'c_time_later', label: 'Just exploring', score: 0 },
          ],
        },
      },
      {
        id: 'b_contact',
        ref: 'contact',
        type: 'contact_info',
        title: 'Where can we reach you?',
        required: true,
        properties: {},
      },
      {
        id: 'b_goals',
        ref: 'goals',
        type: 'long_text',
        title: 'What would you like to achieve?',
        properties: {},
      },
    ],
    endings: [
      {
        id: 'e_thanks',
        ref: 'thank_you',
        title: 'Thanks! We will be in touch.',
      },
      {
        id: 'e_demo',
        ref: 'book_demo',
        title: "Let's talk!",
        description: 'You look like a great fit. A specialist will call you within one working day.',
      },
      {
        id: 'e_self_service',
        ref: 'self_service',
        title: 'Thanks for your interest!',
        description: 'Our self-service plans are a great place to start.',
      },
    ],
    logic: [
      {
        blockId: 'b_budget',
        jumps: [
          {
            id: 'j_small',
            when: {
              op: 'and',
              conditions: [
                { left: { type: 'field', id: 'b_size' }, operator: 'any_of', right: { type: 'constant', value: ['c_size_1'] } },
                { left: { type: 'field', id: 'b_budget' }, operator: 'any_of', right: { type: 'constant', value: ['c_budget_1'] } },
              ],
            },
            to: { type: 'ending', id: 'e_self_service' },
          },
        ],
      },
    ],
    endingRules: [{ id: 'j_demo', when: scoreAtLeast(5), endingId: 'e_demo' }],
  },
};

const itRequest: StarterTemplate = {
  id: 'it-request',
  category: 'operations',
  name: { en: 'IT request', nl: 'IT-verzoek' },
  description: {
    en: 'Let colleagues report IT problems with a category, urgency and screenshots.',
    nl: "Laat collega's IT-problemen melden met categorie, urgentie en schermafbeeldingen.",
  },
  definition: {
    blocks: [
      {
        id: 'b_requester',
        ref: 'requester',
        type: 'contact_info',
        title: 'Who needs help?',
        required: true,
        properties: { fields: { company: { enabled: false, required: false } } },
      },
      {
        id: 'b_category',
        ref: 'category',
        type: 'dropdown',
        title: 'What do you need help with?',
        required: true,
        properties: {
          choices: [
            { id: 'c_hardware', label: 'Hardware' },
            { id: 'c_software', label: 'Software' },
            { id: 'c_access', label: 'Access and accounts' },
            { id: 'c_network', label: 'Network and wifi' },
            { id: 'c_other', label: 'Something else' },
          ],
        },
      },
      {
        id: 'b_priority',
        ref: 'priority',
        type: 'opinion_scale',
        title: 'How urgent is it?',
        required: true,
        properties: { start: 1, end: 5, labels: { left: 'It can wait', right: "I can't work" } },
      },
      {
        id: 'b_description',
        ref: 'description',
        type: 'long_text',
        title: 'Describe the problem',
        description: 'What happened, and what did you expect to happen?',
        required: true,
        properties: {},
      },
      {
        id: 'b_attachments',
        ref: 'attachments',
        type: 'file_upload',
        title: 'Screenshots or other files',
        properties: { maxFiles: 3, maxSizeMb: 10, accept: 'any' },
      },
    ],
    endings: [
      {
        id: 'e_received',
        ref: 'received',
        title: 'Request received',
        description: 'The IT team will pick it up shortly.',
      },
    ],
  },
};

const pulseScale = (id: string, ref: string, title: string) => ({
  id,
  ref,
  type: 'opinion_scale' as const,
  title,
  required: true,
  properties: { start: 1 as const, end: 5, labels: { left: 'Strongly disagree', right: 'Strongly agree' } },
});

const employeePulse: StarterTemplate = {
  id: 'employee-pulse',
  category: 'hr',
  name: { en: 'Employee pulse survey', nl: 'Medewerkerspeiling' },
  description: {
    en: 'A short recurring survey on workload, recognition, growth and teamwork.',
    nl: 'Een korte terugkerende peiling over werkdruk, waardering, groei en samenwerking.',
  },
  definition: {
    presentation: { layout: 'classic', progressBar: 'proportion' },
    blocks: [
      {
        id: 'b_intro',
        ref: 'intro',
        type: 'statement',
        title: 'Your answers are shared with HR as a group total only.',
        properties: {},
      },
      pulseScale('b_workload', 'workload', 'My workload is manageable.'),
      pulseScale('b_recognition', 'recognition', 'I feel recognised for my work.'),
      pulseScale('b_growth', 'growth', 'I see opportunities to grow here.'),
      { id: 'b_page_team', ref: 'page_team', type: 'page_break', title: 'Your team' },
      pulseScale('b_team', 'teamwork', 'My team works well together.'),
      pulseScale('b_manager', 'manager', 'My manager supports me.'),
      { id: 'b_page_open', ref: 'page_open', type: 'page_break', title: 'Anything else' },
      {
        id: 'b_improve',
        ref: 'improve',
        type: 'long_text',
        title: 'What one thing would make your work better?',
        properties: {},
      },
    ],
    endings: [{ id: 'e_thanks', ref: 'thank_you', title: 'Thanks for sharing!' }],
  },
};

export const STARTER_TEMPLATES: readonly StarterTemplate[] = [
  contactForm,
  customerFeedback,
  eventRegistration,
  jobApplication,
  knowledgeQuiz,
  leadQualification,
  itRequest,
  employeePulse,
];
