/** Discord Gateway opcodes */
export const GatewayOpcodes = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
} as const;

/** Gateway intents: GUILDS (1) + GUILD_MESSAGES (512) + MESSAGE_CONTENT (32768) */
export const GATEWAY_INTENTS = 33281;

/** Discord Gateway WebSocket URL (v10, JSON encoding) */
export const GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';

/**
 * Close codes that indicate a configuration error — do NOT auto-reconnect.
 * 4004 = Authentication failed
 * 4010 = Invalid shard
 * 4011 = Sharding required
 * 4012 = Invalid API version
 * 4013 = Invalid intent(s)
 * 4014 = Disallowed intent(s)
 */
export const NON_RECONNECTABLE_CODES = [4004, 4010, 4011, 4012, 4013, 4014];
