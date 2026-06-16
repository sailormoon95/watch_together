import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cookiePlugin from '@fastify/cookie';
import multipartPlugin from '@fastify/multipart';
import staticPlugin from '@fastify/static';
import { appConfig, ensureDataDirectories } from './config.js';
import {
  Store,
  type LibraryItemRecord,
  type LibraryItemWithVideos,
  type VideoRecord
} from './database.js';
import {
  processVideo,
  sanitizeDirectorySegment,
  sanitizeFileName,
  sendVideoFile
} from './video.js';
import { registerWatchSockets } from './sockets.js';

interface UploadedTempFile {
  fieldName: string;
  originalName: string;
  tempPath: string;
}

const adminCookieName = 'watch_admin_session';
const roomCodeAlphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

await ensureDataDirectories();

const store = new Store(appConfig.storePath);
const app = Fastify({
  logger: {
    level: appConfig.logLevel,
    serializers: {
      req(request) {
        return {
          method: request.method,
          url: request.url,
          host: request.host,
          remoteAddress: request.ip
        };
      },
      res(reply) {
        return {
          statusCode: reply.statusCode
        };
      }
    }
  },
  bodyLimit: appConfig.maxUploadBytes
});

await app.register(cookiePlugin, { secret: appConfig.sessionSecret });
await app.register(multipartPlugin, {
  limits: {
    files: 100,
    fileSize: appConfig.maxUploadBytes
  }
});

await registerWatchSockets(app, store);

app.addHook('onResponse', async (request, reply) => {
  app.log.debug(
    {
      method: request.method,
      url: request.url,
      statusCode: reply.statusCode,
      responseTimeMs: Math.round(reply.elapsedTime)
    },
    'request completed'
  );
});

app.get('/watch/api/health', async () => ({ status: 'ok' }));

app.post('/watch/api/admin/login', async (request, reply) => {
  const body = request.body as { password?: string } | undefined;
  const password = body?.password ?? '';

  if (!safeEquals(password, appConfig.adminPassword)) {
    reply.code(401);
    return { error: 'Invalid password' };
  }

  const token = randomToken(32);
  store.createSession({
    tokenHash: hashSessionToken(token),
    expiresAt: Date.now() + appConfig.sessionTtlMs
  });

  reply.setCookie(adminCookieName, token, {
    path: '/watch',
    httpOnly: true,
    secure: appConfig.cookieSecure,
    sameSite: 'lax',
    maxAge: Math.floor(appConfig.sessionTtlMs / 1000)
  });

  return { ok: true };
});

app.post('/watch/api/admin/logout', async (request, reply) => {
  const token = request.cookies[adminCookieName];
  if (token) store.deleteSession(hashSessionToken(token));
  reply.clearCookie(adminCookieName, { path: '/watch' });
  return { ok: true };
});

app.get('/watch/api/admin/me', async (request, reply) => {
  if (!requireAdmin(request, reply)) return reply;
  return { ok: true };
});

app.get('/watch/api/admin/items', async (request, reply) => {
  if (!requireAdmin(request, reply)) return reply;
  return { items: store.listItemsWithVideos().map(publicItem) };
});

app.post('/watch/api/admin/upload', async (request, reply) => {
  if (!requireAdmin(request, reply)) return reply;

  const tempFiles: UploadedTempFile[] = [];

  try {
    const { fields, files } = await readMultipartUpload(request, tempFiles);
    const kind = fields.kind === 'series' ? 'series' : 'film';
    const title = normalizeTitle(fields.title);
    if (!title) {
      reply.code(400);
      return { error: 'Укажите название' };
    }

    const itemDir = await createUniqueMediaDirectory(title);
    app.log.info(
      {
        kind,
        title,
        itemDir,
        files: [...files.values()].map((file) => ({ fieldName: file.fieldName, originalName: file.originalName }))
      },
      'admin upload received'
    );
    const item = store.createLibraryItem({
      id: randomToken(12),
      kind,
      title,
      directoryPath: itemDir
    });

    const videos = kind === 'film'
      ? await createFilmVideos(item, files)
      : await createSeriesVideos(item, fields, files);

    for (const video of videos) {
      app.log.info(
        {
          itemId: item.id,
          videoId: video.id,
          episodeNumber: video.episodeNumber,
          uploadPath: video.uploadPath
        },
        'video processing queued'
      );
      void processVideo(store, video.id)
        .then(() => {
          const processed = store.getVideo(video.id);
          app.log.info(
            {
              itemId: item.id,
              videoId: video.id,
              durationSeconds: processed?.durationSeconds,
              processedPath: processed?.processedPath
            },
            'video processing completed'
          );
        })
        .catch((error) => {
          app.log.error({ error, videoId: video.id }, 'video processing failed');
        });
    }

    reply.code(202);
    return { item: publicItem({ ...item, videos }) };
  } catch (error) {
    await Promise.allSettled(tempFiles.map((file) => rm(file.tempPath, { force: true })));
    const message = error instanceof Error ? error.message : String(error);
    reply.code(400);
    return { error: message };
  }
});

