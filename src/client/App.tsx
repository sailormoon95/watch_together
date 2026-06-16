import { FormEvent, useEffect, useRef, useState } from 'react';

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

interface PeerInfo {
  peerId: string;
  audio: boolean;
  video: boolean;
}

interface WatchState {
  videoId: string;
  playing: boolean;
  positionSeconds: number;
  updatedAt: number;
  version: number;
}

type ServerMessage =
  | { type: 'joined'; peerId: string; serverNow: number; state: WatchState; peers: PeerInfo[] }
  | { type: 'peer-joined'; peer: PeerInfo }
  | { type: 'peer-left'; peerId: string }
  | { type: 'sync-state'; serverNow: number; state: WatchState; sourcePeerId?: string }
  | { type: 'video-switched'; serverNow: number; state: WatchState; sourcePeerId?: string }
  | { type: 'signal'; sourcePeerId: string; data: SignalData }
  | { type: 'media-state'; peer: PeerInfo }
  | { type: 'error'; message: string };

interface SignalData {
  description?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
}

interface LocalMediaState {
  audio: boolean;
  video: boolean;
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

function AdminPage() {
  const [authState, setAuthState] = useState<AuthState>('checking');
  const [password, setPassword] = useState('');
  const [items, setItems] = useState<AdminItem[]>([]);
  const [kind, setKind] = useState<LibraryKind>('film');
  const [title, setTitle] = useState('');
  const [episodeCount, setEpisodeCount] = useState(1);
  const [episodeTitles, setEpisodeTitles] = useState<Record<number, string>>({ 1: 'Серия 1' });
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [uploading, setUploading] = useState(false);
  const [createdLinks, setCreatedLinks] = useState<Array<{ code: string; url: string }>>([]);
  const filmFileRef = useRef<HTMLInputElement>(null);
  const episodeFileRefs = useRef<Record<number, HTMLInputElement | null>>({});

  useEffect(() => {
    void apiJson(`${apiBase}/admin/me`)
      .then(() => setAuthState('in'))
      .catch(() => setAuthState('out'));
  }, []);

  useEffect(() => {
    if (authState !== 'in') return;
    void loadItems();
    const interval = window.setInterval(() => void loadItems(), 3000);
    return () => window.clearInterval(interval);
  }, [authState]);

  async function loadItems() {
    try {
      const response = await apiJson<{ items: AdminItem[] }>(`${apiBase}/admin/items`);
      setItems(response.items);
    } catch (err) {
      setError(getErrorMessage(err));
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

      const response = await fetch(`${apiBase}/admin/upload`, {
        method: 'POST',
        body: formData,
        credentials: 'same-origin'
      });
      if (!response.ok) throw new Error(await readError(response));

      setMessage('Загрузка принята. Сервер обрабатывает видео в фоне.');
      resetUploadForm();
      await loadItems();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setUploading(false);
    }
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

          <button className="primary-button big-action" type="submit" disabled={uploading}>
            {uploading ? 'Загружаю...' : kind === 'film' ? 'Загрузить фильм' : 'Загрузить сериал'}
          </button>
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
  const [peers, setPeers] = useState<PeerInfo[]>([]);
  const [remoteStreams, setRemoteStreams] = useState<Map<string, MediaStream>>(new Map());
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [localMedia, setLocalMedia] = useState<LocalMediaState>({ audio: false, video: false });
  const [myPeerId, setMyPeerId] = useState('');

  const videoRef = useRef<HTMLVideoElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const peerConnectionsRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const localStreamRef = useRef<MediaStream | null>(null);
  const serverOffsetRef = useRef(0);
  const lastStateRef = useRef<WatchState | null>(null);
  const pendingStateRef = useRef<WatchState | null>(null);
  const selectedVideoIdRef = useRef('');
  const suppressEventsRef = useRef(false);

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
      } catch (err) {
        setError(getErrorMessage(err));
        setStatus('Ошибка');
      }
    }

