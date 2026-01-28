import { useState, useEffect } from 'react';
import axios from 'axios';
import { DeviceList } from './components/DeviceList';
import { Player } from './components/Player';
import type { Device } from './types';
import { RefreshCw, Radio, Layers, Github, Plus, Search, LayoutDashboard, Settings } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

const API_URL = `http://10.10.4.213:3005`;

function App() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [selectedHosts, setSelectedHosts] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [manualIp, setManualIp] = useState('');
  const [addingManual, setAddingManual] = useState(false);

  const fetchDevices = async () => {
    setDiscovering(true);
    setError(null);
    try {
      const res = await axios.get(`${API_URL}/devices`);
      setDevices(res.data);
    } catch (err: any) {
      setError(err.message || 'Failed to scan network');
      console.error(err);
    } finally {
      setDiscovering(false);
    }
  };

  const fetchDeep = async () => {
    setDiscovering(true);
    setError(null);
    try {
      const res = await axios.get(`${API_URL}/scan`);
      setDevices(res.data);
      if (res.data.length === 0) {
        setError('No devices found even after deep scan.');
      }
    } catch (err: any) {
      setError('Deep scan failed: ' + err.message);
    } finally {
      setDiscovering(false);
    }
  };

  useEffect(() => {
    fetchDevices();
  }, []);

  const handleVolumeChange = async (host: string, newVolume: number) => {
    // Update local state immediately for snappy UI
    setDevices(prev => prev.map(d => d.host === host ? { ...d, volume: newVolume } : d));

    try {
      await axios.post(`${API_URL}/volume`, { host, volume: newVolume });
    } catch (err: any) {
      console.error('Failed to change volume:', err.message);
    }
  };

  const toggleSelect = (host: string) => {
    setSelectedHosts(prev =>
      prev.includes(host) ? prev.filter(h => h !== host) : [...prev, host]
    );
  };

  const handleAddManual = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!manualIp) return;
    setAddingManual(true);
    try {
      const res = await axios.post(`${API_URL}/add-device`, { host: manualIp });
      const newDevice = res.data;
      if (!devices.find(d => d.host === newDevice.host)) {
        setDevices(prev => [...prev, newDevice]);
      }
      setManualIp('');
    } catch (err: any) {
      alert('Failed to add: ' + (err.response?.data || err.message));
    } finally {
      setAddingManual(false);
    }
  };

  const handlePlay = async (url: string) => {
    if (selectedHosts.length === 0) return;
    setLoading(true);

    if (selectedHosts.length > 1) {
      try {
        await axios.post(`${API_URL}/group`, {
          masterHost: selectedHosts[0],
          memberHosts: selectedHosts
        });
      } catch (err) {
        console.error('Grouping failed', err);
      }
    }

    try {
      await axios.post(`${API_URL}/play`, {
        deviceHost: selectedHosts[0],
        youtubeUrl: url
      });
    } catch (err: any) {
      alert('Playback failed: ' + (err.response?.data || err.message));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex h-screen bg-[#09090b] text-zinc-100 overflow-hidden font-sans">
      <div className="bg-mesh" />
      <div className="bg-grid" />

      {/* Sidebar Navigation */}
      <aside className="w-20 hidden md:flex flex-col items-center py-10 border-r border-white/5 bg-black/20 backdrop-blur-3xl z-10">
        <div className="w-12 h-12 bg-indigo-500 rounded-2xl flex items-center justify-center shadow-lg shadow-indigo-500/20 mb-12">
          <Radio className="text-white" size={24} />
        </div>

        <nav className="flex flex-col gap-8">
          <button className="text-indigo-400 p-3 rounded-xl bg-indigo-500/10 cursor-default">
            <LayoutDashboard size={24} />
          </button>
          <button className="text-zinc-500 p-3 hover:text-white hover:bg-white/5 transition-all rounded-xl">
            <Settings size={24} />
          </button>
        </nav>

        <div className="mt-auto">
          <a href="https://github.com" target="_blank" className="text-zinc-600 hover:text-white transition-colors">
            <Github size={20} />
          </a>
        </div>
      </aside>

      {/* Main Content Area */}
      <main className="flex-1 flex flex-col relative overflow-hidden">

        {/* Header Bar */}
        <header className="h-24 flex items-center justify-between px-10 border-b border-white/5 bg-black/10 backdrop-blur-md z-10">
          <div className="flex flex-col">
            <h1 className="text-2xl font-black italic tracking-tighter uppercase text-white leading-none">Sonons</h1>
            <span className="text-[10px] uppercase tracking-widest text-zinc-500 font-bold">Premium OS v1.0</span>
          </div>

          <div className="flex items-center gap-4">
            {/* Manual Add Input */}
            <form onSubmit={handleAddManual} className="relative group">
              <input
                type="text"
                placeholder="Connect via IP..."
                value={manualIp}
                onChange={(e) => setManualIp(e.target.value)}
                className="bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-xs w-[200px] focus:w-[260px] focus:outline-none focus:ring-1 focus:ring-indigo-500 transition-all placeholder:text-zinc-600"
              />
              <button
                disabled={addingManual || !manualIp}
                className="absolute right-1.5 top-1.5 p-1 bg-indigo-500 rounded-lg text-white disabled:opacity-0 transition-all hover:bg-indigo-400 group-focus-within:opacity-100 opacity-0"
              >
                {addingManual ? <RefreshCw size={14} className="animate-spin" /> : <Plus size={14} />}
              </button>
            </form>

            <div className="h-6 w-px bg-white/10 mx-2" />

            {/* Scan Buttons */}
            <div className="flex items-center gap-2">
              <button
                onClick={fetchDevices}
                disabled={discovering}
                className="bg-zinc-800/50 hover:bg-zinc-800 text-zinc-300 p-2.5 rounded-xl border border-white/5 transition-all disabled:opacity-50"
              >
                <RefreshCw size={18} className={discovering ? 'animate-spin' : ''} />
              </button>
              <button
                onClick={fetchDeep}
                disabled={discovering}
                className="bg-indigo-600/10 hover:bg-indigo-600/20 text-indigo-400 px-4 py-2.5 rounded-xl border border-indigo-500/10 transition-all font-bold text-xs uppercase tracking-wider flex items-center gap-2 disabled:opacity-50"
              >
                <Search size={16} />
                Deep Scan
              </button>
            </div>
          </div>
        </header>

        {/* Scrollable Viewport */}
        <div className="flex-1 overflow-y-auto px-10 py-10">
          <div className="max-w-screen-xl mx-auto space-y-12 pb-32">

            {/* Device Section */}
            <section>
              <header className="flex items-baseline justify-between mb-8">
                <div className="flex items-center gap-3">
                  <div className="w-1.5 h-1.5 bg-indigo-500 rounded-full animate-pulse shadow-[0_0_10px_rgba(99,102,241,0.5)]" />
                  <h2 className="text-xl font-bold tracking-tight text-white">Zone Management</h2>
                </div>
                <span className="text-zinc-500 text-xs font-bold uppercase tracking-widest">{devices.length} Devices Online</span>
              </header>

              <AnimatePresence mode="wait">
                {error ? (
                  <motion.div
                    initial={{ opacity: 0, scale: 0.95 }}
                    animate={{ opacity: 1, scale: 1 }}
                    className="p-12 rounded-[2rem] border border-rose-500/20 bg-rose-500/5 text-center"
                  >
                    <div className="text-rose-400 font-bold mb-2">Network Error</div>
                    <div className="text-zinc-400 text-sm">{error}</div>
                    <button onClick={fetchDevices} className="mt-6 text-xs uppercase tracking-widest font-black text-rose-500 hover:text-rose-400">Retry Connection</button>
                  </motion.div>
                ) : devices.length === 0 && !discovering ? (
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="p-24 rounded-[3rem] border border-white/5 bg-white/[0.01] flex flex-col items-center justify-center text-center"
                  >
                    <div className="w-20 h-20 rounded-3xl bg-zinc-900 border border-white/5 flex items-center justify-center mb-8 text-zinc-700">
                      <Layers size={40} />
                    </div>
                    <h3 className="text-2xl font-black text-white mb-2">Ambient Silence</h3>
                    <p className="text-zinc-500 max-w-sm mb-10 leading-relaxed">No Sonos active in this reality. Try a deep scan or manual IP uplink if your router is shielding them.</p>
                    <button onClick={fetchDeep} className="bg-white text-black px-8 py-3.5 rounded-2xl font-black uppercase text-xs tracking-widest hover:bg-zinc-200 transition-all active:scale-95 shadow-xl">Initiate Deep Scan</button>
                  </motion.div>
                ) : (
                  <DeviceList
                    devices={devices}
                    selectedHosts={selectedHosts}
                    onToggleSelect={toggleSelect}
                    onVolumeChange={handleVolumeChange}
                  />
                )}
              </AnimatePresence>
            </section>

          </div>
        </div>

        {/* Global Player Bar */}
        <div className="absolute bottom-0 inset-x-0 p-8 z-20 pointer-events-none">
          <div className="max-w-4xl mx-auto pointer-events-auto">
            <Player
              onPlay={handlePlay}
              isLoading={loading}
              activeDeviceCount={selectedHosts.length}
            />
          </div>
        </div>

      </main>
    </div>
  );
}

export default App;
