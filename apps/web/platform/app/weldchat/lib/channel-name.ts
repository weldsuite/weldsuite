/**
 * chat-api's limit on a channel name: `max(255)` after trimming, on create and
 * on update (`routes/channels/index.ts`, and the Rust port). The name fields
 * stop there, so the server's raw validator message never has to be shown.
 */
export const CHANNEL_NAME_MAX_LENGTH = 255;
