import type { FastifyInstance } from 'fastify';
import websocketPlugin from '@fastify/websocket';
import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import type { Store, VideoRecord } from './database.js';

interface WatchState {
  videoId: string;
  playing: boolean;
  positionSeconds: number;
  updatedAt: number;
  version: number;
}

interface PeerInfo {
  peerId: string;
  audio: boolean;
  video: boolean;
}

interface ClientConnection extends PeerInfo {
  socket: WebSocket;
}

interface RuntimeRoom {
  token: string;
  state: WatchState;
  clients: Map<string, ClientConnection>;
  bufferWait: BufferWait | null;
}

interface BufferWait {
  id: string;
  videoId: string;
  positionSeconds: number;
  requiredPeerIds: Set<string>;
  readyPeerIds: Set<string>;
}

type ClientMessage =
  | { type: 'join'; token?: string }
  | { type: 'sync-action'; action?: string; videoId?: string; position?: number; playing?: boolean }
  | { type: 'switch-video'; videoId?: string }
  | { type: 'signal'; targetPeerId?: string; data?: unknown }
  | { type: 'media-state'; audio?: boolean; video?: boolean }
  | { type: 'buffer-ready'; waitId?: string }
  | {
      type: 'rtc-state';
      remotePeerId?: string;
      event?: string;
      connectionState?: string;
      iceConnectionState?: string;
      signalingState?: string;
    };

const seekBufferThresholdSeconds = 3;

const rooms = new Map<string, RuntimeRoom>();

