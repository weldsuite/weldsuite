import type {
  AnswerError,
  AnswerErrorCode,
  Answers,
  FileAnswerItem,
  FormDefinition,
  FormLayout,
  FormThemeTokens,
} from '@weldsuite/forms-engine';

/**
 * Every text the renderer shows itself. Passed in as a prop: the package holds
 * no translations. `{name}` placeholders are filled by the renderer.
 */
export interface FormRendererLabels {
  next: string;
  ok: string;
  submit: string;
  back: string;
  /** Default text of the welcome screen's button. */
  start: string;
  /** "press Enter" next to a button. */
  pressEnter: string;
  /** "Shift + Enter to make a line break" under a long text field. */
  shiftEnterHint: string;
  typeAnswer: string;
  other: string;
  otherPlaceholder: string;
  /** `{max}` */
  chooseUpTo: string;
  /** `{min}` */
  chooseAtLeast: string;
  /** `{min}`, `{max}` */
  chooseBetween: string;
  chooseAny: string;
  yes: string;
  no: string;
  accept: string;
  decline: string;
  select: string;
  search: string;
  noResults: string;
  dropFiles: string;
  browse: string;
  /** `{name}` */
  removeFile: string;
  uploading: string;
  uploadFailed: string;
  /** `{max}` (MB) */
  fileTooLarge: string;
  fileTypeNotAllowed: string;
  signatureHint: string;
  signatureClear: string;
  signatureSaving: string;
  signatureSaved: string;
  rankingHint: string;
  rankingKeep: string;
  /** `{item}` */
  moveUp: string;
  /** `{item}` */
  moveDown: string;
  /** `{value}`, `{max}`: the accessible name of one rating star. */
  ratingOption: string;
  progressLabel: string;
  /** `{percent}` */
  progressPercent: string;
  /** `{current}`, `{total}` */
  progressProportion: string;
  /** `{current}`, `{total}` */
  pageOf: string;
  day: string;
  month: string;
  year: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  company: string;
  line1: string;
  line2: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  required: string;
  optional: string;
  submitting: string;
  submitFailed: string;
  fixErrors: string;
  /** `{score}` */
  yourScore: string;
  quizHeading: string;
  quizCorrect: string;
  quizIncorrect: string;
  yourAnswer: string;
  correctAnswer: string;
  noAnswer: string;
  redirecting: string;
  /** `{url}`: shown in preview instead of redirecting. */
  previewRedirect: string;
  previewBadge: string;
  /**
   * Per error code. Placeholders: `{max}` (too_long, too_large, too_many_choices,
   * too_many_files, date_too_late), `{min}` (too_small, too_few_choices,
   * date_too_early), `{decimals}` (too_many_decimals).
   */
  errors: Record<AnswerErrorCode, string>;
}

/** What the renderer needs to show an ending; the shape of forms-api's submit result. */
export interface EndingView {
  id: string;
  /** Recall already filled in. */
  title: string;
  description: string | null;
  redirectUrl: string | null;
  button: { text: string; url: string } | null;
  showScore: boolean;
  showAnswers: boolean;
}

export interface QuizResultItem {
  fieldId: string;
  correct: boolean | null;
  points: number;
}

export interface SubmitResult {
  responseId?: string;
  number?: number;
  ending: EndingView;
  score: number;
  quiz: QuizResultItem[] | null;
}

/** Returned by `onSubmit` instead of a result when the server found wrong answers. */
export interface SubmitFieldErrors {
  fieldErrors: Record<string, AnswerError>;
}

export interface FormTimings {
  [blockId: string]: number;
}

export interface ProgressEvent {
  /** The block (or, in the classic layout, the first block of the page) the respondent reached. */
  lastBlockId: string;
  answers: Answers;
  /** Milliseconds per block id since the previous `onProgress` call. */
  timings: FormTimings;
}

export interface SubmitPayload {
  /** Answers of the fields on the respondent's path. */
  answers: Answers;
  /** Milliseconds per block id since the previous `onProgress` call. */
  timings: FormTimings;
}

export type UploadHandler = (
  fieldId: string,
  file: File,
  onProgress?: (fraction: number) => void,
) => Promise<FileAnswerItem>;

export interface FormRendererProps {
  definition: FormDefinition;
  theme?: FormThemeTokens;
  /** Overrides `definition.presentation.layout` (the builder preview toggles it). */
  layout?: FormLayout;
  initialAnswers?: Answers;
  /** Hidden-field values by name. */
  hidden?: Record<string, string>;
  labels: FormRendererLabels;
  /** `preview` never calls the server: submit shows the ending computed locally. */
  mode?: 'live' | 'preview';
  /** Resume: start at this block (skips the welcome screen). */
  startAtBlockId?: string;
  /** Seeds the stable shuffle of randomized choices; default: random per mount. */
  seed?: string;
  /** Inside an iframe or a host page: no autofocus on first paint, no full-height layout. */
  embedded?: boolean;
  /** Show "Edit" state: skip the welcome screen and start with the answers (editing a response). */
  skipWelcome?: boolean;
  onProgress?: (event: ProgressEvent) => void;
  onUpload?: UploadHandler;
  onSubmit?: (payload: SubmitPayload) => Promise<SubmitResult | SubmitFieldErrors>;
  onEnding?: (result: SubmitResult) => void;
  /** Called for an ending's redirect; default `window.location.assign`. Never called in preview. */
  onRedirect?: (url: string) => void;
  className?: string;
}
