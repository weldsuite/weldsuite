/**
 * Firebase Cloud Messaging (FCM) HTTP v1 push client for Cloudflare Workers
 *
 * Uses the FCM v1 API with service account authentication (OAuth 2.0).
 * The legacy server key API was deprecated by Google in June 2024.
 *
 * @see https://firebase.google.com/docs/cloud-messaging/migrate-v1
 */

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}

interface FcmV1Message {
  message: {
    token: string;
    notification: {
      title: string;
      body: string;
    };
    data?: Record<string, string>;
    android?: {
      notification: {
        channel_id: string;
        sound: string;
      };
      priority: 'NORMAL' | 'HIGH';
    };
  };
}

/**
 * Import a PEM-encoded RSA private key for signing JWTs.
 */
async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const pemContents = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\n/g, '');

  const binaryDer = Uint8Array.from(atob(pemContents), (c) => c.charCodeAt(0));

  return crypto.subtle.importKey(
    'pkcs8',
    binaryDer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
}

/**
 * Create a signed JWT for Google OAuth 2.0 service account auth.
 */
async function createSignedJwt(sa: ServiceAccount): Promise<string> {
  const now = Math.floor(Date.now() / 1000);

  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: sa.client_email,
    sub: sa.client_email,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
  };

  const encode = (obj: object) =>
    btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const unsignedToken = `${encode(header)}.${encode(payload)}`;
  const key = await importPrivateKey(sa.private_key);
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(unsignedToken)
  );

  const sig = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  return `${unsignedToken}.${sig}`;
}

/**
 * Get an OAuth 2.0 access token using a service account JWT.
 */
async function getAccessToken(sa: ServiceAccount): Promise<string> {
  const jwt = await createSignedJwt(sa);

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OAuth token error: ${response.status} ${text}`);
  }

  const data = (await response.json()) as { access_token: string };
  return data.access_token;
}

/**
 * Send push notifications via FCM v1 API to raw device tokens.
 * Requires a Firebase service account JSON string.
 */
export async function sendFcmPush(
  tokens: string[],
  notification: {
    title: string;
    body: string;
    data?: Record<string, string>;
  },
  serviceAccountJson?: string
): Promise<{ success: number; failure: number }> {
  if (tokens.length === 0) {
    return { success: 0, failure: 0 };
  }

  if (!serviceAccountJson) {
    console.warn('[FCM] FIREBASE_SERVICE_ACCOUNT not configured — skipping FCM push for', tokens.length, 'device(s)');
    return { success: 0, failure: tokens.length };
  }

  try {
    const sa: ServiceAccount = JSON.parse(serviceAccountJson);
    const accessToken = await getAccessToken(sa);
    const url = `https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`;

    let successCount = 0;
    let failureCount = 0;

    // FCM v1 API only supports sending to one token per request
    const results = await Promise.allSettled(
      tokens.map(async (token) => {
        const body: FcmV1Message = {
          message: {
            token,
            notification: {
              title: notification.title,
              body: notification.body,
            },
            data: notification.data,
            android: {
              notification: {
                channel_id: 'helpdesk',
                sound: 'default',
              },
              priority: 'HIGH',
            },
          },
        };

        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify(body),
        });

        if (!response.ok) {
          const text = await response.text();
          console.warn(`[FCM] Token ${token.substring(0, 20)}... error: ${response.status} ${text}`);
          throw new Error(`FCM ${response.status}`);
        }

        return response.json();
      })
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        successCount++;
      } else {
        failureCount++;
      }
    }

    console.log(`[FCM] Sent: ${successCount} success, ${failureCount} failure`);
    return { success: successCount, failure: failureCount };
  } catch (err) {
    console.error('[FCM] Failed to send push notifications:', err);
    return { success: 0, failure: tokens.length };
  }
}
