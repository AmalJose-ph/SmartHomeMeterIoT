import './index.css';
import React, { useState, useEffect, useRef, useMemo } from 'react';
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
import { getDatabase, ref, onValue } from "firebase/database";
import { ComposedChart, Area, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { Activity, Zap, ShieldAlert, Cpu, Settings, Sun, Moon, X, ChevronDown } from 'lucide-react';
import bgImage from './smartgrid.jpeg';

const firebaseConfig = {
  apiKey: process.env.REACT_APP_FIREBASE_API_KEY,
  authDomain: "smart-meter-86162.firebaseapp.com",
  databaseURL: "https://smart-meter-86162-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "smart-meter-86162",
  storageBucket: "smart-meter-86162.firebasestorage.app",
  ...(process.env.REACT_APP_FIREBASE_MESSAGING_SENDER_ID && {
    messagingSenderId: process.env.REACT_APP_FIREBASE_MESSAGING_SENDER_ID,
  }),
  ...(process.env.REACT_APP_FIREBASE_APP_ID && {
    appId: process.env.REACT_APP_FIREBASE_APP_ID,
  }),
  ...(process.env.REACT_APP_FIREBASE_MEASUREMENT_ID && {
    measurementId: process.env.REACT_APP_FIREBASE_MEASUREMENT_ID,
  }),
};

const app = initializeApp(firebaseConfig);
if (typeof window !== 'undefined' && firebaseConfig.measurementId) {
  try {
    getAnalytics(app);
  } catch {
    /* analytics optional */
  }
}
const db = getDatabase(app);

const METRIC_KEYS = ['voltage', 'current', 'power', 'energy', 'pf', 'frequency'];

/** RTDB often uses "load" for forecast power (W) instead of "power". */
const POWER_FROM_LOAD_KEYS = [
  'load', 'Load', 'LOAD',
  'predicted_load', 'pred_load', 'load_pred', 'loadPred',
  'predictedLoad', 'PredictedLoad', 'forecast_load', 'forecastLoad',
  'next_load', 'nextLoad', 'Forecast_Load',
  'forecast_power', 'ForecastPower',
];

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function powerPredictionMissing(out) {
  return out.power == null || !Number.isFinite(Number(out.power));
}

/** If `power` is still empty, copy from load-style keys on `source`. */
function assignPowerFromLoadAliases(out, source) {
  if (!source || typeof source !== 'object' || !powerPredictionMissing(out)) return out;
  for (const key of POWER_FROM_LOAD_KEYS) {
    const v = num(source[key]);
    if (v !== null) {
      out.power = v;
      break;
    }
  }
  return out;
}

/** Reads prediction fields from RTDB payload (nested object or per-metric keys). */
function parsePredictionsFromSnapshot(val) {
  if (!val || typeof val !== 'object') return {};
  const nested =
    val.prediction ||
    val.predictions ||
    val.Prediction ||
    val.predicted ||
    val.forecast;
  const out = {};
  if (nested && typeof nested === 'object') {
    METRIC_KEYS.forEach((k) => {
      const v = num(nested[k]);
      if (v !== null) out[k] = v;
    });
    assignPowerFromLoadAliases(out, nested);
    assignPowerFromLoadAliases(out, val);
    return out;
  }
  METRIC_KEYS.forEach((k) => {
    const candidates = [
      val[`pred_${k}`],
      val[`${k}_pred`],
      val[`${k}Pred`],
      val[`predicted_${k}`],
      val[`predicted${k.charAt(0).toUpperCase()}${k.slice(1)}`],
      val[`prediction_${k}`],
    ];
    for (const c of candidates) {
      const v = num(c);
      if (v !== null) {
        out[k] = v;
        break;
      }
    }
  });
  assignPowerFromLoadAliases(out, val);
  return out;
}

/** DigitalTwin_Forecast root: same shapes as parsePredictionsFromSnapshot, or plain metric keys (voltage, power, …). */
function parseDigitalTwinForecast(val) {
  if (val != null && typeof val !== 'object') {
    const v = num(val);
    return v !== null ? { power: v } : {};
  }
  if (!val || typeof val !== 'object') return {};
  const structured = parsePredictionsFromSnapshot(val);
  const out = { ...structured };
  METRIC_KEYS.forEach((k) => {
    if (out[k] != null && Number.isFinite(Number(out[k]))) return;
    const v = num(val[k]);
    if (v !== null) out[k] = v;
  });
  assignPowerFromLoadAliases(out, val);
  return out;
}

const FadeInSection = ({ children, delay = 0, className = '' }) => {
  const [isVisible, setVisible] = React.useState(false);
  const domRef = React.useRef();

  React.useEffect(() => {
    const observer = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          setVisible(true);
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.1 });

    const { current } = domRef;
    if (current) observer.observe(current);

    return () => {
      if (current) observer.unobserve(current);
    };
  }, []);

  return (
    <div
      ref={domRef}
      className={`transition-all duration-1000 ease-out transform ${isVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-12'
        } ${className}`}
      style={{ transitionDelay: `${delay}ms` }}
    >
      {children}
    </div>
  );
};

