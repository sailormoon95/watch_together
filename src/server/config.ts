import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { config as loadDotEnv } from 'dotenv';

loadDotEnv();

function readInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function normalizeBaseUrl(raw: string): string {
  return raw.replace(/\/+$/, '');
}

function readList(name: string): string[] {
  return (process.env[name] ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

const dataDir = path.resolve(process.env.WATCH_DATA_DIR ?? './data');
const mediaDir = path.join(dataDir, 'media');
const publicBaseUrl = normalizeBaseUrl(
  process.env.WATCH_PUBLIC_BASE_URL ?? 'http://localhost:3000/watch'
);

export const appConfig = {
  host: process.env.WATCH_HOST ?? '0.0.0.0',
  port: readInt('WATCH_PORT', 3000),
  logLevel: process.env.WATCH_LOG_LEVEL ?? 'debug',
  publicBaseUrl,
  adminPassword: process.env.WATCH_ADMIN_PASSWORD ?? 'change-me',
  sessionSecret: process.env.WATCH_SESSION_SECRET ?? 'dev-watch-session-secret',
  sessionTtlMs: readInt('WATCH_SESSION_TTL_HOURS', 24) * 60 * 60 * 1000,
  cookieSecure: readBool('WATCH_COOKIE_SECURE', publicBaseUrl.startsWith('https://')),
  maxUploadBytes: readInt('WATCH_MAX_UPLOAD_MB', 8192) * 1024 * 1024,
  dataDir,
  mediaDir,
  incomingDir: path.join(dataDir, 'incoming'),
  storePath: path.join(dataDir, 'store.json'),
  videoAccelRedirectPrefix: process.env.WATCH_VIDEO_ACCEL_REDIRECT_PREFIX ?? '',
  videoAccelFilePrefix: path.resolve(process.env.WATCH_VIDEO_ACCEL_FILE_PREFIX ?? mediaDir),
  turnUrls: readList('WATCH_TURN_URLS'),
  turnSharedSecret: process.env.WATCH_TURN_SHARED_SECRET ?? '',
  turnCredentialTtlSeconds: readInt('WATCH_TURN_CREDENTIAL_TTL_SECONDS', 6 * 60 * 60)
};

export async function ensureDataDirectories(): Promise<void> {
  await mkdir(appConfig.mediaDir, { recursive: true });
  await mkdir(appConfig.incomingDir, { recursive: true });
}
