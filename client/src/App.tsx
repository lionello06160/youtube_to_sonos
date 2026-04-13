import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import axios from 'axios';
import type { Device, LibraryTrack, PlaybackStatus } from './types';

const API_URL = `http://${window.location.hostname}:3005`;

const PlayOneIcon = ({ className }: { className?: string }) => (
  <svg
    className={className}
    viewBox="0 0 340 520"
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
  >
    <defs>
      <pattern id="gridPattern" x="0" y="0" width="4" height="4" patternUnits="userSpaceOnUse">
        <circle cx="2" cy="2" r="1.2" fill="#222" opacity="0.6" />
      </pattern>
      <linearGradient id="bodyGradient" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" style={{ stopColor: '#333', stopOpacity: 1 }} />
        <stop offset="10%" style={{ stopColor: '#666', stopOpacity: 1 }} />
        <stop offset="25%" style={{ stopColor: '#999', stopOpacity: 1 }} />
        <stop offset="50%" style={{ stopColor: '#ccc', stopOpacity: 1 }} />
        <stop offset="75%" style={{ stopColor: '#999', stopOpacity: 1 }} />
        <stop offset="90%" style={{ stopColor: '#666', stopOpacity: 1 }} />
        <stop offset="100%" style={{ stopColor: '#333', stopOpacity: 1 }} />
      </linearGradient>
      <linearGradient id="capGradient" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" style={{ stopColor: '#000', stopOpacity: 1 }} />
        <stop offset="15%" style={{ stopColor: '#333', stopOpacity: 1 }} />
        <stop offset="50%" style={{ stopColor: '#1a1a1a', stopOpacity: 1 }} />
        <stop offset="85%" style={{ stopColor: '#333', stopOpacity: 1 }} />
        <stop offset="100%" style={{ stopColor: '#000', stopOpacity: 1 }} />
      </linearGradient>
      <linearGradient id="shadowOverlay" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" style={{ stopColor: '#000', stopOpacity: 0.6 }} />
        <stop offset="20%" style={{ stopColor: '#000', stopOpacity: 0.1 }} />
        <stop offset="50%" style={{ stopColor: '#fff', stopOpacity: 0.1 }} />
        <stop offset="80%" style={{ stopColor: '#000', stopOpacity: 0.1 }} />
        <stop offset="100%" style={{ stopColor: '#000', stopOpacity: 0.6 }} />
      </linearGradient>
      <linearGradient id="reflectionGrad" x1="0%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%" style={{ stopColor: '#000', stopOpacity: 0.3 }} />
        <stop offset="100%" style={{ stopColor: '#000', stopOpacity: 0 }} />
      </linearGradient>
    </defs>

    <ellipse cx="170" cy="495" rx="140" ry="15" fill="url(#reflectionGrad)" />

    <g transform="translate(20, 40)">
      <rect x="0" y="40" width="300" height="380" rx="30" ry="30" fill="url(#bodyGradient)" />
      <rect x="0" y="40" width="300" height="380" rx="30" ry="30" fill="url(#gridPattern)" />
      <rect x="0" y="40" width="300" height="380" rx="30" ry="30" fill="url(#shadowOverlay)" />
    </g>

    <g transform="translate(20, 455)">
      <path d="M5,0 L295,0 C300,0 300,15 295,25 L5,25 C0,25 0,0 5,0 Z" fill="#111" />
      <path d="M15,25 L285,25 C290,25 290,30 285,35 L15,35 C10,35 10,25 15,25 Z" fill="#000" />
    </g>

    <g transform="translate(20, 20)">
      <path d="M0,20 L0,60 L300,60 L300,20 C300,-10 0,-10 0,20 Z" fill="url(#capGradient)" />
      <path d="M2,20 C2,-5 298,-5 298,20" fill="none" stroke="#555" strokeWidth="1" opacity="0.5" />
      <g transform="translate(150, 42)" fill="#ddd" style={{ fontFamily: 'Arial, sans-serif', fontWeight: 700, letterSpacing: '3px' }}>
        <text x="0" y="0" textAnchor="middle" fontSize="18">SONOS</text>
      </g>
    </g>
  </svg>
);