const App = () => {
  const [data, setData] = useState({ voltage: 0, current: 0, power: 0, energy: 0, pf: 0, frequency: 0 });
  const [predictions, setPredictions] = useState({});
  const [history, setHistory] = useState([]);
  const [metricHistory, setMetricHistory] = useState({ voltage: [], current: [], power: [], energy: [], pf: [], frequency: [] });
  const [activeBlock, setActiveBlock] = useState(null);
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });
  const [isGraphVisible, setIsGraphVisible] = useState(false);
  const graphRef = useRef(null);

  const [dtHistory, setDtHistory] = useState([]);
  const [dtForecast, setDtForecast] = useState({ actual_P: 0, next_P: 0, next_V: 0, next_I: 0, next_F: 0, next_PF: 0 });

  const getForecastData = (id) => {
    switch (id) {
      case 'power': return { pred: dtForecast.next_P, actual: dtForecast.actual_P || data.power };
      case 'voltage': return { pred: dtForecast.next_V, actual: data.voltage };
      case 'current': return { pred: dtForecast.next_I, actual: data.current };
      case 'frequency': return { pred: dtForecast.next_F, actual: data.frequency };
      case 'pf': return { pred: dtForecast.next_PF, actual: data.pf };
      case 'energy': return { pred: predictions.energy, actual: data.energy };
      default: return { pred: predictions[id], actual: data[id] };
    }
  };

  const [limit, setLimit] = useState(2000); // Configurable threshold
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [tempLimit, setTempLimit] = useState(2000);
  const [activeChartMetric, setActiveChartMetric] = useState('power');
  const [isDarkMode, setIsDarkMode] = useState(true);

  const latestLiveRef = useRef({ voltage: 0, current: 0, power: 0, energy: 0, pf: 0, frequency: 0 });
  const livePredsRef = useRef({});
  const forecastPredsRef = useRef({});

  // Theme configuration
  const theme = {
    bgApp: isDarkMode ? 'text-gray-100' : 'text-slate-800 bg-slate-50',
    glassPanel: isDarkMode ? 'bg-slate-900/40 border-white/10' : 'bg-white/60 border-slate-200 shadow-sm',
    glassModal: isDarkMode ? 'bg-slate-900/90 border-white/20' : 'bg-white/90 border-slate-300 shadow-xl',
    radialGradient: isDarkMode ? 'from-transparent to-[#050B14]/90' : 'from-transparent to-slate-200/90',
    textMuted: isDarkMode ? 'text-gray-400' : 'text-slate-500',
    textStrong: isDarkMode ? 'text-white' : 'text-slate-900',
    bgHover: isDarkMode ? 'hover:bg-white/10' : 'hover:bg-black/5',
    borderMuted: isDarkMode ? 'border-white/10' : 'border-slate-200',
  };

  useEffect(() => {
    document.body.style.backgroundColor = isDarkMode ? '#020617' : '#f8fafc';
  }, [isDarkMode]);

  const handleSaveSettings = () => {
    setLimit(tempLimit);
    setIsSettingsOpen(false);
  };

  useEffect(() => {
    const handleMouseMove = (e) => {
      setMousePos({ x: e.clientX, y: e.clientY });
    };
    window.addEventListener('mousemove', handleMouseMove);

    const mergePreds = () => ({ ...livePredsRef.current, ...forecastPredsRef.current });

    const patchLatestHistoryPreds = (preds) => {
      setHistory((prev) => {
        if (!prev.length) return prev;
        const last = prev[prev.length - 1];
        return [
          ...prev.slice(0, -1),
          {
            ...last,
            powerPred: preds.power ?? null,
            voltagePred: preds.voltage ?? null,
            currentPred: preds.current ?? null,
            energyPred: preds.energy ?? null,
            pfPred: preds.pf ?? null,
            frequencyPred: preds.frequency ?? null,
          },
        ];
      });
    };

    const dataRef = ref(db, 'EnergyMonitor/Live');
    const forecastRef = ref(db, 'EnergyMonitor/DigitalTwin_Forecast');

    const unsubscribeLive = onValue(dataRef, (snapshot) => {
      const val = snapshot.val();
      console.log("Firebase EnergyMonitor/Live:", val);
      if (val) {
        livePredsRef.current = parsePredictionsFromSnapshot(val);
        const preds = mergePreds();
        setPredictions(preds);
        setData({
          voltage: Number(val.voltage) || 0,
          current: Number(val.current) || 0,
          power: Number(val.power) || 0,
          energy: Number(val.energy) || 0,
          pf: Number(val.pf) || 0,
          frequency: Number(val.frequency) || 0,
        });

        latestLiveRef.current = {
          voltage: Number(val.voltage) || 0,
          current: Number(val.current) || 0,
          power: Number(val.power) || 0,
          energy: Number(val.energy) || 0,
          pf: Number(val.pf) || 0,
          frequency: Number(val.frequency) || 0,
        };

        const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

        setHistory((prev) => [
          ...prev.slice(-30),
          {
            time: timeStr,
            power: Number(val.power) || 0,
            voltage: Number(val.voltage) || 0,
            current: Number(val.current) || 0,
            energy: Number(val.energy) || 0,
            pf: Number(val.pf) || 0,
            frequency: Number(val.frequency) || 0,
            powerPred: preds.power ?? null,
            voltagePred: preds.voltage ?? null,
            currentPred: preds.current ?? null,
            energyPred: preds.energy ?? null,
            pfPred: preds.pf ?? null,
            frequencyPred: preds.frequency ?? null,
          },
        ]);

        setMetricHistory((prev) => ({
          voltage: [...prev.voltage.slice(-4), { time: timeStr, value: Number(val.voltage) || 0 }],
          current: [...prev.current.slice(-4), { time: timeStr, value: Number(val.current) || 0 }],
          power: [...prev.power.slice(-4), { time: timeStr, value: Number(val.power) || 0 }],
          energy: [...prev.energy.slice(-4), { time: timeStr, value: Number(val.energy) || 0 }],
          pf: [...(prev.pf || []).slice(-4), { time: timeStr, value: Number(val.pf) || 0 }],
          frequency: [...(prev.frequency || []).slice(-4), { time: timeStr, value: Number(val.frequency) || 0 }],
        }));
      }
    }, (error) => {
      console.error("Firebase EnergyMonitor/Live error:", error);
    });

    const unsubscribeForecast = onValue(forecastRef, (snapshot) => {
      const val = snapshot.val();
      console.log("Firebase DigitalTwin_Forecast:", val);

      const v = val || {};
      const live = latestLiveRef.current;

      const actual_P = v.actual_P != null ? Number(v.actual_P) : live.power;
      const next_P = Number(v.next_P) || 0;
      const actual_V = v.actual_V != null ? Number(v.actual_V) : live.voltage;
      const next_V = Number(v.next_V) || 0;
      const actual_I = v.actual_I != null ? Number(v.actual_I) : live.current;
      const next_I = Number(v.next_I) || 0;
      const actual_F = v.actual_F != null ? Number(v.actual_F) : live.frequency;
      const next_F = Number(v.next_F) || 0;
      const actual_PF = v.actual_PF != null ? Number(v.actual_PF) : live.pf;
      const next_PF = Number(v.next_PF) || 0;
      const actual_energy = v.actual_energy != null ? Number(v.actual_energy) : live.energy;
      const next_energy = Number(v.next_energy) || 0;

      setDtForecast({ actual_P, next_P, actual_V, next_V, actual_I, next_I, actual_F, next_F, actual_PF, next_PF, actual_energy, next_energy });

      const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      setDtHistory(prev => [...prev.slice(-30), {
        time: timeStr,
        actual_P, next_P,
        actual_V, next_V,
        actual_I, next_I,
        actual_F, next_F,
        actual_PF, next_PF,
        actual_energy, next_energy
      }]);

      forecastPredsRef.current = parseDigitalTwinForecast(val || {});
      const preds = mergePreds();
      setPredictions(preds);
      patchLatestHistoryPreds(preds);
    }, (error) => {
      console.error("Firebase DigitalTwin_Forecast error:", error);
    });

    // Add a subtle glow pulse to the background periodically
    const interval = setInterval(() => {
      document.documentElement.style.setProperty('--glow-opacity', Math.random() * 0.3 + 0.7);
    }, 2000);

    const observer = new IntersectionObserver(([entry]) => {
      setIsGraphVisible(entry.isIntersecting);
    }, { threshold: 0.1 });

    if (graphRef.current) observer.observe(graphRef.current);

    return () => {
      clearInterval(interval);
      unsubscribeLive();
      unsubscribeForecast();
      window.removeEventListener('mousemove', handleMouseMove);
      observer.disconnect();
    };
  }, []);

  const powerPercent = Math.min((data.power / limit) * 100, 100);
  const isHigh = data.power > (limit * 0.8);

  const getStatusColor = () => isHigh ? 'text-red-400 border-red-500/50 bg-red-500/10' : 'text-emerald-400 border-emerald-500/50 bg-emerald-500/10';

  const getChartColor = (metric) => {
    switch (metric) {
      case 'power': return '#60a5fa';
      case 'voltage': return '#f59e0b';
      case 'current': return '#14b8a6';
      case 'energy': return '#a855f7';
      case 'pf': return '#10b981';
      case 'frequency': return '#eab308';
      default: return '#60a5fa';
    }
  };

  /** Dynamic Y axis for power, current, energy. Fixed for voltage, frequency, pf. */
  const chartYDomain = useMemo(() => {
    if (['voltage', 'frequency', 'pf'].includes(activeChartMetric)) {
      switch (activeChartMetric) {
        case 'voltage': return [200, 260];
        case 'frequency': return [48, 52];
        case 'pf': return [0, 1];
        default: return [0, 100];
      }
    }

    // Dynamic calculation for power, current, energy
    const k = activeChartMetric;
    const actualKey = k === 'power' ? 'actual_P' :
      k === 'voltage' ? 'actual_V' :
        k === 'current' ? 'actual_I' :
          k === 'frequency' ? 'actual_F' :
            k === 'pf' ? 'actual_PF' : 'actual_energy';
    const predKeyName = k === 'power' ? 'next_P' :
      k === 'voltage' ? 'next_V' :
        k === 'current' ? 'next_I' :
          k === 'frequency' ? 'next_F' :
            k === 'pf' ? 'next_PF' : 'next_energy';
    let min = Infinity;
    let max = -Infinity;

    dtHistory.forEach((row) => {
      const a = Number(row[actualKey]);
      if (Number.isFinite(a)) {
        min = Math.min(min, a);
        max = Math.max(max, a);
      }
      const p = row[predKeyName];
      if (p != null && Number.isFinite(Number(p))) {
        const pn = Number(p);
        min = Math.min(min, pn);
        max = Math.max(max, pn);
      }
    });
    if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
    if (min === max) {
      const pad = Math.abs(min) * 0.05 + 0.01;
      return [min - pad, max + pad];
    }
    const pad = (max - min) * 0.08;
    return [min - pad, max + pad];
  }, [dtHistory, activeChartMetric]);

  const predKey = `${activeChartMetric}Pred`;
  const gradientId = `colorMetricActual-${activeChartMetric}`;

  return (
    <div className={`min-h-screen font-sans flex flex-col relative overflow-x-hidden transition-colors duration-500 ${theme.bgApp}`}>

      {/* Background with parallax/overlay */}
      <div
        className={`fixed inset-0 z-0 bg-cover bg-center transition-all duration-1000 ease-in-out pointer-events-none ${isDarkMode ? 'opacity-100' : 'opacity-30 mix-blend-multiply'}`}
        style={{
          backgroundImage: `url(${bgImage})`,
          filter: isDarkMode ? 'brightness(0.5) contrast(1.1) saturate(1.2)' : 'brightness(1.1) contrast(1) saturate(0.8)'
        }}
      />

      {/* Radial Gradient Overlay */}
      <div className={`fixed inset-0 z-0 bg-radial-gradient ${theme.radialGradient} pointer-events-none transition-colors duration-500`} />

      {/* Interactive Cursor Spotlight */}
      <div
        className="pointer-events-none fixed inset-0 z-[5] transition-opacity duration-300"
        style={{
          background: `radial-gradient(600px circle at ${mousePos.x}px ${mousePos.y}px, rgba(59, 130, 246, ${isDarkMode ? 0.12 : 0.05}), transparent 80%)`
        }}
      />

      {/* Hero / Landing Section */}
      <div className="w-full min-h-screen flex flex-col items-center justify-center relative z-20 text-center px-6">
        <FadeInSection delay={100}>
          <div className="p-5 bg-blue-500/10 rounded-2xl border border-blue-500/30 shadow-[0_0_30px_rgba(59,130,246,0.3)] mb-8 inline-block backdrop-blur-md">
            <Zap className="text-blue-400 w-16 h-16" />
          </div>
        </FadeInSection>
        <FadeInSection delay={300}>
          <h1 className={`text-6xl md:text-8xl font-serif font-bold tracking-tight mb-6 bg-clip-text text-transparent bg-gradient-to-r ${isDarkMode ? 'from-white via-blue-200 to-cyan-200' : 'from-slate-900 via-blue-700 to-cyan-600'} drop-shadow-lg`}>
            AC Energy Meter
          </h1>
        </FadeInSection>
        <FadeInSection delay={500}>
          <p className={`text-xl md:text-2xl max-w-3xl font-light leading-relaxed ${isDarkMode ? 'text-gray-300' : 'text-slate-600'} mb-12`}>
            A comprehensive IoT project capable of real-time monitoring, threshold alerts, and detailed amplitude analysis of electrical networks. Empowering smarter energy consumption.
          </p>
        </FadeInSection>

        {/* Scroll indicator */}
        <FadeInSection delay={800}>
          <div className="flex flex-col items-center animate-bounce mt-12 text-blue-400/80">
            <ChevronDown size={32} />
          </div>
        </FadeInSection>
      </div>

      {/* Main Content Container */}
      <div className="w-full max-w-6xl z-10 space-y-12 pb-24 px-6 md:px-12 mx-auto">

        {/* Header Glass Panel */}
        <FadeInSection delay={100}>
          <div className={`${theme.glassPanel} backdrop-blur-md p-6 flex flex-col md:flex-row justify-between items-center md:items-end rounded-2xl transition-colors duration-500`}>
            <div className="flex items-center space-x-4 mb-4 md:mb-0">
              <div className="p-3 bg-blue-500/10 rounded-xl border border-blue-500/30 shadow-[0_0_15px_rgba(59,130,246,0.3)]">
                <Cpu className="text-blue-400 w-8 h-8" />
              </div>
              <div>
                <h1 className={`text-4xl md:text-5xl font-serif font-light tracking-[0.2em] bg-clip-text text-transparent bg-gradient-to-r ${isDarkMode ? 'from-blue-300 to-cyan-200' : 'from-blue-600 to-cyan-500'} drop-shadow-sm`}>
                  SMARTGRID
                </h1>
                <p className={`text-[10px] font-sans uppercase tracking-[0.3em] mt-2 ${isDarkMode ? 'text-blue-200/60' : 'text-blue-800/60'}`}>
                  Advanced Power Monitoring System
                </p>
              </div>
            </div>

            <div className="flex flex-col items-end">
              <div className="flex items-center space-x-4 mb-4">
                <button onClick={() => setIsDarkMode(!isDarkMode)} className={`p-2 rounded-lg transition-colors ${theme.bgHover} ${theme.textStrong}`}>
                  {isDarkMode ? <Sun size={18} /> : <Moon size={18} />}
                </button>
                <button onClick={() => { setTempLimit(limit); setIsSettingsOpen(true); }} className={`p-2 rounded-lg transition-colors ${theme.bgHover} ${theme.textStrong}`}>
                  <Settings size={18} />
                </button>
              </div>
              <div className="flex items-center space-x-2 mb-2">
                <div className={`w-2 h-2 rounded-full animate-pulse ${isHigh ? 'bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.8)]' : 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.8)]'}`}></div>
                <span className={`text-xs font-mono uppercase ${theme.textMuted}`}>Live Connection</span>
              </div>
              <span className={`text-xs font-serif tracking-widest px-4 py-2 rounded-lg border backdrop-blur-sm transition-all duration-300 shadow-lg ${getStatusColor()}`}>
                SYSTEM STATUS: {isHigh ? 'CRITICAL LOAD DETECTED' : 'OPERATIONAL & STABLE'}
              </span>
            </div>
          </div>
        </FadeInSection>

        {/* Grid Blocks */}
        <FadeInSection delay={200}>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6 group/grid">
            {[
              { id: 'voltage', label: 'Voltage', value: data.voltage, unit: 'V', icon: <Zap size={20} />, color: 'from-blue-500/20 to-blue-600/5', border: 'border-blue-500/30', text: isDarkMode ? 'text-blue-200' : 'text-slate-900' },
              { id: 'current', label: 'Current', value: data.current, unit: 'A', icon: <Activity size={20} />, color: 'from-cyan-500/20 to-cyan-600/5', border: 'border-cyan-500/30', text: isDarkMode ? 'text-cyan-200' : 'text-slate-900' },
              { id: 'power', label: 'Power', value: data.power, unit: 'W', icon: <Zap size={20} />, color: isHigh ? 'from-red-500/20 to-orange-600/5' : 'from-indigo-500/20 to-indigo-600/5', border: isHigh ? 'border-red-500/50 shadow-[0_0_15px_rgba(239,68,68,0.3)]' : 'border-indigo-500/30', text: isHigh ? (isDarkMode ? 'text-red-300' : 'text-slate-900') : (isDarkMode ? 'text-indigo-200' : 'text-slate-900') },
              { id: 'energy', label: 'Energy', value: data.energy, unit: 'Wh', icon: <ShieldAlert size={20} />, color: 'from-purple-500/20 to-purple-600/5', border: 'border-purple-500/30', text: isDarkMode ? 'text-purple-200' : 'text-slate-900' },
              { id: 'pf', label: 'Power Factor', value: data.pf, unit: '', icon: <Activity size={20} />, color: 'from-emerald-500/20 to-emerald-600/5', border: 'border-emerald-500/30', text: isDarkMode ? 'text-emerald-200' : 'text-slate-900' },
              { id: 'frequency', label: 'Frequency', value: data.frequency, unit: 'Hz', icon: <Activity size={20} />, color: 'from-yellow-500/20 to-yellow-600/5', border: 'border-yellow-500/30', text: isDarkMode ? 'text-yellow-200' : 'text-slate-900' }
            ].map((item, idx) => (
              <div
                key={idx}
                onClick={() => setActiveBlock(activeBlock === item.id ? null : item.id)}
                className={`data-block relative overflow-hidden rounded-3xl border ${item.border} p-6 bg-gradient-to-br ${item.color} ${isDarkMode ? 'backdrop-blur-xl' : 'backdrop-blur-md bg-white/40 shadow-sm'} group/card transition-all duration-500 hover:-translate-y-2 hover:shadow-[0_15px_40px_-10px_rgba(59,130,246,0.4)] hover:border-blue-400/50 cursor-pointer group-hover/grid:opacity-[0.85] hover:!opacity-100`}
              >
                <div className={`absolute inset-0 bg-gradient-to-tr ${isDarkMode ? 'from-white/5' : 'from-black/5'} to-transparent opacity-0 group-hover/card:opacity-100 transition-opacity duration-500`}></div>
                <div className="absolute top-0 left-0 w-full h-[2px] bg-gradient-to-r from-transparent via-blue-400/60 to-transparent opacity-0 group-hover/card:opacity-100 transition-opacity duration-500"></div>

                <div className="flex justify-between items-start mb-6 relative z-10">
                  <span className={`text-[11px] font-bold tracking-[0.2em] uppercase transition-colors ${theme.textMuted} group-hover/card:${theme.textStrong}`}>{item.label}</span>
                  <div className={`p-2 rounded-xl ${isDarkMode ? 'bg-black/20 text-white/70' : 'bg-black/5 text-slate-800'} group-hover/card:${item.text} transition-all duration-500 group-hover/card:scale-110 group-hover/card:bg-white/5 group-hover/card:shadow-[0_0_15px_rgba(59,130,246,0.2)] border border-white/5`}>
                    {item.icon}
                  </div>
                </div>

                <div className="relative z-10 flex items-baseline">
                  <span className={`text-5xl font-serif font-light tracking-wider drop-shadow-sm ${theme.textStrong}`}>
                    {item.value}
                  </span>
                  <span className={`text-sm tracking-widest ml-2 font-medium ${item.text} opacity-80`}>
                    {item.unit}
                  </span>
                </div>

                {/* Expandable: predicted value (prominent) + recent history */}
                <div className={`transition-all duration-500 ease-in-out relative z-10 overflow-hidden ${activeBlock === item.id ? 'max-h-72 mt-6 opacity-100' : 'max-h-0 opacity-0'}`}>
                  <div className={`border-t ${theme.borderMuted} pt-4`}>
                    <p className={`text-[10px] uppercase tracking-widest mb-2 font-bold ${theme.textMuted}`}>
                      {item.id === 'power' ? 'Predicted load' : 'Prediction'}
                    </p>
                    <div className={`rounded-lg px-3 py-2 mb-4 ${isDarkMode ? 'bg-white/5' : 'bg-slate-100/80'}`}>
                      {(() => {
                        const { pred, actual } = getForecastData(item.id);
                        if (pred != null && Number.isFinite(pred)) {
                          return (
                            <div className="flex items-center justify-between gap-2">
                              <div className="flex items-baseline">
                                <span className={`text-2xl sm:text-3xl font-bold font-serif tracking-tight ${theme.textStrong}`}>
                                  {pred}
                                </span>
                                <span className={`text-sm font-semibold tracking-widest ${item.text} opacity-90 ml-1`}>{item.unit}</span>
                              </div>
                              <div>
                                {pred > actual ? (
                                  <span className="px-2 py-1 rounded-md text-[9px] font-bold uppercase tracking-wider bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">Rising</span>
                                ) : pred < actual ? (
                                  <span className="px-2 py-1 rounded-md text-[9px] font-bold uppercase tracking-wider bg-orange-500/20 text-orange-400 border border-orange-500/30">Falling</span>
                                ) : (
                                  <span className="px-2 py-1 rounded-md text-[9px] font-bold uppercase tracking-wider bg-blue-500/20 text-blue-400 border border-blue-500/30">Stable</span>
                                )}
                              </div>
                            </div>
                          );
                        } else {
                          return (
                            <p className={`text-sm italic ${theme.textMuted}`}>
                              {item.id === 'power'
                                ? 'No predicted load yet'
                                : 'No prediction in Firebase payload yet'}
                            </p>
                          );
                        }
                      })()}
                    </div>
                    <div className={`border-t ${theme.borderMuted} pt-3`}>
                      <p className={`text-[10px] uppercase tracking-widest mb-2 font-bold ${theme.textMuted}`}>Recent History</p>
                      <div className="space-y-1">
                        {metricHistory[item.id]?.map((hist, i) => (
                          <div key={i} className={`flex justify-between text-xs items-center p-1 rounded ${theme.bgHover} transition-colors`}>
                            <span className={`font-mono text-[10px] ${theme.textMuted}`}>{hist.time}</span>
                            <span className={`font-semibold ${theme.textStrong}`}>{hist.value} <span className="text-[10px] opacity-70">{item.unit}</span></span>
                          </div>
                        ))}
                        {(!metricHistory[item.id] || metricHistory[item.id].length === 0) && (
                          <div className={`text-xs italic ${theme.textMuted}`}>Waiting for data...</div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>

              </div>
            ))}
          </div>
        </FadeInSection>

        {/* Dynamic Consumption Bar */}
        <FadeInSection delay={200}>
          <div className={`${theme.glassPanel} p-6 rounded-2xl backdrop-blur-md relative overflow-hidden transition-colors duration-500`}>
            <div className="absolute -right-20 -top-20 w-40 h-40 bg-blue-500/10 rounded-full blur-3xl pointer-events-none"></div>

            <div className="flex justify-between items-end mb-4">
              <div>
                <h3 className="text-xs font-bold uppercase tracking-widest text-blue-300">Network Load Indicator</h3>
                <p className="text-[10px] text-gray-400 mt-1 uppercase tracking-wider">Capacity: {limit}W</p>
              </div>
              <div className="text-right">
                <span className={`text-xl font-light ${theme.textStrong}`}>{((data.power / limit) * 100).toFixed(1)}%</span>
                <span className={`text-[10px] ml-1 uppercase ${theme.textMuted}`}>Allocated</span>
              </div>
            </div>

            <div className="w-full h-4 bg-black/40 rounded-full border border-white/10 overflow-hidden relative shadow-inner">
              <div
                className={`h-full rounded-full transition-all duration-700 ease-out relative ${isHigh ? 'bg-gradient-to-r from-orange-500 to-red-600 shadow-[0_0_15px_rgba(239,68,68,0.8)]' : 'bg-gradient-to-r from-cyan-400 to-blue-500 shadow-[0_0_15px_rgba(59,130,246,0.6)]'}`}
                style={{ width: `${powerPercent}%` }}
              >
                {/* Animated shimmer effect on the bar */}
                <div className="absolute top-0 inset-x-0 h-full bg-gradient-to-r from-transparent via-white/30 to-transparent -translate-x-full animate-[shimmer_2s_infinite]"></div>
              </div>
            </div>
          </div>
        </FadeInSection>

        {/* Advanced Graph Section */}
        <FadeInSection delay={300}>
          <div ref={graphRef} className={`${theme.glassPanel} p-6 rounded-2xl backdrop-blur-md relative transition-colors duration-500`}>
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-6 space-y-4 md:space-y-0">
              <h3 className={`text-xs font-bold uppercase tracking-widest flex items-center ${isDarkMode ? 'text-blue-300' : 'text-blue-600'}`}>
                <Activity size={14} className="mr-2" />
                Telemetry Amplitude Analysis
              </h3>

              {/* Chart Metric Toggles */}
              <div className={`flex flex-wrap gap-1 p-1 rounded-lg ${isDarkMode ? 'bg-black/30' : 'bg-slate-200/50'}`}>
                {['power', 'voltage', 'current', 'energy', 'pf', 'frequency'].map((metric) => (
                  <button
                    key={metric}
                    onClick={() => setActiveChartMetric(metric)}
                    className={`px-3 py-1 text-[10px] font-bold uppercase tracking-widest rounded-md transition-all ${activeChartMetric === metric ? (isDarkMode ? 'bg-blue-500/20 text-blue-300' : 'bg-blue-500/20 text-blue-700') : (isDarkMode ? 'text-gray-500 hover:text-gray-300' : 'text-slate-500 hover:text-slate-700')}`}
                  >
                    {metric}
                  </button>
                ))}
              </div>
            </div>

            <div className="h-[320px] w-full mt-4">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={dtHistory} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                  <defs>
                    <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={getChartColor(activeChartMetric)} stopOpacity={0.6} />
                      <stop offset="95%" stopColor={getChartColor(activeChartMetric)} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={isDarkMode ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.05)"} />
                  <XAxis dataKey="time" fontSize={11} tickMargin={12} stroke={isDarkMode ? "rgba(255,255,255,0.3)" : "rgba(0,0,0,0.3)"} tick={{ fill: isDarkMode ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.5)' }} />
                  <YAxis
                    fontSize={11}
                    stroke={isDarkMode ? "rgba(255,255,255,0.3)" : "rgba(0,0,0,0.3)"}
                    tick={{ fill: isDarkMode ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.5)' }}
                    domain={chartYDomain}
                    allowDataOverflow
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: isDarkMode ? 'rgba(15, 23, 42, 0.8)' : 'rgba(255, 255, 255, 0.9)',
                      color: isDarkMode ? 'white' : '#1e293b',
                      border: isDarkMode ? '1px solid rgba(255,255,255,0.1)' : '1px solid rgba(0,0,0,0.1)',
                      borderRadius: '8px',
                      fontSize: '12px',
                      backdropFilter: 'blur(8px)',
                      boxShadow: '0 4px 15px rgba(0,0,0,0.1)'
                    }}
                  />
                  <Legend
                    wrapperStyle={{ fontSize: 11, paddingTop: 8 }}
                    formatter={(value, entry) => <span style={{ color: entry.color }}>{value}</span>}
                  />
                  <Area
                    name={`Actual ${activeChartMetric.charAt(0).toUpperCase() + activeChartMetric.slice(1)}`}
                    type="monotone"
                    dataKey={
                      activeChartMetric === 'power' ? 'actual_P' :
                        activeChartMetric === 'voltage' ? 'actual_V' :
                          activeChartMetric === 'current' ? 'actual_I' :
                            activeChartMetric === 'frequency' ? 'actual_F' :
                              activeChartMetric === 'pf' ? 'actual_PF' : 'actual_energy'
                    }
                    stroke={getChartColor(activeChartMetric)}
                    strokeWidth={3}
                    fillOpacity={1}
                    fill={`url(#${gradientId})`}
                    animationDuration={300}
                    activeDot={{ r: 6, fill: getChartColor(activeChartMetric), stroke: isDarkMode ? '#fff' : '#020617', strokeWidth: 2 }}
                  />
                  <Line
                    name="Predicted"
                    type="monotone"
                    dataKey={
                      activeChartMetric === 'power' ? 'next_P' :
                        activeChartMetric === 'voltage' ? 'next_V' :
                          activeChartMetric === 'current' ? 'next_I' :
                            activeChartMetric === 'frequency' ? 'next_F' :
                              activeChartMetric === 'pf' ? 'next_PF' : 'next_energy'
                    }
                    stroke={'#ff1493'}
                    strokeWidth={2}
                    strokeDasharray={"5 5"}
                    dot={false}
                    connectNulls
                    isAnimationActive={false}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </div>
        </FadeInSection>

      </div>

      {/* (Modal removed as requested) */}

      {/* Settings Modal */}
      {isSettingsOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setIsSettingsOpen(false)}></div>
          <div className={`relative ${theme.glassModal} backdrop-blur-xl p-8 rounded-2xl w-full max-w-sm animate-fade-in-up transition-colors duration-500`}>
            <button onClick={() => setIsSettingsOpen(false)} className={`absolute top-4 right-4 ${theme.textMuted} hover:${theme.textStrong}`}>
              <X size={20} />
            </button>
            <h2 className={`text-xl font-serif font-bold mb-6 ${theme.textStrong}`}>System Settings</h2>

            <div className="space-y-4">
              <div>
                <label className={`block text-xs font-bold uppercase tracking-widest mb-2 ${theme.textMuted}`}>Power Limit (Watts)</label>
                <input
                  type="number"
                  value={tempLimit}
                  onChange={(e) => setTempLimit(Number(e.target.value))}
                  className={`w-full px-4 py-3 rounded-xl border ${theme.borderMuted} bg-transparent ${theme.textStrong} focus:outline-none focus:border-blue-500 transition-colors`}
                />
                <p className={`text-[10px] mt-2 ${theme.textMuted}`}>Triggers 'CRITICAL LOAD' alert when consumption reaches 80% of this limit.</p>
              </div>
            </div>

            <div className="mt-8 flex justify-end space-x-3">
              <button onClick={() => setIsSettingsOpen(false)} className={`px-4 py-2 rounded-lg text-sm font-bold ${theme.textMuted} hover:${theme.textStrong} transition-colors`}>
                Cancel
              </button>
              <button onClick={handleSaveSettings} className="px-6 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm font-bold shadow-lg shadow-blue-500/30 transition-all">
                Save Changes
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Floating Status Pop-up */}
      <div className={`fixed bottom-6 right-6 p-4 rounded-xl border backdrop-blur-md shadow-2xl transition-all duration-1000 ease-in-out z-50 transform flex items-center space-x-4 ${isGraphVisible ? 'opacity-100 translate-y-0 translate-x-0' : 'opacity-0 translate-y-10 translate-x-10 pointer-events-none'} ${isDarkMode ? (isHigh ? 'bg-red-500/20 border-red-500/50 text-red-100' : 'bg-emerald-500/20 border-emerald-500/50 text-emerald-100') : (isHigh ? 'bg-red-100/90 border-red-300 text-red-900 shadow-[0_4px_20px_rgba(239,68,68,0.2)]' : 'bg-emerald-100/90 border-emerald-300 text-emerald-900 shadow-[0_4px_20px_rgba(16,185,129,0.2)]')}`}>
        <div className={`p-2 rounded-full ${isDarkMode ? (isHigh ? 'bg-red-500/20' : 'bg-emerald-500/20') : (isHigh ? 'bg-red-200/50' : 'bg-emerald-200/50')}`}>
          {isHigh ? <ShieldAlert size={24} className={`animate-pulse ${isDarkMode ? 'text-red-400' : 'text-red-600'}`} /> : <Activity size={24} className={`${isDarkMode ? 'text-emerald-400' : 'text-emerald-700'}`} />}
        </div>
        <div>
          <p className="font-serif font-bold text-sm tracking-widest uppercase">
            {isHigh ? "High Load Alert" : "Optimal"}
          </p>
          <p className="font-sans text-xs opacity-80 mt-1">
            {isHigh
              ? "Watch out for higher consumption!"
              : "Doing good! Consumption is low."}
          </p>
        </div>
      </div>

    </div>
  );
};

export default App;