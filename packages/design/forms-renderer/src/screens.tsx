import { useEffect, useRef, type ReactNode } from 'react';
import { Check, X } from 'lucide-react';
import type { FormDefinition, WelcomeScreen } from '@weldsuite/forms-engine';
import { InlineMedia } from './blocks';
import { quizTexts, type EndingState } from './controller';
import type { FormRendererLabels } from './types';
import { fill, isSafeHref } from './utils';

export function Welcome({
  welcome,
  labels,
  rc,
  onStart,
}: {
  welcome: WelcomeScreen;
  labels: FormRendererLabels;
  rc: (text: string) => string;
  onStart: () => void;
}) {
  return (
    <div className="wf-screen wf-welcome">
      <InlineMedia media={welcome.media} />
      <h1 className="wf-title wf-title-large">{rc(welcome.title)}</h1>
      {welcome.description ? <p className="wf-description">{rc(welcome.description)}</p> : null}
      <div className="wf-actions">
        <button type="button" className="wf-button" data-wf-focus="" onClick={onStart}>
          {welcome.buttonText || labels.start}
        </button>
        <span className="wf-hint wf-enter-hint">{labels.pressEnter}</span>
      </div>
    </div>
  );
}

/** The tick or cross next to a quiz answer; nothing when the question has no correct answer marked. */
function quizMark(correct: boolean | null, labels: FormRendererLabels): ReactNode {
  if (correct === true) return <Check size={18} aria-label={labels.quizCorrect} />;
  if (correct === false) return <X size={18} aria-label={labels.quizIncorrect} />;
  return null;
}

/** The line under an ending that redirects: the target in a preview, else "Redirecting…" once it starts. */
function redirectNote(labels: FormRendererLabels, url: string, preview: boolean, redirecting: boolean): string | null {
  if (preview) return fill(labels.previewRedirect, { url });
  return redirecting ? labels.redirecting : null;
}

export function Ending({
  def,
  state,
  labels,
  preview,
  redirecting,
}: {
  def: FormDefinition;
  state: EndingState;
  labels: FormRendererLabels;
  preview: boolean;
  redirecting: boolean;
}) {
  const { result } = state;
  const { ending } = result;
  const media = def.endings.find((e) => e.id === ending.id)?.media;
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, []);

  return (
    <div className="wf-screen wf-ending" data-ending-id={ending.id}>
      <InlineMedia media={media} />
      <h1 ref={heading} tabIndex={-1} className="wf-title wf-title-large">
        {ending.title}
      </h1>
      {ending.description ? <p className="wf-description">{ending.description}</p> : null}
      {ending.showScore ? <p className="wf-score">{fill(labels.yourScore, { score: result.score })}</p> : null}
      {ending.showAnswers && result.quiz && result.quiz.length > 0 ? (
        <section className="wf-quiz" aria-label={labels.quizHeading}>
          <h2 className="wf-quiz-heading">{labels.quizHeading}</h2>
          <ol className="wf-quiz-list">
            {result.quiz.map((item) => {
              const texts = quizTexts(def, item.fieldId, state.answers);
              if (!texts) return null;
              const wrong = item.correct === false;
              return (
                <li key={item.fieldId} className="wf-quiz-item" data-correct={typeof item.correct === 'boolean' ? String(item.correct) : undefined}>
                  <span className="wf-quiz-mark">{quizMark(item.correct, labels)}</span>
                  <div>
                    <p className="wf-quiz-question">{texts.field.title}</p>
                    <p className="wf-quiz-answer">
                      {labels.yourAnswer}: {texts.answer || labels.noAnswer}
                    </p>
                    {wrong && texts.correct ? (
                      <p className="wf-quiz-answer">
                        {labels.correctAnswer}: {texts.correct}
                      </p>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ol>
        </section>
      ) : null}
      {ending.button && isSafeHref(ending.button.url) ? (
        <div className="wf-actions">
          <a className="wf-button" href={ending.button.url} rel="noopener noreferrer">
            {ending.button.text}
          </a>
        </div>
      ) : null}
      {ending.redirectUrl ? (
        <p className="wf-hint" role="status">
          {redirectNote(labels, ending.redirectUrl, preview, redirecting)}
        </p>
      ) : null}
    </div>
  );
}
