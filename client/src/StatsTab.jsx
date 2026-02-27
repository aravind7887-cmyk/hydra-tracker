import { useState } from 'react';

// ── Helper: build array of day objects for the last N days (today excluded) ──
function getDaysInPeriod(history, days) {
  const result = [];
  for (let i = 1; i <= days; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toDateString();
    const dayData = history[key];
    const entries = dayData?.entries ?? [];
    const consumed = entries.reduce((s, e) => s + e.ml, 0);
    const goal = dayData?.goal ?? 0;
    result.push({ key, date: d, consumed, goal, achieved: goal > 0 && consumed >= goal });
  }
  return result; // index 0 = yesterday, last = oldest
}

// ── Summary stats from period days array ────────────────────────────────────
function getSummaryStats(periodDays) {
  if (!periodDays.length) return { avgDaily: 0, goalHitPct: 0, streak: 0, bestDay: 0 };

  const daysWithData = periodDays.filter(d => d.consumed > 0);
  const avgDaily = daysWithData.length
    ? Math.round(daysWithData.reduce((s, d) => s + d.consumed, 0) / daysWithData.length)
    : 0;

  const withGoal = periodDays.filter(d => d.goal > 0);
  const goalHitPct = withGoal.length
    ? Math.round((withGoal.filter(d => d.achieved).length / withGoal.length) * 100)
    : 0;

  // Streak: consecutive days from yesterday backwards where goal was achieved
  let streak = 0;
  for (const d of periodDays) {
    if (d.goal > 0 && d.achieved) streak++;
    else break;
  }

  const bestDay = periodDays.reduce((max, d) => Math.max(max, d.consumed), 0);

  return { avgDaily, goalHitPct, streak, bestDay };
}

// ── Hourly breakdown: 24-bucket average ml per hour ─────────────────────────
function getHourlyBreakdown(history, days) {
  const buckets = Array(24).fill(0);
  const counts = Array(24).fill(0);

  for (let i = 1; i <= days; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toDateString();
    const entries = history[key]?.entries ?? [];
    entries.forEach(e => {
      const h = new Date(e.time).getHours();
      buckets[h] += e.ml;
      counts[h]++;
    });
  }

  return buckets.map((total, hour) => ({
    hour,
    avg: counts[hour] > 0 ? Math.round(total / counts[hour]) : 0,
  }));
}

// ── Day-of-week averages ─────────────────────────────────────────────────────
function getDayOfWeekAverages(periodDays) {
  const labels = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
  const totals = Array(7).fill(0);
  const counts = Array(7).fill(0);

  periodDays.forEach(d => {
    if (d.consumed > 0) {
      const dow = d.date.getDay();
      totals[dow] += d.consumed;
      counts[dow]++;
    }
  });

  return labels.map((label, i) => ({
    label,
    avg: counts[i] > 0 ? Math.round(totals[i] / counts[i]) : 0,
  }));
}

