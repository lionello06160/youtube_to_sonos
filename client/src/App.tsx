import { useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import type { Device, LoopMode, PlaylistTrack } from './types';

const API_URL = `http://10.10.4.14:3005`;

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

function App() {
  const YT_STORAGE_KEY = 'sonons:lastYoutubeUrl';
  const [devices, setDevices] = useState<Device[]>([]);
  const [selectedHosts, setSelectedHosts] = useState<string[]>([]);
  const [discovering, setDiscovering] = useState(false);
  const [broadcasting, setBroadcasting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [youtubeUrl, setYoutubeUrl] = useState('');
  const [toast, setToast] = useState<string | null>(null);
  const [nowPlaying, setNowPlaying] = useState<{
    title: string | null;
    isPlaying: boolean;
    activeStreams: number;
    startedAt: number | null;
    durationSec: number | null;
    durationLabel: string | null;
    autoStopTime?: string | null;
    autoShutdownTime?: string | null;
  } | null>(null);
  const [playlistItems, setPlaylistItems] = useState<PlaylistTrack[]>([]);
  const [playlistIndex, setPlaylistIndex] = useState<number | null>(null);
  const [loopMode, setLoopMode] = useState<LoopMode>('all');
  const [playlistLoading, setPlaylistLoading] = useState(false);
  const [playlistError, setPlaylistError] = useState<string | null>(null);
  const [dragUid, setDragUid] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const actionLockRef = useRef(false);
  const [buttonFxKey, setButtonFxKey] = useState<string | null>(null);
  const [buttonBusyKey, setButtonBusyKey] = useState<string | null>(null);
  const [buttonDoneKey, setButtonDoneKey] = useState<string | null>(null);
  const [uiAction, setUiAction] = useState<{
    kind: 'idle' | 'play' | 'playlistStart' | 'stop';
    trackIndex: number | null;
  }>({ kind: 'idle', trackIndex: null });

  const selectedMaster = selectedHosts[0];
  const onlineCount = devices.length;
  const actionBusy = uiAction.kind !== 'idle';
  const playButtonBusy = uiAction.kind === 'play';
  const stopButtonBusy = uiAction.kind === 'stop';

  const showToast = (message: string) => {
    setToast(message);
    setTimeout(() => setToast(null), 3500);
  };
  const triggerButtonFx = (key: string) => {
    setButtonFxKey(key);
    window.setTimeout(() => {
      setButtonFxKey((prev) => (prev === key ? null : prev));
    }, 180);
  };
  const markButtonDone = (key: string) => {
    setButtonDoneKey(key);
    window.setTimeout(() => {
      setButtonDoneKey((prev) => (prev === key ? null : prev));
    }, 700);
  };

  const runWithActionLock = async (
    kind: 'play' | 'playlistStart' | 'stop',
    fn: () => Promise<void>,
    trackIndex: number | null = null
  ) => {
    if (actionLockRef.current) {
      showToast('上一個操作進行中，請稍候');
      return;
    }
    actionLockRef.current = true;
    setUiAction({ kind, trackIndex });
    try {
      await fn();
    } finally {
      actionLockRef.current = false;
      setUiAction({ kind: 'idle', trackIndex: null });
    }
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
    } catch (err: any) {
      setError('Deep scan failed: ' + err.message);
    } finally {
      setDiscovering(false);
    }
  };

  const fetchPlaylist = async () => {
    setPlaylistLoading(true);
    setPlaylistError(null);
    try {
      const res = await axios.get(`${API_URL}/playlist`);
      setPlaylistItems(res.data.items || []);
      setPlaylistIndex(
        typeof res.data.currentIndex === 'number' ? res.data.currentIndex : null
      );
      if (res.data.loopMode) {
        setLoopMode(res.data.loopMode as LoopMode);
      }
    } catch (err: any) {
      setPlaylistError('Playlist load failed: ' + err.message);
    } finally {
      setPlaylistLoading(false);
    }
  };

  useEffect(() => {
    fetchDeep();
    fetchPlaylist();
  }, []);

  useEffect(() => {
    const stored = localStorage.getItem(YT_STORAGE_KEY);
    if (stored && !youtubeUrl) {
      setYoutubeUrl(stored);
    }
  }, []);

  useEffect(() => {
    if (youtubeUrl) {
      localStorage.setItem(YT_STORAGE_KEY, youtubeUrl);
    } else {
      localStorage.removeItem(YT_STORAGE_KEY);
    }
  }, [youtubeUrl]);

  useEffect(() => {
    let mounted = true;
    const fetchStatus = async () => {
      try {
        const res = await axios.get(`${API_URL}/status`);
        if (!mounted) return;
        setNowPlaying(res.data);
        if (typeof res.data.playlistIndex === 'number') {
          setPlaylistIndex(res.data.playlistIndex);
        } else {
          setPlaylistIndex(null);
        }
        if (res.data.loopMode) {
          setLoopMode(res.data.loopMode as LoopMode);
        }
      } catch {
        // ignore transient status errors
      }
    };
    fetchStatus();
    const id = setInterval(fetchStatus, 5000);
    return () => {
      mounted = false;
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const handleVolumeChange = async (host: string, newVolume: number) => {
    setDevices(prev => prev.map(d => d.host === host ? { ...d, volume: newVolume } : d));
    try {
      await axios.post(`${API_URL}/volume`, { host, volume: newVolume });
    } catch (err: any) {
      showToast('Volume update failed');
    }
  };

  const toggleSelect = (host: string) => {
    setSelectedHosts(prev =>
      prev.includes(host) ? prev.filter(h => h !== host) : [...prev, host]
    );
  };

  const selectAll = () => setSelectedHosts(devices.map(d => d.host));
  const deselectAll = () => setSelectedHosts([]);

  const handlePlay = async () => {
    if (!youtubeUrl) {
      showToast('請先貼上 YouTube URL');
      return;
    }
    if (selectedHosts.length === 0) {
      showToast('請先選擇播放裝置');
      return;
    }
    await runWithActionLock('play', async () => {
      setBroadcasting(true);
      if (selectedHosts.length > 1) {
        try {
          await axios.post(`${API_URL}/group`, {
            masterHost: selectedHosts[0],
            memberHosts: selectedHosts
          });
        } catch (err) {
          showToast('Grouping failed');
        }
      }

      try {
        await axios.post(`${API_URL}/play`, {
          deviceHost: selectedHosts[0],
          youtubeUrl
        });
        showToast('Broadcast started');
      } catch (err: any) {
        showToast('Playback failed');
      } finally {
        setBroadcasting(false);
      }
    });
  };

  const handleStop = async () => {
    if (selectedHosts.length === 0) {
      showToast('請先選擇播放裝置');
      return;
    }
    await runWithActionLock('stop', async () => {
      try {
        await axios.post(`${API_URL}/stop`, { deviceHost: selectedHosts[0] });
        setNowPlaying((prev) => prev ? { ...prev, isPlaying: false, title: null } : prev);
        showToast('Stopped');
      } catch (err: any) {
        showToast('Stop failed');
      }
    });
  };

  const handleAddToPlaylist = async () => {
    if (!youtubeUrl) return;
    setPlaylistLoading(true);
    try {
      const res = await axios.post(`${API_URL}/playlist`, {
        inputUrl: youtubeUrl,
        mode: 'append'
      });
      setPlaylistItems(res.data.items || []);
      showToast(`Added ${res.data.addedCount ?? 0} track(s)`);
    } catch (err: any) {
      showToast('Add to playlist failed');
    } finally {
      setPlaylistLoading(false);
    }
  };

  const handlePlaylistStart = async (index: number) => {
    if (selectedHosts.length === 0) {
      showToast('請先選擇播放裝置');
      return;
    }
    const trackUid = playlistItems[index]?.uid || String(index);
    const playKey = `play-${trackUid}`;
    triggerButtonFx(playKey);
    await runWithActionLock('playlistStart', async () => {
      setButtonBusyKey(playKey);
      setBroadcasting(true);
      if (selectedHosts.length > 1) {
        try {
          await axios.post(`${API_URL}/group`, {
            masterHost: selectedHosts[0],
            memberHosts: selectedHosts
          });
        } catch (err) {
          showToast('Grouping failed');
        }
      }
      try {
        await axios.post(`${API_URL}/playlist/start`, {
          deviceHost: selectedHosts[0],
          index
        });
        setPlaylistIndex(index);
        markButtonDone(playKey);
        showToast('Playlist started');
      } catch (err: any) {
        showToast('Playlist start failed');
      } finally {
        setButtonBusyKey((prev) => (prev === playKey ? null : prev));
        setBroadcasting(false);
      }
    }, index);
  };

  const handlePlaylistRemove = async (uid: string) => {
    const deleteKey = `delete-${uid}`;
    triggerButtonFx(deleteKey);
    setButtonBusyKey(deleteKey);
    try {
      const res = await axios.post(`${API_URL}/playlist/remove`, { uid });
      setPlaylistItems(res.data.items || []);
      if (typeof res.data.currentIndex === 'number') {
        setPlaylistIndex(res.data.currentIndex);
      } else {
        setPlaylistIndex(null);
      }
      markButtonDone(deleteKey);
      showToast('Removed from playlist');
    } catch (err: any) {
      showToast('Remove failed');
    } finally {
      setButtonBusyKey((prev) => (prev === deleteKey ? null : prev));
    }
  };

  const handleLoopModeChange = async (value: LoopMode) => {
    const previous = loopMode;
    setLoopMode(value);
    try {
      await axios.post(`${API_URL}/playlist/mode`, { loopMode: value });
      showToast(`Loop mode: ${value}`);
    } catch (err: any) {
      setLoopMode(previous);
      showToast('Mode update failed');
    }
  };

  const handleReorder = async (fromUid: string, toUid: string) => {
    if (fromUid === toUid) return;
    const fromIndex = playlistItems.findIndex((item) => item.uid === fromUid);
    const toIndex = playlistItems.findIndex((item) => item.uid === toUid);
    if (fromIndex < 0 || toIndex < 0) return;
    const updated = [...playlistItems];
    const [moved] = updated.splice(fromIndex, 1);
    updated.splice(toIndex, 0, moved);
    setPlaylistItems(updated);
    try {
      await axios.post(`${API_URL}/playlist/reorder`, {
        order: updated.map((item) => item.uid)
      });
    } catch (err: any) {
      showToast('Reorder failed');
      fetchPlaylist();
    }
  };

  const stats = useMemo(() => ([
    { label: 'Devices Online', value: `${onlineCount}`, note: onlineCount > 0 ? 'Active' : 'Offline' },
    { label: 'Selected Zones', value: `${selectedHosts.length}`, note: selectedHosts.length ? 'Ready' : 'None' },
    { label: 'Playback', value: nowPlaying?.isPlaying ? 'LIVE' : 'IDLE', note: nowPlaying?.isPlaying ? 'Broadcast' : 'Standby' },
  ]), [onlineCount, selectedHosts.length, nowPlaying?.isPlaying]);

  const progress = useMemo(() => {
    if (!nowPlaying?.startedAt || !nowPlaying?.durationSec) return null;
    const elapsed = Math.max(0, Math.floor((Date.now() - nowPlaying.startedAt) / 1000));
    const percent = Math.min(100, (elapsed / nowPlaying.durationSec) * 100);
    return {
      elapsed,
      duration: nowPlaying.durationSec,
      percent
    };
  }, [nowPlaying?.startedAt, nowPlaying?.durationSec, tick]);

  return (
    <div className="font-display min-h-screen flex bg-background-dark text-white">
      <div className="bg-mesh" />
      <div className="bg-grid" />
      <div className="ambient-orbs" aria-hidden="true">
        <span className="orb orb-one" />
        <span className="orb orb-two" />
        <span className="orb orb-three" />
      </div>

      {/* Main Content */}
      <main className="flex-1 flex flex-col h-screen overflow-hidden">
        {/* Header */}
        <header className="glass sticky top-0 z-30 border-b border-white/10">
          <div className="w-full max-w-6xl mx-auto flex items-center justify-between px-4 md:px-8 py-4">
            <div className="flex items-center gap-6">
              <h2 className="text-white text-xl font-bold tracking-tight">System Overview</h2>
              <div className="flex items-center gap-2 px-3 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/20">
                <span className="size-2 rounded-full bg-emerald-500 animate-pulse"></span>
                <span className="text-emerald-500 text-xs font-bold uppercase tracking-wider">
                  {discovering ? 'Scanning' : `${onlineCount} Online`}
                </span>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={fetchDeep}
                disabled={discovering}
                className="btn-accent flex items-center gap-2 px-5 py-2.5 rounded-lg bg-accent-amber/20 border border-accent-amber/40 text-accent-amber text-sm font-bold hover:bg-accent-amber/30 transition-all neon-glow-amber disabled:opacity-50"
              >
                <span className={`material-symbols-outlined text-[18px] ${discovering ? 'animate-spin' : ''}`}>radar</span>
                Scan
              </button>
              <div className="hidden md:flex items-center gap-2 px-3 py-1.5 rounded-full border border-white/10 bg-white/5 text-white/60 text-[11px] font-mono">
                <span className="size-2 rounded-full bg-emerald-500/60"></span>
                <span>Server: {API_URL.replace('http://', '').replace('https://', '')}</span>
              </div>
              <div className="h-8 w-[1px] bg-white/10 mx-2"></div>
              <div className="size-10 rounded-full border border-white/20 p-0.5">
                <div className="w-full h-full rounded-full bg-gradient-to-br from-white/30 to-white/5"></div>
              </div>
            </div>
          </div>
        </header>

        {/* Scrollable Area */}
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-6xl mx-auto px-4 md:px-8 py-8 space-y-8">
            {/* Stats */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
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

            {/* Device Grid */}
            <div>
              <div className="flex items-center justify-between mb-6 px-1">
                <h3 className="text-white text-lg font-bold">Discovered Devices</h3>
                <div className="flex gap-4">
                  <button
                    onClick={selectAll}
                    className="text-white/40 hover:text-white text-xs font-bold uppercase transition-colors tracking-widest"
                  >
                    Select All
                  </button>
                  <button
                    onClick={deselectAll}
                    className="text-white/40 hover:text-white text-xs font-bold uppercase transition-colors tracking-widest"
                  >
                    Deselect
                  </button>
                </div>
              </div>

              {error && (
                <div className="glass border border-rose-500/20 text-rose-200 px-4 py-3 rounded-xl mb-6">
                  {error}
                </div>
              )}

              {devices.length === 0 && !discovering ? (
                <div className="glass p-12 rounded-2xl text-center border border-white/10">
                  <div className="mx-auto size-16 rounded-2xl bg-white/5 flex items-center justify-center">
                    <span className="material-symbols-outlined text-white/40 text-4xl">layers</span>
                  </div>
                  <h3 className="text-white text-lg font-bold mt-6">Ambient Silence</h3>
                  <p className="text-white/40 text-sm mt-2">No Sonos active right now. Try a deep scan.</p>
                  <button
                    onClick={fetchDeep}
                    className="mt-6 px-6 py-2.5 rounded-xl bg-white text-black font-bold text-xs uppercase tracking-widest"
                  >
                    Scan Network
                  </button>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
                  {discovering && devices.length === 0 && (
                    <div className="glass p-5 rounded-2xl border-white/5 animate-pulse">
                      <div className="flex gap-4 mb-6">
                        <div className="size-20 bg-white/5 rounded-xl"></div>
                        <div className="flex-1 flex flex-col justify-center gap-2">
                          <div className="h-4 bg-white/10 rounded w-3/4"></div>
                          <div className="h-3 bg-white/5 rounded w-1/2"></div>
                        </div>
                      </div>
                      <div className="h-1 bg-white/5 rounded-full w-full"></div>
                    </div>
                  )}

                  {devices.map((device) => {
                    const isSelected = selectedHosts.includes(device.host);
                    const isMaster = device.host === selectedMaster;
                    return (
                      <div
                        key={device.host}
                        onClick={() => toggleSelect(device.host)}
                        className={`device-card glass p-5 rounded-2xl relative cursor-pointer transition-all ${isSelected ? 'neon-border-primary' : 'border-white/10 hover:border-white/20'} ${isSelected && nowPlaying?.isPlaying ? 'playing-glow' : ''}`}
                      >
                        {isSelected && (
                          <div className="absolute top-4 right-4 text-primary flex items-center gap-2">
                            {isMaster && (
                              <span className="text-[10px] uppercase tracking-widest bg-primary/20 px-2 py-1 rounded-full">Master</span>
                            )}
                            <span className="material-symbols-outlined fill-1">check_circle</span>
                          </div>
                        )}
                        <div className="flex gap-4 mb-6">
                          <div className={`speaker-badge size-20 rounded-xl flex items-center justify-center border ${isSelected ? 'bg-primary/20 border-primary/30' : 'bg-white/5 border-white/10'}`}>
                            <PlayOneIcon className="w-12 h-16" />
                            {isSelected && (
                              <span className="speaker-pulse" />
                            )}
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
                            style={{ '--volume': `${device.volume}%` } as React.CSSProperties}
                            onChange={(e) => handleVolumeChange(device.host, Number(e.target.value))}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Playlist */}
            <div>
              <div className="flex items-center justify-between mb-6 px-1">
                <h3 className="text-white text-lg font-bold">Playlist</h3>
                <div className="flex items-center gap-3">
                  <span className="text-white/40 text-[10px] font-bold uppercase tracking-widest">Loop</span>
                  <select
                    value={loopMode}
                    onChange={(e) => handleLoopModeChange(e.target.value as LoopMode)}
                    disabled={actionBusy}
                    className="bg-white/5 border border-white/10 text-white text-xs rounded-lg px-3 py-2 focus:outline-none focus:border-primary"
                  >
                    <option value="single">Single</option>
                    <option value="all">All</option>
                    <option value="shuffle">Shuffle</option>
                  </select>
                </div>
              </div>

              {playlistError && (
                <div className="glass border border-rose-500/20 text-rose-200 px-4 py-3 rounded-xl mb-6">
                  {playlistError}
                </div>
              )}

              {playlistLoading && playlistItems.length === 0 ? (
                <div className="glass p-8 rounded-2xl border border-white/10 animate-pulse">
                  <div className="h-4 bg-white/10 rounded w-2/3 mb-4"></div>
                  <div className="h-3 bg-white/5 rounded w-1/2"></div>
                </div>
              ) : playlistItems.length === 0 ? (
                <div className="glass p-8 rounded-2xl text-center border border-white/10">
                  <div className="mx-auto size-14 rounded-2xl bg-white/5 flex items-center justify-center">
                    <span className="material-symbols-outlined text-white/40 text-3xl">queue_music</span>
                  </div>
                  <h3 className="text-white text-lg font-bold mt-5">Empty Playlist</h3>
                  <p className="text-white/40 text-sm mt-2">Add a YouTube URL to build your playlist.</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {playlistItems.map((track, index) => {
                    const isCurrent = playlistIndex === index && nowPlaying?.isPlaying;
                    const playKey = `play-${track.uid}`;
                    const deleteKey = `delete-${track.uid}`;
                    const isPlayBusy = (uiAction.kind === 'playlistStart' && uiAction.trackIndex === index) || buttonBusyKey === playKey;
                    return (
                      <div
                        key={track.uid}
                        draggable
                        onDragStart={(e) => {
                          setDragUid(track.uid);
                          e.dataTransfer.effectAllowed = 'move';
                        }}
                        onDragEnd={() => setDragUid(null)}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={() => {
                          if (dragUid) {
                            handleReorder(dragUid, track.uid);
                          }
                          setDragUid(null);
                        }}
                        className={`glass p-4 rounded-xl border flex items-center gap-4 transition-all ${isCurrent ? 'border-primary/50 shadow-[0_0_20px_rgba(34,197,94,0.3)]' : 'border-white/10 hover:border-white/20'}`}
                      >
                        <div className="flex items-center gap-3">
                          <span className="text-white/30 text-xs font-mono w-6 text-right">{index + 1}</span>
                          <span className="material-symbols-outlined text-white/30">drag_indicator</span>
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-white font-medium truncate">{track.title}</p>
                          <p className="text-white/40 text-xs font-mono mt-1">
                            {track.durationLabel || (track.durationSec != null ? formatTime(track.durationSec) : '--:--')}
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => handlePlaylistStart(index)}
                            disabled={actionBusy || selectedHosts.length === 0}
                            className={`playlist-action-btn px-4 py-2 rounded-lg bg-primary/20 border border-primary/40 text-primary text-xs font-bold uppercase tracking-widest hover:bg-primary/30 transition-all disabled:opacity-40 disabled:cursor-not-allowed ${buttonFxKey === playKey ? 'is-pressed' : ''} ${buttonBusyKey === playKey ? 'is-busy' : ''} ${buttonDoneKey === playKey ? 'is-done' : ''}`}
                            aria-label="Play track"
                            title="Play"
                          >
                            <span className={`material-symbols-outlined text-[18px] ${isPlayBusy ? 'animate-spin' : ''}`}>
                              {isPlayBusy ? 'progress_activity' : 'play_arrow'}
                            </span>
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handlePlaylistRemove(track.uid);
                            }}
                            disabled={actionBusy || buttonBusyKey === deleteKey}
                            className={`playlist-action-btn playlist-action-btn-danger px-3 py-2 rounded-lg border border-rose-500/30 text-rose-200 text-xs font-bold uppercase tracking-widest hover:bg-rose-500/10 transition-all disabled:opacity-40 disabled:cursor-not-allowed ${buttonFxKey === deleteKey ? 'is-pressed' : ''} ${buttonBusyKey === deleteKey ? 'is-busy' : ''} ${buttonDoneKey === deleteKey ? 'is-done' : ''}`}
                            aria-label="Delete track"
                            title="Delete"
                          >
                            <span className={`material-symbols-outlined text-[18px] ${buttonBusyKey === deleteKey ? 'animate-spin' : ''}`}>
                              {buttonBusyKey === deleteKey ? 'progress_activity' : 'delete'}
                            </span>
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Broadcast Panel */}
        <footer className="glass border-t border-white/10 z-40">
          <div className="max-w-6xl mx-auto flex flex-col md:flex-row items-center gap-6 px-4 md:px-8 py-6">
            <div className="flex items-center gap-4 w-full md:w-auto">
              <div className="size-12 rounded-xl bg-red-500/10 flex items-center justify-center border border-red-500/20">
                <span className="material-symbols-outlined text-red-500">video_library</span>
              </div>
              <div className="min-w-[220px]">
                <h4 className="text-white font-bold text-sm leading-tight">YouTube Broadcast</h4>
                <p className="text-white/40 text-xs">Broadcast audio to selected devices</p>
                <div className="flex items-center gap-2 mt-2 text-xs text-white/60 max-w-[320px]">
                  <span className={`size-2 rounded-full ${nowPlaying?.isPlaying ? 'bg-emerald-500 animate-pulse' : 'bg-white/20'}`}></span>
                  <span className="truncate">
                    {nowPlaying?.title ? `Now: ${nowPlaying.title}` : 'Idle'}
                  </span>
                </div>
                <div className="mt-2 w-full">
                  <div className="progress-track">
                    <div
                      className={`progress-bar ${progress ? '' : 'is-indeterminate'}`}
                      style={progress ? { width: `${progress.percent}%` } : undefined}
                    />
                  </div>
                  <div className="mt-1 flex justify-between text-[10px] text-white/50 font-mono">
                    {progress ? (
                      <>
                        <span>{formatTime(progress.elapsed)}</span>
                        <span>{nowPlaying?.durationLabel || formatTime(progress.duration)}</span>
                      </>
                    ) : (
                      <span className="text-white/30">--:--</span>
                    )}
                    <span className="text-white/60">
                      Stop: {nowPlaying?.autoStopTime || '--:--'}
                    </span>
                  </div>
                </div>
              </div>
            </div>
            <div className="flex-1 w-full relative">
              <input
                className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white placeholder-white/20 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-all text-sm font-display"
                placeholder="Paste YouTube URL here (e.g., https://youtube.com/watch?v=...)"
                type="text"
                value={youtubeUrl}
                onChange={(e) => setYoutubeUrl(e.target.value)}
              />
              <div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-2 text-white/40">
                <span className="material-symbols-outlined text-sm">link</span>
              </div>
            </div>
            <button
              onClick={handleAddToPlaylist}
              disabled={!youtubeUrl || playlistLoading || actionBusy}
              className="btn-secondary w-full md:w-auto px-6 py-3 rounded-xl border border-white/10 text-white/80 font-bold text-sm hover:text-white hover:bg-white/10 transition-all disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              <span className="material-symbols-outlined text-[20px]">playlist_add</span>
              Add to Playlist
            </button>
            <div className="transport-cluster w-full md:w-auto">
              <button
                onClick={handlePlay}
                disabled={!youtubeUrl || selectedHosts.length === 0 || broadcasting || actionBusy}
                className={`transport-btn transport-btn-play ${playButtonBusy ? 'is-busy' : ''}`}
                aria-label="Start Broadcast"
                title={playButtonBusy ? 'Processing...' : 'Start Broadcast'}
              >
                <span className={`material-symbols-outlined text-[22px] ${playButtonBusy ? 'animate-spin' : ''}`}>
                  {playButtonBusy ? 'progress_activity' : 'play_arrow'}
                </span>
              </button>
              <button
                onClick={handleStop}
                disabled={selectedHosts.length === 0 || actionBusy}
                className={`transport-btn transport-btn-stop ${stopButtonBusy ? 'is-busy' : ''}`}
                aria-label="Stop"
                title={stopButtonBusy ? 'Stopping...' : 'Stop'}
              >
                <span className={`material-symbols-outlined text-[20px] ${stopButtonBusy ? 'animate-spin' : ''}`}>
                  {stopButtonBusy ? 'progress_activity' : 'stop'}
                </span>
              </button>
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
