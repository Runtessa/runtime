import https from 'https';
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
            port: parsedUrl.port || 443,
            path: `${parsedUrl.pathname}${parsedUrl.search}`,
            headers,
          };

          const req = https.request(requestOptions, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
              resolve({
                statusCode: res.statusCode ?? 0,
                headers: res.headers as Record<string, string | string[]>,
                body: Buffer.concat(chunks).toString('utf8'),
              });
            });
          });

          req.on('error', reject);

          req.setTimeout(options?.timeoutMs ?? 5000, () => {
            req.destroy(new Error('HTTP request timed out'));
          });

          if (body) {
            req.write(body);
          }
          req.end();
        }),
    ),
});