export async function registerWatchSockets(app: FastifyInstance, store: Store): Promise<void> {
  await app.register(websocketPlugin);

  app.get('/watch/ws', { websocket: true }, (socket, request) => {
    let peerId: string | null = null;
    let roomToken: string | null = null;

    app.log.debug({ ip: request.ip }, 'websocket connected');

    socket.on('message', (raw) => {
      let message: ClientMessage;
      try {
        message = JSON.parse(raw.toString()) as ClientMessage;
      } catch {
        send(socket, { type: 'error', message: 'Invalid JSON message' });
        return;
      }

      if (message.type === 'join') {
        if (peerId) return;
        const token = typeof message.token === 'string' ? message.token.toUpperCase() : '';
        const roomWithItem = store.getRoomWithItem(token);
        const readyVideos = roomWithItem?.videos.filter((video) => video.status === 'ready') ?? [];
        const currentVideo = getCurrentReadyVideo(roomWithItem?.currentVideoId ?? '', readyVideos);
        if (!roomWithItem || !currentVideo) {
          app.log.warn({ token }, 'websocket join rejected');
          send(socket, { type: 'error', message: 'Room was not found or video is not ready' });
          socket.close();
          return;
        }

        const runtimeRoom = getRuntimeRoom(token, currentVideo.id);
        peerId = randomUUID();
        roomToken = token;

        const client: ClientConnection = { peerId, socket, audio: false, video: false };
        runtimeRoom.clients.set(peerId, client);

        app.log.info(
          {
            token,
            peerId,
            currentVideoId: runtimeRoom.state.videoId,
            peers: runtimeRoom.clients.size
          },
          'websocket peer joined room'
        );

        send(socket, {
          type: 'joined',
          peerId,
          serverNow: Date.now(),
          state: runtimeRoom.state,
          peers: [...runtimeRoom.clients.values()]
            .filter((peer) => peer.peerId !== peerId)
            .map(publicPeer)
        });

        broadcast(runtimeRoom, { type: 'peer-joined', peer: publicPeer(client) }, peerId);
        return;
      }

      if (!peerId || !roomToken) {
        send(socket, { type: 'error', message: 'Join a room before sending events' });
        return;
      }

      const runtimeRoom = rooms.get(roomToken);
      if (!runtimeRoom) return;

      if (message.type === 'sync-action') {
        const previousBufferWaitId = runtimeRoom.bufferWait?.id ?? null;
        const changed = updateWatchState(runtimeRoom, store, message);
        if (changed) {
          app.log.debug(
            {
              token: roomToken,
              peerId,
              action: message.action,
              videoId: runtimeRoom.state.videoId,
              positionSeconds: runtimeRoom.state.positionSeconds,
              version: runtimeRoom.state.version
            },
            'watch state updated'
          );
          if (runtimeRoom.bufferWait && runtimeRoom.bufferWait.id !== previousBufferWaitId) {
            broadcast(runtimeRoom, {
              type: 'buffer-wait',
              sourcePeerId: peerId,
              waitId: runtimeRoom.bufferWait.id,
              serverNow: Date.now(),
              state: runtimeRoom.state
            });
            return;
          }
          broadcast(runtimeRoom, {
            type: 'sync-state',
            sourcePeerId: peerId,
            serverNow: Date.now(),
            state: runtimeRoom.state
          }, peerId);
        }
        return;
      }

      if (message.type === 'buffer-ready') {
        const wait = runtimeRoom.bufferWait;
        if (!wait || message.waitId !== wait.id || !wait.requiredPeerIds.has(peerId)) return;
        wait.readyPeerIds.add(peerId);
        app.log.debug(
          {
            token: roomToken,
            peerId,
            waitId: wait.id,
            readyPeers: wait.readyPeerIds.size,
            requiredPeers: wait.requiredPeerIds.size
          },
          'peer buffered seek target'
        );
        if (isBufferWaitReady(runtimeRoom)) {
          finishBufferWait(runtimeRoom);
          broadcast(runtimeRoom, { type: 'sync-state', serverNow: Date.now(), state: runtimeRoom.state });
        }
        return;
      }

      if (message.type === 'switch-video') {
        const nextVideo = findReadyVideo(store, roomToken, message.videoId ?? '');
        if (!nextVideo) {
          send(socket, { type: 'error', message: 'Episode is not ready' });
          return;
        }

        clearBufferWait(runtimeRoom);
        store.updateRoomCurrentVideo(roomToken, nextVideo.id);
        runtimeRoom.state = {
          videoId: nextVideo.id,
          playing: false,
          positionSeconds: 0,
          updatedAt: Date.now(),
          version: runtimeRoom.state.version + 1
        };
        app.log.info({ token: roomToken, peerId, videoId: nextVideo.id }, 'room video switched');
        broadcast(runtimeRoom, {
          type: 'video-switched',
          sourcePeerId: peerId,
          serverNow: Date.now(),
          state: runtimeRoom.state
        });
        return;
      }

      if (message.type === 'signal') {
        const targetPeerId = typeof message.targetPeerId === 'string' ? message.targetPeerId : '';
        const target = runtimeRoom.clients.get(targetPeerId);
        app.log.debug(
          {
            token: roomToken,
            sourcePeerId: peerId,
            targetPeerId,
            signal: signalSummary(message.data),
            delivered: Boolean(target)
          },
          'webrtc signal relayed'
        );
        if (target) {
          send(target.socket, {
            type: 'signal',
            sourcePeerId: peerId,
            data: message.data
          });
        }
        return;
      }

      if (message.type === 'rtc-state') {
        app.log.debug(
          {
            token: roomToken,
            peerId,
            remotePeerId: message.remotePeerId,
            event: message.event,
            connectionState: message.connectionState,
            iceConnectionState: message.iceConnectionState,
            signalingState: message.signalingState
          },
          'webrtc client state changed'
        );
        return;
      }

      if (message.type === 'media-state') {
        const client = runtimeRoom.clients.get(peerId);
        if (!client) return;
        client.audio = Boolean(message.audio);
        client.video = Boolean(message.video);
        app.log.debug(
          { token: roomToken, peerId, audio: client.audio, video: client.video },
          'peer media state changed'
        );
        broadcast(runtimeRoom, { type: 'media-state', peer: publicPeer(client) }, peerId);
      }
    });

    socket.on('close', () => {
      if (!peerId || !roomToken) return;
      const runtimeRoom = rooms.get(roomToken);
      if (!runtimeRoom) return;
      runtimeRoom.clients.delete(peerId);
      if (runtimeRoom.bufferWait) {
        runtimeRoom.bufferWait.requiredPeerIds.delete(peerId);
        runtimeRoom.bufferWait.readyPeerIds.delete(peerId);
      }
      app.log.info({ token: roomToken, peerId, peers: runtimeRoom.clients.size }, 'websocket peer left room');
      broadcast(runtimeRoom, { type: 'peer-left', peerId }, peerId);
      if (isBufferWaitReady(runtimeRoom)) {
        finishBufferWait(runtimeRoom);
        broadcast(runtimeRoom, { type: 'sync-state', serverNow: Date.now(), state: runtimeRoom.state });
      }
      if (runtimeRoom.clients.size === 0) rooms.delete(roomToken);
    });
  });

  const interval = setInterval(() => {
    const now = Date.now();
    for (const room of rooms.values()) {
      if (room.clients.size < 2) continue;
      broadcast(room, { type: 'sync-state', serverNow: now, state: room.state });
    }
  }, 5000);
  interval.unref();

  app.addHook('onClose', async () => {
    clearInterval(interval);
  });
}

function getRuntimeRoom(token: string, videoId: string): RuntimeRoom {
  const existing = rooms.get(token);
  if (existing) return existing;
  const room: RuntimeRoom = {
    token,
    state: {
      videoId,
      playing: false,
      positionSeconds: 0,
      updatedAt: Date.now(),
      version: 0
    },
    clients: new Map(),
    bufferWait: null
  };
  rooms.set(token, room);
  return room;
}

