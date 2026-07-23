// Re-export auth utilities from lib/auth
// This file exists at the project root for @/auth imports
export { auth, getAccessToken, getServerSession } from './lib/auth';
export type { AppSession } from './lib/auth';
