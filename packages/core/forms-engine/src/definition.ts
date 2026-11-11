/**
 * The WeldForms definition: what a form contains and how it behaves.
 *
 * One Zod schema for the builder, the renderer, forms-api and (through the
 * fixtures) the Rust backend. A definition is stored as JSON on `forms`
 * (the draft) and `form_versions` (published snapshots), see
 * packages/core/db/src/schema/weldforms.ts and docs/plans/weldforms.md.
 *
 * Shape:
 *   - `welcome`: optional first screen.
 *   - `blocks`: the steps in order. A field (question), a statement, a group
 *     (several fields shown as one step) or a page break (classic layout only).
 *   - `endings`: at least one; logic picks which one a respondent sees.
 *   - `hidden`: names of values that come in through the URL or an embed.
 *   - `variables`: numbers or text changed by calculations; `score` always exists.
 *   - `logic`: per top-level block, calculations and jumps; `endingRules`
 *     choose the ending when the path runs past the last block.
 *
 * Rules the schema can't express (unique ids, forward-only jumps, operands
 * that exist) are checked by `validateDefinition()` in `./validate.ts`.
 */

import { z } from 'zod';

export const DEFINITION_SCHEMA_VERSION = 1;

/** Block ids are short and stable: `b_` + 8 base62 characters; endings `e_`, choices `c_`, rows/columns `r_`/`k_`. */
const idSchema = z.string().min(1).max(30);
/** Editable slug used in recall, prefill, integrations and exports. */
export const refSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/, 'lowercase letters, digits and underscores, starting with a letter');

const textSchema = z.string().max(5000);
const titleSchema = z.string().max(1000);

export const mediaSchema = z.object({
  kind: z.enum(['image', 'video']),
  /** Public URL (image in the public bucket, or a YouTube/Vimeo/video URL). */
  url: z.string().url().max(2000),
  alt: z.string().max(500).optional(),
  /** Where the media sits next to the question in the conversational layout. */
  placement: z.enum(['above', 'split_left', 'split_right', 'background']).default('above'),
});
export type FormMedia = z.infer<typeof mediaSchema>;

// ---------------------------------------------------------------------------
// Field types
// ---------------------------------------------------------------------------