    void boot();

    return () => {
      stopped = true;
      wsRef.current?.close();
      for (const pc of peerConnectionsRef.current.values()) pc.close();
      peerConnectionsRef.current.clear();
      localStreamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, [token]);

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

  function handleServerMessage(message: ServerMessage) {
    if (message.type === 'error') {
      setError(message.message);
      return;
    }

    if ('serverNow' in message) serverOffsetRef.current = message.serverNow - Date.now();

    if (message.type === 'joined') {
      setMyPeerId(message.peerId);
      setPeers(message.peers);
      lastStateRef.current = message.state;
      queueApplyState(message.state);
      return;
    }

    if (message.type === 'peer-joined') {
      setPeers((current) => upsertPeer(current, message.peer));
      ensurePeerConnection(message.peer.peerId);
      if (localStreamRef.current) void createOffer(message.peer.peerId);
      return;
    }

    if (message.type === 'peer-left') {
      removePeer(message.peerId);
      return;
    }

    if (message.type === 'media-state') {
      setPeers((current) => upsertPeer(current, message.peer));
      return;
    }

    if (message.type === 'sync-state' || message.type === 'video-switched') {
      if (!lastStateRef.current || message.state.version >= lastStateRef.current.version) {
        lastStateRef.current = message.state;
        queueApplyState(message.state);
      }
      return;
    }

    if (message.type === 'signal') {
      void handleSignal(message.sourcePeerId, message.data);
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
  }

  function onVideoLoaded() {
    const pending = pendingStateRef.current;
    if (!pending || pending.videoId !== selectedVideoIdRef.current) return;
    pendingStateRef.current = null;
    applyWatchState(pending);
  }

  function sendSyncAction(action: 'play' | 'pause' | 'seek') {
    const video = videoRef.current;
    if (!video || suppressEventsRef.current) return;
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

  function ensurePeerConnection(peerId: string): RTCPeerConnection {
    const existing = peerConnectionsRef.current.get(peerId);
    if (existing) return existing;

    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });

    peerConnectionsRef.current.set(peerId, pc);
    syncLocalTracks(pc);

    pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      sendWs({
        type: 'signal',
        targetPeerId: peerId,
        data: { candidate: event.candidate.toJSON() }
      });
    };

    pc.ontrack = (event) => {
      const stream = event.streams[0] ?? new MediaStream([event.track]);
      setRemoteStreams((current) => {
        const next = new Map(current);
        next.set(peerId, stream);
        return next;
      });
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') removePeer(peerId);
    };

