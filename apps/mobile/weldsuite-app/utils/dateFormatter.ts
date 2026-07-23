/**
 * Date formatting utilities for converting UTC times to local timezone
 */

/**
 * Format a UTC ISO string to local time (e.g., "2:45 PM", "Yesterday 3:30 PM")
 */
export function formatEmailTime(utcDateString: string): string {
  const date = new Date(utcDateString);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const emailDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());

  // Today: just show time
  if (today.getTime() === emailDay.getTime()) {
    return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  }

  // Older: show "3 Feb"
  return `${date.getDate()} ${date.toLocaleDateString('en-US', { month: 'short' })}${date.getFullYear() !== now.getFullYear() ? ` ${date.getFullYear()}` : ''}`;
}

/**
 * Format a UTC ISO string to local date (e.g., "Today", "Yesterday", "Jan 15")
 */
export function formatEmailDate(utcDateString: string): string {
  const date = new Date(utcDateString);

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const emailDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());

  const diffMs = today.getTime() - emailDate.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  // Today
  if (diffDays === 0) {
    return 'Today';
  }

  // Yesterday
  if (diffDays === 1) {
    return 'Yesterday';
  }

  // Show date like "3 Feb"
  return `${date.getDate()} ${date.toLocaleDateString('en-US', { month: 'short' })}${date.getFullYear() !== now.getFullYear() ? ` ${date.getFullYear()}` : ''}`;
}

/**
 * Format a UTC ISO string to a short time display (e.g., "2:45 PM", "2h ago", "Yesterday")
 */
export function formatShortTime(utcDateString: string): string {
  const date = new Date(utcDateString);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const emailDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());

  // Today: show time
  if (today.getTime() === emailDay.getTime()) {
    return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  }

  // Older: show "3 Feb"
  return `${date.getDate()} ${date.toLocaleDateString('en-US', { month: 'short' })}${date.getFullYear() !== now.getFullYear() ? ` ${date.getFullYear()}` : ''}`;
}

/**
 * Format a full date/time in local timezone (e.g., "January 15, 2024 at 2:45 PM")
 */
export function formatFullDateTime(utcDateString: string): string {
  const date = new Date(utcDateString);

  const dateString = date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  const timeString = date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });

  return `${dateString} at ${timeString}`;
}
