import { createContext, useContext } from 'react';
import type { AnswerError, AnswerValue, FieldBlock } from '@weldsuite/forms-engine';
import type { FormRendererLabels, UploadHandler } from './types';

/** What the fields need from the renderer around them. */
export interface FieldEnv {
  labels: FormRendererLabels;
  seed: string;
  preview: boolean;
  conversational: boolean;
  /** Letter / digit keys pick answers (one question on screen). */
  shortcuts: boolean;
  /** Set when choosing an answer may move on by itself (single choice, one question on screen). */
  autoAdvance: (() => void) | null;
  onUpload: UploadHandler | undefined;
  /** Lets "Next" wait for uploads still running. */
  trackUpload: (promise: Promise<unknown>) => void;
}

const FieldEnvContext = createContext<FieldEnv | null>(null);
export const FieldEnvProvider = FieldEnvContext.Provider;

export function useFieldEnv(): FieldEnv {
  const env = useContext(FieldEnvContext);
  if (!env) throw new Error('FieldEnvProvider is missing');
  return env;
}

export interface FieldViewProps<F extends FieldBlock = FieldBlock> {
  field: F;
  value: unknown;
  onChange: (value: AnswerValue | undefined) => void;
  error: AnswerError | null;
  inputId: string;
  describedBy: string | undefined;
}
