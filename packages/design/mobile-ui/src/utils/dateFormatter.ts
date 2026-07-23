export function formatEmailTime(utcDateString: string): string {
  const date = new Date(utcDateString);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const emailDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());

  if (today.getTime() === emailDay.getTime()) {
    return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  }

  return `${date.getDate()} ${date.toLocaleDateString('en-US', { month: 'short' })}${date.getFullYear() !== now.getFullYear() ? ` ${date.getFullYear()}` : ''}`;
}

export function formatEmailDate(utcDateString: string): string {
  const date = new Date(utcDateString);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const emailDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffMs = today.getTime() - emailDate.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';

  return `${date.getDate()} ${date.toLocaleDateString('en-US', { month: 'short' })}${date.getFullYear() !== now.getFullYear() ? ` ${date.getFullYear()}` : ''}`;
}

export function formatShortTime(utcDateString: string): string {
  const date = new Date(utcDateString);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const emailDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());

  if (today.getTime() === emailDay.getTime()) {
    return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  }

  return `${date.getDate()} ${date.toLocaleDateString('en-US', { month: 'short' })}${date.getFullYear() !== now.getFullYear() ? ` ${date.getFullYear()}` : ''}`;
}

export function formatFullDateTime(utcDateString: string): string {
  const date = new Date(utcDateString);
  const dateString = date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const timeString = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  return `${dateString} at ${timeString}`;
}