    return pc;
  }

  async function handleSignal(peerId: string, data: SignalData) {
    const pc = ensurePeerConnection(peerId);

    if (data.description) {
      await pc.setRemoteDescription(new RTCSessionDescription(data.description));
      if (data.description.type === 'offer') {
        syncLocalTracks(pc);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        sendWs({
          type: 'signal',
          targetPeerId: peerId,
          data: { description: pc.localDescription }
        });
      }
      return;
    }

    if (data.candidate) {
      await pc.addIceCandidate(new RTCIceCandidate(data.candidate)).catch((err) => {
        console.warn('Failed to add ICE candidate', err);
      });
    }
  }

  async function createOffer(peerId: string) {
    const pc = ensurePeerConnection(peerId);
    if (pc.signalingState !== 'stable') return;
    syncLocalTracks(pc);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendWs({
      type: 'signal',
      targetPeerId: peerId,
      data: { description: pc.localDescription }
    });
  }

  function syncLocalTracks(pc: RTCPeerConnection) {
    for (const sender of pc.getSenders()) {
      if (sender.track) pc.removeTrack(sender);
    }
    const stream = localStreamRef.current;
    if (!stream) return;
    for (const track of stream.getTracks()) pc.addTrack(track, stream);
  }

  async function changeLocalMedia(next: LocalMediaState) {
    setError('');

    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;
    setLocalStream(null);

    if (!next.audio && !next.video) {
      setLocalMedia(next);
      sendWs({ type: 'media-state', audio: false, video: false });
      await renegotiateAllPeers();
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: next.audio,
        video: next.video ? { width: { ideal: 960 }, height: { ideal: 540 } } : false
      });
      localStreamRef.current = stream;
      setLocalStream(stream);
      setLocalMedia(next);
      sendWs({ type: 'media-state', audio: next.audio, video: next.video });
      await renegotiateAllPeers();
    } catch (err) {
      setError(`Не удалось включить камеру/микрофон: ${getErrorMessage(err)}`);
      setLocalMedia({ audio: false, video: false });
      sendWs({ type: 'media-state', audio: false, video: false });
    }
  }

  async function renegotiateAllPeers() {
    const peerIds = [...peerConnectionsRef.current.keys()];
    for (const peerId of peerIds) await createOffer(peerId);
  }

  function removePeer(peerId: string) {
    peerConnectionsRef.current.get(peerId)?.close();
    peerConnectionsRef.current.delete(peerId);
    setPeers((current) => current.filter((peer) => peer.peerId !== peerId));
    setRemoteStreams((current) => {
      const next = new Map(current);
      next.delete(peerId);
      return next;
    });
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
        <video
          key={selectedVideoId}
          ref={videoRef}
          className="movie-player"
          src={videoSrc}
          controls
          playsInline
          preload="metadata"
          onLoadedMetadata={onVideoLoaded}
          onPlay={() => sendSyncAction('play')}
          onPause={() => sendSyncAction('pause')}
          onSeeked={() => sendSyncAction('seek')}
        />
        <p className="hint">
          Любой участник может поставить паузу, продолжить просмотр, перемотать или выбрать серию. Это
          синхронизируется у всех зрителей.
        </p>
      </section>

      <aside className="people-panel">
        <div className="section-head compact">
          <div>
            <p className="eyebrow">Call</p>
            <h2>Камера и микрофон</h2>
          </div>
          {myPeerId && <span className="tiny-id">{myPeerId.slice(0, 8)}</span>}
        </div>
        <div className="media-actions">
          <button
            className={localMedia.audio ? 'secondary-button active' : 'secondary-button'}
            type="button"
            onClick={() => void changeLocalMedia({ ...localMedia, audio: !localMedia.audio })}
          >
            {localMedia.audio ? 'Выключить микрофон' : 'Включить микрофон'}
          </button>
          <button
            className={localMedia.video ? 'secondary-button active' : 'secondary-button'}
            type="button"
            onClick={() => void changeLocalMedia({ ...localMedia, video: !localMedia.video })}
          >
            {localMedia.video ? 'Выключить камеру' : 'Включить камеру'}
          </button>
        </div>
        <div className="tiles">
          <MediaTile label="Вы" stream={localStream} muted />
          {[...remoteStreams.entries()].map(([peerId, stream]) => (
            <MediaTile
              key={peerId}
              label={`Участник ${peerId.slice(0, 8)}`}
              stream={stream}
              muted={false}
            />
          ))}
          {peers.length === 0 && <p className="muted">Другие участники пока не подключились.</p>}
        </div>
      </aside>
    </main>
  );
}

function MediaTile({ label, stream, muted }: { label: string; stream: MediaStream | null; muted: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
  }, [stream]);

  return (
    <div className="media-tile">
      {stream ? (
        <video ref={ref} autoPlay playsInline muted={muted} />
      ) : (
        <div className="empty-tile">Нет видео</div>
      )}
      <span>{label}</span>
    </div>
  );
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

function upsertPeer(peers: PeerInfo[], peer: PeerInfo): PeerInfo[] {
  const index = peers.findIndex((item) => item.peerId === peer.peerId);
  if (index === -1) return [...peers, peer];
  return peers.map((item) => (item.peerId === peer.peerId ? peer : item));
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
