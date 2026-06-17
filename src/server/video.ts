import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Store } from './database.js';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const ffmpegStaticPath = require('ffmpeg-static') as string | null;
const ffprobeStatic = require('ffprobe-static') as { path?: string };
const ffmpegPath = process.env.WATCH_FFMPEG_PATH ?? ffmpegStaticPath ?? 'ffmpeg';
const ffprobePath = process.env.WATCH_FFPROBE_PATH ?? ffprobeStatic.path ?? 'ffprobe';

interface ProbeResult {
  formatName: string;
  durationSeconds: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
}

interface FfprobeJson {
  streams?: Array<{
    codec_type?: string;
    codec_name?: string;
  }>;
  format?: {
    format_name?: string;
    duration?: string;
  };
}

export function sanitizeFileName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}. _-]+/gu, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180) || 'video';
}

export function sanitizeDirectorySegment(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}. _-]+/gu, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'item';
}

export async function processVideo(store: Store, videoId: string): Promise<void> {
  const video = store.getVideo(videoId);
  if (!video) throw new Error(`Video ${videoId} was not found`);

  store.updateVideoProcessing(videoId);

  try {
    const probe = await probeVideo(video.uploadPath);
    const outputPath = path.join(path.dirname(video.uploadPath), 'processed.mp4');
    const compatible = isBrowserMp4(probe);

    await runFfmpeg(
      compatible
        ? [
            '-y',
            '-i',
            video.uploadPath,
            '-map',
            '0:v:0',
            '-map',
            '0:a:0?',
            '-map',
            '-0:d?',
            '-map',
            '-0:s?',
            '-sn',
            '-dn',
            '-map_metadata',
            '-1',
            '-map_chapters',
            '-1',
            '-c:v',
            'copy',
            '-c:a',
            'aac',
            '-ac',
            '2',
            '-b:a',
            '160k',
            '-movflags',
            '+faststart',
            outputPath
          ]
        : [
            '-y',
            '-i',
            video.uploadPath,
            '-map',
            '0:v:0',
            '-map',
            '0:a:0?',
            '-map',
            '-0:d?',
            '-map',
            '-0:s?',
            '-sn',
            '-dn',
            '-map_metadata',
            '-1',
            '-map_chapters',
            '-1',
            '-c:v',
            'libx264',
            '-preset',
            'veryfast',
            '-crf',
            '23',
            '-pix_fmt',
            'yuv420p',
            '-c:a',
            'aac',
            '-ac',
            '2',
            '-b:a',
            '160k',
            '-movflags',
            '+faststart',
            outputPath
          ]
    );

    store.updateVideoReady({
      id: videoId,
      processedPath: outputPath,
      mimeType: 'video/mp4',
      durationSeconds: probe.durationSeconds
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    store.updateVideoFailed(videoId, message);
    throw error;
  }
}

export async function sendVideoFile(
  request: FastifyRequest,
  reply: FastifyReply,
  filePath: string,
  mimeType: string
): Promise<void> {
  const fileStat = await stat(filePath);
  const range = request.headers.range;

  reply.header('Accept-Ranges', 'bytes');
  reply.header('Content-Type', mimeType);
  reply.header('Cache-Control', 'no-store');

  if (!range) {
    sendStreamResponse(request, reply, 200, filePath, {
      start: undefined,
      end: undefined,
      headers: {
        'Accept-Ranges': 'bytes',
        'Content-Type': mimeType,
        'Cache-Control': 'no-store',
        'Content-Length': fileStat.size
      }
    });
    return;
  }

  const parsedRange = parseRange(range, fileStat.size);
  if (!parsedRange) {
    reply.code(416);
    reply.header('Content-Range', `bytes */${fileStat.size}`);
    reply.send();
    return;
  }

  const { start, end } = parsedRange;
  sendStreamResponse(request, reply, 206, filePath, {
    start,
    end,
    headers: {
      'Accept-Ranges': 'bytes',
      'Content-Type': mimeType,
      'Cache-Control': 'no-store',
      'Content-Length': end - start + 1,
      'Content-Range': `bytes ${start}-${end}/${fileStat.size}`
    }
  });
}

function sendStreamResponse(
  request: FastifyRequest,
  reply: FastifyReply,
  statusCode: number,
  filePath: string,
  options: {
    start: number | undefined;
    end: number | undefined;
    headers: Record<string, string | number>;
  }
): void {
  reply.hijack();
  const stream = createReadStream(filePath, { start: options.start, end: options.end });

  stream.on('error', (error) => {
    request.log.error({ error, filePath }, 'video stream failed');
    reply.raw.destroy(error);
  });

  request.raw.on('close', () => {
    stream.destroy();
  });

  reply.raw.writeHead(statusCode, options.headers);
  stream.pipe(reply.raw);
}

function isBrowserMp4(probe: ProbeResult): boolean {
  const isMp4 = probe.formatName.split(',').some((format) => format === 'mp4' || format === 'mov');
  const videoOk = probe.videoCodec === 'h264';
  const audioOk = probe.audioCodec === null || ['aac', 'mp3'].includes(probe.audioCodec);
  return isMp4 && videoOk && audioOk;
}

async function probeVideo(filePath: string): Promise<ProbeResult> {
  const { stdout } = await execFileAsync(
    ffprobePath,
    [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      filePath
    ],
    { timeout: 60_000, maxBuffer: 1024 * 1024 }
  );

  const parsed = JSON.parse(stdout) as FfprobeJson;
  const videoStream = parsed.streams?.find((stream) => stream.codec_type === 'video');
  const audioStream = parsed.streams?.find((stream) => stream.codec_type === 'audio');
  const duration = parsed.format?.duration ? Number.parseFloat(parsed.format.duration) : Number.NaN;

  if (!videoStream?.codec_name) {
    throw new Error('Uploaded file does not contain a video stream');
  }

  return {
    formatName: parsed.format?.format_name ?? '',
    durationSeconds: Number.isFinite(duration) ? duration : null,
    videoCodec: videoStream.codec_name ?? null,
    audioCodec: audioStream?.codec_name ?? null
  };
}

async function runFfmpeg(args: string[]): Promise<void> {
  try {
    await execFileAsync(ffmpegPath, args, {
      timeout: 6 * 60 * 60 * 1000,
      maxBuffer: 8 * 1024 * 1024
    });
  } catch (error) {
    if (error && typeof error === 'object' && 'stderr' in error) {
      const stderr = String((error as { stderr?: unknown }).stderr ?? '').trim();
      if (stderr) throw new Error(stderr.slice(-2000));
    }
    throw error;
  }
}

function parseRange(rangeHeader: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
  if (!match) return null;

  const rawStart = match[1] ?? '';
  const rawEnd = match[2] ?? '';
  if (!rawStart && !rawEnd) return null;

  let start: number;
  let end: number;

  if (!rawStart) {
    const suffixLength = Number.parseInt(rawEnd, 10);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return null;
    start = Math.max(size - suffixLength, 0);
    end = size - 1;
  } else {
    start = Number.parseInt(rawStart, 10);
    end = rawEnd ? Number.parseInt(rawEnd, 10) : size - 1;
  }

  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start < 0 || end < start || start >= size) return null;

  return {
    start,
    end: Math.min(end, size - 1)
  };
}
