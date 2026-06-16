import { existsSync, readFileSync, writeFileSync } from 'node:fs';

export type LibraryKind = 'film' | 'series';
export type VideoStatus = 'uploaded' | 'processing' | 'ready' | 'failed';

export interface LibraryItemRecord {
  id: string;
  kind: LibraryKind;
  title: string;
  directoryPath: string;
  createdAt: string;
  updatedAt: string;
}

export interface VideoRecord {
  id: string;
  itemId: string;
  episodeNumber: number | null;
  title: string;
  originalName: string;
  uploadPath: string;
  processedPath: string | null;
  mimeType: string | null;
  durationSeconds: number | null;
  status: VideoStatus;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LibraryItemWithVideos extends LibraryItemRecord {
  videos: VideoRecord[];
}

export interface RoomRecord {
  id: string;
  token: string;
  itemId: string;
  currentVideoId: string;
  createdAt: string;
}

export interface RoomWithItem extends RoomRecord {
  item: LibraryItemRecord;
  videos: VideoRecord[];
  currentVideo: VideoRecord | null;
}

interface AdminSessionRecord {
  tokenHash: string;
  expiresAt: number;
  createdAt: number;
}

interface StoreData {
  items: LibraryItemRecord[];
  videos: VideoRecord[];
  rooms: RoomRecord[];
  sessions: AdminSessionRecord[];
}

const emptyData = (): StoreData => ({
  items: [],
  videos: [],
  rooms: [],
  sessions: []
});

export class Store {
  private data: StoreData;

  constructor(private readonly storePath: string) {
    this.data = this.readData();
  }

  createLibraryItem(input: {
    id: string;
    kind: LibraryKind;
    title: string;
    directoryPath: string;
  }): LibraryItemRecord {
    const now = new Date().toISOString();
    const item: LibraryItemRecord = {
      id: input.id,
      kind: input.kind,
      title: input.title,
      directoryPath: input.directoryPath,
      createdAt: now,
      updatedAt: now
    };
    this.data.items.push(item);
    this.persist();
    return item;
  }

  createVideo(input: {
    id: string;
    itemId: string;
    episodeNumber: number | null;
    title: string;
    originalName: string;
    uploadPath: string;
  }): VideoRecord {
    const now = new Date().toISOString();
    const video: VideoRecord = {
      id: input.id,
      itemId: input.itemId,
      episodeNumber: input.episodeNumber,
      title: input.title,
      originalName: input.originalName,
      uploadPath: input.uploadPath,
      processedPath: null,
      mimeType: null,
      durationSeconds: null,
      status: 'uploaded',
      error: null,
      createdAt: now,
      updatedAt: now
    };
    this.data.videos.push(video);
    this.touchItem(input.itemId, now);
    this.persist();
    return video;
  }

  updateVideoProcessing(id: string): void {
    this.updateVideo(id, (video) => {
      video.status = 'processing';
      video.error = null;
    });
  }

  updateVideoReady(input: {
    id: string;
    processedPath: string;
    mimeType: string;
    durationSeconds: number | null;
  }): void {
    this.updateVideo(input.id, (video) => {
      video.status = 'ready';
      video.processedPath = input.processedPath;
      video.mimeType = input.mimeType;
      video.durationSeconds = input.durationSeconds;
      video.error = null;
    });
  }

  updateVideoFailed(id: string, error: string): void {
    this.updateVideo(id, (video) => {
      video.status = 'failed';
      video.error = error.slice(0, 2000);
    });
  }

  getVideo(id: string): VideoRecord | null {
    return this.data.videos.find((video) => video.id === id) ?? null;
  }

  listItemsWithVideos(): LibraryItemWithVideos[] {
    return [...this.data.items]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((item) => ({ ...item, videos: this.getItemVideos(item.id) }));
  }

  getItemWithVideos(itemId: string): LibraryItemWithVideos | null {
    const item = this.data.items.find((entry) => entry.id === itemId);
    if (!item) return null;
    return { ...item, videos: this.getItemVideos(item.id) };
  }

  createRoom(input: {
    id: string;
    token: string;
    itemId: string;
    currentVideoId: string;
  }): RoomRecord {
    const room: RoomRecord = {
      id: input.id,
      token: input.token,
      itemId: input.itemId,
      currentVideoId: input.currentVideoId,
      createdAt: new Date().toISOString()
    };
    this.data.rooms.push(room);
    this.persist();
    return room;
  }

