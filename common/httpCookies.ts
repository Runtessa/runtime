export const parseCookieHeader = (rawCookieHeader: string | undefined): Record<string, string> => {
  if (!rawCookieHeader) return {};
  const cookies: Record<string, string> = {};
  const parts = rawCookieHeader.split(';');
  for (const part of parts) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!key) continue;
    try {
      cookies[key] = decodeURIComponent(value);
    } catch {
      cookies[key] = value;
    }
  }
  return cookies;
};

export const readCookie = (rawCookieHeader: string | undefined, name: string): string | null => {
  if (!name) return null;
  const cookies = parseCookieHeader(rawCookieHeader);
  const value = cookies[name];
  if (!value) return null;
  return value;
};