export const FIELD_TYPES = [
  'short_text',
  'long_text',
  'email',
  'phone',
  'number',
  'website',
  'date',
  'multiple_choice',
  'dropdown',
  'picture_choice',
  'yes_no',
  'legal',
  'rating',
  'opinion_scale',
  'nps',
  'ranking',
  'matrix',
  'file_upload',
  'signature',
  'contact_info',
  'address',
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

/** Field types whose answer is one or more choice ids. */
export const CHOICE_FIELD_TYPES = ['multiple_choice', 'dropdown', 'picture_choice'] as const;
/** Field types that hold files (uploaded through a session before submit). */
export const FILE_FIELD_TYPES = ['file_upload', 'signature'] as const;

export const choiceSchema = z.object({
  id: idSchema,
  label: z.string().max(500),
  /** Picture choice only. */
  imageUrl: z.string().url().max(2000).optional(),
  /** Added to the `score` variable when chosen (quizzes, assessments). */
  score: z.number().finite().optional(),
  /** Marks the right answer in a quiz. */
  correct: z.boolean().optional(),
});
export type FormChoice = z.infer<typeof choiceSchema>;

const subFieldSchema = z.object({ enabled: z.boolean(), required: z.boolean() });

const baseFieldShape = {
  id: idSchema,
  ref: refSchema,
  title: titleSchema,
  description: textSchema.optional(),
  media: mediaSchema.optional(),
  required: z.boolean().default(false),
  /**
   * The answer stays in forms-api: it is not put on the entity-event bus,
   * in notification emails or in WeldConnect payloads (ADR FORMS-004).
   */
  sensitive: z.boolean().optional(),
};

export const shortTextFieldSchema = z.object({
  ...baseFieldShape,
  type: z.literal('short_text'),
  properties: z.object({ placeholder: z.string().max(200).optional(), maxLength: z.number().int().min(1).max(1000).optional() }).default({}),
});
export const longTextFieldSchema = z.object({
  ...baseFieldShape,
  type: z.literal('long_text'),
  properties: z.object({ placeholder: z.string().max(200).optional(), maxLength: z.number().int().min(1).max(10000).optional() }).default({}),
});
export const emailFieldSchema = z.object({
  ...baseFieldShape,
  type: z.literal('email'),
  properties: z.object({ placeholder: z.string().max(200).optional() }).default({}),
});
export const phoneFieldSchema = z.object({
  ...baseFieldShape,
  type: z.literal('phone'),
  properties: z.object({ defaultCountry: z.string().length(2).optional() }).default({}),
});
export const numberFieldSchema = z.object({
  ...baseFieldShape,
  type: z.literal('number'),
  properties: z
    .object({
      min: z.number().finite().optional(),
      max: z.number().finite().optional(),
      /** Allowed decimal places; 0 = whole numbers only. */
      decimals: z.number().int().min(0).max(6).default(0),
    })
    .default({}),
});
export const websiteFieldSchema = z.object({
  ...baseFieldShape,
  type: z.literal('website'),
  properties: z.object({ placeholder: z.string().max(200).optional() }).default({}),
});
export const dateFieldSchema = z.object({
  ...baseFieldShape,
  type: z.literal('date'),
  properties: z
    .object({
      /** Display order of day, month and year; the answer is always `YYYY-MM-DD`. */
      format: z.enum(['DMY', 'MDY', 'YMD']).default('DMY'),
      min: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      max: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    })
    .default({}),
});
export const multipleChoiceFieldSchema = z.object({
  ...baseFieldShape,
  type: z.literal('multiple_choice'),
  properties: z.object({
    choices: z.array(choiceSchema).min(1).max(200),
    multiple: z.boolean().default(false),
    minSelections: z.number().int().min(1).optional(),
    maxSelections: z.number().int().min(1).optional(),
    allowOther: z.boolean().default(false),
    randomize: z.boolean().default(false),
  }),
});
export const dropdownFieldSchema = z.object({
  ...baseFieldShape,
  type: z.literal('dropdown'),
  properties: z.object({
    choices: z.array(choiceSchema).min(1).max(5000),
    randomize: z.boolean().default(false),
    alphabetical: z.boolean().default(false),
  }),
});
export const pictureChoiceFieldSchema = z.object({
  ...baseFieldShape,
  type: z.literal('picture_choice'),
  properties: z.object({
    choices: z.array(choiceSchema).min(1).max(50),
    multiple: z.boolean().default(false),
    minSelections: z.number().int().min(1).optional(),
    maxSelections: z.number().int().min(1).optional(),
    allowOther: z.boolean().default(false),
    randomize: z.boolean().default(false),
    showLabels: z.boolean().default(true),
  }),
});
export const yesNoFieldSchema = z.object({
  ...baseFieldShape,
  type: z.literal('yes_no'),
  properties: z.object({}).default({}),
});
export const legalFieldSchema = z.object({
  ...baseFieldShape,
  type: z.literal('legal'),
  properties: z.object({}).default({}),
});
export const ratingFieldSchema = z.object({
  ...baseFieldShape,
  type: z.literal('rating'),
  properties: z
    .object({
      steps: z.number().int().min(3).max(10).default(5),
      shape: z.enum(['star', 'heart', 'thumb', 'circle']).default('star'),
    })
    .default({}),
});
export const opinionScaleFieldSchema = z.object({
  ...baseFieldShape,
  type: z.literal('opinion_scale'),
  properties: z
    .object({
      start: z.union([z.literal(0), z.literal(1)]).default(1),
      end: z.number().int().min(5).max(10).default(10),
      labels: z.object({ left: z.string().max(100).optional(), center: z.string().max(100).optional(), right: z.string().max(100).optional() }).default({}),
    })
    .default({}),
});
export const npsFieldSchema = z.object({
  ...baseFieldShape,
  type: z.literal('nps'),
  properties: z
    .object({ labels: z.object({ left: z.string().max(100).optional(), right: z.string().max(100).optional() }).default({}) })
    .default({}),
});
export const rankingFieldSchema = z.object({
  ...baseFieldShape,
  type: z.literal('ranking'),
  properties: z.object({
    choices: z.array(choiceSchema).min(2).max(50),
    randomize: z.boolean().default(false),
  }),
});
export const matrixFieldSchema = z.object({
  ...baseFieldShape,
  type: z.literal('matrix'),
  properties: z.object({
    rows: z.array(z.object({ id: idSchema, label: z.string().max(500) })).min(1).max(50),
    columns: z.array(z.object({ id: idSchema, label: z.string().max(200) })).min(2).max(20),
    multiple: z.boolean().default(false),
  }),
});
export const fileUploadFieldSchema = z.object({
  ...baseFieldShape,
  type: z.literal('file_upload'),
  properties: z
    .object({
      maxFiles: z.number().int().min(1).max(10).default(1),
      /** Per file; the platform maximum is 25 MB. */
      maxSizeMb: z.number().int().min(1).max(25).default(10),
      accept: z.enum(['any', 'images', 'documents', 'pdf']).default('any'),
    })
    .default({}),
});
export const signatureFieldSchema = z.object({
  ...baseFieldShape,
  type: z.literal('signature'),
  properties: z.object({}).default({}),
});
export const contactInfoFieldSchema = z.object({
  ...baseFieldShape,
  type: z.literal('contact_info'),
  properties: z
    .object({
      fields: z
        .object({
          firstName: subFieldSchema.default({ enabled: true, required: true }),
          lastName: subFieldSchema.default({ enabled: true, required: true }),
          email: subFieldSchema.default({ enabled: true, required: true }),
          phone: subFieldSchema.default({ enabled: true, required: false }),
          company: subFieldSchema.default({ enabled: true, required: false }),
        })
        .default({}),
    })
    .default({}),
});
export const addressFieldSchema = z.object({
  ...baseFieldShape,
  type: z.literal('address'),
  properties: z
    .object({
      fields: z
        .object({
          line1: subFieldSchema.default({ enabled: true, required: true }),
          line2: subFieldSchema.default({ enabled: true, required: false }),
          city: subFieldSchema.default({ enabled: true, required: true }),
          state: subFieldSchema.default({ enabled: true, required: false }),
          postalCode: subFieldSchema.default({ enabled: true, required: true }),
          country: subFieldSchema.default({ enabled: true, required: true }),
        })
        .default({}),
    })
    .default({}),
});

export const fieldBlockSchema = z.discriminatedUnion('type', [
  shortTextFieldSchema,
  longTextFieldSchema,
  emailFieldSchema,
  phoneFieldSchema,
  numberFieldSchema,
  websiteFieldSchema,
  dateFieldSchema,
  multipleChoiceFieldSchema,
  dropdownFieldSchema,
  pictureChoiceFieldSchema,
  yesNoFieldSchema,
  legalFieldSchema,
  ratingFieldSchema,
  opinionScaleFieldSchema,
  npsFieldSchema,
  rankingFieldSchema,
  matrixFieldSchema,
  fileUploadFieldSchema,
  signatureFieldSchema,
  contactInfoFieldSchema,
  addressFieldSchema,
]);
export type FieldBlock = z.infer<typeof fieldBlockSchema>;
export type FieldBlockOf<T extends FieldType> = Extract<FieldBlock, { type: T }>;

// ---------------------------------------------------------------------------
// Layout blocks
// ---------------------------------------------------------------------------

export const statementBlockSchema = z.object({
  id: idSchema,
  ref: refSchema,
  type: z.literal('statement'),
  title: titleSchema,
  description: textSchema.optional(),
  media: mediaSchema.optional(),
  properties: z.object({ buttonText: z.string().max(60).optional() }).default({}),
});
export type StatementBlock = z.infer<typeof statementBlockSchema>;

/** Fields and statements shown together as one step. Groups don't nest. */
export const groupBlockSchema = z.object({
  id: idSchema,
  ref: refSchema,
  type: z.literal('group'),
  title: titleSchema,
  description: textSchema.optional(),
  media: mediaSchema.optional(),
  properties: z.object({ buttonText: z.string().max(60).optional() }).default({}),
  children: z.array(z.union([fieldBlockSchema, statementBlockSchema])).max(50),
});
export type GroupBlock = z.infer<typeof groupBlockSchema>;

/** Starts a new page in the classic layout; ignored by the conversational one. */
export const pageBreakBlockSchema = z.object({
  id: idSchema,
  ref: refSchema,
  type: z.literal('page_break'),
  title: titleSchema.default(''),
});
export type PageBreakBlock = z.infer<typeof pageBreakBlockSchema>;

export const blockSchema = z.union([fieldBlockSchema, statementBlockSchema, groupBlockSchema, pageBreakBlockSchema]);
export type Block = z.infer<typeof blockSchema>;
/** A block that can hold an answer or be shown: anything but a page break. */
export type ContentBlock = FieldBlock | StatementBlock | GroupBlock;

export const welcomeScreenSchema = z.object({
  title: titleSchema,
  description: textSchema.optional(),
  media: mediaSchema.optional(),
  buttonText: z.string().max(60).optional(),
});
export type WelcomeScreen = z.infer<typeof welcomeScreenSchema>;

/**
 * An ending's link (redirect, button) is a web link: empty (the builder keeps a
 * button whose link is still to be typed) or starting with `http://` or
 * `https://`, any case. The text as written is checked, recall placeholders
 * included: they may follow the scheme (`https://x.com/?e={{field:email}}`),
 * never stand in for it, so no author or respondent can make a `javascript:`
 * link out of it.
 */
const ENDING_URL_RE = /^(?:https?:\/\/|$)/i;
export const ENDING_URL_MESSAGE = 'must start with http:// or https://';

/** Whether an ending's redirect or button link passes the schema (see `ENDING_URL_RE`). */
export function isEndingUrl(url: string): boolean {
  return ENDING_URL_RE.test(url);
}

const endingUrlSchema = z.string().max(2000).regex(ENDING_URL_RE, ENDING_URL_MESSAGE);

export const endingSchema = z.object({
  id: idSchema,
  ref: refSchema,
  title: titleSchema,
  description: textSchema.optional(),
  media: mediaSchema.optional(),
  /** Show the `score` variable (quizzes). */
  showScore: z.boolean().default(false),
  /** Show each scored question with the respondent's answer and the right one. */
  showAnswers: z.boolean().default(false),
  /** Go straight to this URL after submit; recall allowed (URL-encoded). */
  redirectUrl: endingUrlSchema.optional(),
  /** A link under the ending; recall allowed. */
  button: z.object({ text: z.string().max(60), url: endingUrlSchema }).optional(),
});
export type FormEnding = z.infer<typeof endingSchema>;

export const hiddenFieldSchema = z.object({
  /** Query-string name: `?utm_source=…`. */
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z_]\w*$/),
});
export type HiddenField = z.infer<typeof hiddenFieldSchema>;

