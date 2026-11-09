import { useEffect, useRef } from 'react';
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
              const right = item.correct === true;
              const wrong = item.correct === false;
              return (
                <li key={item.fieldId} className="wf-quiz-item" data-correct={right ? 'true' : wrong ? 'false' : undefined}>
                  <span className="wf-quiz-mark">
                    {right ? <Check size={18} aria-label={labels.quizCorrect} /> : wrong ? <X size={18} aria-label={labels.quizIncorrect} /> : null}
                  </span>
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
          {preview ? fill(labels.previewRedirect, { url: ending.redirectUrl }) : redirecting ? labels.redirecting : null}
        </p>
      ) : null}
    </div>
  );
}