  deleteItem(itemId: string): LibraryItemRecord | null {
    const item = this.data.items.find((entry) => entry.id === itemId) ?? null;
    if (!item) return null;
    this.data.items = this.data.items.filter((entry) => entry.id !== itemId);
    this.data.videos = this.data.videos.filter((video) => video.itemId !== itemId);
    this.data.rooms = this.data.rooms.filter((room) => room.itemId !== itemId);
    this.persist();
    return item;
  }

  deleteVideo(videoId: string): VideoRecord | null {
    const video = this.getVideo(videoId);
    if (!video) return null;
    this.data.videos = this.data.videos.filter((entry) => entry.id !== videoId);

    const remainingVideos = this.getItemVideos(video.itemId);
    const fallbackVideo = remainingVideos.find((entry) => entry.status === 'ready') ?? remainingVideos[0];
    if (fallbackVideo) {
      for (const room of this.data.rooms) {
        if (room.currentVideoId === videoId) room.currentVideoId = fallbackVideo.id;
      }
    } else {
      this.data.rooms = this.data.rooms.filter((room) => room.itemId !== video.itemId);
    }

    this.touchItem(video.itemId, new Date().toISOString());
    this.persist();
    return video;
  }

  getRoomByToken(token: string): RoomRecord | null {
    return this.data.rooms.find((room) => room.token === token) ?? null;
  }

  hasRoomToken(token: string): boolean {
    return this.data.rooms.some((room) => room.token === token);
  }

  getRoomWithItem(token: string): RoomWithItem | null {
    const room = this.getRoomByToken(token);
    if (!room) return null;
    const item = this.data.items.find((entry) => entry.id === room.itemId);
    if (!item) return null;
    const videos = this.getItemVideos(item.id);
    return {
      ...room,
      item,
      videos,
      currentVideo: videos.find((video) => video.id === room.currentVideoId) ?? null
    };
  }

  updateRoomCurrentVideo(token: string, videoId: string): void {
    const room = this.data.rooms.find((entry) => entry.token === token);
    if (!room) return;
    room.currentVideoId = videoId;
    this.persist();
  }

  createSession(input: { tokenHash: string; expiresAt: number }): void {
    this.data.sessions.push({
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt,
      createdAt: Date.now()
    });
    this.persist();
  }

  hasValidSession(tokenHash: string): boolean {
    this.deleteExpiredSessions();
    return this.data.sessions.some(
      (session) => session.tokenHash === tokenHash && session.expiresAt > Date.now()
    );
  }

  deleteSession(tokenHash: string): void {
    this.data.sessions = this.data.sessions.filter((session) => session.tokenHash !== tokenHash);
    this.persist();
  }

  deleteExpiredSessions(): void {
    const before = this.data.sessions.length;
    this.data.sessions = this.data.sessions.filter((session) => session.expiresAt > Date.now());
    if (this.data.sessions.length !== before) this.persist();
  }

  close(): void {
    this.persist();
  }

  private getItemVideos(itemId: string): VideoRecord[] {
    return this.data.videos
      .filter((video) => video.itemId === itemId)
      .sort((left, right) => {
        const leftNumber = left.episodeNumber ?? 0;
        const rightNumber = right.episodeNumber ?? 0;
        return leftNumber - rightNumber || left.title.localeCompare(right.title);
      });
  }

  private updateVideo(id: string, update: (video: VideoRecord) => void): void {
    const video = this.data.videos.find((entry) => entry.id === id);
    if (!video) return;
    update(video);
    video.updatedAt = new Date().toISOString();
    this.touchItem(video.itemId, video.updatedAt);
    this.persist();
  }

  private touchItem(itemId: string, updatedAt: string): void {
    const item = this.data.items.find((entry) => entry.id === itemId);
    if (item) item.updatedAt = updatedAt;
  }

  private readData(): StoreData {
    if (!existsSync(this.storePath)) return emptyData();
    try {
      const parsed = JSON.parse(readFileSync(this.storePath, 'utf8')) as Partial<StoreData>;
      return {
        items: Array.isArray(parsed.items) ? parsed.items : [],
        videos: Array.isArray(parsed.videos) ? parsed.videos : [],
        rooms: Array.isArray(parsed.rooms) ? parsed.rooms : [],
        sessions: Array.isArray(parsed.sessions) ? parsed.sessions : []
      };
    } catch {
      return emptyData();
    }
  }

  private persist(): void {
    writeFileSync(this.storePath, `${JSON.stringify(this.data, null, 2)}\n`);
  }
}
