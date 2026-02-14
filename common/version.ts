import { randomUUID } from 'crypto';

export const generateVersion = () => {
  const stamp = Date.now().toString(36);
  const rand = randomUUID().replace(/-/g, '').slice(0, 8);
  return `v${stamp}-${rand}`;
};