export const variableSchema = z.discriminatedUnion('type', [
  z.object({ name: refSchema, type: z.literal('number'), initial: z.number().finite().default(0) }),
  z.object({ name: refSchema, type: z.literal('text'), initial: z.string().max(1000).default('') }),
]);
export type FormVariable = z.infer<typeof variableSchema>;

// ---------------------------------------------------------------------------
// Logic
// ---------------------------------------------------------------------------

/**
 * A value in a condition or calculation. `field` reads an answer (for a
 * matrix, `rowId` picks the row; for contact info and address, `part` picks
 * the sub-field), `hidden` a hidden field, `variable` a variable, `constant`
 * a literal (choice ids for choice fields).
 */
export const operandSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('field'),
    id: idSchema,
    rowId: idSchema.optional(),
    part: z.string().max(30).optional(),
  }),
  z.object({ type: z.literal('hidden'), name: z.string().max(64) }),
  z.object({ type: z.literal('variable'), name: refSchema }),
  z.object({
    type: z.literal('constant'),
    value: z.union([z.string().max(1000), z.number().finite(), z.boolean(), z.array(z.string().max(100)).max(200)]),
  }),
]);
export type Operand = z.infer<typeof operandSchema>;

export const CONDITION_OPERATORS = [
  'is',
  'is_not',
  'contains',
  'not_contains',
  'starts_with',
  'ends_with',
  'greater_than',
  'greater_or_equal',
  'less_than',
  'less_or_equal',
  'is_answered',
  'is_empty',
  /** Choice fields: at least one of the constant's choice ids is selected. */
  'any_of',
  /** Choice fields: every one of the constant's choice ids is selected. */
  'all_of',
  /** Choice fields: none of the constant's choice ids is selected. */
  'none_of',
  'before',
  'after',
] as const;
export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];

