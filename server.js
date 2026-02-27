require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const app = express();
app.use(express.json());
const PORT = 3001;
const TOKENS_FILE = path.join(__dirname, 'tokens.json');

// ── SQLite setup ───────────────────────────────────────────────────────────────
const db = new Database(path.join(__dirname, 'hydra.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS water_logs (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    date_key  TEXT    NOT NULL,
    ml        INTEGER NOT NULL,
    time      TEXT    NOT NULL,
    goal      INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_water_date ON water_logs(date_key);

  CREATE TABLE IF NOT EXISTS weight_logs (
    date_key  TEXT PRIMARY KEY,
    weight_kg REAL NOT NULL
  );
`);

const stmts = {
  getAllWater:   db.prepare('SELECT * FROM water_logs ORDER BY time ASC'),
  insertWater:  db.prepare('INSERT INTO water_logs (date_key, ml, time, goal) VALUES (@date_key, @ml, @time, @goal)'),
  deleteWater:  db.prepare('DELETE FROM water_logs WHERE id = ?'),
  updateGoal:   db.prepare('UPDATE water_logs SET goal = @goal WHERE date_key = @date_key'),
  getAllWeights: db.prepare('SELECT date_key, weight_kg FROM weight_logs'),
  upsertWeight: db.prepare('INSERT INTO weight_logs (date_key, weight_kg) VALUES (@date_key, @weight_kg) ON CONFLICT(date_key) DO UPDATE SET weight_kg = excluded.weight_kg'),
  countWater:   db.prepare('SELECT COUNT(*) AS cnt FROM water_logs'),
};

// GET /auth/start — redirect user to Strava OAuth
app.get('/auth/start', (req, res) => {
  const params = new URLSearchParams({
    client_id: process.env.STRAVA_CLIENT_ID,
    redirect_uri: process.env.STRAVA_REDIRECT_URI,
    response_type: 'code',
    approval_prompt: 'force',
    scope: 'read,activity:read_all',
  });
  res.redirect(`https://www.strava.com/oauth/authorize?${params}`);
});

// GET /auth/callback — exchange code for tokens and save to tokens.json
app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('Missing code parameter');

  try {
    const response = await axios.post('https://www.strava.com/oauth/token', {
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
    });

    const { access_token, refresh_token, expires_at } = response.data;
    fs.writeFileSync(TOKENS_FILE, JSON.stringify({ access_token, refresh_token, expires_at }, null, 2));
    res.redirect('http://localhost:5173?connected=true');
  } catch (err) {
    const msg = err.response?.data?.message || err.message;
    res.status(500).send(`OAuth error: ${msg}`);
  }
});

// GET /api/token — return a valid access token, refreshing if expired
app.get('/api/token', async (req, res) => {
  if (!fs.existsSync(TOKENS_FILE)) {
    return res.status(401).json({ error: 'Not connected to Strava' });
  }

  let tokens = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
  const now = Math.floor(Date.now() / 1000);

  if (tokens.expires_at <= now) {
    try {
      const response = await axios.post('https://www.strava.com/oauth/token', {
        client_id: process.env.STRAVA_CLIENT_ID,
        client_secret: process.env.STRAVA_CLIENT_SECRET,
        refresh_token: tokens.refresh_token,
        grant_type: 'refresh_token',
      });

      const { access_token, refresh_token, expires_at } = response.data;
      tokens = { access_token, refresh_token, expires_at };
      fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2));
    } catch (err) {
      const msg = err.response?.data?.message || err.message;
      return res.status(500).json({ error: `Token refresh failed: ${msg}` });
    }
  }

  res.json({ access_token: tokens.access_token });
});

// GET /api/hevy — fetch today's (or most recent) workouts from the Hevy API
app.get('/api/hevy', async (req, res) => {
  const apiKey = process.env.HEVY_API_KEY;
  if (!apiKey) return res.json({ date: null, workouts: [], totalMins: 0 });

  try {
    const response = await axios.get('https://api.hevyapp.com/v1/workouts', {
      headers: { 'api-key': apiKey },
      params: { page: 1, pageSize: 10 },
    });

    const workouts = response.data.workouts ?? [];
    if (workouts.length === 0) return res.json({ date: null, workouts: [], totalMins: 0 });

    function dayKey(date) { return date.toDateString(); }

    const parsed = workouts.map(w => ({
      title: w.title,
      start: new Date(w.start_time),
      durationMins: Math.max(1, Math.round((new Date(w.end_time) - new Date(w.start_time)) / 60000)),
    }));

    const todayKey = dayKey(new Date());
    const todayWorkouts = parsed.filter(w => dayKey(w.start) === todayKey);

    if (todayWorkouts.length > 0) {
      return res.json({
        date: 'today',
        workouts: todayWorkouts.map(w => ({ title: w.title, durationMins: w.durationMins })),
        totalMins: todayWorkouts.reduce((s, w) => s + w.durationMins, 0),
      });
    }

    // Fall back to most recent day
    const recentDay = dayKey(parsed[0].start);
    const recentWorkouts = parsed.filter(w => dayKey(w.start) === recentDay);
    return res.json({
      date: parsed[0].start.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }),
      workouts: recentWorkouts.map(w => ({ title: w.title, durationMins: w.durationMins })),
      totalMins: recentWorkouts.reduce((s, w) => s + w.durationMins, 0),
    });
  } catch (err) {
    const msg = err.response?.data?.message || err.message;
    res.status(500).json({ error: `Hevy API error: ${msg}` });
  }
});

