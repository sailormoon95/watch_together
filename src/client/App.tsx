import { FormEvent, useEffect, useRef, useState } from 'react';
import {
  Room,
  RoomEvent,
  Track,
  type LocalTrackPublication,
  type Participant,
  type TrackPublication
} from 'livekit-client';

const apiBase = '/watch/api';

type AuthState = 'checking' | 'in' | 'out';
type LibraryKind = 'film' | 'series';
type VideoStatus = 'uploaded' | 'processing' | 'ready' | 'failed';

interface AdminVideo {
  id: string;
  itemId: string;
  episodeNumber: number | null;
  title: string;
  originalName: string;
  mimeType: string | null;
  durationSeconds: number | null;
  status: VideoStatus;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

interface AdminItem {
  id: string;
  kind: LibraryKind;
  title: string;
  createdAt: string;
  updatedAt: string;
  videos: AdminVideo[];
}

interface StorageInfo {
  dataDir: string;
  totalBytes: number;
  availableBytes: number;
  usedBytes: number;
  usedPercent: number;
}

interface RoomVideo {
  id: string;
  episodeNumber: number | null;
  title: string;
  durationSeconds: number | null;
}

interface RoomMeta {
  token: string;
  item: {
    kind: LibraryKind;
    title: string;
  };
  currentVideoId: string;
  videos: RoomVideo[];
}

interface LiveKitTokenResponse {
  url: string;
  token: string;
  identity: string;
  name: string;
}

interface WatchState {
  videoId: string;
  playing: boolean;
  positionSeconds: number;
  updatedAt: number;
  version: number;
}

type ServerMessage =
  | { type: 'joined'; peerId?: string; serverNow: number; state: WatchState }
  | { type: 'sync-state'; serverNow: number; state: WatchState; sourcePeerId?: string }
  | { type: 'buffer-wait'; waitId: string; serverNow: number; state: WatchState; sourcePeerId?: string }
  | { type: 'video-switched'; serverNow: number; state: WatchState; sourcePeerId?: string }
  | { type: 'error'; message: string };

interface LocalMediaState {
  microphone: boolean;
  muted: boolean;
  camera: boolean;
}

interface ParticipantTileData {
  identity: string;
  label: string;
  stream: MediaStream | null;
  audio: boolean;
  muted: boolean;
  video: boolean;
  local: boolean;
}

interface BufferWaitState {
  waitId: string;
  videoId: string;
  positionSeconds: number;
  stateVersion: number;
  readySent: boolean;
}

export function App() {
  const path = window.location.pathname;
  const roomMatch = /^\/watch\/r\/([^/]+)\/?$/.exec(path);

  if (path.startsWith('/watch/admin')) return <AdminPage />;
  if (roomMatch?.[1]) return <RoomPage token={roomMatch[1].toUpperCase()} />;
  return <HomePage />;
}

function HomePage() {
  const [code, setCode] = useState('');

  function join(event: FormEvent) {
    event.preventDefault();
    const normalized = normalizeRoomCode(code);
    if (normalized) window.location.href = `/watch/r/${normalized}`;
  }

  return (
    <main className="shell narrow">
      <section className="hero-card">
        <p className="eyebrow">Watch Together</p>
        <h1>Совместный просмотр фильма по короткой ссылке</h1>
        <p>
          Откройте комнату на ноутбуке, телефоне или ТВ. Все участники синхронно управляют
          просмотром, камерой и микрофоном.
        </p>
        <form className="join-form" onSubmit={join}>
          <input
            value={code}
            onChange={(event) => setCode(event.target.value.toUpperCase())}
            placeholder="Код комнаты"
            inputMode="text"
            autoCapitalize="characters"
          />
          <button className="primary-button" type="submit">
            Войти
          </button>
        </form>
        <a className="secondary-link" href="/watch/admin">
          Админка
        </a>
      </section>
    </main>
  );
}

function StorageCard({ storage }: { storage: StorageInfo }) {
  return (
    <div className="storage-card">
      <div>
        <p className="eyebrow">Storage</p>
        <h2>Место на диске</h2>
        <p className="muted">Свободно: {formatBytes(storage.availableBytes)}</p>
      </div>
      <div className="storage-meter" aria-label={`Занято ${storage.usedPercent}%`}>
        <div className="storage-meter-bar">
          <span style={{ width: `${Math.min(storage.usedPercent, 100)}%` }} />
        </div>
        <p>
          Занято {formatBytes(storage.usedBytes)} из {formatBytes(storage.totalBytes)} ·{' '}
          {storage.usedPercent}%
        </p>
      </div>
    </div>
  );
}

function AdminPage() {
  const [authState, setAuthState] = useState<AuthState>('checking');
  const [password, setPassword] = useState('');
  const [items, setItems] = useState<AdminItem[]>([]);
  const [storage, setStorage] = useState<StorageInfo | null>(null);
  const [kind, setKind] = useState<LibraryKind>('film');
  const [title, setTitle] = useState('');
  const [episodeCount, setEpisodeCount] = useState(1);
  const [episodeTitles, setEpisodeTitles] = useState<Record<number, string>>({ 1: 'Серия 1' });
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [uploadSpeed, setUploadSpeed] = useState('');
  const [createdLinks, setCreatedLinks] = useState<Array<{ code: string; url: string }>>([]);
  const filmFileRef = useRef<HTMLInputElement>(null);
  const episodeFileRefs = useRef<Record<number, HTMLInputElement | null>>({});
  const cancelUploadRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    void apiJson(`${apiBase}/admin/me`)
      .then(() => setAuthState('in'))
      .catch(() => setAuthState('out'));
  }, []);

  useEffect(() => {
    if (authState !== 'in') return;
    void loadAdminData();
    const interval = window.setInterval(() => void loadAdminData(), 3000);
    return () => window.clearInterval(interval);
  }, [authState]);

  async function loadAdminData() {
    await Promise.allSettled([loadItems(), loadStorage()]);
  }

  async function loadItems() {
    try {
      const response = await apiJson<{ items: AdminItem[] }>(`${apiBase}/admin/items`);
      setItems(response.items);
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  async function loadStorage() {
    try {
      const response = await apiJson<StorageInfo>(`${apiBase}/admin/storage`);
      setStorage(response);
    } catch {
      setStorage(null);
    }
  }

  async function login(event: FormEvent) {
    event.preventDefault();
    setError('');
    setMessage('');
    try {
      await apiJson(`${apiBase}/admin/login`, {
        method: 'POST',
        body: JSON.stringify({ password })
      });
      setPassword('');
      setAuthState('in');
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  async function logout() {
    await apiJson(`${apiBase}/admin/logout`, { method: 'POST' }).catch(() => undefined);
    setAuthState('out');
    setItems([]);
  }

  async function upload(event: FormEvent) {
    event.preventDefault();
    setUploading(true);
    setUploadProgress(0);
    setUploadSpeed('0 Б/с');
    setError('');
    setMessage('');

    try {
      const formData = new FormData();
      formData.append('kind', kind);
      formData.append('title', title);

      if (kind === 'film') {
        const file = filmFileRef.current?.files?.[0];
        if (!file) throw new Error('Выберите файл фильма');
        formData.append('filmFile', file);
      } else {
        formData.append('episodeCount', String(episodeCount));
        for (const episodeNumber of episodeNumbers(episodeCount)) {
          const file = episodeFileRefs.current[episodeNumber]?.files?.[0];
          if (!file) throw new Error(`Выберите файл серии ${episodeNumber}`);
          formData.append(`episodeTitle_${episodeNumber}`, episodeTitles[episodeNumber] || `Серия ${episodeNumber}`);
          formData.append(`episodeFile_${episodeNumber}`, file);
        }
      }

      await uploadFormData(
        `${apiBase}/admin/upload`,
        formData,
        (progress, bytesPerSecond) => {
          setUploadProgress(progress);
          setUploadSpeed(formatBytesPerSecond(bytesPerSecond));
        },
        (cancel) => {
          cancelUploadRef.current = cancel;
        }
      );

      setUploadProgress(100);
      setUploadSpeed('');
      setMessage('Загрузка принята. Сервер обрабатывает видео в фоне.');
      resetUploadForm();
      await loadItems();
    } catch (err) {
      setUploadProgress(null);
      setUploadSpeed('');
      if (err instanceof UploadCancelledError) {
        setMessage('Загрузка прервана. Частично загруженный файл удален.');
      } else {
        setError(getErrorMessage(err));
      }
    } finally {
      cancelUploadRef.current = null;
      setUploading(false);
    }
  }

  function cancelUpload() {
    setMessage('Прерываю загрузку...');
    cancelUploadRef.current?.();
  }

  async function createRoom(itemId: string) {
    setError('');
    setMessage('');
    try {
      const response = await apiJson<{ code: string; url: string }>(`${apiBase}/admin/rooms`, {
        method: 'POST',
        body: JSON.stringify({ itemId })
      });
      setCreatedLinks((current) => [response, ...current]);
      setMessage(`Комната создана. Код: ${response.code}`);
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  async function deleteItem(item: AdminItem) {
    const label = item.kind === 'film' ? 'фильм' : 'сериал';
    if (!window.confirm(`Удалить ${label} "${item.title}" вместе со всеми файлами?`)) return;
    try {
      await deleteJson(`${apiBase}/admin/items/${encodeURIComponent(item.id)}`);
      setMessage(`${label === 'фильм' ? 'Фильм' : 'Сериал'} удален`);
      await loadItems();
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  async function deleteVideo(video: AdminVideo) {
    const name = video.episodeNumber ? `серию ${video.episodeNumber} "${video.title}"` : `файл "${video.title}"`;
    if (!window.confirm(`Удалить ${name}?`)) return;
    try {
      await deleteJson(`${apiBase}/admin/videos/${encodeURIComponent(video.id)}`);
      setMessage(video.episodeNumber ? 'Серия удалена' : 'Файл удален');
      await loadItems();
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  function resetUploadForm() {
    setTitle('');
    setEpisodeCount(1);
    setEpisodeTitles({ 1: 'Серия 1' });
    if (filmFileRef.current) filmFileRef.current.value = '';
    for (const input of Object.values(episodeFileRefs.current)) {
      if (input) input.value = '';
    }
  }

  function updateEpisodeCount(nextCount: number) {
    const normalized = Math.max(1, Math.min(100, nextCount || 1));
    setEpisodeCount(normalized);
    setEpisodeTitles((current) => {
      const next: Record<number, string> = {};
      for (const episodeNumber of episodeNumbers(normalized)) {
        next[episodeNumber] = current[episodeNumber] || `Серия ${episodeNumber}`;
      }
      return next;
    });
  }

  if (authState === 'checking') {
    return (
      <main className="shell narrow">
        <section className="panel">Проверяю доступ...</section>
      </main>
    );
  }

  if (authState === 'out') {
    return (
      <main className="shell narrow">
        <section className="panel auth-panel">
          <p className="eyebrow">Admin</p>
          <h1>Вход в админку</h1>
          <form onSubmit={login} className="stack">
            <label>
              Пароль из .env
              <input
                autoFocus
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="WATCH_ADMIN_PASSWORD"
              />
            </label>
            {error && <p className="error-text">{error}</p>}
            <button className="primary-button" type="submit">
              Войти
            </button>
          </form>
        </section>
      </main>
    );
  }

  return (
    <main className="shell admin-grid">
      <section className="panel">
        <div className="section-head">
          <div>
            <p className="eyebrow">Admin</p>
            <h1>Загрузка</h1>
          </div>
          <button className="ghost-button" onClick={logout} type="button">
            Выйти
          </button>
        </div>

        {storage && <StorageCard storage={storage} />}

        <form onSubmit={upload} className="upload-box">
          <div className="segmented-control">
            <button
              className={kind === 'film' ? 'segment active' : 'segment'}
              type="button"
              onClick={() => setKind('film')}
            >
              Фильм
            </button>
            <button
              className={kind === 'series' ? 'segment active' : 'segment'}
              type="button"
              onClick={() => setKind('series')}
            >
              Сериал
            </button>
          </div>

          <label>
            Название {kind === 'film' ? 'фильма' : 'сериала'}
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder={kind === 'film' ? 'Например: Интерстеллар' : 'Например: Друзья'}
              required
            />
          </label>

          {kind === 'film' ? (
            <label>
              Файл фильма
              <input ref={filmFileRef} type="file" accept="video/*,.mkv,.avi,.mov,.mp4,.webm" />
            </label>
          ) : (
            <div className="episodes-form">
              <label>
                Количество серий
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={episodeCount}
                  onChange={(event) => updateEpisodeCount(Number.parseInt(event.target.value, 10))}
                />
              </label>
              {episodeNumbers(episodeCount).map((episodeNumber) => (
                <div className="episode-upload" key={episodeNumber}>
                  <h2>Серия {episodeNumber}</h2>
                  <label>
                    Название серии
                    <input
                      value={episodeTitles[episodeNumber] ?? ''}
                      onChange={(event) =>
                        setEpisodeTitles((current) => ({
                          ...current,
                          [episodeNumber]: event.target.value
                        }))
                      }
                    />
                  </label>
                  <label>
                    Файл серии
                    <input
                      ref={(node) => {
                        episodeFileRefs.current[episodeNumber] = node;
                      }}
                      type="file"
                      accept="video/*,.mkv,.avi,.mov,.mp4,.webm"
                    />
                  </label>
                </div>
              ))}
            </div>
          )}

          <div className="upload-actions">
            <button className="primary-button big-action" type="submit" disabled={uploading}>
              {uploading ? 'Загружаю...' : kind === 'film' ? 'Загрузить фильм' : 'Загрузить сериал'}
            </button>
            {uploading && (
              <button className="danger-button big-action" type="button" onClick={cancelUpload}>
                Прервать загрузку
              </button>
            )}
          </div>
          {uploadProgress !== null && (
            <div className="upload-progress" aria-live="polite">
              <div className="upload-progress-bar">
                <span style={{ width: `${uploadProgress}%` }} />
              </div>
              <strong>
                {uploading
                  ? uploadProgress >= 100
                    ? '100% загружено, сервер принимает файл...'
                    : `${uploadProgress}% загружено`
                  : 'Файл успешно загружен на сервер'}
              </strong>
              {uploading && uploadSpeed && <span>{uploadSpeed}</span>}
            </div>
          )}
        </form>

        <p className="hint">
          Для фильма создается отдельная директория с названием фильма. Для сериала создается директория
          сериала, внутри нее отдельная директория каждой серии с номером и названием.
        </p>
        {message && <p className="success-text">{message}</p>}
        {error && <p className="error-text">{error}</p>}

        {createdLinks.length > 0 && (
          <div className="links-box">
            <h2>Короткие приглашения</h2>
            {createdLinks.map((link) => (
              <div className="invite-card" key={link.url}>
                <strong>{link.code}</strong>
                <a href={link.url} target="_blank" rel="noreferrer">
                  {link.url}
                </a>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="panel">
        <div className="section-head">
          <div>
            <p className="eyebrow">Library</p>
            <h1>Медиатека</h1>
          </div>
          <button className="ghost-button" type="button" onClick={() => void loadItems()}>
            Обновить
          </button>
        </div>
        <div className="video-list">
          {items.length === 0 && <p className="muted">Пока нет загруженных фильмов или сериалов.</p>}
          {items.map((item) => {
            const hasReadyVideo = item.videos.some((video) => video.status === 'ready');
            return (
              <article className="item-card" key={item.id}>
                <div className="item-head">
                  <div>
                    <p className="eyebrow">{item.kind === 'film' ? 'Film' : 'Series'}</p>
                    <h2>{item.title}</h2>
                    <p className="muted">{item.videos.length} файл(ов)</p>
                  </div>
                  <div className="row-actions">
                    <button
                      className="secondary-button"
                      type="button"
                      disabled={!hasReadyVideo}
                      onClick={() => void createRoom(item.id)}
                    >
                      Создать ссылку
                    </button>
                    <button className="danger-button" type="button" onClick={() => void deleteItem(item)}>
                      Удалить
                    </button>
                  </div>
                </div>
                <div className="episode-list">
                  {item.videos.map((video) => (
                    <div className="episode-row" key={video.id}>
                      <div>
                        <strong>{videoLabel(item, video)}</strong>
                        <p className="muted">
                          {statusText(video.status)} · {formatDuration(video.durationSeconds)}
                        </p>
                        {video.error && <p className="error-text">{video.error}</p>}
                      </div>
                      <button className="danger-button subtle" type="button" onClick={() => void deleteVideo(video)}>
                        Удалить
                      </button>
                    </div>
                  ))}
                </div>
              </article>
            );
          })}
        </div>
      </section>
    </main>
  );
}

function RoomPage({ token }: { token: string }) {
  const [room, setRoom] = useState<RoomMeta | null>(null);
  const [selectedVideoId, setSelectedVideoId] = useState('');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('Подключаюсь...');
  const [callStatus, setCallStatus] = useState('Камеры подключаются...');
  const [participants, setParticipants] = useState<ParticipantTileData[]>([]);
  const [localMedia, setLocalMedia] = useState<LocalMediaState>({ microphone: false, muted: false, camera: false });
  const [liveKitIdentity, setLiveKitIdentity] = useState('');
  const [stageFullscreen, setStageFullscreen] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const liveKitRoomRef = useRef<Room | null>(null);
  const serverOffsetRef = useRef(0);
  const lastStateRef = useRef<WatchState | null>(null);
  const pendingStateRef = useRef<WatchState | null>(null);
  const pendingBufferWaitRef = useRef<BufferWaitState | null>(null);
  const selectedVideoIdRef = useRef('');
  const suppressEventsRef = useRef(false);
  const switchingNativeFullscreenRef = useRef(false);

  useEffect(() => {
    selectedVideoIdRef.current = selectedVideoId;
  }, [selectedVideoId]);

  useEffect(() => {
    let stopped = false;

    async function boot() {
      try {
        const roomMeta = await apiJson<RoomMeta>(`${apiBase}/rooms/${encodeURIComponent(token)}`);
        if (stopped) return;
        setRoom(roomMeta);
        setSelectedVideoId(roomMeta.currentVideoId);
        selectedVideoIdRef.current = roomMeta.currentVideoId;
        connectSocket();
        void connectLiveKit(() => stopped);
      } catch (err) {
        setError(getErrorMessage(err));
        setStatus('Ошибка');
      }
    }

    void boot();

    return () => {
      stopped = true;
      wsRef.current?.close();
      void liveKitRoomRef.current?.disconnect(true);
      liveKitRoomRef.current = null;
    };
  }, [token]);

  useEffect(() => {
    const onFullscreenChange = () => {
      const fullscreenElement = document.fullscreenElement;
      const stage = stageRef.current;
      const video = videoRef.current;

      if (fullscreenElement === video && stage && !switchingNativeFullscreenRef.current) {
        switchingNativeFullscreenRef.current = true;
        void document.exitFullscreen()
          .then(() => stage.requestFullscreen())
          .catch(() => undefined)
          .finally(() => {
            switchingNativeFullscreenRef.current = false;
          });
        return;
      }

      setStageFullscreen(fullscreenElement === stage);
    };

    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, []);

  useEffect(() => {
    const interval = window.setInterval(() => {
      const video = videoRef.current;
      const state = lastStateRef.current;
      if (!video || !state || !state.playing || video.paused) return;
      if (state.videoId !== selectedVideoIdRef.current) return;
      const target = estimateTargetPosition(state, serverOffsetRef.current, video.duration);
      const diff = target - video.currentTime;

      if (Math.abs(diff) > 1.2) {
        suppressVideoEvents(() => {
          video.currentTime = target;
        });
        video.playbackRate = 1;
        return;
      }

      if (Math.abs(diff) > 0.2) {
        video.playbackRate = diff > 0 ? 1.04 : 0.96;
      } else {
        video.playbackRate = 1;
      }
    }, 1000);

    return () => window.clearInterval(interval);
  }, []);

  function connectSocket() {
    const socket = new WebSocket(watchSocketUrl());
    wsRef.current = socket;

    socket.addEventListener('open', () => {
      setStatus('Онлайн');
      sendWs({ type: 'join', token });
    });
    socket.addEventListener('close', () => setStatus('Отключено'));
    socket.addEventListener('error', () => setStatus('Ошибка WebSocket'));
    socket.addEventListener('message', (event) => {
      try {
        handleServerMessage(JSON.parse(event.data as string) as ServerMessage);
      } catch (err) {
        console.warn('Failed to handle server message', err);
      }
    });
  }

  async function connectLiveKit(isStopped: () => boolean) {
    try {
      setCallStatus('Камеры подключаются...');
      const credentials = await apiJson<LiveKitTokenResponse>(
        `${apiBase}/rooms/${encodeURIComponent(token)}/livekit-token`
      );
      if (isStopped()) return;

      const liveKitRoom = new Room();
      liveKitRoomRef.current = liveKitRoom;

      const refreshParticipants = () => {
        if (isStopped()) return;
        updateLiveKitParticipants(liveKitRoom);
      };

      liveKitRoom.on(RoomEvent.ParticipantConnected, refreshParticipants);
      liveKitRoom.on(RoomEvent.ParticipantDisconnected, refreshParticipants);
      liveKitRoom.on(RoomEvent.TrackSubscribed, refreshParticipants);
      liveKitRoom.on(RoomEvent.TrackUnsubscribed, refreshParticipants);
      liveKitRoom.on(RoomEvent.TrackMuted, refreshParticipants);
      liveKitRoom.on(RoomEvent.TrackUnmuted, refreshParticipants);
      liveKitRoom.on(RoomEvent.LocalTrackPublished, refreshParticipants);
      liveKitRoom.on(RoomEvent.LocalTrackUnpublished, refreshParticipants);
      liveKitRoom.on(RoomEvent.Reconnecting, () => {
        if (!isStopped()) setCallStatus('Камеры переподключаются...');
      });
      liveKitRoom.on(RoomEvent.Reconnected, () => {
        if (isStopped()) return;
        setCallStatus('Камеры онлайн');
        refreshParticipants();
      });
      liveKitRoom.on(RoomEvent.Disconnected, () => {
        if (isStopped()) return;
        setCallStatus('Камеры отключены');
        refreshParticipants();
      });

      await liveKitRoom.connect(credentials.url, credentials.token, { autoSubscribe: true });
      if (isStopped()) {
        await liveKitRoom.disconnect(true);
        return;
      }

      setCallStatus('Камеры онлайн');
      refreshParticipants();
      void liveKitRoom.startAudio().catch(() => undefined);
    } catch (err) {
      if (isStopped()) return;
      setCallStatus('Камеры недоступны');
      setError(`Не удалось подключить камеры через LiveKit: ${getErrorMessage(err)}`);
    }
  }

  function handleServerMessage(message: ServerMessage) {
    if (message.type === 'error') {
      setError(message.message);
      return;
    }

    if ('serverNow' in message) serverOffsetRef.current = message.serverNow - Date.now();

    if (message.type === 'joined') {
      lastStateRef.current = message.state;
      queueApplyState(message.state);
      return;
    }

    if (message.type === 'buffer-wait') {
      pendingBufferWaitRef.current = {
        waitId: message.waitId,
        videoId: message.state.videoId,
        positionSeconds: message.state.positionSeconds,
        stateVersion: message.state.version,
        readySent: false
      };
      setStatus('Ждем буферизацию у всех...');
      lastStateRef.current = message.state;
      queueApplyState(message.state);
      window.setTimeout(maybeSendBufferReady, 0);
      return;
    }

    if (message.type === 'sync-state' || message.type === 'video-switched') {
      const wait = pendingBufferWaitRef.current;
      if (wait && message.state.version > wait.stateVersion) {
        pendingBufferWaitRef.current = null;
        setStatus('Онлайн');
      }
      if (!lastStateRef.current || message.state.version >= lastStateRef.current.version) {
        lastStateRef.current = message.state;
        queueApplyState(message.state);
      }
      return;
    }

  }

  function queueApplyState(state: WatchState) {
    if (state.videoId !== selectedVideoIdRef.current) {
      pendingStateRef.current = state;
      suppressVideoEvents(() => {
        selectedVideoIdRef.current = state.videoId;
        setSelectedVideoId(state.videoId);
      });
      return;
    }
    applyWatchState(state);
  }

  function applyWatchState(state: WatchState) {
    const video = videoRef.current;
    if (!video) return;

    const target = estimateTargetPosition(state, serverOffsetRef.current, video.duration);
    const diff = target - video.currentTime;

    suppressVideoEvents(() => {
      if (Math.abs(diff) > 0.45) video.currentTime = target;

      if (state.playing && video.paused) {
        void video.play().catch(() => {
          setStatus('Нажмите Play в плеере, браузер заблокировал автозапуск');
        });
      }

      if (!state.playing && !video.paused) video.pause();
      if (!state.playing) video.playbackRate = 1;
    });

    window.setTimeout(maybeSendBufferReady, 0);
  }

  function onVideoLoaded() {
    const pending = pendingStateRef.current;
    if (!pending || pending.videoId !== selectedVideoIdRef.current) return;
    pendingStateRef.current = null;
    applyWatchState(pending);
  }

  function maybeSendBufferReady() {
    const wait = pendingBufferWaitRef.current;
    const video = videoRef.current;
    if (!wait || wait.readySent || !video) return;
    if (wait.videoId !== selectedVideoIdRef.current) return;
    if (video.seeking || video.readyState < 3) return;
    if (Math.abs(video.currentTime - wait.positionSeconds) > 1.25) return;

    pendingBufferWaitRef.current = { ...wait, readySent: true };
    setStatus('Готово, ждем остальных...');
    sendWs({ type: 'buffer-ready', waitId: wait.waitId });
  }

  function sendSyncAction(action: 'play' | 'pause' | 'seek') {
    const video = videoRef.current;
    if (!video || suppressEventsRef.current) return;
    const wait = pendingBufferWaitRef.current;
    if (action === 'seek' && wait) {
      if (wait.videoId === selectedVideoIdRef.current && Math.abs(video.currentTime - wait.positionSeconds) <= 1.25) {
        maybeSendBufferReady();
        return;
      }
      pendingBufferWaitRef.current = null;
    }
    sendWs({
      type: 'sync-action',
      action,
      videoId: selectedVideoIdRef.current,
      position: video.currentTime,
      playing: !video.paused
    });
  }

  function switchVideo(videoId: string) {
    if (videoId === selectedVideoIdRef.current) return;
    sendWs({ type: 'switch-video', videoId });
  }

  async function toggleMicrophoneConnection() {
    const liveKitRoom = liveKitRoomRef.current;
    if (!liveKitRoom) {
      setError('Камеры еще не подключены');
      return;
    }

    setError('');
    try {
      if (localMedia.microphone) {
        await unpublishLocalSource(Track.Source.Microphone);
      } else {
        await liveKitRoom.startAudio().catch(() => undefined);
        await liveKitRoom.localParticipant.setMicrophoneEnabled(true);
      }
      updateLiveKitParticipants(liveKitRoom);
    } catch (err) {
      setError(`Не удалось изменить микрофон: ${getErrorMessage(err)}`);
    }
  }

  async function toggleMicrophoneMute() {
    const liveKitRoom = liveKitRoomRef.current;
    const publication = getLocalPublication(Track.Source.Microphone);
    if (!liveKitRoom || !publication) return;

    setError('');
    try {
      if (publication.isMuted) {
        await publication.unmute();
      } else {
        await publication.mute();
      }
      updateLiveKitParticipants(liveKitRoom);
    } catch (err) {
      setError(`Не удалось изменить мьют микрофона: ${getErrorMessage(err)}`);
    }
  }

  async function toggleCameraConnection() {
    const liveKitRoom = liveKitRoomRef.current;
    if (!liveKitRoom) {
      setError('Камеры еще не подключены');
      return;
    }

    setError('');
    try {
      if (localMedia.camera) {
        await unpublishLocalSource(Track.Source.Camera);
      } else {
        await liveKitRoom.localParticipant.setCameraEnabled(true);
      }
      updateLiveKitParticipants(liveKitRoom);
    } catch (err) {
      setError(`Не удалось изменить камеру: ${getErrorMessage(err)}`);
    }
  }

  async function unpublishLocalSource(source: Track.Source) {
    const liveKitRoom = liveKitRoomRef.current;
    const publication = getLocalPublication(source);
    if (!liveKitRoom || !publication?.track) return;
    await liveKitRoom.localParticipant.unpublishTrack(publication.track, true);
  }

  function getLocalPublication(source: Track.Source): LocalTrackPublication | undefined {
    return liveKitRoomRef.current?.localParticipant.getTrackPublication(source) as LocalTrackPublication | undefined;
  }

  function updateLiveKitParticipants(liveKitRoom: Room | null = liveKitRoomRef.current) {
    if (!liveKitRoom) {
      setParticipants([]);
      setLiveKitIdentity('');
      setLocalMedia({ microphone: false, muted: false, camera: false });
      return;
    }

    setLiveKitIdentity(liveKitRoom.localParticipant.identity);
    setLocalMedia(readLocalMedia(liveKitRoom));
    setParticipants(buildParticipantTiles(liveKitRoom));
  }

  function sendWs(payload: unknown) {
    const socket = wsRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(payload));
  }

  function suppressVideoEvents(fn: () => void) {
    suppressEventsRef.current = true;
    fn();
    window.setTimeout(() => {
      suppressEventsRef.current = false;
    }, 450);
  }

  async function toggleStageFullscreen() {
    const stage = stageRef.current;
    if (!stage || !document.fullscreenEnabled) return;

    try {
      if (document.fullscreenElement === stage) {
        await document.exitFullscreen();
      } else {
        await stage.requestFullscreen();
      }
    } catch (err) {
      setError(`Не удалось открыть полноэкранный режим: ${getErrorMessage(err)}`);
    }
  }

  const selectedVideo = room?.videos.find((video) => video.id === selectedVideoId) ?? null;
  const videoSrc = selectedVideoId
    ? `${apiBase}/rooms/${encodeURIComponent(token)}/video/${encodeURIComponent(selectedVideoId)}`
    : '';

  return (
    <main className="watch-shell">
      <section className="cinema-panel">
        <div className="room-topbar">
          <div>
            <p className="eyebrow">Room {token}</p>
            <h1>{room ? room.item.title : 'Загрузка комнаты...'}</h1>
            {selectedVideo && <p className="muted now-playing">Сейчас: {roomVideoLabel(selectedVideo)}</p>}
          </div>
          <span className="status-pill">{status}</span>
        </div>
        {error && <p className="error-text">{error}</p>}
        {room?.videos && room.videos.length > 1 && (
          <div className="episode-switcher">
            {room.videos.map((video) => (
              <button
                className={video.id === selectedVideoId ? 'episode-chip active' : 'episode-chip'}
                key={video.id}
                type="button"
                onClick={() => switchVideo(video.id)}
              >
                {roomVideoLabel(video)}
              </button>
            ))}
          </div>
        )}
        <div ref={stageRef} className="movie-stage">
          <div className="movie-frame">
            {document.fullscreenEnabled && (
              <button className="fullscreen-button" type="button" onClick={() => void toggleStageFullscreen()}>
                {stageFullscreen ? 'Выйти из полного экрана' : 'Во весь экран с камерами'}
              </button>
            )}
            <video
              key={selectedVideoId}
              ref={videoRef}
              className="movie-player"
              src={videoSrc}
              controls
              playsInline
              preload="auto"
              onLoadedMetadata={onVideoLoaded}
              onCanPlay={() => maybeSendBufferReady()}
              onPlay={() => sendSyncAction('play')}
              onPause={() => sendSyncAction('pause')}
              onSeeked={() => {
                sendSyncAction('seek');
                maybeSendBufferReady();
              }}
            />
          </div>
          <aside className="fullscreen-rail">
            <CallPanelContent
              callStatus={callStatus}
              identity={liveKitIdentity}
              localMedia={localMedia}
              participants={participants}
              onToggleCamera={() => void toggleCameraConnection()}
              onToggleMicrophone={() => void toggleMicrophoneConnection()}
              onToggleMute={() => void toggleMicrophoneMute()}
            />
          </aside>
        </div>
        <p className="hint">
          Любой участник может поставить паузу, продолжить просмотр, перемотать или выбрать серию. Это
          синхронизируется у всех зрителей.
        </p>
      </section>

      <aside className="people-panel">
        <CallPanelContent
          callStatus={callStatus}
          identity={liveKitIdentity}
          localMedia={localMedia}
          participants={participants}
          onToggleCamera={() => void toggleCameraConnection()}
          onToggleMicrophone={() => void toggleMicrophoneConnection()}
          onToggleMute={() => void toggleMicrophoneMute()}
        />
      </aside>
    </main>
  );
}

function CallPanelContent({
  callStatus,
  identity,
  localMedia,
  participants,
  onToggleCamera,
  onToggleMicrophone,
  onToggleMute
}: {
  callStatus: string;
  identity: string;
  localMedia: LocalMediaState;
  participants: ParticipantTileData[];
  onToggleCamera: () => void;
  onToggleMicrophone: () => void;
  onToggleMute: () => void;
}) {
  return (
    <>
      <div className="section-head compact">
        <div>
          <p className="eyebrow">Call</p>
          <h2>Камера и микрофон</h2>
        </div>
        {identity && <span className="tiny-id">{identity.slice(-8)}</span>}
      </div>
      <p className="call-status">{callStatus}</p>
      <div className="media-actions">
        <button
          className={localMedia.microphone ? 'secondary-button active' : 'secondary-button'}
          type="button"
          onClick={onToggleMicrophone}
        >
          {localMedia.microphone ? 'Отключить микрофон' : 'Подключить микрофон'}
        </button>
        <button
          className={localMedia.muted ? 'secondary-button muted' : 'secondary-button'}
          type="button"
          disabled={!localMedia.microphone}
          onClick={onToggleMute}
        >
          {localMedia.muted ? 'Снять мьют' : 'Поставить мьют'}
        </button>
        <button
          className={localMedia.camera ? 'secondary-button active' : 'secondary-button'}
          type="button"
          onClick={onToggleCamera}
        >
          {localMedia.camera ? 'Выключить камеру' : 'Включить камеру'}
        </button>
      </div>
      <div className="tiles">
        {participants.map((participant) => (
          <MediaTile key={participant.identity} participant={participant} />
        ))}
        {participants.length <= 1 && <p className="muted">Другие участники пока не подключились.</p>}
      </div>
    </>
  );
}

function MediaTile({ participant }: { participant: ParticipantTileData }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [playBlocked, setPlayBlocked] = useState(false);
  const { stream, local, video: hasVideo } = participant;

  useEffect(() => {
    const video = ref.current;
    if (!video) return;

    setPlayBlocked(false);
    video.muted = local;
    video.srcObject = stream;

    if (!stream) return;

    const play = () => {
      void video.play().then(() => setPlayBlocked(false)).catch(() => setPlayBlocked(true));
    };
    const tracks = stream.getTracks();
    for (const track of tracks) track.addEventListener('unmute', play);
    play();

    return () => {
      for (const track of tracks) track.removeEventListener('unmute', play);
      if (video.srcObject === stream) video.srcObject = null;
    };
  }, [stream, local]);

  return (
    <div className="media-tile">
      <div className="media-viewport" onClick={() => void ref.current?.play()}>
        {stream ? (
          <video
            ref={ref}
            autoPlay
            playsInline
            muted={local}
            className={hasVideo ? '' : 'audio-only-media'}
            onClick={() => void ref.current?.play()}
          />
        ) : null}
        {!hasVideo && <div className="empty-tile">Камера выключена</div>}
        {playBlocked && <div className="empty-tile overlay">Нажмите, чтобы включить звук/видео</div>}
      </div>
      <span>
        {participant.label} · {participantMediaLabel(participant)}
      </span>
    </div>
  );
}

function buildParticipantTiles(liveKitRoom: Room): ParticipantTileData[] {
  const localParticipant = liveKitRoom.localParticipant;
  const remoteParticipants = [...liveKitRoom.remoteParticipants.values()];
  return [localParticipant, ...remoteParticipants].map((participant) =>
    buildParticipantTile(participant, participant === localParticipant)
  );
}

function buildParticipantTile(participant: Participant, local: boolean): ParticipantTileData {
  const cameraPublication = participant.getTrackPublication(Track.Source.Camera);
  const microphonePublication = participant.getTrackPublication(Track.Source.Microphone);
  const stream = new MediaStream();

  addPublicationTrack(stream, cameraPublication);
  addPublicationTrack(stream, microphonePublication);

  const hasVideo = Boolean(cameraPublication?.track && !cameraPublication.isMuted);
  const hasMicrophone = Boolean(microphonePublication);
  const microphoneMuted = hasMicrophone ? Boolean(microphonePublication?.isMuted) : false;

  return {
    identity: participant.identity,
    label: local ? 'Вы' : participant.name || `Участник ${participant.identity.slice(-4).toUpperCase()}`,
    stream: stream.getTracks().length > 0 ? stream : null,
    audio: hasMicrophone && !microphoneMuted,
    muted: microphoneMuted,
    video: hasVideo,
    local
  };
}

function addPublicationTrack(stream: MediaStream, publication: TrackPublication | undefined) {
  const track = publication?.track;
  if (!track || publication.isMuted) return;
  stream.addTrack(track.mediaStreamTrack);
}

function readLocalMedia(liveKitRoom: Room): LocalMediaState {
  const microphone = liveKitRoom.localParticipant.getTrackPublication(Track.Source.Microphone) as
    | LocalTrackPublication
    | undefined;
  const camera = liveKitRoom.localParticipant.getTrackPublication(Track.Source.Camera) as LocalTrackPublication | undefined;

  return {
    microphone: Boolean(microphone),
    muted: Boolean(microphone?.isMuted),
    camera: Boolean(camera && !camera.isMuted)
  };
}

function participantMediaLabel(participant: ParticipantTileData): string {
  const mic = participant.audio ? 'микрофон включен' : participant.muted ? 'микрофон в мьюте' : 'без микрофона';
  if (participant.video) return mic;
  return `без камеры, ${mic}`;
}

class UploadCancelledError extends Error {
  constructor() {
    super('Загрузка отменена');
    this.name = 'UploadCancelledError';
  }
}

function uploadFormData(
  url: string,
  formData: FormData,
  onProgress: (progress: number, bytesPerSecond: number) => void,
  onCancelReady: (cancel: () => void) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    let lastLoaded = 0;
    let lastTime = performance.now();
    let currentSpeed = 0;

    request.open('POST', url);
    request.withCredentials = true;
    onCancelReady(() => request.abort());

    request.upload.onprogress = (event) => {
      const now = performance.now();
      const elapsedSeconds = Math.max((now - lastTime) / 1000, 0.001);
      const loadedDelta = Math.max(event.loaded - lastLoaded, 0);

      if (now - lastTime >= 300 || event.loaded === event.total) {
        currentSpeed = loadedDelta / elapsedSeconds;
        lastLoaded = event.loaded;
        lastTime = now;
      }

      const progress = event.lengthComputable
        ? Math.min(100, Math.max(0, Math.round((event.loaded / event.total) * 100)))
        : 0;
      onProgress(progress, currentSpeed);
    };

    request.onload = () => {
      if (request.status >= 200 && request.status < 300) {
        resolve();
        return;
      }
      reject(new Error(readXhrError(request)));
    };

    request.onerror = () => reject(new Error('Ошибка сети при загрузке файла'));
    request.onabort = () => reject(new UploadCancelledError());
    request.send(formData);
  });
}

async function apiJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    credentials: 'same-origin',
    ...init,
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers
    }
  });
  if (!response.ok) throw new Error(await readError(response));
  return (await response.json()) as T;
}

function readXhrError(request: XMLHttpRequest): string {
  try {
    const body = JSON.parse(request.responseText) as { error?: string; message?: string };
    return body.error ?? body.message ?? request.statusText;
  } catch {
    return request.statusText || 'Upload failed';
  }
}

async function deleteJson(url: string): Promise<void> {
  const response = await fetch(url, { method: 'DELETE', credentials: 'same-origin' });
  if (!response.ok) throw new Error(await readError(response));
}

async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string; message?: string };
    return body.error ?? body.message ?? response.statusText;
  } catch {
    return response.statusText;
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function watchSocketUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/watch/ws`;
}

function estimateTargetPosition(state: WatchState, serverOffset: number, duration: number): number {
  const serverNow = Date.now() + serverOffset;
  const elapsed = state.playing ? (serverNow - state.updatedAt) / 1000 : 0;
  const target = state.positionSeconds + elapsed;
  const max = Number.isFinite(duration) && duration > 0 ? duration : Number.POSITIVE_INFINITY;
  return Math.max(0, Math.min(target, max));
}

function episodeNumbers(count: number): number[] {
  return Array.from({ length: count }, (_, index) => index + 1);
}

function normalizeRoomCode(value: string): string {
  return value.replace(/[^A-Z0-9]/gi, '').toUpperCase();
}

function videoLabel(item: AdminItem, video: AdminVideo): string {
  if (item.kind === 'film') return video.title;
  return `${video.episodeNumber ?? '?'} серия: ${video.title}`;
}

function roomVideoLabel(video: RoomVideo): string {
  return video.episodeNumber ? `${video.episodeNumber}. ${video.title}` : video.title;
}

function statusText(status: VideoStatus): string {
  if (status === 'uploaded') return 'ожидает обработки';
  if (status === 'processing') return 'обрабатывается';
  if (status === 'ready') return 'готово';
  return 'ошибка';
}

function formatDuration(seconds: number | null): string {
  if (!seconds) return 'длительность неизвестна';
  const rounded = Math.round(seconds);
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const rest = rounded % 60;
  if (hours > 0) return `${hours}ч ${minutes}м`;
  return `${minutes}м ${rest}с`;
}

function formatBytesPerSecond(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '0 Б/с';
  return `${formatBytes(bytesPerSecond)}/с`;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 Б';
  const sizeUnits = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < sizeUnits.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const precision = value >= 10 || unitIndex === 0 ? 0 : 1;
  return `${value.toFixed(precision)} ${sizeUnits[unitIndex]}`;
}