export const conditionSchema = z.object({
  left: operandSchema,
  operator: z.enum(CONDITION_OPERATORS),
  /** Absent for `is_answered` / `is_empty`. */
  right: operandSchema.optional(),
});
export type Condition = z.infer<typeof conditionSchema>;

/** AND/OR of conditions, one level of nesting. */
export const conditionGroupSchema = z.object({
  op: z.enum(['and', 'or']),
  conditions: z
    .array(
      z.union([
        conditionSchema,
        z.object({ op: z.enum(['and', 'or']), conditions: z.array(conditionSchema).min(1).max(20) }),
      ]),
    )
    .min(1)
    .max(20),
});
export type ConditionGroup = z.infer<typeof conditionGroupSchema>;

export const targetSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('block'), id: idSchema }),
  z.object({ type: z.literal('ending'), id: idSchema }),
]);
export type LogicTarget = z.infer<typeof targetSchema>;

export const calculationSchema = z.object({
  id: idSchema,
  /** Null = always. */
  when: conditionGroupSchema.nullable().default(null),
  variable: refSchema,
  op: z.enum(['add', 'subtract', 'multiply', 'divide', 'set']),
  value: operandSchema,
});
export type Calculation = z.infer<typeof calculationSchema>;

export const jumpSchema = z.object({
  id: idSchema,
  when: conditionGroupSchema,
  to: targetSchema,
});
export type Jump = z.infer<typeof jumpSchema>;