app.post('/watch/api/admin/rooms', async (request, reply) => {
  if (!requireAdmin(request, reply)) return reply;

  const body = request.body as { itemId?: string } | undefined;
  const itemId = body?.itemId ?? '';
  const item = store.getItemWithVideos(itemId);
  if (!item) {
    reply.code(404);
    return { error: 'Фильм или сериал не найден' };
  }

  const firstReadyVideo = item.videos.find((video) => video.status === 'ready');
  if (!firstReadyVideo) {
    reply.code(409);
    return { error: 'Еще нет готовых видео для просмотра' };
  }

  const token = createUniqueRoomCode();
  const room = store.createRoom({
    id: randomToken(12),
    token,
    itemId,
    currentVideoId: firstReadyVideo.id
  });

  app.log.info(
    { roomId: room.id, code: room.token, itemId, currentVideoId: firstReadyVideo.id },
    'room created'
  );

  return {
    room,
    code: room.token,
    url: `${appConfig.publicBaseUrl}/r/${room.token}`
  };
});

app.delete('/watch/api/admin/items/:itemId', async (request, reply) => {
  if (!requireAdmin(request, reply)) return reply;
  const params = request.params as { itemId?: string };
  const item = store.deleteItem(params.itemId ?? '');
  if (!item) {
    reply.code(404);
    return { error: 'Фильм или сериал не найден' };
  }
  app.log.warn({ itemId: item.id, title: item.title, directoryPath: item.directoryPath }, 'library item deleted');
  await removeMediaDirectory(item.directoryPath);
  return { ok: true };
});

app.delete('/watch/api/admin/videos/:videoId', async (request, reply) => {
  if (!requireAdmin(request, reply)) return reply;
  const params = request.params as { videoId?: string };
  const video = store.deleteVideo(params.videoId ?? '');
  if (!video) {
    reply.code(404);
    return { error: 'Серия не найдена' };
  }

  app.log.warn(
    { videoId: video.id, itemId: video.itemId, episodeNumber: video.episodeNumber, uploadPath: video.uploadPath },
    'video deleted'
  );
  await removeMediaDirectory(path.dirname(video.uploadPath));
  return { ok: true };
});

app.get('/watch/api/rooms/:token', async (request, reply) => {
  const token = getTokenParam(request);
  const room = store.getRoomWithItem(token);
  const readyVideos = room?.videos.filter((video) => video.status === 'ready') ?? [];
  const currentVideo = readyVideos.find((video) => video.id === room?.currentVideoId) ?? readyVideos[0];
  if (!room || !currentVideo) {
    app.log.warn({ token }, 'room metadata request rejected');
    reply.code(404);
    return { error: 'Комната не найдена' };
  }

  return {
    token: room.token,
    item: {
      kind: room.item.kind,
      title: room.item.title
    },
    currentVideoId: currentVideo.id,
    videos: readyVideos.map(publicRoomVideo)
  };
});

app.get('/watch/api/rooms/:token/video', async (request, reply) => {
  const token = getTokenParam(request);
  const room = store.getRoomWithItem(token);
  if (!room?.currentVideo) {
    app.log.warn({ token }, 'current room video request rejected');
    reply.code(404);
    return { error: 'Видео не найдено' };
  }

  await sendRoomVideo(request, reply, room.currentVideo);
});

app.get('/watch/api/rooms/:token/video/:videoId', async (request, reply) => {
  const token = getTokenParam(request);
  const params = request.params as { videoId?: string };
  const room = store.getRoomWithItem(token);
  const video = room?.videos.find((entry) => entry.id === params.videoId);
  if (!room || !video) {
    app.log.warn({ token, videoId: params.videoId }, 'room video request rejected');
    reply.code(404);
    return { error: 'Видео не найдено' };
  }

  await sendRoomVideo(request, reply, video);
});

