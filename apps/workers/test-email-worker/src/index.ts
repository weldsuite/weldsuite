import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { EmailMessage } from 'cloudflare:email';
import { createMimeMessage } from 'mimetext';

interface Env {
	SEB: SendEmail;
}

const app = new Hono<{ Bindings: Env }>();

app.use('*', cors());

app.get('/', (c) => {
	return c.html(HTML_PAGE);
});

app.post('/api/send', async (c) => {
	const { from, to, subject, body, html } = await c.req.json<{
		from: string;
		to: string;
		subject: string;
		body: string;
		html?: boolean;
	}>();

	if (!from || !to || !subject || !body) {
		return c.json({ error: 'Missing required fields: from, to, subject, body' }, 400);
	}

	const msg = createMimeMessage();
	msg.setSender({ name: from.split('@')[0], addr: from });
	msg.setRecipient(to);
	msg.setSubject(subject);
	msg.addMessage({
		contentType: html ? 'text/html' : 'text/plain',
		data: body,
	});

	const message = new EmailMessage(from, to, msg.asRaw());

	try {
		await c.env.SEB.send(message);
	} catch (e: unknown) {
		const errorMessage = e instanceof Error ? e.message : String(e);
		return c.json({ error: errorMessage }, 500);
	}

	return c.json({ success: true, message: `Email sent from ${from} to ${to}` });
});

export default app;

const HTML_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Email Test</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f5f5; padding: 2rem; color: #1a1a1a; }
  .container { max-width: 560px; margin: 0 auto; background: #fff; border-radius: 12px; box-shadow: 0 2px 12px rgba(0,0,0,.08); padding: 2rem; }
  h1 { font-size: 1.4rem; margin-bottom: 1.5rem; }
  label { display: block; font-size: .85rem; font-weight: 600; margin-bottom: .3rem; color: #444; }
  input, textarea { width: 100%; padding: .6rem .75rem; border: 1px solid #ddd; border-radius: 6px; font-size: .95rem; font-family: inherit; transition: border-color .15s; }
  input:focus, textarea:focus { outline: none; border-color: #3b82f6; box-shadow: 0 0 0 3px rgba(59,130,246,.15); }
  textarea { min-height: 120px; resize: vertical; }
  .field { margin-bottom: 1rem; }
  .row { display: flex; gap: 1rem; }
  .row .field { flex: 1; }
  .toggle { display: flex; align-items: center; gap: .5rem; margin-bottom: 1.25rem; font-size: .85rem; cursor: pointer; }
  .toggle input { width: auto; }
  button { background: #3b82f6; color: #fff; border: none; padding: .7rem 1.5rem; border-radius: 6px; font-size: .95rem; font-weight: 600; cursor: pointer; transition: background .15s; width: 100%; }
  button:hover { background: #2563eb; }
  button:disabled { opacity: .6; cursor: not-allowed; }
  .result { margin-top: 1rem; padding: .75rem 1rem; border-radius: 6px; font-size: .9rem; display: none; }
  .result.success { background: #dcfce7; color: #166534; display: block; }
  .result.error { background: #fee2e2; color: #991b1b; display: block; }
</style>
</head>
<body>
<div class="container">
  <h1>Send Test Email</h1>
  <form id="emailForm">
    <div class="row">
      <div class="field">
        <label for="from">From</label>
        <input id="from" type="email" value="test@example.com" required />
      </div>
      <div class="field">
        <label for="to">To</label>
        <input id="to" type="email" placeholder="recipient@example.com" required />
      </div>
    </div>
    <div class="field">
      <label for="subject">Subject</label>
      <input id="subject" type="text" placeholder="Test email from Cloudflare Worker" required />
    </div>
    <div class="field">
      <label for="body">Body</label>
      <textarea id="body" placeholder="Write your email content here..." required></textarea>
    </div>
    <label class="toggle">
      <input type="checkbox" id="html" /> Send as HTML
    </label>
    <button type="submit" id="sendBtn">Send Email</button>
  </form>
  <div id="result" class="result"></div>
</div>
<script>
  const form = document.getElementById('emailForm');
  const result = document.getElementById('result');
  const sendBtn = document.getElementById('sendBtn');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    result.className = 'result';
    result.style.display = 'none';
    sendBtn.disabled = true;
    sendBtn.textContent = 'Sending...';

    try {
      const res = await fetch('/api/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: document.getElementById('from').value,
          to: document.getElementById('to').value,
          subject: document.getElementById('subject').value,
          body: document.getElementById('body').value,
          html: document.getElementById('html').checked,
        }),
      });

      const data = await res.json();
      if (res.ok) {
        result.className = 'result success';
        result.textContent = data.message;
      } else {
        result.className = 'result error';
        result.textContent = data.error || 'Unknown error';
      }
    } catch (err) {
      result.className = 'result error';
      result.textContent = 'Network error: ' + err.message;
    } finally {
      sendBtn.disabled = false;
      sendBtn.textContent = 'Send Email';
    }
  });
</script>
</body>
</html>`;
