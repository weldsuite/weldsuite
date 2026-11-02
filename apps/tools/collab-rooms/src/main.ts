/**
 * collab-rooms: WeldDocs' and WeldSheets' rooms for the Kubernetes editions
 * (rust/docs/collab-rooms.md). Reads its settings from the environment:
 *
 *   PORT                      listen port (8090)
 *   COLLAB_ROOMS_SECRET       x-internal-secret, both ways with the Rust server
 *   COLLAB_EVENTS_URL         the Rust server's /internal/collab/events
 *   COLLAB_ROOMS_URLS, COLLAB_ROOMS_SELF
 *                             every pod's URL and this pod's: which rooms' alarms this pod wakes
 *   S3_ENDPOINT, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_FORCE_PATH_STYLE,
 *   S3_BUCKET_PRIVATE, S3_BUCKET_PUBLIC
 *   DATABASE_URL_MASTER, DATABASE_ENCRYPTION_KEY, DATABASE_ENCRYPTION_KEY_V2, TENANT_POOL_MAX_CONNECTIONS
 */

import { createHash } from 'node:crypto';
import { createCollabApp } from './app';
import { S3ObjectStore, type ObjectStore } from './runtime/objects';

const env = process.env;

function store(bucket: string | undefined): ObjectStore | undefined {
  if (!bucket || !env.S3_ENDPOINT) return undefined;
  return new S3ObjectStore({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION || 'us-east-1',
    bucket,
    accessKeyId: env.S3_ACCESS_KEY_ID ?? '',
    secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? '',
    forcePathStyle: (env.S3_FORCE_PATH_STYLE ?? 'true') !== 'false',
  });
}

/** Rendezvous hashing over the pod URLs, as the Rust server routes rooms (adapters-oss/src/collab.rs). */
export function ownerOf(roomId: string, urls: string[]): string | undefined {
  let best: { url: string; score: bigint } | undefined;
  for (const url of urls) {
    const score = createHash('sha256').update(`${roomId}\n${url}`).digest().readBigUInt64BE(0);
    if (!best || score > best.score) best = { url, score };
  }
  return best?.url;
}

const privateStore = store(env.S3_BUCKET_PRIVATE);
if (!privateStore) {
  console.error('[collab-rooms] S3_ENDPOINT and S3_BUCKET_PRIVATE are required');
  process.exit(1);
}
const urls = (env.COLLAB_ROOMS_URLS ?? '')
  .split(',')
  .map((url) => url.trim().replace(/\/$/, ''))
  .filter(Boolean);
const self = env.COLLAB_ROOMS_SELF?.replace(/\/$/, '');

const app = createCollabApp({
  privateStore,
  publicStore: store(env.S3_BUCKET_PUBLIC),
  eventsUrl: env.COLLAB_EVENTS_URL,
  secret: env.COLLAB_ROOMS_SECRET || undefined,
  database: {
    masterUrl: env.DATABASE_URL_MASTER,
    encryptionKey: env.DATABASE_ENCRYPTION_KEY,
    encryptionKeyV2: env.DATABASE_ENCRYPTION_KEY_V2,
    tenantPoolMax: env.TENANT_POOL_MAX_CONNECTIONS,
  },
  owns: urls.length > 1 && self ? (id) => ownerOf(id, urls) === self : undefined,
  environment: env.ENVIRONMENT,
});

const port = Number(env.PORT) || 8090;
app.server.listen(port, () => console.log(`[collab-rooms] listening on :${port}`));

let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    console.log(`[collab-rooms] ${signal}: closing the rooms`);
    app.close().then(
      () => process.exit(0),
      (error: unknown) => {
        console.error('[collab-rooms] closing failed:', error);
        process.exit(1);
      },
    );
  });
}