await registerClientRoutes(app);

const close = async (): Promise<void> => {
  await app.close();
  store.close();
};

process.on('SIGTERM', () => {
  void close().finally(() => process.exit(0));
});

process.on('SIGINT', () => {
  void close().finally(() => process.exit(0));
});

try {
  await app.listen({ host: appConfig.host, port: appConfig.port });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

async function readMultipartUpload(
  request: FastifyRequest,
  tempFiles: UploadedTempFile[]
): Promise<{ fields: Record<string, string>; files: Map<string, UploadedTempFile> }> {
  const fields: Record<string, string> = {};
  const files = new Map<string, UploadedTempFile>();

  for await (const part of request.parts()) {
    if (part.type === 'file') {
      const originalName = sanitizeFileName(part.filename ?? 'video');
      const extension = normalizeExtension(path.extname(originalName));
      const tempPath = path.join(appConfig.incomingDir, `${randomToken(12)}${extension}`);
      await pipeline(part.file, createWriteStream(tempPath));
      const tempFile = { fieldName: part.fieldname, originalName, tempPath };
      tempFiles.push(tempFile);
      files.set(part.fieldname, tempFile);
    } else {
      fields[part.fieldname] = String(part.value ?? '').trim();
    }
  }

  return { fields, files };
}

async function createFilmVideos(
  item: LibraryItemRecord,
  files: Map<string, UploadedTempFile>
): Promise<VideoRecord[]> {
  const file = files.get('filmFile');
  if (!file) throw new Error('Загрузите файл фильма');

  const uploadPath = path.join(item.directoryPath, withOriginalPrefix(file.originalName));
  await rename(file.tempPath, uploadPath);
  return [
    store.createVideo({
      id: randomToken(12),
      itemId: item.id,
      episodeNumber: null,
      title: item.title,
      originalName: file.originalName,
      uploadPath
    })
  ];
}

async function createSeriesVideos(
  item: LibraryItemRecord,
  fields: Record<string, string>,
  files: Map<string, UploadedTempFile>
): Promise<VideoRecord[]> {
  const episodeCount = Number.parseInt(fields.episodeCount ?? '', 10);
  if (!Number.isInteger(episodeCount) || episodeCount < 1 || episodeCount > 100) {
    throw new Error('Укажите количество серий от 1 до 100');
  }

  const videos: VideoRecord[] = [];
  for (let episodeNumber = 1; episodeNumber <= episodeCount; episodeNumber += 1) {
    const title = normalizeTitle(fields[`episodeTitle_${episodeNumber}`]) || `Серия ${episodeNumber}`;
    const file = files.get(`episodeFile_${episodeNumber}`);
    if (!file) throw new Error(`Загрузите файл для серии ${episodeNumber}`);

    const episodeDir = path.join(
      item.directoryPath,
      `${String(episodeNumber).padStart(2, '0')} - ${sanitizeDirectorySegment(title)}`
    );
    await mkdir(episodeDir, { recursive: true });
    const uploadPath = path.join(episodeDir, withOriginalPrefix(file.originalName));
    await rename(file.tempPath, uploadPath);

    videos.push(
      store.createVideo({
        id: randomToken(12),
        itemId: item.id,
        episodeNumber,
        title,
        originalName: file.originalName,
        uploadPath
      })
    );
  }

  return videos;
}

async function sendRoomVideo(
  request: FastifyRequest,
  reply: FastifyReply,
  video: VideoRecord
): Promise<void> {
  if (video.status !== 'ready' || !video.processedPath) {
    request.log.warn({ videoId: video.id, status: video.status }, 'video file requested before ready');
    reply.code(404);
    reply.send({ error: 'Видео еще не готово' });
    return;
  }

  request.log.debug({ videoId: video.id, processedPath: video.processedPath }, 'serving video file');
  await sendVideoFile(request, reply, video.processedPath, video.mimeType ?? 'video/mp4');
}

function requireAdmin(request: FastifyRequest, reply: FastifyReply): boolean {
  const token = request.cookies[adminCookieName];
  if (!token || !store.hasValidSession(hashSessionToken(token))) {
    reply.code(401).send({ error: 'Admin login required' });
    return false;
  }
  return true;
}

function publicItem(item: LibraryItemWithVideos) {
  return {
    id: item.id,
    kind: item.kind,
    title: item.title,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    videos: item.videos.map(publicVideo)
  };
}

function publicVideo(video: VideoRecord) {
  return {
    id: video.id,
    itemId: video.itemId,
    episodeNumber: video.episodeNumber,
    title: video.title,
    originalName: video.originalName,
    mimeType: video.mimeType,
    durationSeconds: video.durationSeconds,
    status: video.status,
    error: video.error,
    createdAt: video.createdAt,
    updatedAt: video.updatedAt
  };
}

function publicRoomVideo(video: VideoRecord): Pick<
  VideoRecord,
  'id' | 'episodeNumber' | 'title' | 'durationSeconds'
> {
  return {
    id: video.id,
    episodeNumber: video.episodeNumber,
    title: video.title,
    durationSeconds: video.durationSeconds
  };
}

async function registerClientRoutes(fastify: typeof app): Promise<void> {
  const currentFile = fileURLToPath(import.meta.url);
  const currentDir = path.dirname(currentFile);
  const clientRoot = path.resolve(currentDir, '../client');
  const indexPath = path.join(clientRoot, 'index.html');

  try {
    await stat(indexPath);
  } catch {
    fastify.log.warn('client build was not found; only API routes are available');
    return;
  }

  await fastify.register(staticPlugin, {
    root: path.join(clientRoot, 'assets'),
    prefix: '/watch/assets/',
    decorateReply: false
  });

  const sendIndex = async (_request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    reply.type('text/html').send(await readFile(indexPath, 'utf8'));
  };

  fastify.get('/watch', sendIndex);
  fastify.get('/watch/', sendIndex);
  fastify.get('/watch/*', sendIndex);
}

function getTokenParam(request: FastifyRequest): string {
  const params = request.params as { token?: string };
  return (params.token ?? '').toUpperCase();
}

function createUniqueRoomCode(): string {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const code = createRoomCode(6);
    if (!store.hasRoomToken(code)) return code;
  }
  return createRoomCode(8);
}

