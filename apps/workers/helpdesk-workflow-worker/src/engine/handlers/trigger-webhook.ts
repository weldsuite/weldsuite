import type { StepHandler, StepContext, StepResult } from '../../types';

export const triggerWebhookHandler: StepHandler = {
  type: 'trigger_webhook',

  async execute(ctx: StepContext): Promise<StepResult> {
    const url = String(ctx.inputs.url);
    const method = String(ctx.inputs.method || 'POST').toUpperCase();
    const inputHeaders = (ctx.inputs.headers as Record<string, string>) ?? {};
    const body = ctx.inputs.body;

    const headers: Record<string, string> = { ...inputHeaders };

    let requestBody: string | undefined;
    if (body !== undefined && body !== null) {
      if (typeof body === 'object') {
        requestBody = JSON.stringify(body);
        if (!headers['Content-Type'] && !headers['content-type']) {
          headers['Content-Type'] = 'application/json';
        }
      } else {
        requestBody = String(body);
      }
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10_000);

      const response = await fetch(url, {
        method,
        headers,
        body: requestBody,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      let responseBody = '';
      try {
        responseBody = await response.text();
      } catch {
        // Response body may not be readable
      }

      // Truncate response to 1000 chars
      if (responseBody.length > 1000) {
        responseBody = responseBody.slice(0, 1000);
      }

      return {
        success: response.ok,
        statusCode: response.status,
        responseBody,
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown network error';
      return { success: false, error: errorMessage };
    }
  },
};
