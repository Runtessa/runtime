import https from 'https';
import http from 'http';
import { HttpRequestOptions, HttpResponse } from './adapterTypes';

export const createHttpAdapter = (
  fire: <T>(execute: () => Promise<T>) => Promise<T>,
): {
  request: (url: string, options?: HttpRequestOptions) => Promise<HttpResponse>;
} => ({
  request: async (url: string, options?: HttpRequestOptions): Promise<HttpResponse> =>
    fire(
      () =>
        new Promise<HttpResponse>((resolve, reject) => {
          const parsedUrl = new URL(url);
          if (!['http:', 'https:'].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password)
            throw new Error('Invalid HTTP destination');
          const headers: Record<string, string> = { ...(options?.headers ?? {}) };

          const body =
            options?.body && typeof options.body === 'object' && !(options.body instanceof Buffer)
              ? JSON.stringify(options.body)
              : (options?.body as string | Buffer | undefined);

          if (body && !headers['content-length']) {
            headers['content-length'] = Buffer.byteLength(body).toString();
          }

          if (body && !headers['content-type'] && typeof options?.body === 'object') {
            headers['content-type'] = 'application/json';
          }

          const requestOptions: https.RequestOptions = {
            method: options?.method ?? 'GET',
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
            path: `${parsedUrl.pathname}${parsedUrl.search}`,
            headers,
          };

          const req = (parsedUrl.protocol === 'https:' ? https : http).request(requestOptions, (res) => {
            const chunks: Buffer[] = [];
            let bytes = 0;
            res.on('data', (chunk) => {
              bytes += chunk.length;
              if (bytes > 4 * 1024 * 1024) { res.destroy(new Error('HTTP response exceeds runtime budget')); return; }
              chunks.push(chunk);
            });
            res.on('error', reject);
            res.on('end', () => {
              resolve({
                statusCode: res.statusCode ?? 0,
                headers: res.headers as Record<string, string | string[]>,
                body: Buffer.concat(chunks).toString('utf8'),
              });
            });
          });

          req.on('error', reject);

          req.setTimeout(Math.max(1, Math.min(Number(options?.timeoutMs) || 5000, 10000)), () => {
            req.destroy(new Error('HTTP request timed out'));
          });

          if (body) {
            req.write(body);
          }
          req.end();
        }),
    ),
});
