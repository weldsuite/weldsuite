import { useTranslations } from '@weldsuite/i18n/client';

/** `t` scoped to `weldpass.passwords`, so call sites read `tp('detail.reveal')`. */
export function usePasswordsT() {
  const t = useTranslations();
  return (key: string, params?: Record<string, unknown>) =>
    t(`weldpass.passwords.${key}`, params);
}

export type PasswordsT = ReturnType<typeof usePasswordsT>;
