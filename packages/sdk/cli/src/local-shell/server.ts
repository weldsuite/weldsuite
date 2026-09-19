/**
 * Tiny static HTTP server that hosts the WeldApps local shell page.
 */

import { createServer, type Server } from 'node:http';
import { CliError } from '../errors.js';
import { renderLocalShellHtml, type LocalShellPageOptions } from './html.js';

export interface LocalShellServer {
  url: string;
  port: number;
  close: () => Promise<void>;
}

export interface StartLocalShellOptions extends LocalShellPageOptions {
  /** Preferred listen port (falls back to an ephemeral port if busy). */
  port?: number;
  host?: string;
}

function listen(server: Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      const address = server.address();
      if (address && typeof address === 'object') {
        resolve(address.port);
        return;
      }
      reject(new CliError('Local shell server failed to bind a port'));
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

export async function startLocalShellServer(options: StartLocalShellOptions): Promise<LocalShellServer> {
  const host = options.host ?? '127.0.0.1';
  const preferredPort = options.port ?? 4173;
  const html = renderLocalShellHtml({
    appUrl: options.appUrl,
    appCode: options.appCode,
    appName: options.appName,
  });

  const server = createServer((req, res) => {
    const url = req.url ?? '/';
    if (url === '/' || url.startsWith('/?') || url.startsWith('/index.html')) {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(html);
      return;
    }
    if (url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  });

  let port: number;
  try {
    port = await listen(server, preferredPort, host);
  } catch (cause) {
    const err = cause as NodeJS.ErrnoException;
    if (err.code === 'EADDRINUSE' && preferredPort !== 0) {
      port = await listen(server, 0, host);
    } else {
      throw new CliError(
        `Could not start local shell server: ${err.message ?? String(cause)}`,
      );
    }
  }

  const url = `http://localhost:${port}/`;
  return {
    url,
    port,
    close: () =>
      new Promise((resolveClose) => {
        server.close(() => resolveClose());
      }),
  };
}