// POST /api/ai-plan — generate a personalised hydration plan via Claude
app.post('/api/ai-plan', async (req, res) => {
  const { weight, age, consumed, goal, weather, stravaDate, stravaActivities = [], hevyMins, healthifyCalories } = req.body;

  const totalStravaSecs = stravaActivities.reduce((s, a) => s + a.movingTime, 0);
  const stravaLines = stravaActivities.length === 0
    ? ['- No Strava activity data available']
    : [
        stravaDate && stravaDate !== 'today'
          ? `- Strava activities (from ${stravaDate}, most recent day with data):`
          : '- Strava activities (today):',
        ...stravaActivities.map(a =>
          `  • ${a.type}: ${(a.distance / 1000).toFixed(1)} km, ${Math.floor(a.movingTime / 60)} min` +
          (a.avgHeartRate ? `, avg HR ${Math.round(a.avgHeartRate)} bpm` : '') +
          (a.elevationGain > 0 ? `, ${a.elevationGain}m elevation` : '')
        ),
        `  Total active time: ${Math.floor(totalStravaSecs / 60)} min`,
      ];

  const prompt = [
    `You are a sports nutritionist and hydration specialist. Create a concise, practical hydration plan based on these stats:`,
    ``,
    `- Weight: ${weight} kg`,
    `- Age: ${age}`,
    `- Water consumed today: ${consumed} ml out of a ${goal} ml goal`,
    `- Weather: ${weather}`,
    ...stravaLines,
    hevyMins > 0         ? `- Strength training (Hevy): ${hevyMins} minutes` : '',
    healthifyCalories > 0 ? `- Active calories burned (Healthify): ${healthifyCalories} kcal` : '',
    ``,
    `Provide a hydration plan with these sections:`,
    `## Status Assessment`,
    `## Recommended Intake Schedule (for the rest of today)`,
    `## Electrolyte & Nutrition Tips`,
    `## Tomorrow's Plan`,
    ``,
    `Be specific with timings and amounts. Keep it under 250 words.`,
  ].filter(Boolean).join('\n');

  try {
    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-sonnet-4-6',
        max_tokens: 768,
        messages: [{ role: 'user', content: prompt }],
      },
      {
        headers: {
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
      }
    );
    res.json({ plan: response.data.content[0].text });
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    res.status(500).json({ error: `AI plan failed: ${msg}` });
  }
});

// ── Hydra DB routes ────────────────────────────────────────────────────────────

// GET /api/hydra/history — full history object keyed by date_key
app.get('/api/hydra/history', (req, res) => {
  const rows = stmts.getAllWater.all();
  const history = {};
  for (const row of rows) {
    if (!history[row.date_key]) history[row.date_key] = { entries: [], goal: row.goal };
    history[row.date_key].entries.push({ id: row.id, ml: row.ml, time: row.time });
    history[row.date_key].goal = row.goal; // use last seen goal for the day
  }
  res.json(history);
});

// POST /api/hydra/water — insert one drink entry
app.post('/api/hydra/water', (req, res) => {
  const { date_key, ml, time, goal } = req.body;
  const result = stmts.insertWater.run({ date_key, ml, time, goal: goal ?? 0 });
  res.json({ id: result.lastInsertRowid });
});

// DELETE /api/hydra/water/:id — delete by DB id
app.delete('/api/hydra/water/:id', (req, res) => {
  stmts.deleteWater.run(Number(req.params.id));
  res.json({ ok: true });
});

// PUT /api/hydra/goal — update goal for all rows of a date_key
app.put('/api/hydra/goal', (req, res) => {
  const { date_key, goal } = req.body;
  stmts.updateGoal.run({ date_key, goal });
  res.json({ ok: true });
});

// GET /api/hydra/weights — full weight log object
app.get('/api/hydra/weights', (req, res) => {
  const rows = stmts.getAllWeights.all();
  const weights = {};
  for (const row of rows) weights[row.date_key] = row.weight_kg;
  res.json(weights);
});

// PUT /api/hydra/weight — upsert one day's weight
app.put('/api/hydra/weight', (req, res) => {
  const { date_key, weight_kg } = req.body;
  stmts.upsertWeight.run({ date_key, weight_kg });
  res.json({ ok: true });
});

// POST /api/hydra/migrate — one-time import from localStorage dump
app.post('/api/hydra/migrate', (req, res) => {
  const { cnt } = stmts.countWater.get();
  if (cnt > 0) return res.json({ skipped: true });

  const { hydraHistory = {}, weightLog = {} } = req.body;

  const insertMany = db.transaction(() => {
    for (const [date_key, day] of Object.entries(hydraHistory)) {
      const goal = day.goal ?? 0;
      for (const entry of (day.entries ?? [])) {
        stmts.insertWater.run({ date_key, ml: entry.ml, time: entry.time, goal });
      }
    }
    for (const [date_key, weight_kg] of Object.entries(weightLog)) {
      stmts.upsertWeight.run({ date_key, weight_kg });
    }
  });

  insertMany();
  res.json({ ok: true });
});

// Serve built Vite client
app.use(express.static(path.join(__dirname, 'client/dist')));
// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'client/dist', 'index.html'));
});

app.listen(PORT, () => console.log(`Backend running on http://localhost:${PORT}`));
