import Redis from 'ioredis';

const DEFAULT_TTL_SECONDS = 30 * 60;
let redisClient: Redis | null = null;
let loggedRedisError = false;

const getRedisClient = () => {
  if (redisClient) return redisClient;
  const redisUrl = process.env.CACHE_REDIS_URL || process.env.REDIS_URL;
  if (!redisUrl) return null;
  redisClient = new Redis(redisUrl, {
    maxRetriesPerRequest: 1,
    enableReadyCheck: true,
  });
  redisClient.on('error', (err) => {
    if (!loggedRedisError) {
      console.warn(`Redis cache unavailable, falling back to memory: ${err.message}`);
      loggedRedisError = true;
    }
  });
  return redisClient;
};

export const publishedCache = {
  async get<T>(key: string): Promise<T | null> {
    const client = getRedisClient();
    if (client) {
      try {
        const raw = await client.get(key);
        if (!raw) return null;
        return JSON.parse(raw) as T;
      } catch (err) {
        return null;
      }
    }
    return null;
  },

  async set<T>(key: string, value: T, ttlSeconds: number = DEFAULT_TTL_SECONDS): Promise<void> {
    const payload = JSON.stringify(value);
    const client = getRedisClient();
    if (client) {
      try {
        await client.set(key, payload, 'EX', ttlSeconds);
        return;
      } catch {
        // ignore
      }
    }
  },

  async del(key: string): Promise<void> {
    const client = getRedisClient();
    if (client) {
      try {
        await client.del(key);
      } catch {
        // ignore
      }
    }
  },
};