function updateWatchState(room: RuntimeRoom, store: Store, message: ClientMessage): boolean {
  if (message.type !== 'sync-action') return false;
  if (message.videoId && message.videoId !== room.state.videoId) return false;

  const currentVideo = findReadyVideo(store, room.token, room.state.videoId);
  const now = Date.now();
  const action = message.action;
  const currentPosition = getCurrentPosition(room.state, now);
  const requestedPosition = Number.isFinite(message.position)
    ? Number(message.position)
    : currentPosition;
  const position = clampPosition(requestedPosition, currentVideo?.durationSeconds ?? null);

  if (action === 'play') {
    clearBufferWait(room);
    room.state = {
      ...room.state,
      playing: true,
      positionSeconds: position,
      updatedAt: now,
      version: room.state.version + 1
    };
    return true;
  }

  if (action === 'pause') {
    clearBufferWait(room);
    room.state = {
      ...room.state,
      playing: false,
      positionSeconds: position,
      updatedAt: now,
      version: room.state.version + 1
    };
    return true;
  }

  if (action === 'seek') {
    clearBufferWait(room);
    if (message.playing === true
      && room.clients.size > 1
      && Math.abs(position - currentPosition) >= seekBufferThresholdSeconds) {
      room.bufferWait = {
        id: randomUUID(),
        videoId: room.state.videoId,
        positionSeconds: position,
        requiredPeerIds: new Set(room.clients.keys()),
        readyPeerIds: new Set()
      };
      room.state = {
        ...room.state,
        playing: false,
        positionSeconds: position,
        updatedAt: now,
        version: room.state.version + 1
      };
      return true;
    }

    room.state = {
      ...room.state,
      playing: typeof message.playing === 'boolean' ? message.playing : room.state.playing,
      positionSeconds: position,
      updatedAt: now,
      version: room.state.version + 1
    };
    return true;
  }

  return false;
}

function clearBufferWait(room: RuntimeRoom): void {
  room.bufferWait = null;
}

function isBufferWaitReady(room: RuntimeRoom): boolean {
  const wait = room.bufferWait;
  if (!wait) return false;
  for (const peerId of wait.requiredPeerIds) {
    if (!room.clients.has(peerId)) continue;
    if (!wait.readyPeerIds.has(peerId)) return false;
  }
  return true;
}

function finishBufferWait(room: RuntimeRoom): void {
  const wait = room.bufferWait;
  if (!wait) return;
  room.bufferWait = null;
  room.state = {
    ...room.state,
    videoId: wait.videoId,
    playing: true,
    positionSeconds: wait.positionSeconds,
    updatedAt: Date.now(),
    version: room.state.version + 1
  };
}

function findReadyVideo(store: Store, token: string, videoId: string): VideoRecord | null {
  const room = store.getRoomWithItem(token);
  return room?.videos.find((video) => video.id === videoId && video.status === 'ready') ?? null;
}

function getCurrentReadyVideo(videoId: string, videos: VideoRecord[]): VideoRecord | null {
  return videos.find((video) => video.id === videoId) ?? videos[0] ?? null;
}

function getCurrentPosition(state: WatchState, now: number): number {
  if (!state.playing) return state.positionSeconds;
  return state.positionSeconds + (now - state.updatedAt) / 1000;
}

function clampPosition(position: number, durationSeconds: number | null): number {
  const max = durationSeconds && durationSeconds > 0 ? durationSeconds : Number.POSITIVE_INFINITY;
  return Math.max(0, Math.min(position, max));
}

function publicPeer(peer: PeerInfo): PeerInfo {
  return {
    peerId: peer.peerId,
    audio: peer.audio,
    video: peer.video
  };
}

function signalSummary(data: unknown): string {
  if (!data || typeof data !== 'object') return 'unknown';
  const signal = data as {
    description?: { type?: unknown };
    candidate?: { candidate?: unknown; type?: unknown; protocol?: unknown };
  };
  if (signal.description?.type) return `description:${String(signal.description.type)}`;
  if (signal.candidate) {
    const rawCandidate = typeof signal.candidate.candidate === 'string' ? signal.candidate.candidate : '';
    const type = typeof signal.candidate.type === 'string'
      ? signal.candidate.type
      : / typ ([a-z]+)/.exec(rawCandidate)?.[1] ?? 'candidate';
    const protocol = typeof signal.candidate.protocol === 'string'
      ? signal.candidate.protocol
      : / udp /i.test(rawCandidate)
        ? 'udp'
        : / tcp /i.test(rawCandidate)
          ? 'tcp'
          : 'unknown';
    return `candidate:${type}:${protocol}`;
  }
  return 'unknown';
}

function broadcast(room: RuntimeRoom, payload: unknown, exceptPeerId?: string): void {
  for (const client of room.clients.values()) {
    if (client.peerId === exceptPeerId) continue;
    send(client.socket, payload);
  }
}

function send(socket: WebSocket, payload: unknown): void {
  if (socket.readyState !== 1) return;
  socket.send(JSON.stringify(payload));
}