function formatTime(seconds: number) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  const hrs = Math.floor(mins / 60);
  const mm = mins % 60;
  if (hrs > 0) {
    return `${hrs}:${String(mm).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${mm}:${String(secs).padStart(2, '0')}`;
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let next = value;
  let unitIndex = 0;
  while (next >= 1024 && unitIndex < units.length - 1) {
    next /= 1024;
    unitIndex += 1;
  }
  const digits = next >= 10 || unitIndex === 0 ? 0 : 1;
  return `${next.toFixed(digits)} ${units[unitIndex]}`;
}

function formatUploadDate(value: string) {
  if (!value) return '--';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '--';
  return parsed.toLocaleString('zh-TW', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function getRequestErrorMessage(err: unknown, fallback: string) {
  if (axios.isAxiosError(err)) {
    const responseData = err.response?.data;
    if (typeof responseData === 'string' && responseData.trim()) {
      return responseData.trim();
    }
    if (responseData && typeof responseData === 'object' && 'message' in responseData) {
      const message = String(responseData.message || '').trim();
      if (message) return message;
    }
  }
  if (err instanceof Error && err.message.trim()) {
    return err.message.trim();
  }
  return fallback;
}

function App() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [selectedHosts, setSelectedHosts] = useState<string[]>([]);
  const [discovering, setDiscovering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [libraryTracks, setLibraryTracks] = useState<LibraryTrack[]>([]);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [libraryUploading, setLibraryUploading] = useState(false);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [libraryBusyId, setLibraryBusyId] = useState<string | null>(null);
  const [libraryDeleteBusyId, setLibraryDeleteBusyId] = useState<string | null>(null);
  const [isUploadHover, setIsUploadHover] = useState(false);
  const [nowPlaying, setNowPlaying] = useState<PlaybackStatus | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [actionBusy, setActionBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [ytUrl, setYtUrl] = useState('');
  const [playingYt, setPlayingYt] = useState(false);

  const selectedMaster = selectedHosts[0];
  const onlineCount = devices.length;

  const showToast = (message: string) => {
    setToast(message);
    setTimeout(() => setToast(null), 3500);
  };

  const fetchDeep = async () => {
    setDiscovering(true);
    setError(null);
    try {
      const res = await axios.get(`${API_URL}/scan`);
      setDevices(res.data);
      setSelectedHosts(res.data.map((device: Device) => device.host));
      if (res.data.length === 0) {
        setError('No devices found even after deep scan.');
      }
    } catch (err: unknown) {
      setError(getRequestErrorMessage(err, 'Deep scan failed'));
    } finally {
      setDiscovering(false);
    }
  };

  const fetchLibrary = async () => {
    setLibraryLoading(true);
    setLibraryError(null);
    try {
      const res = await axios.get(`${API_URL}/library`);
      setLibraryTracks(res.data.items || []);
    } catch (err: unknown) {
      setLibraryError(getRequestErrorMessage(err, 'Library load failed'));
    } finally {
      setLibraryLoading(false);
    }
  };

  useEffect(() => {
    void fetchDeep();
    void fetchLibrary();
  }, []);

  useEffect(() => {
    let mounted = true;
    const fetchStatus = async () => {
      try {
        const res = await axios.get(`${API_URL}/status`);
        if (!mounted) return;
        setNowPlaying(res.data);
      } catch {
        // ignore transient status errors
      }
    };
    void fetchStatus();
    const id = setInterval(() => {
      void fetchStatus();
    }, 5000);
    return () => {
      mounted = false;
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const handleVolumeChange = async (host: string, newVolume: number) => {
    setDevices((prev) => prev.map((d) => d.host === host ? { ...d, volume: newVolume } : d));
    try {
      await axios.post(`${API_URL}/volume`, { host, volume: newVolume });
    } catch (err: unknown) {
      showToast(getRequestErrorMessage(err, 'Volume update failed'));
    }
  };

  const toggleSelect = (host: string) => {
    setSelectedHosts((prev) => prev.includes(host) ? prev.filter((h) => h !== host) : [...prev, host]);
  };
  const handleDeviceCardKeyDown = (event: KeyboardEvent<HTMLDivElement>, host: string) => {
    if (event.target !== event.currentTarget) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    toggleSelect(host);
  };

  const selectAll = () => setSelectedHosts(devices.map((d) => d.host));
  const deselectAll = () => setSelectedHosts([]);

  const groupSelectedDevices = async () => {
    if (selectedHosts.length <= 1) return;
    await axios.post(`${API_URL}/group`, {
      masterHost: selectedHosts[0],
      memberHosts: selectedHosts
    });
  };

  const handleStop = async () => {
    if (selectedHosts.length === 0 || actionBusy) {
      if (selectedHosts.length === 0) showToast('請先選擇播放裝置');
      return;
    }
    setActionBusy(true);
    try {
      await axios.post(`${API_URL}/stop`, { deviceHost: selectedHosts[0] });
      setNowPlaying((prev) => prev ? {
        ...prev,
        isPlaying: false,
        title: null,
        playbackState: 'stopped',
        sourceType: 'idle',
        libraryItemId: null,
        positionSec: 0,
        positionUpdatedAt: Date.now()
      } : prev);
      showToast('Stopped');
    } catch (err: unknown) {
      showToast(getRequestErrorMessage(err, 'Stop failed'));
    } finally {
      setActionBusy(false);
    }
  };

  const handleLibraryUpload = async (files: FileList | File[] | null) => {
    const list = files ? Array.from(files) : [];
    if (!list.length) return;
    const formData = new FormData();
    list.forEach((file) => formData.append('files', file));
    setLibraryUploading(true);
    setLibraryError(null);
    try {
      const res = await axios.post(`${API_URL}/library/upload`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });
      setLibraryTracks(res.data.items || []);
      showToast(`Uploaded ${list.length} file${list.length > 1 ? 's' : ''}`);
    } catch (err: unknown) {
      const message = getRequestErrorMessage(err, 'Upload failed');
      setLibraryError(message);
      showToast(message);
    } finally {
      setLibraryUploading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const handleLibraryPlay = async (track: LibraryTrack) => {
    if (selectedHosts.length === 0) {
      showToast('請先選擇播放裝置');
      return;
    }
    if (actionBusy) return;
    setActionBusy(true);
    setLibraryBusyId(track.id);
    try {
      if (selectedHosts.length > 1) {
        await groupSelectedDevices();
      }
      const res = await axios.post(`${API_URL}/library/play`, {
        deviceHost: selectedHosts[0],
        id: track.id
      });
      const item = res.data.item || track;
      setNowPlaying((prev) => ({
        ...(prev || {
          isPlaying: true,
          activeStreams: 1,
          startedAt: Date.now(),
          playbackState: 'playing',
          sourceType: 'upload',
          autoStopTime: null,
          autoShutdownTime: null
        }),
        title: item.title,
        isPlaying: true,
        activeStreams: 1,
        startedAt: Date.now(),
        positionSec: 0,
        positionUpdatedAt: Date.now(),
        durationSec: item.durationSec,
        durationLabel: item.durationLabel,
        playbackState: 'playing',
        sourceType: 'upload',
        libraryItemId: item.id
      }));
      showToast(`Playing ${item.title}`);
      void fetchLibrary();
    } catch (err: unknown) {
      showToast(getRequestErrorMessage(err, 'Library play failed'));
    } finally {
      setLibraryBusyId(null);
      setActionBusy(false);
    }
  };

  const handleYoutubePlay = async () => {
    if (selectedHosts.length === 0 || !ytUrl.trim()) {
      if (selectedHosts.length === 0) showToast('請先選擇播放裝置');
      return;
    }
    if (actionBusy) return;
    setActionBusy(true);
    setPlayingYt(true);
    try {
      if (selectedHosts.length > 1) {
        await groupSelectedDevices();
      }
      const res = await axios.post(`${API_URL}/play`, {
        deviceHost: selectedHosts[0],
        youtubeUrl: ytUrl.trim()
      });
      setNowPlaying((prev) => ({
        ...(prev || {
          isPlaying: true,
          activeStreams: 1,
          startedAt: Date.now(),
          playbackState: 'playing',
          sourceType: 'youtube',
          autoStopTime: null,
          autoShutdownTime: null
        }),
        title: res.data.title || 'YouTube Stream',
        isPlaying: true,
        activeStreams: 1,
        startedAt: Date.now(),
        positionSec: 0,
        positionUpdatedAt: Date.now(),
        playbackState: 'playing',
        sourceType: 'youtube'
      }));
      showToast(`Started Broadcast: ${res.data.title || 'YouTube URL'}`);
    } catch (err: unknown) {
      showToast(getRequestErrorMessage(err, 'YouTube broadcast failed'));
    } finally {
      setPlayingYt(false);
      setActionBusy(false);
    }
  };

  const handleLibraryDelete = async (track: LibraryTrack) => {
    setLibraryDeleteBusyId(track.id);
    try {
      const res = await axios.delete(`${API_URL}/library/${track.id}`);
      setLibraryTracks(res.data.items || []);
      showToast(`Deleted ${track.title}`);
    } catch (err: unknown) {
      showToast(getRequestErrorMessage(err, 'Delete failed'));
    } finally {
      setLibraryDeleteBusyId(null);
    }
  };

  const stats = useMemo(() => ([
    { label: 'Devices Online', value: `${onlineCount}`, note: onlineCount > 0 ? 'Active' : 'Offline' },
    { label: 'Selected Zones', value: `${selectedHosts.length}`, note: selectedHosts.length ? 'Ready' : 'None' },
    { label: 'Upload Tracks', value: `${libraryTracks.length}`, note: libraryTracks.length ? 'Catalogued' : 'Empty' },
    { label: 'Playback', value: nowPlaying?.isPlaying ? 'LIVE' : 'IDLE', note: nowPlaying?.isPlaying ? 'Broadcast' : 'Standby' },
  ]), [onlineCount, selectedHosts.length, libraryTracks.length, nowPlaying?.isPlaying]);

  const nowPlayingDisplayTitle = useMemo(() => {
    const rawTitle = String(nowPlaying?.title || '').trim();
    return rawTitle || null;
  }, [nowPlaying?.title]);

  const currentTrack = useMemo(() => {
    const trackId = nowPlaying?.libraryItemId;
    if (!trackId) return null;
    return libraryTracks.find((item) => item.id === trackId) || null;
  }, [libraryTracks, nowPlaying?.libraryItemId]);

  const progress = useMemo(() => {
    if (!nowPlaying || nowPlaying.sourceType === 'idle') return null;
    const basePosition = typeof nowPlaying.positionSec === 'number' && Number.isFinite(nowPlaying.positionSec)
      ? Math.max(0, Math.floor(nowPlaying.positionSec))
      : 0;
    const driftSec = nowPlaying.playbackState === 'playing' && nowPlaying.positionUpdatedAt
      ? Math.max(0, Math.floor((nowMs - nowPlaying.positionUpdatedAt) / 1000))
      : 0;
    const duration =
      typeof nowPlaying.durationSec === 'number' && Number.isFinite(nowPlaying.durationSec) && nowPlaying.durationSec > 0
        ? nowPlaying.durationSec
        : null;
    const elapsed = duration != null ? Math.min(duration, basePosition + driftSec) : basePosition + driftSec;
    const percent = duration ? Math.min(100, (elapsed / duration) * 100) : null;
    return { elapsed, duration, percent };
  }, [nowMs, nowPlaying]);

  return (
    <div className="font-display min-h-screen flex bg-background-dark text-white">
      <div className="bg-mesh" />
      <div className="bg-grid" />
      <div className="ambient-orbs" aria-hidden="true">
        <span className="orb orb-one" />
        <span className="orb orb-two" />
        <span className="orb orb-three" />
      </div>

      <main className="flex-1 flex flex-col h-screen overflow-hidden">
        <header className="glass sticky top-0 z-30 border-b border-white/10">
          <div className="w-full max-w-6xl mx-auto flex items-center justify-between px-4 md:px-8 py-4">
            <div className="flex items-center gap-6">
              <h2 className="text-white text-xl font-bold tracking-tight">Upload Broadcast Console</h2>
              <div className="flex items-center gap-2 px-3 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/20">
                <span className="size-2 rounded-full bg-emerald-500 animate-pulse"></span>
                <span className="text-emerald-500 text-xs font-bold uppercase tracking-wider">
                  {discovering ? 'Scanning' : `${onlineCount} Online`}
                </span>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={() => void fetchDeep()}
                disabled={discovering}
                className="btn-accent flex items-center gap-2 px-5 py-2.5 rounded-lg bg-accent-amber/20 border border-accent-amber/40 text-accent-amber text-sm font-bold hover:bg-accent-amber/30 transition-all neon-glow-amber disabled:opacity-50"
              >
                <span className={`material-symbols-outlined text-[18px] ${discovering ? 'animate-spin' : ''}`}>radar</span>
                Scan
              </button>
              <div className="hidden md:flex items-center gap-2 px-3 py-1.5 rounded-full border border-white/10 bg-white/5 text-white/60 text-[11px] font-mono">
                <span className="size-2 rounded-full bg-emerald-500/60"></span>
                <span>Server: {API_URL.replace('http://', '')}</span>
              </div>
            </div>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto">
          <div className="max-w-6xl mx-auto px-4 md:px-8 py-8 space-y-8">
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-6">
              {stats.map((item) => (
                <div key={item.label} className="glass p-6 rounded-2xl flex flex-col gap-1">
                  <span className="text-white/40 text-xs font-bold uppercase tracking-widest">{item.label}</span>
                  <div className="flex items-end gap-2">
                    <span className="text-2xl font-bold text-white">{item.value}</span>
                    <span className="text-emerald-500 text-sm mb-1 font-medium">{item.note}</span>
                  </div>
                </div>
              ))}
            </div>

            <div>
              <div className="flex items-center justify-between mb-6 px-1">
                <h3 className="text-white text-lg font-bold">Discovered Devices</h3>
                <div className="flex gap-4">
                  <button onClick={selectAll} className="text-white/40 hover:text-white text-xs font-bold uppercase transition-colors tracking-widest">Select All</button>
                  <button onClick={deselectAll} className="text-white/40 hover:text-white text-xs font-bold uppercase transition-colors tracking-widest">Deselect</button>
                </div>
              </div>

              {error && (
                <div className="glass border border-rose-500/20 text-rose-200 px-4 py-3 rounded-xl mb-6">
                  {error}
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
                {devices.map((device) => {
                  const isSelected = selectedHosts.includes(device.host);
                  const isMaster = device.host === selectedMaster;
                  return (
                    <div
                      key={device.host}
                      onClick={() => toggleSelect(device.host)}
                      onKeyDown={(event) => handleDeviceCardKeyDown(event, device.host)}
                      role="button"
                      tabIndex={0}
                      aria-pressed={isSelected}
                      aria-label={`${isSelected ? 'Deselect' : 'Select'} ${device.name}`}
                      className={`device-card glass p-5 rounded-2xl relative cursor-pointer transition-all ${isSelected ? 'neon-border-primary' : 'border-white/10 hover:border-white/20'} ${isSelected && nowPlaying?.isPlaying ? 'playing-glow' : ''}`}
                    >
                      {isSelected && (
                        <div className="absolute top-4 right-4 text-primary flex items-center gap-2">
                          {isMaster && <span className="text-[10px] uppercase tracking-widest bg-primary/20 px-2 py-1 rounded-full">Master</span>}
                          <span className="material-symbols-outlined fill-1">check_circle</span>
                        </div>
                      )}
                      <div className="flex gap-4 mb-6">
                        <div className={`speaker-badge size-20 rounded-xl flex items-center justify-center border ${isSelected ? 'bg-primary/20 border-primary/30' : 'bg-white/5 border-white/10'}`}>
                          <PlayOneIcon className="w-12 h-16" />
                          {isSelected && <span className="speaker-pulse" />}
                        </div>
                        <div className="flex flex-col justify-center">
                          <h4 className="text-white font-bold">{device.name}</h4>
                          <p className="text-white/40 text-xs font-medium uppercase tracking-tight">Model: {device.model}</p>
                          <p className="text-white/40 text-[10px] font-mono mt-1">IP: {device.host}</p>
                          <div className={`equalizer mt-3 ${isSelected && nowPlaying?.isPlaying ? 'is-active' : 'is-idle'}`}>
                            <span className="equalizer-bar bar-1" />
                            <span className="equalizer-bar bar-2" />
                            <span className="equalizer-bar bar-3" />
                            <span className="equalizer-bar bar-4" />
                            <span className="equalizer-bar bar-5" />
                          </div>
                        </div>
                      </div>
                      <div className="space-y-3" onClick={(e) => e.stopPropagation()}>
                        <div className="flex justify-between items-center text-xs">
                          <span className="text-white/60">Volume</span>
                          <span className={`font-bold ${isSelected ? 'text-primary' : 'text-white/40'}`}>{device.volume}%</span>
                        </div>
                        <input
                          className="w-full"
                          type="range"
                          min="0"
                          max="100"
                          value={device.volume}
                          aria-label={`${device.name} volume`}
                          style={{ '--volume': `${device.volume}%` } as React.CSSProperties}
                          onChange={(e) => void handleVolumeChange(device.host, Number(e.target.value))}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-6 px-1">
                <div>
                  <h3 className="text-white text-lg font-bold">YouTube Broadcast</h3>
                  <p className="text-white/40 text-xs mt-1">Paste a URL here to stream audio instantly from YouTube.</p>
                </div>
              </div>
              <div className="glass p-6 rounded-2xl flex flex-col md:flex-row gap-4 items-center">
                <div className="flex-1 w-full relative">
                  <span className="material-symbols-outlined absolute left-4 top-1/2 -translate-y-1/2 text-white/20">link</span>
                  <input
                    type="text"
                    value={ytUrl}
                    onChange={(e) => setYtUrl(e.target.value)}
                    placeholder="https://www.youtube.com/watch?v=..."
                    className="w-full bg-white/5 border border-white/10 rounded-xl py-3.5 pl-12 pr-4 text-sm text-white focus:outline-none focus:border-emerald-500/50 transition-all"
                  />
                </div>
                <button
                  onClick={() => void handleYoutubePlay()}
                  disabled={actionBusy || !ytUrl.trim() || selectedHosts.length === 0}
                  className="btn-accent shrink-0 px-8 py-3.5 rounded-xl bg-emerald-500 text-black font-bold text-xs uppercase tracking-widest hover:bg-emerald-400 transition-all disabled:opacity-50 flex items-center gap-2"
                >
                  <span className={`material-symbols-outlined text-[20px] ${playingYt ? 'animate-spin' : ''}`}>
                    {playingYt ? 'progress_activity' : 'sensors'}
                  </span>
                  {playingYt ? 'Connecting...' : 'Broadcast'}
                </button>
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-6 px-1">
                <div>
                  <h3 className="text-white text-lg font-bold">Upload Library</h3>
                  <p className="text-white/40 text-xs mt-1">The upload vault is now the only playback source.</p>
                </div>
                <div className="text-white/40 text-[11px] font-mono">
                  {libraryTracks.length} file{libraryTracks.length === 1 ? '' : 's'}
                </div>
              </div>

              <div className="grid grid-cols-1 xl:grid-cols-[1.1fr_1.4fr] gap-6 items-start">
                <div className="glass rounded-2xl border border-white/10 p-6">
                  <div
                    onDragOver={(e) => {
                      e.preventDefault();
                      setIsUploadHover(true);
                    }}
                    onDragLeave={() => setIsUploadHover(false)}
                    onDrop={(e) => {
                      e.preventDefault();
                      setIsUploadHover(false);
                      void handleLibraryUpload(e.dataTransfer.files);
                    }}
                    className={`upload-dropzone ${isUploadHover ? 'is-hover' : ''} ${libraryUploading ? 'is-uploading' : ''}`}
                  >
                    <div className="upload-dropzone__halo" />
                    <div className="upload-dropzone__content">
                      <div className="size-16 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center">
                        <span className={`material-symbols-outlined text-emerald-300 text-4xl ${libraryUploading ? 'animate-bounce' : ''}`}>upload_file</span>
                      </div>
                      <div>
                        <h4 className="text-white text-xl font-bold">Sound Vault</h4>
                        <p className="text-white/45 text-sm mt-2 max-w-sm">
                          Upload audio, keep it on the server, and play it across your selected Sonos zones.
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center justify-center gap-3">
                        <button
                          type="button"
                          onClick={() => fileInputRef.current?.click()}
                          disabled={libraryUploading}
                          className="px-5 py-3 rounded-xl bg-white text-black font-bold text-xs uppercase tracking-[0.22em] disabled:opacity-50"
                        >
                          {libraryUploading ? 'Uploading...' : 'Choose Files'}
                        </button>
                        <span className="text-white/35 text-xs uppercase tracking-[0.26em]">or drag & drop</span>
                      </div>
                    </div>
                  </div>
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    accept="audio/*,.mp3,.wav,.m4a,.flac,.ogg,.aac"
                    onChange={(e) => void handleLibraryUpload(e.target.files)}
                    className="hidden"
                  />
                  {libraryError && (
                    <div className="glass border border-rose-500/20 text-rose-200 px-4 py-3 rounded-xl mt-4">
                      {libraryError}
                    </div>
                  )}
                </div>

                <div className="glass self-start min-w-0 overflow-hidden rounded-2xl border border-white/10 p-4 md:p-5">
                  {libraryLoading ? (
                    <div className="p-8 animate-pulse">
                      <div className="h-4 bg-white/10 rounded w-1/2 mb-4"></div>
                      <div className="h-3 bg-white/5 rounded w-2/3"></div>
                    </div>
                  ) : libraryTracks.length === 0 ? (
                    <div className="p-8 text-center">
                      <div className="mx-auto size-14 rounded-2xl bg-white/5 flex items-center justify-center">
                        <span className="material-symbols-outlined text-white/40 text-3xl">library_music</span>
                      </div>
                      <h4 className="text-white text-lg font-bold mt-5">No uploaded tracks yet</h4>
                      <p className="text-white/40 text-sm mt-2">Upload your first file and it becomes available everywhere in the room set.</p>
                    </div>
                  ) : (
                    <div className="space-y-3 overflow-x-hidden max-h-[560px] overflow-y-auto pr-1">
                      {libraryTracks.map((track) => {
                        const isPlayingTrack = nowPlaying?.isPlaying && nowPlaying?.libraryItemId === track.id;
                        const isPlayBusy = libraryBusyId === track.id;
                        const isDeleteBusy = libraryDeleteBusyId === track.id;
                        return (
                          <div
                            key={track.id}
                            className={`upload-track glass w-full px-4 py-[0.7rem] rounded-2xl border ${isPlayingTrack ? 'border-emerald-400/40 shadow-[0_0_24px_rgba(16,185,129,0.18)]' : 'border-white/10'}`}
                          >
                            <div className="flex min-w-0 items-center gap-4">
                              <div className="upload-track__meter shrink-0">
                                <span className="material-symbols-outlined text-white/70">audio_file</span>
                              </div>
                              <div className="flex-1 min-w-0">
                                <div className="upload-track__row">
                                  <div className="min-w-0">
                                    <p className="text-white font-semibold truncate">{track.title}</p>
                                  </div>
                                  <div className="upload-track__actions flex items-center gap-2 shrink-0">
                                    <button
                                      onClick={() => void handleLibraryPlay(track)}
                                      disabled={actionBusy || selectedHosts.length === 0 || isDeleteBusy}
                                      aria-label={`Play ${track.title}`}
                                      title={`Play ${track.title}`}
                                      className="playlist-action-btn px-4 py-2 rounded-lg bg-emerald-500/15 border border-emerald-400/30 text-emerald-200 text-xs font-bold uppercase tracking-widest hover:bg-emerald-500/25 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                                    >
                                      <span className={`material-symbols-outlined text-[18px] ${isPlayBusy ? 'animate-spin' : ''}`}>
                                        {isPlayBusy ? 'progress_activity' : 'play_arrow'}
                                      </span>
                                    </button>
                                    <button
                                      onClick={() => void handleLibraryDelete(track)}
                                      disabled={actionBusy || isPlayBusy || isDeleteBusy}
                                      aria-label={`Delete ${track.title}`}
                                      title={`Delete ${track.title}`}
                                      className="playlist-action-btn playlist-action-btn-danger px-3 py-2 rounded-lg border border-rose-500/30 text-rose-200 text-xs font-bold uppercase tracking-widest hover:bg-rose-500/10 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                                    >
                                      <span className={`material-symbols-outlined text-[18px] ${isDeleteBusy ? 'animate-spin' : ''}`}>
                                        {isDeleteBusy ? 'progress_activity' : 'delete'}
                                      </span>
                                    </button>
                                  </div>
                                </div>
                                <div className="upload-track__subline mt-1.5">
                                  <div className="flex min-w-0 items-center gap-3 text-[10px] uppercase tracking-[0.22em] text-white/35">
                                    <span className={`size-1.5 rounded-full shrink-0 ${isPlayingTrack ? 'bg-emerald-400 animate-pulse' : 'bg-white/20'}`}></span>
                                    <span>{isPlayingTrack ? 'LIVE' : 'READY'}</span>
                                  </div>
                                  <div className="upload-track__meta flex items-center gap-3 text-[10px] font-mono text-white/35">
                                    <span>{track.durationLabel || '--:--'}</span>
                                    <span>{formatBytes(track.size)}</span>
                                    <span>{formatUploadDate(track.uploadedAt)}</span>
                                  </div>
                                </div>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>

        <footer className="glass border-t border-white/10 z-40">
          <div className="max-w-6xl mx-auto px-4 md:px-8 py-4">
            <div className="glass footer-playback-panel rounded-2xl border border-white/10 px-4 py-4 md:px-5">
              <div className="flex items-center gap-4">
                <button
                  onClick={handleStop}
                  disabled={selectedHosts.length === 0 || actionBusy}
                  className={`transport-btn transport-btn-stop footer-stop-btn ${actionBusy ? 'is-busy' : ''}`}
                  aria-label="Stop"
                  title={actionBusy ? 'Stopping...' : 'Stop'}
                >
                  <span className={`material-symbols-outlined text-[22px] ${actionBusy ? 'animate-spin' : ''}`}>
                    {actionBusy ? 'progress_activity' : 'stop'}
                  </span>
                </button>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-4 text-xs text-white/60">
                    <span className="truncate">
                      {nowPlayingDisplayTitle || currentTrack?.originalName || 'Idle'}
                    </span>
                    <span className="shrink-0">
                      {selectedHosts.length > 0 ? `${selectedHosts.length} zone${selectedHosts.length > 1 ? 's' : ''}` : 'No output'}
                    </span>
                  </div>
                  <div className="mt-3">
                    <div className="progress-track progress-track-large">
                      <div
                        className={`progress-bar ${progress?.percent == null ? 'is-indeterminate' : ''}`}
                        style={progress?.percent != null ? { width: `${progress.percent}%` } : undefined}
                      />
                    </div>
                    <div className="mt-2 flex justify-between text-[11px] text-white/50 font-mono">
                      {progress ? (
                        <>
                          <span>{formatTime(progress.elapsed)}</span>
                          <span>
                            {progress.duration != null
                              ? (nowPlaying?.durationLabel || formatTime(progress.duration))
                              : (nowPlaying?.durationLabel || '--:--')}
                          </span>
                        </>
                      ) : (
                        <>
                          <span>--:--</span>
                          <span>{nowPlaying?.durationLabel || '--:--'}</span>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </footer>
      </main>

      {toast && (
        <div className="fixed bottom-32 right-8 glass p-4 rounded-2xl border-emerald-500/20 flex items-center gap-4 shadow-2xl z-50">
          <div className="size-10 bg-emerald-500/20 rounded-full flex items-center justify-center">
            <span className="material-symbols-outlined text-emerald-500">cloud_done</span>
          </div>
          <div>
            <p className="text-white text-sm font-bold">Status</p>
            <p className="text-white/40 text-xs">{toast}</p>
          </div>
          <button onClick={() => setToast(null)} className="text-white/20 hover:text-white ml-2">
            <span className="material-symbols-outlined text-sm">close</span>
          </button>
        </div>
      )}
    </div>
  );
}

export default App;