// ── ISO week key ─────────────────────────────────────────────────────────────
function isoWeekKey(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const week1 = new Date(d.getFullYear(), 0, 4);
  const weekNum = 1 + Math.round(((d - week1) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7);
  return `${d.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

// ── Sub-component: Summary Cards ─────────────────────────────────────────────
function SummaryCards({ stats }) {
  const items = [
    { val: stats.avgDaily ? `${stats.avgDaily.toLocaleString()}ml` : '—', lbl: 'Avg Daily' },
    { val: stats.goalHitPct ? `${stats.goalHitPct}%` : '—', lbl: 'Goal Hit %' },
    { val: stats.streak ? `${stats.streak}d` : '—', lbl: 'Streak' },
    { val: stats.bestDay ? `${stats.bestDay.toLocaleString()}ml` : '—', lbl: 'Best Day' },
  ];
  return (
    <div className="stats-summary-grid">
      {items.map(({ val, lbl }) => (
        <div key={lbl} className="stat-box">
          <span className="stat-val">{val}</span>
          <span className="stat-lbl">{lbl}</span>
        </div>
      ))}
    </div>
  );
}

// ── Sub-component: Trend Chart ───────────────────────────────────────────────
function TrendChart({ periodDays }) {
  const W = 320, H = 120, PAD = { top: 12, right: 8, bottom: 28, left: 38 };
  const days = [...periodDays].reverse(); // oldest → newest
  if (!days.length) return null;

  const maxVal = Math.max(...days.map(d => d.consumed), ...days.map(d => d.goal), 100);
  const xScale = i => PAD.left + (i / (days.length - 1 || 1)) * (W - PAD.left - PAD.right);
  const yScale = v => PAD.top + (1 - v / maxVal) * (H - PAD.top - PAD.bottom);

  // Build points for consumed polyline
  const pts = days.map((d, i) => `${xScale(i)},${yScale(d.consumed)}`).join(' ');

  // Date labels (show at most 5 evenly spaced)
  const labelStep = Math.max(1, Math.floor(days.length / 5));
  const labelIdxs = days.map((_, i) => i).filter(i => i % labelStep === 0 || i === days.length - 1);

  // Dashed goal reference line (use first goal found)
  const refGoal = days.find(d => d.goal > 0)?.goal;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', overflow: 'visible' }}>
      {/* Goal reference line */}
      {refGoal && (
        <line
          x1={PAD.left} y1={yScale(refGoal)}
          x2={W - PAD.right} y2={yScale(refGoal)}
          stroke="rgba(56,189,248,0.3)" strokeWidth="1" strokeDasharray="4 3"
        />
      )}
      {/* Consumed polyline */}
      {days.length > 1 && (
        <polyline
          points={pts}
          fill="none"
          stroke="rgba(56,189,248,0.55)"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
      )}
      {/* Dots */}
      {days.map((d, i) => (
        <circle
          key={i}
          cx={xScale(i)} cy={yScale(d.consumed)}
          r="3.5"
          fill={d.achieved ? '#86efac' : '#38bdf8'}
          stroke="var(--surface)" strokeWidth="1.5"
        />
      ))}
      {/* Y-axis label */}
      <text x={PAD.left - 4} y={PAD.top} textAnchor="end" fontSize="9" fill="#5d7a96">
        {Math.round(maxVal / 1000)}L
      </text>
      <text x={PAD.left - 4} y={H - PAD.bottom} textAnchor="end" fontSize="9" fill="#5d7a96">0</text>
      {/* X-axis date labels */}
      {labelIdxs.map(i => (
        <text key={i} x={xScale(i)} y={H - 4} textAnchor="middle" fontSize="9" fill="#5d7a96">
          {days[i].date.toLocaleDateString([], { month: 'numeric', day: 'numeric' })}
        </text>
      ))}
    </svg>
  );
}

// ── Sub-component: Hourly Chart ──────────────────────────────────────────────
function HourlyChart({ hourlyData }) {
  const W = 320, H = 80, PAD = { top: 8, right: 4, bottom: 16, left: 4 };
  const maxVal = Math.max(...hourlyData.map(d => d.avg), 1);
  const barW = (W - PAD.left - PAD.right) / 24;

  function barColor(hour) {
    if (hour >= 0 && hour < 6)  return 'rgba(129,140,248,0.7)';  // night — indigo
    if (hour >= 6 && hour < 12) return 'rgba(56,189,248,0.8)';   // morning — cyan
    if (hour >= 12 && hour < 18) return 'rgba(33,150,243,0.8)';  // afternoon — blue
    return 'rgba(99,102,241,0.7)';                                 // evening — purple
  }

  const labelHours = [0, 6, 12, 18, 23];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', overflow: 'visible' }}>
      {hourlyData.map(({ hour, avg }) => {
        const barH = avg > 0 ? Math.max(2, ((avg / maxVal) * (H - PAD.top - PAD.bottom))) : 0;
        const x = PAD.left + hour * barW;
        const y = H - PAD.bottom - barH;
        return (
          <rect
            key={hour}
            x={x + 0.5} y={y}
            width={barW - 1} height={barH}
            rx="1.5"
            fill={barColor(hour)}
          />
        );
      })}
      {labelHours.map(h => (
        <text
          key={h}
          x={PAD.left + h * barW + barW / 2}
          y={H - 2}
          textAnchor="middle"
          fontSize="8"
          fill="#5d7a96"
        >
          {h === 0 ? '12a' : h === 12 ? '12p' : h < 12 ? `${h}a` : `${h - 12}p`}
        </text>
      ))}
    </svg>
  );
}

// ── Sub-component: Day-of-Week Chart ─────────────────────────────────────────
function DowChart({ dowData }) {
  const W = 320, H = 90, PAD = { top: 20, right: 8, bottom: 16, left: 8 };
  const maxVal = Math.max(...dowData.map(d => d.avg), 1);
  const barW = (W - PAD.left - PAD.right) / 7;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', overflow: 'visible' }}>
      {dowData.map(({ label, avg }, i) => {
        const isWeekend = i === 0 || i === 6;
        const barH = avg > 0 ? Math.max(2, (avg / maxVal) * (H - PAD.top - PAD.bottom)) : 0;
        const x = PAD.left + i * barW;
        const y = H - PAD.bottom - barH;
        return (
          <g key={label}>
            {barH > 0 && (
              <rect
                x={x + 2} y={y}
                width={barW - 4} height={barH}
                rx="2"
                fill={isWeekend ? 'rgba(129,140,248,0.75)' : 'rgba(56,189,248,0.75)'}
              />
            )}
            {avg > 0 && (
              <text
                x={x + barW / 2} y={y - 3}
                textAnchor="middle" fontSize="8" fill="#5d7a96"
              >
                {avg >= 1000 ? `${(avg / 1000).toFixed(1)}L` : `${avg}`}
              </text>
            )}
            <text
              x={x + barW / 2} y={H - 2}
              textAnchor="middle" fontSize="9"
              fill={isWeekend ? '#818cf8' : '#5d7a96'}
              fontWeight={isWeekend ? '700' : '400'}
            >
              {label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

// ── Sub-component: Weekly Summary ────────────────────────────────────────────
function WeeklySummary({ periodDays }) {
  // Group by ISO week
  const weeks = {};
  periodDays.forEach(d => {
    const wk = isoWeekKey(d.date);
    if (!weeks[wk]) weeks[wk] = [];
    weeks[wk].push(d);
  });

  const sortedWeeks = Object.keys(weeks).sort().reverse();

  if (!sortedWeeks.length) return null;

  return (
    <div className="card">
      <h3 className="card-title">Weekly Summary</h3>
      {sortedWeeks.map(wk => {
        const days = weeks[wk];
        const total = days.reduce((s, d) => s + d.consumed, 0);
        const achieved = days.filter(d => d.achieved).length;
        const daysWithGoal = days.filter(d => d.goal > 0).length;
        return (
          <div key={wk} style={{ marginBottom: '0.75rem' }}>
            <div className="bd-row" style={{ fontWeight: 700, color: 'var(--text)' }}>
              <span>{wk}</span>
              <span className="log-ml">{total.toLocaleString()}ml</span>
            </div>
            {daysWithGoal > 0 && (
              <div className="bd-row">
                <span>Goal achieved</span>
                <span>{achieved}/{daysWithGoal} days</span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Main StatsTab component ───────────────────────────────────────────────────
export default function StatsTab({ history, todayGoal }) {
  const [period, setPeriod] = useState(7);

  const periodDays = getDaysInPeriod(history, period);
  const hasData = periodDays.some(d => d.consumed > 0);
  const stats = getSummaryStats(periodDays);
  const hourlyData = getHourlyBreakdown(history, period);
  const dowData = getDayOfWeekAverages(periodDays);

  return (
    <div className="tab-content">
      <h2 className="tab-title">Stats</h2>

      {/* Period selector */}
      <div className="stats-period-row">
        {[7, 30, 90].map(p => (
          <button
            key={p}
            className={`period-chip${period === p ? ' active' : ''}`}
            onClick={() => setPeriod(p)}
          >
            {p}D
          </button>
        ))}
      </div>

      {!hasData ? (
        <div className="card" style={{ textAlign: 'center', padding: '2rem 1.5rem' }}>
          <div style={{ fontSize: '2rem', marginBottom: '0.75rem' }}>📊</div>
          <p style={{ color: 'var(--muted)', fontSize: '0.88rem', lineHeight: 1.55 }}>
            No history yet for the last {period} days.<br />
            Log water entries to see your trends here.
          </p>
        </div>
      ) : (
        <>
          {/* Summary cards */}
          <SummaryCards stats={stats} />

          {/* Daily Intake trend */}
          <div className="card">
            <h3 className="card-title">Daily Intake</h3>
            <TrendChart periodDays={periodDays} />
            <div style={{ display: 'flex', gap: '1rem', marginTop: '0.5rem' }}>
              <span style={{ fontSize: '0.72rem', color: '#86efac' }}>● Goal achieved</span>
              <span style={{ fontSize: '0.72rem', color: '#38bdf8' }}>● Below goal</span>
              <span style={{ fontSize: '0.72rem', color: 'rgba(56,189,248,0.35)' }}>— — Goal</span>
            </div>
          </div>

          {/* Hourly breakdown */}
          <div className="card">
            <h3 className="card-title">Intake by Time of Day</h3>
            <HourlyChart hourlyData={hourlyData} />
            <div style={{ display: 'flex', gap: '0.75rem', marginTop: '0.5rem', flexWrap: 'wrap' }}>
              <span style={{ fontSize: '0.72rem', color: 'rgba(129,140,248,0.9)' }}>● Night</span>
              <span style={{ fontSize: '0.72rem', color: 'rgba(56,189,248,0.9)' }}>● Morning</span>
              <span style={{ fontSize: '0.72rem', color: 'rgba(33,150,243,0.9)' }}>● Afternoon</span>
              <span style={{ fontSize: '0.72rem', color: 'rgba(99,102,241,0.9)' }}>● Evening</span>
            </div>
          </div>

          {/* Day-of-week averages */}
          <div className="card">
            <h3 className="card-title">Day-of-Week Averages</h3>
            <DowChart dowData={dowData} />
          </div>

          {/* Weekly summary */}
          <WeeklySummary periodDays={periodDays} />
        </>
      )}
    </div>
  );
}
