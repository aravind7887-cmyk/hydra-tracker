import { useState, useEffect } from 'react';
import StatsTab from './StatsTab.jsx';

// ── Constants ──────────────────────────────────────────────────────────────────
const DEFAULT_WEIGHT_KG = 82;
const AGE = 38;
const QUICK_AMOUNTS = [150, 250, 350, 500, 750];
const STRAVA_API = 'https://www.strava.com/api/v3';
const TODAY_KEY = new Date().toDateString();

const WEATHER_OPTIONS = [
  { value: 'cool',     label: '❄️ Cool',     adj: -100 },
  { value: 'moderate', label: '🌤 Moderate', adj: 0    },
  { value: 'warm',     label: '☀️ Warm',     adj: 200  },
  { value: 'hot',      label: '🌡 Hot',      adj: 500  },
];

// ── Weight helpers ─────────────────────────────────────────────────────────────
function getEffectiveWeight(weightLog) {
  const todayEntry = weightLog[TODAY_KEY];
  if (todayEntry) return todayEntry;

  // Collect entries from the past 7 days (excluding today)
  const entries = [];
  for (let i = 1; i <= 7; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const val = weightLog[d.toDateString()];
    if (val) entries.push(val);
  }
  if (entries.length > 0) {
    return Math.round((entries.reduce((s, v) => s + v, 0) / entries.length) * 10) / 10;
  }
  return DEFAULT_WEIGHT_KG;
}