function createRoomCode(length: number): string {
  const bytes = randomBytes(length);
  let code = '';
  for (const byte of bytes) code += roomCodeAlphabet[byte % roomCodeAlphabet.length];
  return code;
}

function randomToken(bytes: number): string {
  return randomBytes(bytes).toString('base64url');
}

function hashSessionToken(token: string): string {
  return createHash('sha256').update(appConfig.sessionSecret).update(token).digest('hex');
}

function safeEquals(left: string, right: string): boolean {
  const leftHash = createHash('sha256').update(left).digest();
  const rightHash = createHash('sha256').update(right).digest();
  return timingSafeEqual(leftHash, rightHash);
}

function normalizeTitle(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);
}

function normalizeExtension(extension: string): string {
  const normalized = extension.toLowerCase().replace(/[^a-z0-9.]/g, '');
  return normalized && normalized.startsWith('.') ? normalized : '.bin';
}

function withOriginalPrefix(fileName: string): string {
  return `original-${sanitizeFileName(fileName)}`;
}

async function createUniqueMediaDirectory(title: string): Promise<string> {
  const baseName = sanitizeDirectorySegment(title);
  for (let suffix = 0; suffix < 1000; suffix += 1) {
    const directoryName = suffix === 0 ? baseName : `${baseName}-${suffix + 1}`;
    const directoryPath = path.join(appConfig.mediaDir, directoryName);
    try {
      await mkdir(directoryPath);
      return directoryPath;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  throw new Error('Не удалось создать директорию для медиа');
}

async function removeMediaDirectory(directoryPath: string): Promise<void> {
  const resolvedMediaDir = path.resolve(appConfig.mediaDir);
  const resolvedPath = path.resolve(directoryPath);
  if (!resolvedPath.startsWith(`${resolvedMediaDir}${path.sep}`) && resolvedPath !== resolvedMediaDir) {
    throw new Error('Refusing to delete a path outside media directory');
  }
  if (resolvedPath === resolvedMediaDir) {
    throw new Error('Refusing to delete media root directory');
  }
  await rm(resolvedPath, { recursive: true, force: true });
}
