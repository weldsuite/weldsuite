/** What the certificate reports say about time: how long a certificate lasts and how long a missing one can still be cured. */

export interface CertificateTexts {
  expiredAgo: string;
  expiredYesterday: string;
  expiresToday: string;
  expiresTomorrow: string;
  expiresIn: string;
}

function fillCount(template: string, count: number): string {
  return template.replace('{count}', String(count));
}

/** "Expires in 12 days", "Expired yesterday": the wording of the days left on a certificate (negative once expired). */
export function expiryText(texts: CertificateTexts, daysLeft: number): string {
  if (daysLeft > 1) return fillCount(texts.expiresIn, daysLeft);
  if (daysLeft === 1) return texts.expiresTomorrow;
  if (daysLeft === 0) return texts.expiresToday;
  if (daysLeft === -1) return texts.expiredYesterday;
  return fillCount(texts.expiredAgo, Math.abs(daysLeft));
}

export interface CureTexts {
  daysLeft: string;
  oneDayLeft: string;
  dueToday: string;
  pastBy: string;
}

/** The time left to cure a missing certificate: "12 days left", "Last day", "Past by 3 days". */
export function cureText(texts: CureTexts, daysLeft: number): string {
  if (daysLeft > 1) return fillCount(texts.daysLeft, daysLeft);
  if (daysLeft === 1) return texts.oneDayLeft;
  if (daysLeft === 0) return texts.dueToday;
  return fillCount(texts.pastBy, Math.abs(daysLeft));
}

export type CertificateUrgency = 'expired' | 'soon' | 'later';

/** A certificate that expired is urgent, one that expires within 30 days needs attention soon. */
export function expiryUrgency(daysLeft: number): CertificateUrgency {
  if (daysLeft < 0) return 'expired';
  return daysLeft <= 30 ? 'soon' : 'later';
}

export const EXPIRING_WINDOWS = [30, 60, 90, 180, 365] as const;