// ── Goal calculation ───────────────────────────────────────────────────────────
function calcGoal(weight, totalActivitySecs, weatherValue, hevyMins, healthifyCalories) {
  const base       = Math.round(weight * 35);
  const ageAdj     = 100;                                                           // age 38
  const stravaAdj  = Math.floor(totalActivitySecs / 1800) * 500;                   // +500ml / 30min cardio
  const hevyAdj    = Math.floor(hevyMins / 30) * 300;                              // +300ml / 30min lifting
  const weatherAdj = WEATHER_OPTIONS.find(w => w.value === weatherValue)?.adj ?? 0;
  const calAdj     = Math.round(healthifyCalories * 0.5);                          // ~0.5ml per kcal
  return base + ageAdj + stravaAdj + hevyAdj + weatherAdj + calAdj;
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function fmtTime(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function fmtDuration(secs) {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
function fmtDist(m) { return (m / 1000).toFixed(2) + ' km'; }

// dateKey: extract YYYY-MM-DD from a Strava start_date_local string
function dateKey(iso) { return iso.slice(0, 10); }

// ── Water Vessel ───────────────────────────────────────────────────────────────
function WaterVessel({ pct, consumed, goal }) {
  const clamped = Math.min(100, Math.max(0, pct));
  return (
    <div className="vessel-wrap">
      <div className="vessel">
        <div className="vessel-water" style={{ height: `${clamped}%` }}>
          <div className="vessel-wave" />
          <div className="vessel-wave vessel-wave-2" />
        </div>
        <div className="vessel-text">
          <div className="vessel-pct">{Math.round(clamped)}%</div>
          <div className="vessel-sub">{consumed.toLocaleString()} / {goal.toLocaleString()} ml</div>
        </div>
      </div>
    </div>
  );
}

// ── Single activity card ───────────────────────────────────────────────────────
function ActivityCard({ act }) {
  return (
    <div className="activity-card">
      <div className="activity-badge">{act.type}</div>
      <div className="activity-name">{act.name}</div>
      <div className="activity-stats">
        <div className="stat-box">
          <span className="stat-val">{fmtDist(act.distance)}</span>
          <span className="stat-lbl">Distance</span>
        </div>
        <div className="stat-box">
          <span className="stat-val">{fmtDuration(act.moving_time)}</span>
          <span className="stat-lbl">Duration</span>
        </div>
        {act.average_heartrate && (
          <div className="stat-box">
            <span className="stat-val">{Math.round(act.average_heartrate)} bpm</span>
            <span className="stat-lbl">Avg Heart Rate</span>
          </div>
        )}
        {act.total_elevation_gain > 0 && (
          <div className="stat-box">
            <span className="stat-val">{act.total_elevation_gain}m</span>
            <span className="stat-lbl">Elevation</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main App ───────────────────────────────────────────────────────────────────
export default function App() {
  const [tab, setTab] = useState('track');

  // Hydration log
  const [log, setLog] = useState([]);
  const [customMl, setCustomMl] = useState('');

  // All-time hydration history — { [dateString]: { entries, goal } }
  const [hydraHistory, setHydraHistory] = useState({});

  // Weight log — { [dateString]: kg }
  const [weightLog, setWeightLog] = useState({});
  const [weightInput, setWeightInput] = useState('');

  // Goal factors
  const [weather, setWeather] = useState('moderate');
  const [hevyMins, setHevyMins] = useState('');
  const [healthifyCalories, setHealthifyCalories] = useState('');

  // Hevy CSV data
  const [hevyData, setHevyData] = useState(null); // { date, workouts, totalMins }

  // Strava — array of all activities for the relevant day
  const [stravaActivities, setStravaActivities] = useState([]);
  const [stravaActivityDate, setStravaActivityDate] = useState(null); // 'today' | date string | null
  const [stravaConnected, setStravaConnected] = useState(false);
  const [stravaLoading, setStravaLoading] = useState(false);
  const [stravaError, setStravaError] = useState(null);

  // DB ready flag
  const [dbReady, setDbReady] = useState(false);

  // AI Plan
  const [aiPlan, setAiPlan] = useState('');
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState(null);

  // ── Derived values ────────────────────────────────────────────────────────
  const hevyNum         = parseInt(hevyMins, 10) || 0;
  const calNum          = parseInt(healthifyCalories, 10) || 0;
  const totalStravaSecs = stravaActivities.reduce((s, a) => s + a.moving_time, 0);
  const effectiveWeight = getEffectiveWeight(weightLog);
  const isWeightAvg     = !weightLog[TODAY_KEY];
  const goal            = calcGoal(effectiveWeight, totalStravaSecs, weather, hevyNum, calNum);
  const consumed        = log.reduce((s, e) => s + e.ml, 0);
  const pct             = goal > 0 ? (consumed / goal) * 100 : 0;
  const weatherAdj      = WEATHER_OPTIONS.find(w => w.value === weather)?.adj ?? 0;

  // ── Init: migrate localStorage → DB, load from DB, then OAuth/Strava/Hevy ──
  useEffect(() => {
    async function init() {
      // 1. One-time migration from localStorage
      const lsHistory = localStorage.getItem('hydra-history');
      const lsWeight  = localStorage.getItem('hydra-weight-log');
      if (lsHistory || lsWeight) {
        try {
          await fetch('/api/hydra/migrate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              hydraHistory: lsHistory ? JSON.parse(lsHistory) : {},
              weightLog:    lsWeight  ? JSON.parse(lsWeight)  : {},
            }),
          });
          localStorage.removeItem('hydra-history');
          localStorage.removeItem('hydra-weight-log');
          localStorage.removeItem('hydra-log');
        } catch { /* keep localStorage intact, retry next load */ }
      }

      // 2. Load from DB
      try {
        const [histRes, weightRes] = await Promise.all([
          fetch('/api/hydra/history'),
          fetch('/api/hydra/weights'),
        ]);
        const history = await histRes.json();
        const weights = await weightRes.json();
        setHydraHistory(history);
        setWeightLog(weights);
        if (history[TODAY_KEY]?.entries) setLog(history[TODAY_KEY].entries);
        if (weights[TODAY_KEY]) setWeightInput(String(weights[TODAY_KEY]));
      } catch { /* silent */ }

      setDbReady(true);

      // 3. OAuth + Strava + Hevy
      const params = new URLSearchParams(window.location.search);
      if (params.get('connected') === 'true') window.history.replaceState({}, '', '/');
      tryFetchStrava();
      fetchHevyData();
    }
    init();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Sync goal to DB whenever it changes (after init) ─────────────────────
  useEffect(() => {
    if (!dbReady) return;
    fetch('/api/hydra/goal', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date_key: TODAY_KEY, goal }),
    }).catch(() => {});
  }, [goal, dbReady]);

  // ── Hevy fetch ────────────────────────────────────────────────────────────
  async function fetchHevyData() {
    try {
      const res = await fetch('/api/hevy');
      if (!res.ok) return;
      const data = await res.json();
      if (data.totalMins > 0) {
        setHevyData(data);
        // Pre-populate only if the user hasn't typed anything yet
        setHevyMins(prev => prev === '' ? String(data.totalMins) : prev);
      }
    } catch { /* silent — file may not exist */ }
  }

  // ── Strava fetch ──────────────────────────────────────────────────────────
  async function tryFetchStrava() {
    setStravaLoading(true);
    setStravaError(null);
    try {
      const tokenRes = await fetch('/api/token');
      if (tokenRes.status === 401) { setStravaConnected(false); return; }
      if (!tokenRes.ok) throw new Error('Token error');
      const { access_token } = await tokenRes.json();
      setStravaConnected(true);

      const headers = { Authorization: `Bearer ${access_token}` };

      // 1. Try today's activities (all of them)
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      const after = Math.floor(startOfDay.getTime() / 1000);

      const todayRes = await fetch(
        `${STRAVA_API}/athlete/activities?after=${after}&per_page=20`,
        { headers }
      );
      if (!todayRes.ok) throw new Error(`Strava API error ${todayRes.status}`);
      const todayActs = await todayRes.json();

      if (todayActs.length > 0) {
        setStravaActivities(todayActs);
        setStravaActivityDate('today');
        return;
      }

      // 2. No activities today — find the most recent day with at least one activity
      //    and collect ALL activities from that day.
      const recentRes = await fetch(
        `${STRAVA_API}/athlete/activities?per_page=20`,
        { headers }
      );
      if (!recentRes.ok) throw new Error(`Strava API error ${recentRes.status}`);
      const recentActs = await recentRes.json();

      if (recentActs.length === 0) {
        setStravaActivities([]);
        setStravaActivityDate(null);
        return;
      }

      // Group by calendar day, pick the most recent day
      const mostRecentDay = dateKey(recentActs[0].start_date_local);
      const dayActivities = recentActs.filter(
        a => dateKey(a.start_date_local) === mostRecentDay
      );

      setStravaActivities(dayActivities);
      setStravaActivityDate(
        new Date(recentActs[0].start_date_local).toLocaleDateString([], {
          weekday: 'short', month: 'short', day: 'numeric',
        })
      );
    } catch (err) {
      setStravaError(err.message);
    } finally {
      setStravaLoading(false);
    }
  }

  async function saveWeight() {
    const val = parseFloat(weightInput);
    if (!val || val <= 0) return;
    await fetch('/api/hydra/weight', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date_key: TODAY_KEY, weight_kg: val }),
    }).catch(() => {});
    setWeightLog(prev => ({ ...prev, [TODAY_KEY]: val }));
  }

  async function addWater(ml) {
    const amount = parseInt(ml, 10);
    if (!amount || amount <= 0) return;
    const entry = { ml: amount, time: new Date().toISOString() };
    try {
      const res = await fetch('/api/hydra/water', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date_key: TODAY_KEY, ...entry, goal }),
      });
      const { id } = await res.json();
      const newEntry = { ...entry, id };
      setLog(prev => [...prev, newEntry]);
      setHydraHistory(prev => {
        const today = prev[TODAY_KEY] ?? { entries: [], goal };
        return { ...prev, [TODAY_KEY]: { entries: [...today.entries, newEntry], goal } };
      });
    } catch { /* silent */ }
    setCustomMl('');
  }

  async function removeEntry(entryId) {
    await fetch(`/api/hydra/water/${entryId}`, { method: 'DELETE' }).catch(() => {});
    setLog(prev => prev.filter(e => e.id !== entryId));
    setHydraHistory(prev => {
      const today = prev[TODAY_KEY];
      if (!today) return prev;
      return { ...prev, [TODAY_KEY]: { ...today, entries: today.entries.filter(e => e.id !== entryId) } };
    });
  }

  // ── AI Plan ───────────────────────────────────────────────────────────────
  async function fetchAiPlan() {
    setAiLoading(true);
    setAiError(null);
    try {
      const res = await fetch('/api/ai-plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          weight: effectiveWeight,
          age: AGE,
          consumed,
          goal,
          weather,
          stravaDate: stravaActivityDate,
          stravaActivities: stravaActivities.map(a => ({
            name: a.name,
            type: a.type,
            distance: a.distance,
            movingTime: a.moving_time,
            avgHeartRate: a.average_heartrate ?? null,
            elevationGain: a.total_elevation_gain ?? 0,
          })),
          hevyMins: hevyNum,
          healthifyCalories: calNum,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'AI plan request failed');
      }
      const data = await res.json();
      setAiPlan(data.plan);
    } catch (err) {
      setAiError(err.message);
    } finally {
      setAiLoading(false);
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="app">
      <div className="screen">

        {/* ── TRACK TAB ──────────────────────────────────────────────────── */}
        {tab === 'track' && (
          <div className="tab-content">
            <header className="app-header">
              <h1 className="logo">HYDRA</h1>
              <p className="header-date">
                {new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}
              </p>
            </header>

            <WaterVessel pct={pct} consumed={consumed} goal={goal} />

            {consumed >= goal && goal > 0 && (
              <div className="goal-badge">🎯 Daily goal reached!</div>
            )}

            <div className="quick-btns">
              {QUICK_AMOUNTS.map(ml => (
                <button key={ml} className="quick-btn" onClick={() => addWater(ml)}>
                  +{ml}ml
                </button>
              ))}
            </div>

            <div className="custom-row">
              <input
                type="number"
                className="custom-input"
                placeholder="Custom amount (ml)"
                value={customMl}
                min="1"
                onChange={e => setCustomMl(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && addWater(customMl)}
              />
              <button
                className="add-btn"
                onClick={() => addWater(customMl)}
                disabled={!customMl || parseInt(customMl, 10) <= 0}
              >
                Add
              </button>
            </div>
          </div>
        )}

        {/* ── STRAVA TAB ─────────────────────────────────────────────────── */}
        {tab === 'strava' && (
          <div className="tab-content">
            <h2 className="tab-title">Strava Activity</h2>

            {!stravaConnected ? (
              <div className="connect-box">
                <div className="connect-icon">🏃</div>
                <p>Connect Strava to factor your workouts into your personalised hydration goal.</p>
                <a href="/auth/start" className="strava-btn">Connect with Strava</a>
              </div>
            ) : (
              <>
                {stravaLoading && <p className="info-text">Fetching activities…</p>}
                {stravaError   && <p className="error-text">{stravaError}</p>}

                {!stravaLoading && stravaActivities.length > 0 && (
                  <>
                    {/* Date context banner when using a previous day */}
                    {stravaActivityDate !== 'today' && stravaActivityDate && (
                      <div className="strava-date-banner">
                        📅 No activity today — using {stravaActivityDate}
                      </div>
                    )}

                    {/* One card per activity */}
                    {stravaActivities.map(act => (
                      <ActivityCard key={act.id} act={act} />
                    ))}

                    {/* Totals row when multiple activities */}
                    {stravaActivities.length > 1 && (
                      <div className="strava-totals">
                        <span>{stravaActivities.length} activities</span>
                        <span>
                          {fmtDist(stravaActivities.reduce((s, a) => s + a.distance, 0))} &nbsp;·&nbsp;
                          {fmtDuration(totalStravaSecs)} total
                        </span>
                      </div>
                    )}

                    <div className="hydration-impact" style={{ marginTop: '0.75rem' }}>
                      {stravaActivityDate === 'today'
                        ? `Adds +${Math.floor(totalStravaSecs / 1800) * 500}ml to your daily goal`
                        : `Based on ${stravaActivityDate} — adds +${Math.floor(totalStravaSecs / 1800) * 500}ml to your goal`}
                    </div>
                  </>
                )}

                {!stravaLoading && stravaActivities.length === 0 && !stravaError && (
                  <p className="info-text">No Strava activities found.</p>
                )}

                <button className="refresh-btn" onClick={tryFetchStrava} disabled={stravaLoading}
                  style={{ marginTop: '1rem' }}>
                  {stravaLoading ? 'Refreshing…' : '↻ Refresh'}
                </button>
              </>
            )}
          </div>
        )}

        {/* ── DATA TAB ───────────────────────────────────────────────────── */}
        {tab === 'data' && (
          <div className="tab-content">
            <h2 className="tab-title">Today's Data</h2>

            {/* Goal breakdown */}
            <div className="card">
              <h3 className="card-title">Goal Breakdown</h3>
              <div className="bd-row">
                <span>
                  Base ({effectiveWeight} kg × 35 ml/kg
                  {isWeightAvg ? ', 7-day avg' : ''})
                </span>
                <span>{Math.round(effectiveWeight * 35).toLocaleString()}ml</span>
              </div>
              <div className="bd-row">
                <span>Age factor (38 yrs)</span>
                <span>+100ml</span>
              </div>
              {stravaActivities.length > 0 && (
                <div className="bd-row accent">
                  <span>
                    Strava — {stravaActivities.length > 1
                      ? `${stravaActivities.length} activities, ${fmtDuration(totalStravaSecs)}`
                      : `${fmtDuration(totalStravaSecs)} ${stravaActivities[0].type}`}
                    {stravaActivityDate !== 'today' && stravaActivityDate ? ` (${stravaActivityDate})` : ''}
                  </span>
                  <span>+{Math.floor(totalStravaSecs / 1800) * 500}ml</span>
                </div>
              )}
              {hevyNum > 0 && (
                <div className="bd-row accent">
                  <span>Hevy — {hevyNum}min lifting</span>
                  <span>+{Math.floor(hevyNum / 30) * 300}ml</span>
                </div>
              )}
              {calNum > 0 && (
                <div className="bd-row accent">
                  <span>Healthify — {calNum} kcal</span>
                  <span>+{Math.round(calNum * 0.5)}ml</span>
                </div>
              )}
              {weatherAdj !== 0 && (
                <div className="bd-row accent">
                  <span>Weather ({weather})</span>
                  <span>{weatherAdj > 0 ? '+' : ''}{weatherAdj}ml</span>
                </div>
              )}
              <div className="bd-row bd-total">
                <span>Daily Goal</span>
                <span>{goal.toLocaleString()}ml</span>
              </div>
            </div>

            {/* Weight input */}
            <div className="card">
              <h3 className="card-title">Today's Weight</h3>
              <div className="bd-row" style={{ marginBottom: '0.5rem' }}>
                <span style={{ opacity: 0.7 }}>
                  {isWeightAvg
                    ? `Using 7-day avg (${effectiveWeight} kg)`
                    : `Today: ${effectiveWeight} kg`}
                </span>
              </div>
              <div className="custom-row">
                <input
                  type="number"
                  className="custom-input"
                  placeholder="Enter weight (kg)"
                  value={weightInput}
                  step="0.1"
                  min="1"
                  onChange={e => setWeightInput(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && saveWeight()}
                />
                <button
                  className="add-btn"
                  onClick={saveWeight}
                  disabled={!weightInput || parseFloat(weightInput) <= 0}
                >
                  Save
                </button>
              </div>
            </div>

            {/* Manual inputs */}
            <div className="card">
              <h3 className="card-title">Manual Inputs</h3>

              <label className="field-label">Weather Conditions</label>
              <div className="weather-row">
                {WEATHER_OPTIONS.map(w => (
                  <button
                    key={w.value}
                    className={`weather-chip ${weather === w.value ? 'active' : ''}`}
                    onClick={() => setWeather(w.value)}
                  >
                    {w.label}
                  </button>
                ))}
              </div>

              <label className="field-label">Hevy — Lifting duration (min)</label>
              {hevyData && (
                <div className="source-banner">
                  📂 {hevyData.date === 'today' ? 'Today' : hevyData.date} — {hevyData.workouts.map(w => `${w.title} (${w.durationMins}min)`).join(', ')}
                </div>
              )}
              <input
                type="number"
                className="field-input"
                value={hevyMins}
                onChange={e => setHevyMins(e.target.value)}
                placeholder="e.g. 60"
                min="0"
              />

              <label className="field-label">Healthify — Active calories burned</label>
              <input
                type="number"
                className="field-input"
                value={healthifyCalories}
                onChange={e => setHealthifyCalories(e.target.value)}
                placeholder="e.g. 400"
                min="0"
              />
            </div>

            {/* Intake log */}
            <div className="card">
              <h3 className="card-title">Intake Log</h3>
              {log.length === 0 ? (
                <p className="empty-text">No entries yet — start tracking!</p>
              ) : (
                <>
                  {[...log].reverse().map((entry, i) => (
                    <div key={entry.id ?? i} className="log-row">
                      <span className="log-time">{fmtTime(entry.time)}</span>
                      <span className="log-ml">+{entry.ml}ml</span>
                      <button
                        className="log-del"
                        onClick={() => removeEntry(entry.id)}
                        title="Remove"
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                  <div className="log-total-row">
                    <span>Total consumed</span>
                    <span>{consumed.toLocaleString()}ml</span>
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        {/* ── STATS TAB ──────────────────────────────────────────────────── */}
        {tab === 'stats' && <StatsTab history={hydraHistory} todayGoal={goal} />}

        {/* ── AI PLAN TAB ────────────────────────────────────────────────── */}
        {tab === 'ai' && (
          <div className="tab-content">
            <h2 className="tab-title">AI Hydration Plan</h2>

            <div className="ai-summary-card">
              {[
                ['Weight',     `${effectiveWeight} kg${isWeightAvg ? ' (avg)' : ''}`],
                ['Age',        AGE],
                ['Consumed',   `${consumed.toLocaleString()}ml`],
                ['Goal',       `${goal.toLocaleString()}ml`],
                ['Progress',   `${Math.round(pct)}%`],
                ['Weather',    weather],
                ['Strava',     stravaActivities.length > 0
                  ? `${stravaActivities.length} activity${stravaActivities.length > 1 ? 's' : ''}`
                  : 'None'],
                ['Hevy',       hevyNum > 0 ? `${hevyNum}min` : 'None'],
                ['Healthify',  calNum > 0 ? `${calNum} kcal` : 'None'],
                ['Remaining',  `${Math.max(0, goal - consumed).toLocaleString()}ml`],
              ].map(([k, v]) => (
                <div key={k} className="ai-kv">
                  <span className="ai-k">{k}</span>
                  <span className="ai-v">{v}</span>
                </div>
              ))}
            </div>

            <button className="ai-gen-btn" onClick={fetchAiPlan} disabled={aiLoading}>
              {aiLoading ? '⏳ Generating…' : '✨ Generate AI Hydration Plan'}
            </button>

            {aiError && <p className="error-text">{aiError}</p>}

            {aiPlan && (
              <div className="ai-plan-card">
                {aiPlan.split('\n').filter(l => l.trim()).map((line, i) => {
                  if (line.startsWith('### ')) return <h4 key={i} className="plan-h3">{line.slice(4)}</h4>;
                  if (line.startsWith('## '))  return <h3 key={i} className="plan-h2">{line.slice(3)}</h3>;
                  if (line.startsWith('# '))   return <h2 key={i} className="plan-h1">{line.slice(2)}</h2>;
                  if (line.startsWith('- ') || line.startsWith('• '))
                                                return <li key={i} className="plan-li">{line.slice(2)}</li>;
                  if (/^\d+\./.test(line))      return <li key={i} className="plan-li plan-ol">{line.replace(/^\d+\.\s*/, '')}</li>;
                  return <p key={i} className="plan-p">{line}</p>;
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── BOTTOM NAV ───────────────────────────────────────────────────── */}
      <nav className="bottom-nav">
        {[
          { id: 'track',  label: 'Track',   icon: '💧' },
          { id: 'strava', label: 'Strava',  icon: '🏃' },
          { id: 'data',   label: 'Data',    icon: '📊' },
          { id: 'ai',     label: 'AI Plan', icon: '🧠' },
          { id: 'stats',  label: 'Stats',   icon: '📈' },
        ].map(({ id, label, icon }) => (
          <button
            key={id}
            className={`nav-tab ${tab === id ? 'active' : ''}`}
            onClick={() => setTab(id)}
          >
            <span className="nav-icon">{icon}</span>
            <span className="nav-lbl">{label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}