/**
 * Logic of one top-level block, run when the respondent leaves it:
 * calculations in order, then the first matching jump, else `otherwise`
 * (null = the next block). Jumps only go forward.
 */
export const blockLogicSchema = z.object({
  blockId: idSchema,
  calculations: z.array(calculationSchema).max(50).default([]),
  jumps: z.array(jumpSchema).max(50).default([]),
  otherwise: targetSchema.nullable().default(null),
});
export type BlockLogic = z.infer<typeof blockLogicSchema>;

/** Which ending to show when the path runs past the last block; first match wins, else `endings[0]`. */
export const endingRuleSchema = z.object({
  id: idSchema,
  when: conditionGroupSchema,
  endingId: idSchema,
});
export type EndingRule = z.infer<typeof endingRuleSchema>;

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

export const FORM_LAYOUTS = ['conversational', 'classic'] as const;
export type FormLayout = (typeof FORM_LAYOUTS)[number];

/** Languages of the renderer's own texts (Next, Submit, errors). */
export const FORM_LANGUAGES = ['en', 'nl'] as const;
export type FormLanguage = (typeof FORM_LANGUAGES)[number];

export const presentationSchema = z
  .object({
    layout: z.enum(FORM_LAYOUTS).default('conversational'),
    language: z.enum(FORM_LANGUAGES).default('en'),
    progressBar: z.enum(['percentage', 'proportion', 'none']).default('percentage'),
    showQuestionNumbers: z.boolean().default(true),
    /** Conversational: allow going back to the previous question. */
    allowBack: z.boolean().default(true),
  })
  .default({});
export type FormPresentation = z.infer<typeof presentationSchema>;

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

const colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const formThemeTokensSchema = z.object({
  font: z.enum(['inter', 'system', 'serif', 'mono', 'rounded', 'grotesk']).default('inter'),
  colors: z
    .object({
      background: colorSchema.default('#ffffff'),
      question: colorSchema.default('#1f2937'),
      answer: colorSchema.default('#2563eb'),
      button: colorSchema.default('#2563eb'),
      buttonText: colorSchema.default('#ffffff'),
    })
    .default({}),
  background: z
    .object({
      imageUrl: z.string().url().max(2000).optional(),
      /** 0 (none) to 100 (opaque) darkening over the image. */
      overlay: z.number().int().min(0).max(100).default(0),
    })
    .default({}),
  logoUrl: z.string().url().max(2000).optional(),
  radius: z.enum(['none', 'small', 'medium', 'large', 'full']).default('medium'),
  alignment: z.enum(['left', 'center']).default('left'),
  fontSize: z.enum(['small', 'medium', 'large']).default('medium'),
});
export type FormThemeTokens = z.infer<typeof formThemeTokensSchema>;

// ---------------------------------------------------------------------------
// The definition
// ---------------------------------------------------------------------------

export const formDefinitionSchema = z.object({
  schemaVersion: z.literal(DEFINITION_SCHEMA_VERSION).default(DEFINITION_SCHEMA_VERSION),
  presentation: presentationSchema,
  welcome: welcomeScreenSchema.nullable().default(null),
  blocks: z.array(blockSchema).max(500),
  endings: z.array(endingSchema).min(1).max(50),
  hidden: z.array(hiddenFieldSchema).max(50).default([]),
  variables: z.array(variableSchema).max(50).default([]),
  logic: z.array(blockLogicSchema).max(500).default([]),
  endingRules: z.array(endingRuleSchema).max(50).default([]),
});
export type FormDefinition = z.infer<typeof formDefinitionSchema>;
export type FormDefinitionInput = z.input<typeof formDefinitionSchema>;

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

/** Answer to a choice field: selected choice ids, plus the typed "Other" text. */
export const choiceAnswerSchema = z.object({
  choiceIds: z.array(z.string().max(30)).max(5000),
  other: z.string().max(1000).optional(),
});
export type ChoiceAnswer = z.infer<typeof choiceAnswerSchema>;

/** A file the session uploaded; `fileId` is a `form_response_files` id given by forms-api. */
export const fileAnswerItemSchema = z.object({
  fileId: z.string().max(30),
  name: z.string().max(255),
  size: z.number().int().nonnegative(),
  type: z.string().max(255),
});
export type FileAnswerItem = z.infer<typeof fileAnswerItemSchema>;

export type ContactInfoAnswer = Partial<Record<'firstName' | 'lastName' | 'email' | 'phone' | 'company', string>>;
export type AddressAnswer = Partial<Record<'line1' | 'line2' | 'city' | 'state' | 'postalCode' | 'country', string>>;

/**
 * The answer value per field type, as sent by the renderer and stored in
 * `form_responses.answers[blockId]`:
 *
 * | type | value |
 * |---|---|
 * | short_text, long_text, email, phone, website | string |
 * | number, rating, opinion_scale, nps | number |
 * | date | `YYYY-MM-DD` |
 * | multiple_choice, dropdown, picture_choice | `ChoiceAnswer` |
 * | yes_no, legal | boolean |
 * | ranking | choice ids, best first |
 * | matrix | `{ [rowId]: columnIds[] }` |
 * | file_upload | `FileAnswerItem[]` |
 * | signature | `FileAnswerItem` |
 * | contact_info | `ContactInfoAnswer` |
 * | address | `AddressAnswer` |
 */
export type AnswerValue =
  | string
  | number
  | boolean
  | string[]
  | ChoiceAnswer
  | Record<string, string[]>
  | FileAnswerItem
  | FileAnswerItem[]
  | ContactInfoAnswer
  | AddressAnswer;

export type Answers = Record<string, AnswerValue>;
