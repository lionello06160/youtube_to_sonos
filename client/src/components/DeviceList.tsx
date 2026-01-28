import { motion } from 'framer-motion';
import { Speaker, Volume2, Activity } from 'lucide-react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import type { Device } from '../types';

function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}

interface DeviceListProps {
    devices: Device[];
    selectedHosts: string[];
    onToggleSelect: (host: string) => void;
    onVolumeChange?: (host: string, volume: number) => void;
}

export function DeviceList({ devices, selectedHosts, onToggleSelect, onVolumeChange }: DeviceListProps) {
    if (devices.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center p-12 border border-dashed border-white/10 rounded-3xl bg-white/5">
                <div className="w-16 h-16 rounded-2xl bg-white/5 flex items-center justify-center mb-4">
                    <Speaker className="w-8 h-8 text-white/20" />
                </div>
                <p className="text-white/40 font-medium">No devices found on the network</p>
                <p className="text-xs text-white/20 mt-2 italic">Try a Deep Scan to find all zones</p>
            </div>
        );
    }

    return (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {devices.map((device, index) => {
                const isSelected = selectedHosts.includes(device.host);

                return (
                    <motion.div
                        key={device.host}
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: index * 0.05 }}
                        onClick={() => onToggleSelect(device.host)}
                        className={cn(
                            "group relative p-6 rounded-[2rem] cursor-pointer transition-all duration-500",
                            "border bg-gradient-to-br transition-colors",
                            isSelected
                                ? "border-blue-500/50 bg-blue-500/10 shadow-[0_0_40px_-10px_rgba(59,130,246,0.3)]"
                                : "border-white/5 bg-white/5 hover:border-white/20"
                        )}
                    >
                        {/* Active Indicator */}
                        {isSelected && (
                            <div className="absolute top-6 right-6 flex gap-1 items-end h-4">
                                {[1, 2, 3].map((i) => (
                                    <motion.div
                                        key={i}
                                        animate={{ height: [4, 16, 8, 14, 4] }}
                                        transition={{
                                            duration: 0.8,
                                            repeat: Infinity,
                                            delay: i * 0.1,
                                            ease: "easeInOut"
                                        }}
                                        className="w-1 bg-blue-400 rounded-full"
                                    />
                                ))}
                            </div>
                        )}

                        <div className="flex items-start gap-4 mb-6">
                            <div className={cn(
                                "w-14 h-14 rounded-2xl flex items-center justify-center transition-all duration-300",
                                isSelected ? "bg-blue-500 shadow-lg shadow-blue-500/50" : "bg-white/10 group-hover:bg-white/15"
                            )}>
                                <Speaker className={cn("w-7 h-7", isSelected ? "text-white" : "text-white/60")} />
                            </div>

                            <div>
                                <h3 className="font-bold text-lg text-white group-hover:text-blue-200 transition-colors">
                                    {device.name}
                                </h3>
                                <p className="text-xs text-white/40 font-medium uppercase tracking-widest flex items-center gap-2">
                                    <Activity className="w-3 h-3" />
                                    {device.model}
                                </p>
                            </div>
                        </div>

                        {/* Volume Control */}
                        <div
                            className="mt-4 p-4 rounded-2xl bg-black/20 space-y-3"
                            onClick={(e) => e.stopPropagation()} // Prevent card selection when adjusting volume
                        >
                            <div className="flex items-center justify-between text-xs font-semibold text-white/40 px-1">
                                <span className="flex items-center gap-2 uppercase tracking-tighter">
                                    <Volume2 className="w-3.5 h-3.5" /> Volume
                                </span>
                                <span className="font-mono bg-white/5 px-2 py-0.5 rounded-lg text-white/60">
                                    {device.volume}%
                                </span>
                            </div>

                            <div className="relative h-2 bg-white/5 rounded-full overflow-hidden group/slider">
                                <input
                                    type="range"
                                    min="0"
                                    max="100"
                                    value={device.volume}
                                    onChange={(e) => onVolumeChange?.(device.host, parseInt(e.target.value))}
                                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10"
                                />
                                <motion.div
                                    initial={false}
                                    animate={{ width: `${device.volume}%` }}
                                    className={cn(
                                        "absolute top-0 left-0 h-full bg-gradient-to-r from-blue-600 to-blue-400 transition-all",
                                        isSelected ? "opacity-100" : "opacity-40"
                                    )}
                                />
                            </div>
                        </div>

                        <p className="mt-4 text-[10px] text-white/20 font-mono tracking-tight">
                            IP: {device.host}
                        </p>
                    </motion.div>
                );
            })}
        </div>
    );
}
