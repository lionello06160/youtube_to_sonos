import React, { useState } from 'react';
import { Play, Loader2, Youtube, Zap, Radio, RefreshCw } from 'lucide-react';
import { motion } from 'framer-motion';

interface PlayerProps {
    onPlay: (url: string) => void;
    isLoading: boolean;
    activeDeviceCount: number;
}

export const Player: React.FC<PlayerProps> = ({ onPlay, isLoading, activeDeviceCount }) => {
    const [url, setUrl] = useState('');

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (url) onPlay(url);
    };

    return (
        <motion.div
            initial={{ opacity: 0, y: 100 }}
            animate={{ opacity: 1, y: 0 }}
            className="w-full"
        >
            <div className="bg-zinc-900/40 backdrop-blur-3xl rounded-[2.5rem] p-2 border border-white/5 shadow-[0_32px_64px_-12px_rgba(0,0,0,0.8)]">
                <div className="flex flex-col md:flex-row items-center gap-4 px-6 py-4">

                    {/* Status Icon */}
                    <div className="hidden lg:flex items-center justify-center w-12 h-12 rounded-2xl bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
                        {isLoading ? <RefreshCw className="animate-spin" size={20} /> : <Zap size={20} fill="currentColor" />}
                    </div>

                    {/* Main Control Group */}
                    <div className="flex-1 w-full">
                        <form onSubmit={handleSubmit} className="flex flex-col md:flex-row items-center gap-3">
                            <div className="relative flex-1 w-full">
                                <input
                                    type="text"
                                    placeholder="Paste YouTube audio uplink..."
                                    className="w-full bg-white/5 border border-white/10 text-white rounded-2xl px-6 py-4 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 transition-all text-sm font-medium placeholder:text-zinc-600"
                                    value={url}
                                    onChange={(e) => setUrl(e.target.value)}
                                />
                                <div className="absolute right-4 top-1/2 -translate-y-1/2 text-rose-500/40">
                                    <Youtube size={16} />
                                </div>
                            </div>

                            <button
                                type="submit"
                                disabled={isLoading || !url || activeDeviceCount === 0}
                                className="w-full md:w-auto bg-indigo-500 hover:bg-indigo-400 disabled:opacity-20 disabled:grayscale disabled:cursor-not-allowed text-white h-[52px] px-8 rounded-2xl font-black uppercase text-[10px] tracking-widest flex items-center justify-center gap-3 transition-all active:scale-95 shadow-lg shadow-indigo-500/20 whitespace-nowrap"
                            >
                                {isLoading ? <Loader2 className="animate-spin" size={16} /> : <Play size={16} fill="currentColor" />}
                                Broadcast
                            </button>
                        </form>
                    </div>

                    {/* Metadata / Stats */}
                    <div className="flex items-center gap-6 text-[10px] font-black uppercase tracking-widest text-zinc-500 h-full border-l border-white/10 pl-6 hidden md:flex">
                        <div className="flex items-center gap-2">
                            <div className={`w-1.5 h-1.5 rounded-full ${activeDeviceCount > 0 ? 'bg-indigo-500 shadow-[0_0_8px_rgba(99,102,241,1)]' : 'bg-zinc-700'}`} />
                            <span>{activeDeviceCount} Zones</span>
                        </div>
                        <div className="text-zinc-700">|</div>
                        <div className="flex items-center gap-2">
                            <Radio size={12} />
                            <span>Hi-Fidelity Loop</span>
                        </div>
                    </div>
                </div>
            </div>

            {/* Reflection Effect */}
            <div className="mx-auto w-[90%] h-px bg-gradient-to-r from-transparent via-white/10 to-transparent mt-[-1px] opacity-50" />
        </motion.div>
    );
};
