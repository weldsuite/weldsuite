import { Video } from 'lucide-react';

export function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function formatDurationLong(seconds?: number): string {
  if (!seconds) return '--:--';
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  if (hours > 0) {
    return `${hours}h ${mins}m ${secs}s`;
  }
  return `${mins}m ${secs}s`;
}

export function formatTimestamp(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  if (hours > 0) {
    return `${hours}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export function formatSegmentTime(seconds: number): string {
  if (isNaN(seconds)) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export function formatDurationMin(seconds: number): string {
  const mins = Math.round(seconds / 60);
  return mins > 0 ? `${mins}min` : '<1min';
}

function getPlatformIcon(platform?: string | null): string {
  if (!platform) return '';
  switch (platform.toLowerCase()) {
    case 'googlemeet':
    case 'google_meet':
      return '/logos/google-meet.png';
    case 'teams':
    case 'microsoft_teams':
      return '/logos/teams.svg';
    case 'zoom':
      return '/logos/zoom.svg';
    default:
      return '';
  }
}

function getPlatformName(platform?: string | null): string {
  if (!platform) return '';
  switch (platform.toLowerCase()) {
    case 'googlemeet':
    case 'google_meet':
      return 'Google Meet';
    case 'teams':
    case 'microsoft_teams':
      return 'Microsoft Teams';
    case 'zoom':
      return 'Zoom';
    default:
      return platform;
  }
}

export function detectPlatform(platform?: string, meetingUrl?: string): { name: string; icon: string } | null {
  const p = (platform || '').toLowerCase();
  const url = (meetingUrl || '').toLowerCase();

  if (p.includes('google') || url.includes('meet.google')) {
    return { name: 'Google Meet', icon: '/logos/google-meet.png' };
  }
  if (p.includes('teams') || p.includes('microsoft') || url.includes('teams.microsoft')) {
    return { name: 'Microsoft Teams', icon: '/logos/teams.svg' };
  }
  if (p.includes('zoom') || url.includes('zoom.us')) {
    return { name: 'Zoom', icon: '/logos/zoom.svg' };
  }
  return null;
}

export function parseSpeakerId(speakerLabel: string): number {
  const match = speakerLabel.match(/\d+/);
  return match ? parseInt(match[0]) : 0;
}
