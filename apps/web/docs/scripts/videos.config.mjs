/**
 * Registry of help doc support videos.
 *
 * Each entry records the real platform UI (a /preview/* mirror of the module,
 * answered by fixtures) into public/videos/help/<name>.mp4 plus a poster
 * <name>.jpg. See video-director.mjs for the scripting API.
 */
import weldmailSendEmail from './videos/weldmail-send-email.mjs'

export const videoManifest = [weldmailSendEmail]
