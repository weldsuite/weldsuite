export default {
    async email(message, env, ctx) {
        // Determine environment from +suffix in email
        let targetEnv = 'production';
        let webhookUrl = env.WEBHOOK_URL_PRODUCTION;
        let secret = env.WEBHOOK_SECRET_PRODUCTION;

        const toAddress = message.to.toLowerCase();

        if (toAddress.includes('+preview@')) {
            targetEnv = 'preview';
            webhookUrl = env.WEBHOOK_URL_PREVIEW;
            secret = env.WEBHOOK_SECRET_PREVIEW;
        } else if (toAddress.includes('+test@')) {
            targetEnv = 'test';
            webhookUrl = env.WEBHOOK_URL_TEST;
            secret = env.WEBHOOK_SECRET_TEST;
        }

        console.log(`[${targetEnv}] Routing email to: ${message.to}`);

        // Read raw email
        const rawEmail = await new Response(message.raw).arrayBuffer();
        const base64Email = btoa(String.fromCharCode(...new Uint8Array(rawEmail)));

        const payload = {
            rawEmail: base64Email,
            from: message.from,
            to: message.to,
            size: message.rawSize,
            timestamp: Math.floor(Date.now() / 1000),
            headers: Object.fromEntries(message.headers),
            environment: targetEnv,
        };

        const body = JSON.stringify(payload);
        const timestamp = Math.floor(Date.now() / 1000).toString();

        // Create HMAC signature
        const encoder = new TextEncoder();
        const key = await crypto.subtle.importKey(
            'raw',
            encoder.encode(secret),
            { name: 'HMAC', hash: 'SHA-256' },
            false,
            ['sign']
        );

        const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(timestamp + body));
        const signatureHex = Array.from(new Uint8Array(signature))
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');

        const response = await fetch(webhookUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-mail-provider': 'cloudflare',
                'x-cf-email-signature': signatureHex,
                'x-cf-email-timestamp': timestamp,
            },
            body: body,
        });

        if (!response.ok) {
            console.error(`[${targetEnv}] Webhook failed: ${response.status}`);
        } else {
            console.log(`[${targetEnv}] Email forwarded successfully`);
        }
    },
};