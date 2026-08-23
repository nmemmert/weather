const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const webpush = require('web-push');

const app = express();
const PORT = process.env.PORT || 3000;
const weatherCache = new Map();
const WEATHER_CACHE_MAX_ENTRIES = 500;

// ── Persistent data directory ─────────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ── Dashboard auth ────────────────────────────────────────────────────────────
const DASH_AUTH_FILE = path.join(DATA_DIR, 'dashboard-auth.json');
const DASH_SECRET_FILE = path.join(DATA_DIR, 'dashboard-secret.txt');

let dashAuth = null;
try { dashAuth = JSON.parse(fs.readFileSync(DASH_AUTH_FILE, 'utf8')); } catch {}

let SESSION_SECRET;
try { SESSION_SECRET = fs.readFileSync(DASH_SECRET_FILE, 'utf8').trim(); } catch {}
if (!SESSION_SECRET) {
  SESSION_SECRET = crypto.randomBytes(32).toString('hex');
  try { fs.writeFileSync(DASH_SECRET_FILE, SESSION_SECRET); } catch {}
}

function parseCookies(req) {
  const raw = req.headers.cookie || '';
  return Object.fromEntries(raw.split(';').map(c => {
    const [k, ...v] = c.trim().split('=');
    return [k ? k.trim() : '', v.join('=')];
  }).filter(([k]) => k));
}

function signSession(username) {
  const expiry = Date.now() + 30 * 24 * 60 * 60 * 1000;
  const payload = Buffer.from(`${username}|${expiry}`).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifySession(token) {
  if (!token || typeof token !== 'string') return null;
  const dotIdx = token.lastIndexOf('.');
  if (dotIdx < 1) return null;
  const payload = token.slice(0, dotIdx);
  const sig = token.slice(dotIdx + 1);
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig + '='.repeat((4 - sig.length % 4) % 4), 'base64'), Buffer.from(expected + '='.repeat((4 - expected.length % 4) % 4), 'base64'))) return null;
  } catch { return null; }
  const decoded = Buffer.from(payload, 'base64url').toString();
  const [username, expiry] = decoded.split('|');
  if (!username || !expiry || Date.now() > parseInt(expiry)) return null;
  return username;
}

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
}

function getDailyRecoveryToken() {
  const day = Math.floor(Date.now() / (24 * 60 * 60 * 1000));
  return crypto.createHmac('sha256', SESSION_SECRET).update('recover:' + day).digest('hex').slice(0, 16);
}

function requireDashboardAuth(req, res, next) {
  const cookies = parseCookies(req);
  const user = verifySession(cookies.dsession);
  if (user) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
  res.redirect('/dashboard/login');
}

// ── Station data recording ────────────────────────────────────────────────────
const STATION_DIR = path.join(DATA_DIR, 'station');
if (!fs.existsSync(STATION_DIR)) fs.mkdirSync(STATION_DIR, { recursive: true });

function stationDateKey(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

let lastRecordedDateutc = 0;

function recordStationReading(obs) {
  if (!obs.dateutc || obs.dateutc === lastRecordedDateutc) return;
  try {
    const day = stationDateKey(obs.dateutc);
    const file = path.join(STATION_DIR, `${day}.jsonl`);
    fs.appendFileSync(file, JSON.stringify(obs) + '\n');
    lastRecordedDateutc = obs.dateutc;
  } catch (e) {
    console.error('[station] record error:', e.message);
  }
}

function loadStationReadings(rangeMs) {
  const now = Date.now();
  const cutoff = now - rangeMs;
  const days = Math.ceil(rangeMs / 86400000) + 1;
  const results = [];
  for (let i = 0; i < days; i++) {
    const day = stationDateKey(now - i * 86400000);
    const file = path.join(STATION_DIR, `${day}.jsonl`);
    try {
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          const ts = obj.dateutc || 0;
          if (ts >= cutoff) results.push(obj);
        } catch {}
      }
    } catch {}
  }
  return results.sort((a, b) => (a.dateutc || 0) - (b.dateutc || 0));
}

// ── VAPID web push ────────────────────────────────────────────────────────────
const VAPID_FILE = path.join(DATA_DIR, 'vapid.json');
let vapidKeys;
try {
  vapidKeys = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8'));
} catch {
  vapidKeys = webpush.generateVAPIDKeys();
  fs.writeFileSync(VAPID_FILE, JSON.stringify(vapidKeys));
  console.log('[vapid] Generated new keys. Public key:', vapidKeys.publicKey);
}
webpush.setVapidDetails('mailto:nate@necloud.us', vapidKeys.publicKey, vapidKeys.privateKey);

// ── Push subscription store ───────────────────────────────────────────────────
const SUBS_FILE = path.join(DATA_DIR, 'subscriptions.json');
let pushSubscriptions = [];
try {
  if (fs.existsSync(SUBS_FILE)) pushSubscriptions = JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8'));
} catch { pushSubscriptions = []; }
function saveSubs() {
  try { fs.writeFileSync(SUBS_FILE, JSON.stringify(pushSubscriptions, null, 2)); } catch {}
}

function setCache(key, data) {
  if (weatherCache.size >= WEATHER_CACHE_MAX_ENTRIES) {
    const oldestKey = weatherCache.keys().next().value;
    weatherCache.delete(oldestKey);
  }
  weatherCache.set(key, { data, at: Date.now() });
}

// Fetch with retry/timeout, shared by all upstream proxy calls.
async function fetchWithRetry(url, { attempts = 2, timeoutMs = 12000, retryDelayMs = 500, fetchOptions } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const r = await fetch(url, { ...fetchOptions, signal: controller.signal });
      clearTimeout(timeoutId);
      if (!r.ok) throw new Error(`Upstream status ${r.status}`);
      return r;
    } catch (err) {
      clearTimeout(timeoutId);
      lastError = err;
      if (attempt < attempts) {
        await new Promise(resolve => setTimeout(resolve, retryDelayMs * attempt));
      }
    }
  }
  throw lastError;
}

function isValidCoord(value, min, max) {
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max;
}

// Keep shell assets fresh so SW/app versions do not drift.
app.use('/', (req, res, next) => {
  if (req.path === '/' || req.path.endsWith('.html')) {
    res.setHeader('Cache-Control', 'no-store');
  } else if (
    req.path.endsWith('.css') ||
    req.path.endsWith('.js') ||
    req.path === '/sw.js' ||
    req.path === '/manifest.json'
  ) {
    res.setHeader('Cache-Control', 'no-cache');
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// Prevent browser favicon requests from showing noisy 404s.
app.get('/favicon.ico', (_req, res) => {
  res.status(204).end();
});

// Geocoding proxy
app.get('/api/geocode', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'Missing query' });
  try {
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=5&language=en&format=json`;

    let openMeteoData = null;
    try {
      const r = await fetchWithRetry(url, { attempts: 2, timeoutMs: 9000, retryDelayMs: 300 });
      openMeteoData = await r.json();
    } catch (err) {
      console.warn('Open-Meteo geocode failed after retries:', err.message);
    }

    if (openMeteoData?.results?.length) {
      return res.json(openMeteoData);
    }

    // Fallback to Nominatim when Open-Meteo geocoding is empty/unavailable.
    const nomParams = new URLSearchParams({ q: String(q), format: 'jsonv2', limit: '5', addressdetails: '1' });
    const nom = await fetchWithRetry(`https://nominatim.openstreetmap.org/search?${nomParams}`, {
      attempts: 1,
      timeoutMs: 9000,
      fetchOptions: {
        headers: {
          'User-Agent': 'weather-app-v2 (nate@necloud.us)',
          Accept: 'application/json',
        },
      },
    });

    const nomData = await nom.json();
    const results = (nomData || []).map(item => {
      const address = item.address || {};
      return {
        name: address.city || address.town || address.village || address.hamlet || address.county || item.display_name?.split(',')?.[0] || 'Unknown',
        latitude: Number(item.lat),
        longitude: Number(item.lon),
        country: address.country || '',
        admin1: address.state || address.region || address.county || '',
        timezone: 'auto',
      };
    }).filter(r => Number.isFinite(r.latitude) && Number.isFinite(r.longitude));

    return res.json({ results });
  } catch (e) {
    console.error('Geocoding error:', e.message);
    res.status(500).json({ error: 'Geocoding failed' });
  }
});

// Reverse geocoding proxy
app.get('/api/reverse-geocode', async (req, res) => {
  const { lat, lon } = req.query;
  if (!lat || !lon) return res.status(400).json({ error: 'Missing lat/lon' });
  if (!isValidCoord(lat, -90, 90) || !isValidCoord(lon, -180, 180)) {
    return res.status(400).json({ error: 'Invalid lat/lon' });
  }

  try {
    const params = new URLSearchParams({
      format: 'jsonv2',
      lat: String(lat),
      lon: String(lon),
      zoom: '10',
      addressdetails: '1',
    });

    const r = await fetchWithRetry(`https://nominatim.openstreetmap.org/reverse?${params}`, {
      attempts: 1,
      timeoutMs: 9000,
      fetchOptions: {
        headers: {
          'User-Agent': 'weather-app-v2 (nate@necloud.us)',
          Accept: 'application/json',
        },
      },
    });

    const data = await r.json();
    const address = data.address || {};
    const name = address.city || address.town || address.village || address.hamlet || address.municipality || address.county || address.state || data.name || 'Detected location';

    res.json({
      name,
      admin1: address.state || address.region || address.county || '',
      country: address.country || '',
      latitude: Number(lat),
      longitude: Number(lon),
      timezone: 'auto',
      display_name: data.display_name || '',
    });
  } catch (e) {
    console.error('Reverse geocoding error:', e.message);
    res.status(500).json({ error: 'Reverse geocoding failed' });
  }
});

// Weather proxy
app.get('/api/weather', async (req, res) => {
  const { lat, lon, tz, units } = req.query;
  if (!lat || !lon) return res.status(400).json({ error: 'Missing lat/lon' });
  if (!isValidCoord(lat, -90, 90) || !isValidCoord(lon, -180, 180)) {
    return res.status(400).json({ error: 'Invalid lat/lon' });
  }
  const timezone = tz || 'auto';
  const useMetric = units === 'metric';
  const cacheKey = `${Number(lat).toFixed(3)},${Number(lon).toFixed(3)},${timezone},${units || 'us'}`;
  try {
    const params = new URLSearchParams({
      latitude: lat, longitude: lon, timezone,
      current: [
        'temperature_2m','relative_humidity_2m','apparent_temperature',
        'is_day','precipitation','weather_code','cloud_cover',
        'wind_speed_10m','wind_direction_10m','wind_gusts_10m','surface_pressure','visibility'
      ].join(','),
      hourly: [
        'temperature_2m','precipitation_probability','weather_code',
        'wind_speed_10m','apparent_temperature','rain','snowfall'
      ].join(','),
      daily: [
        'weather_code','temperature_2m_max','temperature_2m_min',
        'precipitation_sum','precipitation_probability_max',
        'wind_speed_10m_max','sunrise','sunset','uv_index_max'
      ].join(','),
      forecast_days: 16,
      wind_speed_unit: useMetric ? 'kmh' : 'mph',
      temperature_unit: useMetric ? 'celsius' : 'fahrenheit',
      precipitation_unit: useMetric ? 'mm' : 'inch'
    });

    const r = await fetchWithRetry(`https://api.open-meteo.com/v1/forecast?${params}`, { attempts: 3, timeoutMs: 12000, retryDelayMs: 500 });
    const data = await r.json();
    setCache(cacheKey, data);
    return res.json(data);
  } catch (e) {
    const cached = weatherCache.get(cacheKey);
    if (cached && Date.now() - cached.at < 45 * 60 * 1000) {
      res.setHeader('X-Weather-Cache', 'stale-fallback');
      console.warn('Weather proxy using stale cache for', cacheKey);
      return res.json(cached.data);
    }
    console.error('Weather proxy failed:', e.message);
    res.status(502).json({ error: 'Weather fetch failed' });
  }
});

// Open-Meteo Air Quality proxy
app.get('/api/air-quality', async (req, res) => {
  const { lat, lon, tz } = req.query;
  if (!lat || !lon) return res.status(400).json({ error: 'Missing lat/lon' });
  if (!isValidCoord(lat, -90, 90) || !isValidCoord(lon, -180, 180)) {
    return res.status(400).json({ error: 'Invalid lat/lon' });
  }
  try {
    const params = new URLSearchParams({
      latitude: lat,
      longitude: lon,
      timezone: tz || 'auto',
      current: ['us_aqi', 'pm2_5', 'alder_pollen', 'birch_pollen', 'grass_pollen', 'mugwort_pollen', 'olive_pollen', 'ragweed_pollen'].join(','),
      forecast_days: 1,
    });
    const r = await fetchWithRetry(`https://air-quality-api.open-meteo.com/v1/air-quality?${params}`, { attempts: 2, timeoutMs: 12000, retryDelayMs: 500 });
    const data = await r.json();
    return res.json(data);
  } catch (e) {
    console.error('Air quality fetch error:', e);
    res.setHeader('X-Air-Quality-Fallback', 'empty');
    res.json({ current: {} });
  }
});

// NWS alerts proxy (US only)
app.get('/api/alerts', async (req, res) => {
  const { lat, lon } = req.query;
  if (!lat || !lon) return res.status(400).json({ error: 'Missing lat/lon' });
  if (!isValidCoord(lat, -90, 90) || !isValidCoord(lon, -180, 180)) {
    return res.status(400).json({ error: 'Invalid lat/lon' });
  }
  try {
    const r = await fetchWithRetry(`https://api.weather.gov/alerts/active?point=${lat},${lon}`, {
      attempts: 1,
      timeoutMs: 12000,
      fetchOptions: {
        headers: {
          'User-Agent': 'weather-app-v2 (nate@necloud.us)',
          Accept: 'application/geo+json',
        },
      },
    });
    const data = await r.json();
    res.json(data);
  } catch (e) {
    console.error('Alerts fetch error:', e.message);
    res.setHeader('X-Alerts-Fallback', 'empty');
    res.json({ features: [] });
  }
});

// Radar/satellite tile configuration
app.get('/api/radar/times', async (req, res) => {
  try {
    const now = Math.floor(Date.now() / 1000);

    // IEM NEXRAD tile service (US radar, public/free) with historical offsets for animation.
    const radarLayerBase = 'https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0';
    const radarOffsetsMin = [55, 50, 45, 40, 35, 30, 25, 20, 15, 10, 5, 0];
    const radarPast = radarOffsetsMin.map(offset => {
      const layer = offset === 0 ? 'nexrad-n0q-900913' : `nexrad-n0q-900913-m${String(offset).padStart(2, '0')}m`;
      return {
        time: now - (offset * 60),
        url: `${radarLayerBase}/${layer}/{z}/{x}/{y}.png`,
        isForecast: false,
        maxNativeZoom: 12,
      };
    });

    // IEM GOES East cloud/satellite frames for animation.
    const satOffsetsMin = [30, 25, 20, 15, 10, 5, 0];
    const satelliteInfrared = satOffsetsMin.map(offset => {
      const layer = offset === 0 ? 'goes_east' : `goes_east_m${String(offset).padStart(2, '0')}m`;
      return {
        time: now - (offset * 60),
        url: `https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/${layer}/{z}/{x}/{y}.png`,
        isForecast: false,
        maxNativeZoom: 10,
      };
    });

    res.json({
      provider: 'iem-radar-sat',
      radar: {
        past: radarPast,
      },
      satellite: {
        infrared: satelliteInfrared,
      },
    });
  } catch (e) {
    console.error('Radar config error:', e.message);
    res.status(500).json({ error: 'Radar times failed' });
  }
});

app.use(express.json({ limit: '10kb' }));

// ── VAPID public key ──────────────────────────────────────────────────────────
app.get('/api/vapid-public-key', (_req, res) => res.json({ publicKey: vapidKeys.publicKey }));

// ── Push subscription management ──────────────────────────────────────────────
app.post('/api/push-subscribe', (req, res) => {
  const { subscription, lat, lon, ntfyTopic, thresholds, digestHour } = req.body;
  if (!subscription?.endpoint) return res.status(400).json({ error: 'Missing subscription' });
  if (!isValidCoord(lat, -90, 90) || !isValidCoord(lon, -180, 180)) return res.status(400).json({ error: 'Invalid coords' });
  const idx = pushSubscriptions.findIndex(s => s.subscription.endpoint === subscription.endpoint);
  const entry = {
    subscription, lat: Number(lat), lon: Number(lon),
    ntfyTopic: ntfyTopic || '', thresholds: thresholds || {},
    digestHour: digestHour ?? 7,
    seenAlertIds: idx >= 0 ? pushSubscriptions[idx].seenAlertIds : [],
    lastDigestDate: idx >= 0 ? pushSubscriptions[idx].lastDigestDate : '',
    lastThresholdDate: '', lastThresholdAlerted: {},
  };
  if (idx >= 0) pushSubscriptions[idx] = entry; else pushSubscriptions.push(entry);
  saveSubs();
  res.status(201).json({ ok: true });
});

app.post('/api/push-unsubscribe', (req, res) => {
  const { endpoint } = req.body || {};
  pushSubscriptions = pushSubscriptions.filter(s => s.subscription.endpoint !== endpoint);
  saveSubs();
  res.json({ ok: true });
});

// ── Hurricane tracking proxy (NHC) ────────────────────────────────────────────
const hCache = { data: null, at: 0 };
app.get('/api/hurricanes', async (_req, res) => {
  if (hCache.data && Date.now() - hCache.at < 5 * 60 * 1000) return res.json(hCache.data);
  try {
    const r = await fetchWithRetry('https://www.nhc.noaa.gov/CurrentStorms.json', {
      attempts: 2, timeoutMs: 10000,
      fetchOptions: { headers: { 'User-Agent': 'weather-app-v2 (nate@necloud.us)', Accept: 'application/json' } },
    });
    const data = await r.json();
    hCache.data = { storms: data.activeStorms || [] };
    hCache.at = Date.now();
    res.json(hCache.data);
  } catch (e) {
    console.error('Hurricane fetch error:', e.message);
    res.json(hCache.data || { storms: [] });
  }
});

// ── Wildfire perimeter proxy (NIFC) ───────────────────────────────────────────
const wfCache = { data: null, at: 0 };
app.get('/api/wildfires', async (_req, res) => {
  if (wfCache.data && Date.now() - wfCache.at < 15 * 60 * 1000) return res.json(wfCache.data);
  try {
    const params = new URLSearchParams({
      where: 'GISAcres>100', outFields: 'IncidentName,GISAcres,PercentContained',
      f: 'geojson', resultRecordCount: '150', geometryPrecision: '4', outSR: '4326',
    });
    const r = await fetchWithRetry(
      `https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Interagency_Perimeters_Current/FeatureServer/0/query?${params}`,
      { attempts: 2, timeoutMs: 15000 }
    );
    wfCache.data = await r.json();
    wfCache.at = Date.now();
    res.json(wfCache.data);
  } catch (e) {
    console.error('Wildfire fetch error:', e.message);
    res.json(wfCache.data || { type: 'FeatureCollection', features: [] });
  }
});

// ── SPC storm reports proxy ────────────────────────────────────────────────────
const spcCache = { data: null, at: 0 };
function parseSPCCsv(csv, type) {
  return csv.trim().split('\n').slice(1).flatMap(line => {
    const p = line.split(',');
    const lat = parseFloat(p[5]), lon = parseFloat(p[6]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90) return [];
    return [{
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lon, lat] },
      properties: { type, location: p[4] || '', comments: p.slice(7).join(',').slice(0, 120) },
    }];
  });
}
app.get('/api/spc/reports', async (_req, res) => {
  if (spcCache.data && Date.now() - spcCache.at < 10 * 60 * 1000) return res.json(spcCache.data);
  try {
    const results = await Promise.allSettled(['torn', 'wind', 'hail'].map(t =>
      fetchWithRetry(`https://www.spc.noaa.gov/climo/reports/today_filtered_${t}.csv`, {
        attempts: 1, timeoutMs: 8000,
        fetchOptions: { headers: { 'User-Agent': 'weather-app-v2 (nate@necloud.us)' } },
      }).then(r => r.text()).then(csv => parseSPCCsv(csv, t))
    ));
    spcCache.data = { type: 'FeatureCollection', features: results.flatMap(r => r.status === 'fulfilled' ? r.value : []) };
    spcCache.at = Date.now();
    res.json(spcCache.data);
  } catch (e) {
    console.error('SPC fetch error:', e.message);
    res.json(spcCache.data || { type: 'FeatureCollection', features: [] });
  }
});

// ── Ambient Weather personal station ─────────────────────────────────────────
const AMBIENT_CONFIG_FILE = path.join(DATA_DIR, 'ambient-config.json');
let ambientServerConfig = { apiKey: '', appKey: '' };
try {
  if (fs.existsSync(AMBIENT_CONFIG_FILE)) {
    ambientServerConfig = JSON.parse(fs.readFileSync(AMBIENT_CONFIG_FILE, 'utf8'));
  }
} catch {}

function saveAmbientConfig() {
  try { fs.writeFileSync(AMBIENT_CONFIG_FILE, JSON.stringify(ambientServerConfig)); } catch {}
}

const ambientCaches = new Map();

// Save keys server-side so all devices share them
app.post('/api/ambient-config', requireDashboardAuth, (req, res) => {
  const { apiKey, appKey } = req.body || {};
  if (!apiKey || !appKey) return res.status(400).json({ error: 'apiKey and appKey required' });
  ambientServerConfig = { apiKey, appKey };
  saveAmbientConfig();
  res.json({ ok: true });
});

// Return whether server-side keys exist (never expose the actual keys)
app.get('/api/ambient-config', (_req, res) => {
  const hasKeys = !!(ambientServerConfig.apiKey && ambientServerConfig.appKey);
  res.json({ configured: hasKeys });
});

app.get('/api/ambient', async (req, res) => {
  // Priority: query params (client override) → server-saved → env vars
  const apiKey = req.query.apiKey || ambientServerConfig.apiKey || process.env.AMBIENT_API_KEY;
  const appKey = req.query.appKey || ambientServerConfig.appKey || process.env.AMBIENT_APP_KEY;
  if (!apiKey || !appKey) return res.status(503).json({ error: 'Ambient Weather keys not configured' });

  const cacheKey = apiKey;
  const cached = ambientCaches.get(cacheKey);
  if (cached && Date.now() - cached.at < 60 * 1000) return res.json(cached.data);

  try {
    const url = `https://rt.ambientweather.net/v1/devices?apiKey=${encodeURIComponent(apiKey)}&applicationKey=${encodeURIComponent(appKey)}`;
    const r = await fetchWithRetry(url, { attempts: 2, timeoutMs: 10000, retryDelayMs: 500 });
    const devices = await r.json();
    ambientCaches.set(cacheKey, { data: devices, at: Date.now() });
    res.json(devices);
  } catch (e) {
    console.error('Ambient Weather fetch error:', e.message);
    if (cached) return res.json(cached.data);
    res.status(502).json({ error: 'Ambient Weather fetch failed' });
  }
});

// ── HomeKit thermostat push ───────────────────────────────────────────────────
const HOMEKIT_CONFIG_FILE = path.join(DATA_DIR, 'homekit-config.json');
const HOMEKIT_LATEST_FILE = path.join(DATA_DIR, 'homekit-latest.json');

let homekitConfig = { token: '' };
let homekitLatest = null;

try {
  if (fs.existsSync(HOMEKIT_CONFIG_FILE)) {
    homekitConfig = JSON.parse(fs.readFileSync(HOMEKIT_CONFIG_FILE, 'utf8'));
  }
} catch {}

if (!homekitConfig.token) {
  homekitConfig.token = crypto.randomBytes(32).toString('hex');
  try { fs.writeFileSync(HOMEKIT_CONFIG_FILE, JSON.stringify(homekitConfig)); } catch {}
}

try {
  if (fs.existsSync(HOMEKIT_LATEST_FILE)) {
    homekitLatest = JSON.parse(fs.readFileSync(HOMEKIT_LATEST_FILE, 'utf8'));
  }
} catch {}

// Get push token — dashboard auth
app.get('/api/homekit/config', requireDashboardAuth, (_req, res) => {
  res.json({ token: homekitConfig.token });
});

// Regenerate push token — dashboard auth
app.post('/api/homekit/config/regenerate', requireDashboardAuth, (_req, res) => {
  homekitConfig.token = crypto.randomBytes(32).toString('hex');
  try { fs.writeFileSync(HOMEKIT_CONFIG_FILE, JSON.stringify(homekitConfig)); } catch {}
  res.json({ token: homekitConfig.token });
});

// Receive thermostat data from iOS Shortcut — token in query string or header
// Accepts both GET (query params) and POST (JSON body or query params)
function handleHomekitPush(req, res) {
  const token = req.query.token || req.headers['x-homekit-token'] || (req.body || {}).token;
  if (!token || token !== homekitConfig.token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const p = { ...(req.body || {}), ...req.query };

  function parseTemp(val) {
    const n = parseFloat(val);
    if (isNaN(n)) return null;
    return n < 50 ? +(n * 9 / 5 + 32).toFixed(1) : +n.toFixed(1);
  }

  homekitLatest = {
    tempF: parseTemp(p.temperature ?? p.tempF),
    heatSetF: parseTemp(p.heatSetF),
    coolSetF: parseTemp(p.coolSetF),
    humidity: p.humidity != null ? +parseFloat(p.humidity).toFixed(0) : null,
    mode: p.mode || null,
    hvacState: p.hvacState || null,
    receivedAt: Date.now(),
  };
  try { fs.writeFileSync(HOMEKIT_LATEST_FILE, JSON.stringify(homekitLatest)); } catch {}
  res.json({ ok: true });
}

app.get('/api/homekit/push', handleHomekitPush);
app.post('/api/homekit/push', handleHomekitPush);

// Latest thermostat reading — dashboard auth
app.get('/api/homekit/data', requireDashboardAuth, (_req, res) => {
  if (!homekitLatest) return res.status(503).json({ error: 'No data yet' });
  res.json(homekitLatest);
});

// ── Personal weather station proxy ────────────────────────────────────────────
app.get('/api/pws', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing url' });
  let parsed;
  try { parsed = new URL(url); } catch { return res.status(400).json({ error: 'Invalid url' }); }
  if (!['http:', 'https:'].includes(parsed.protocol)) return res.status(400).json({ error: 'Only http/https allowed' });
  try {
    const r = await fetchWithRetry(url, { attempts: 1, timeoutMs: 5000 });
    res.json(await r.json());
  } catch (e) {
    res.status(502).json({ error: 'PWS fetch failed' });
  }
});

// ── NWS Forecast Discussion ───────────────────────────────────────────────────
const nwsDiscCache = new Map();
app.get('/api/nws/discussion', async (req, res) => {
  const { lat, lon } = req.query;
  if (!isValidCoord(lat, -90, 90) || !isValidCoord(lon, -180, 180)) {
    return res.status(400).json({ error: 'Invalid coords' });
  }
  const cacheKey = `${parseFloat(lat).toFixed(2)},${parseFloat(lon).toFixed(2)}`;
  const cached = nwsDiscCache.get(cacheKey);
  if (cached && Date.now() - cached.at < 45 * 60 * 1000) return res.json(cached.data);

  const NWS_HEADERS = { 'User-Agent': 'weather-app-v2 (nate@necloud.us)', Accept: 'application/geo+json' };
  try {
    // Step 1: resolve lat/lon to NWS forecast office
    const ptRes = await fetchWithRetry(
      `https://api.weather.gov/points/${parseFloat(lat).toFixed(4)},${parseFloat(lon).toFixed(4)}`,
      { attempts: 2, timeoutMs: 10000, fetchOptions: { headers: NWS_HEADERS } }
    );
    if (!ptRes.ok) return res.status(404).json({ error: 'Location not covered by NWS (US only)' });
    const ptData = await ptRes.json();
    const cwa = ptData.properties?.cwa;
    if (!cwa) return res.status(404).json({ error: 'No NWS office found for this location' });

    // Step 2: get list of Area Forecast Discussions for that office
    const listRes = await fetchWithRetry(
      `https://api.weather.gov/products/types/AFD/locations/${cwa}`,
      { attempts: 2, timeoutMs: 10000, fetchOptions: { headers: { 'User-Agent': NWS_HEADERS['User-Agent'] } } }
    );
    const listData = await listRes.json();
    const latest = listData['@graph']?.[0];
    if (!latest) return res.status(404).json({ error: 'No forecast discussion available' });

    // Step 3: fetch the actual product text
    const prodUrl = latest['@id'];
    const prodRes = await fetchWithRetry(prodUrl, {
      attempts: 2, timeoutMs: 10000,
      fetchOptions: { headers: { 'User-Agent': NWS_HEADERS['User-Agent'] } }
    });
    const prodData = await prodRes.json();

    const result = {
      office: cwa,
      issuingOffice: prodData.issuingOffice || cwa,
      issuanceTime: prodData.issuanceTime,
      text: prodData.productText || '',
    };
    nwsDiscCache.set(cacheKey, { data: result, at: Date.now() });
    res.json(result);
  } catch (e) {
    console.error('[discussion]', e.message);
    const stale = nwsDiscCache.get(cacheKey);
    if (stale) return res.json(stale.data);
    res.status(502).json({ error: 'Could not fetch forecast discussion' });
  }
});

// ── Alert watcher + daily digest + threshold cron ─────────────────────────────
const WMO_SHORT = { 0:'Clear',1:'Mainly clear',2:'Partly cloudy',3:'Overcast',45:'Fog',51:'Light drizzle',61:'Light rain',63:'Rain',65:'Heavy rain',71:'Light snow',73:'Snow',75:'Heavy snow',80:'Showers',95:'Thunderstorm' };
function wmoShort(c) { return WMO_SHORT[c] || 'Variable'; }

async function doWebPush(sub, payload) {
  try {
    await webpush.sendNotification(sub.subscription, JSON.stringify(payload));
  } catch (err) {
    if (err.statusCode === 410 || err.statusCode === 404) {
      pushSubscriptions = pushSubscriptions.filter(s => s.subscription.endpoint !== sub.subscription.endpoint);
      saveSubs();
    }
  }
}

async function doNtfy(topic, title, body, priority = 'default') {
  if (!topic) return;
  try {
    await fetch(topic, { method: 'POST', body, headers: { Title: title, Priority: priority, Tags: 'weather' } });
  } catch {}
}

async function alertWatcherCron() {
  const now = new Date();
  const todayStr = now.toDateString();
  const currentHour = now.getHours();
  const base = `http://localhost:${PORT}`;

  // Fetch station once per cron run — reuses the server-side cache
  let stationObs = null;
  if (ambientServerConfig.apiKey && ambientServerConfig.appKey) {
    try {
      const qs = `?apiKey=${encodeURIComponent(ambientServerConfig.apiKey)}&appKey=${encodeURIComponent(ambientServerConfig.appKey)}`;
      const sr = await fetch(`${base}/api/ambient${qs}`);
      if (sr.ok) {
        const devices = await sr.json();
        const d = devices?.[0]?.lastData;
        if (d?.dateutc && Date.now() - d.dateutc < 15 * 60 * 1000) {
          stationObs = d;
          recordStationReading(d);
        }
      }
    } catch {}
  }

  if (!pushSubscriptions.length) return;

  for (const sub of [...pushSubscriptions]) {
    try {
      // ── NWS alerts ──────────────────────────────────────────────────────────
      const alertData = await fetch(`${base}/api/alerts?lat=${sub.lat}&lon=${sub.lon}`)
        .then(r => r.json()).catch(() => ({ features: [] }));
      const newAlerts = (alertData.features || []).filter(f => {
        const id = f.id || f.properties?.id;
        return id && !sub.seenAlertIds.includes(id);
      });
      if (newAlerts.length) {
        for (const a of newAlerts) {
          const p = a.properties || {};
          const title = `Weather alert: ${p.event || 'Severe weather'}`;
          const body = p.headline || p.description || 'Alert for your saved location.';
          await doWebPush(sub, { title, body, tag: 'weather-alert', url: '/?tab=alerts' });
          await doNtfy(sub.ntfyTopic, title, body, 'high');
        }
        sub.seenAlertIds = [...new Set([...sub.seenAlertIds, ...newAlerts.map(f => f.id || f.properties?.id)])].slice(-200);
        saveSubs();
      }

      // ── Daily digest ─────────────────────────────────────────────────────────
      if (sub.lastDigestDate !== todayStr && currentHour === (sub.digestHour ?? 7)) {
        const wx = await fetch(`${base}/api/weather?lat=${sub.lat}&lon=${sub.lon}`).then(r => r.json()).catch(() => null);
        if (wx) {
          const d = wx.daily;
          const body = `High ${Math.round(d.temperature_2m_max[0])}° / Low ${Math.round(d.temperature_2m_min[0])}° · ${wmoShort(d.weather_code[0])} · Rain ${d.precipitation_probability_max[0]}% · UV ${Math.round(d.uv_index_max[0] ?? 0)}`;
          await doWebPush(sub, { title: '☀️ NeCloud Daily Forecast', body, tag: 'daily-digest', url: '/' });
          await doNtfy(sub.ntfyTopic, '☀️ NeCloud Daily Forecast', body);
          sub.lastDigestDate = todayStr;
          saveSubs();
        }
      }

      // ── Custom thresholds ─────────────────────────────────────────────────────
      if (sub.thresholds && Object.keys(sub.thresholds).length) {
        if (sub.lastThresholdDate !== todayStr) { sub.lastThresholdAlerted = {}; sub.lastThresholdDate = todayStr; }
        const wx = await fetch(`${base}/api/weather?lat=${sub.lat}&lon=${sub.lon}`).then(r => r.json()).catch(() => null);
        if (wx) {
          const c = wx.current;
          const alerted = sub.lastThresholdAlerted || {};

          const gustVal = stationObs?.windgustmph ?? c.wind_gusts_10m;
          const gustSrc = stationObs ? 'station' : 'forecast model';
          if (sub.thresholds.wind && gustVal > sub.thresholds.wind && !alerted.wind) {
            alerted.wind = true;
            const body = `Gusts at ${Math.round(gustVal)} mph — your threshold is ${sub.thresholds.wind} mph (${gustSrc})`;
            await doWebPush(sub, { title: '💨 Wind Alert', body, tag: 'wind-threshold', url: '/' });
            await doNtfy(sub.ntfyTopic, '💨 Wind Alert', body, 'high');
          }

          const tempVal = stationObs?.tempf ?? c.temperature_2m;
          const tempSrc = stationObs ? 'station' : 'forecast model';
          if (sub.thresholds.tempLow && tempVal < sub.thresholds.tempLow && !alerted.tempLow) {
            alerted.tempLow = true;
            const body = `Temperature at ${Math.round(tempVal)}°F — at or below your freeze threshold (${tempSrc})`;
            await doWebPush(sub, { title: '🧊 Freeze Alert', body, tag: 'temp-threshold', url: '/' });
            await doNtfy(sub.ntfyTopic, '🧊 Freeze Alert', body);
          }
          if (sub.thresholds.aqi) {
            const aqData = await fetch(`${base}/api/air-quality?lat=${sub.lat}&lon=${sub.lon}`).then(r => r.json()).catch(() => null);
            const aqi = aqData?.current?.us_aqi;
            if (aqi && aqi > sub.thresholds.aqi && !alerted.aqi) {
              alerted.aqi = true;
              const body = `AQI at ${aqi} — above your threshold of ${sub.thresholds.aqi}`;
              await doWebPush(sub, { title: '😷 Air Quality Alert', body, tag: 'aqi-threshold', url: '/' });
              await doNtfy(sub.ntfyTopic, '😷 Air Quality Alert', body);
            }
          }
          // ── Station-based threshold alerts ───────────────────────────────────
          if (stationObs) {
            if (sub.thresholds.rainRate && stationObs.rainratein != null && stationObs.rainratein > sub.thresholds.rainRate && !alerted.rainRate) {
              alerted.rainRate = true;
              const body = `Rain rate at ${stationObs.rainratein.toFixed(2)} in/hr — threshold is ${sub.thresholds.rainRate} in/hr`;
              await doWebPush(sub, { title: '🌧 Heavy Rain Alert', body, tag: 'rain-threshold', url: '/' });
              await doNtfy(sub.ntfyTopic, '🌧 Heavy Rain Alert', body, 'high');
            }
            if (sub.thresholds.tempHigh && stationObs.tempf != null && stationObs.tempf > sub.thresholds.tempHigh && !alerted.tempHigh) {
              alerted.tempHigh = true;
              const body = `Station temp at ${stationObs.tempf.toFixed(1)}°F — threshold is ${sub.thresholds.tempHigh}°F`;
              await doWebPush(sub, { title: '🌡 High Temp Alert', body, tag: 'temp-high', url: '/' });
              await doNtfy(sub.ntfyTopic, '🌡 High Temp Alert', body, 'high');
            }
            if (sub.thresholds.tempLow && stationObs.tempf != null && stationObs.tempf < sub.thresholds.tempLow && !alerted.stationTempLow) {
              alerted.stationTempLow = true;
              const body = `Station temp at ${stationObs.tempf.toFixed(1)}°F — threshold is ${sub.thresholds.tempLow}°F`;
              await doWebPush(sub, { title: '🧊 Low Temp Alert', body, tag: 'temp-low', url: '/' });
              await doNtfy(sub.ntfyTopic, '🧊 Low Temp Alert', body, 'default');
            }
            if (stationObs.tempf != null && stationObs.tempf <= 34 && !alerted.freeze) {
              alerted.freeze = true;
              const body = `Station reading ${stationObs.tempf.toFixed(1)}°F — freezing conditions`;
              await doWebPush(sub, { title: '❄️ Freeze Warning', body, tag: 'freeze', url: '/' });
              await doNtfy(sub.ntfyTopic, '❄️ Freeze Warning', body, 'urgent');
            }
            if (sub.thresholds.wind && stationObs.windgustmph != null && stationObs.windgustmph > sub.thresholds.wind && !alerted.stationWind) {
              alerted.stationWind = true;
              const body = `Station gust at ${stationObs.windgustmph.toFixed(0)} mph — threshold is ${sub.thresholds.wind} mph`;
              await doWebPush(sub, { title: '💨 Wind Gust Alert', body, tag: 'wind-station', url: '/' });
              await doNtfy(sub.ntfyTopic, '💨 Wind Gust Alert', body, 'high');
            }
          }
          // ── Station offline alert ────────────────────────────────────────────
          if (!stationObs && ambientServerConfig.apiKey) {
            const lastReading = lastRecordedDateutc;
            if (lastReading && Date.now() - lastReading > 20 * 60 * 1000 && !alerted.stationOffline) {
              alerted.stationOffline = true;
              const mins = Math.round((Date.now() - lastReading) / 60000);
              const body = `No station data for ${mins} minutes`;
              await doWebPush(sub, { title: '📡 Station Offline', body, tag: 'station-offline', url: '/' });
              await doNtfy(sub.ntfyTopic, '📡 Station Offline', body, 'default');
            }
          } else if (stationObs) {
            alerted.stationOffline = false;
          }

          sub.lastThresholdAlerted = alerted;
          saveSubs();
        }
      }
      await new Promise(r => setTimeout(r, 200));
    } catch (err) {
      console.error('[cron] Subscription error:', err.message);
    }
  }
}

setTimeout(alertWatcherCron, 15000);
setInterval(alertWatcherCron, 60 * 1000);

// ── Dashboard routes ──────────────────────────────────────────────────────────
app.use('/dashboard', express.urlencoded({ extended: false }));

// Setup (first-time account creation)
app.get('/dashboard/setup', (req, res) => {
  if (dashAuth) return res.redirect('/dashboard');
  res.sendFile(path.join(__dirname, 'public', 'dashboard-setup.html'));
});

app.post('/dashboard/setup', (req, res) => {
  if (dashAuth) return res.redirect('/dashboard');
  const { username, password } = req.body || {};
  if (!username || !password || password.length < 6) {
    return res.redirect('/dashboard/setup?error=1');
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPassword(password, salt);
  dashAuth = { username, salt, hash };
  try { fs.writeFileSync(DASH_AUTH_FILE, JSON.stringify(dashAuth)); } catch {}
  const token = signSession(username);
  res.setHeader('Set-Cookie', `dsession=${token}; HttpOnly; Path=/; Max-Age=${30*24*3600}; SameSite=Lax`);
  res.redirect('/dashboard');
});

// Login
app.get('/dashboard/login', (req, res) => {
  if (!dashAuth) return res.redirect('/dashboard/setup');
  const cookies = parseCookies(req);
  if (verifySession(cookies.dsession)) return res.redirect('/dashboard');
  res.sendFile(path.join(__dirname, 'public', 'dashboard-login.html'));
});

app.post('/dashboard/login', (req, res) => {
  if (!dashAuth) return res.redirect('/dashboard/setup');
  const { username, password } = req.body || {};
  if (!username || !password) return res.redirect('/dashboard/login?error=1');
  if (username !== dashAuth.username) return res.redirect('/dashboard/login?error=1');
  const hash = hashPassword(password, dashAuth.salt);
  let match = false;
  try { match = crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(dashAuth.hash, 'hex')); } catch {}
  if (!match) return res.redirect('/dashboard/login?error=1');
  const token = signSession(username);
  res.setHeader('Set-Cookie', `dsession=${token}; HttpOnly; Path=/; Max-Age=${30*24*3600}; SameSite=Lax`);
  res.redirect('/dashboard');
});

// Logout
app.get('/dashboard/logout', (_req, res) => {
  res.setHeader('Set-Cookie', 'dsession=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax');
  res.redirect('/dashboard/login');
});

// Password recovery
app.get('/dashboard/recover', (_req, res) => {
  if (!dashAuth) return res.redirect('/dashboard/setup');
  res.sendFile(path.join(__dirname, 'public', 'dashboard-recover.html'));
});

app.post('/dashboard/recover', (req, res) => {
  if (!dashAuth) return res.redirect('/dashboard/setup');
  const { token, password } = req.body || {};
  if (!token || !password || password.length < 6) return res.redirect('/dashboard/recover?error=1');
  const expected = getDailyRecoveryToken();
  let match = false;
  try { match = crypto.timingSafeEqual(Buffer.from(token.trim()), Buffer.from(expected)); } catch {}
  if (!match) return res.redirect('/dashboard/recover?error=1');
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPassword(password, salt);
  dashAuth = { ...dashAuth, salt, hash };
  try { fs.writeFileSync(DASH_AUTH_FILE, JSON.stringify(dashAuth)); } catch {}
  res.redirect('/dashboard/login?recovered=1');
});

// Main dashboard
app.get('/dashboard', requireDashboardAuth, (_req, res) => {
  if (!dashAuth) return res.redirect('/dashboard/setup');
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// Station history API
app.get('/api/station/history', requireDashboardAuth, (req, res) => {
  const rangeMap = { '1h': 3600000, '6h': 21600000, '24h': 86400000, '7d': 604800000, '30d': 2592000000, '90d': 7776000000, '1y': 31536000000, '2y': 63072000000, '3y': 94608000000 };
  const range = req.query.range || '24h';
  const rangeMs = rangeMap[range] || rangeMap['24h'];
  const readings = loadStationReadings(rangeMs);
  res.json(readings);
});

// Latest station reading
app.get('/api/station/latest', requireDashboardAuth, async (req, res) => {
  if (!ambientServerConfig.apiKey || !ambientServerConfig.appKey) {
    return res.status(503).json({ error: 'Station not configured' });
  }
  const cached = ambientCaches.get(ambientServerConfig.apiKey);
  if (cached) return res.json(cached.data?.[0]?.lastData || null);
  res.json(null);
});

// ── Ambient historical backfill ───────────────────────────────────────────────
let backfillState = { running: false, done: 0, total: 0, inserted: 0, error: null };

async function runBackfill(daysBack) {
  const apiKey = ambientServerConfig.apiKey;
  const appKey = ambientServerConfig.appKey;
  if (!apiKey || !appKey) {
    backfillState = { running: false, done: 0, total: 0, inserted: 0, error: 'No API keys configured' };
    return;
  }

  // Get device MAC address
  let mac;
  try {
    const r = await fetchWithRetry(
      `https://rt.ambientweather.net/v1/devices?apiKey=${encodeURIComponent(apiKey)}&applicationKey=${encodeURIComponent(appKey)}`,
      { attempts: 3, timeoutMs: 15000 }
    );
    const devices = await r.json();
    mac = devices?.[0]?.macAddress;
  } catch (e) {
    backfillState = { running: false, done: 0, total: 0, inserted: 0, error: `Device fetch failed: ${e.message}` };
    return;
  }

  if (!mac) {
    backfillState = { running: false, done: 0, total: 0, inserted: 0, error: 'No device found for these keys' };
    return;
  }

  const cutoff = Date.now() - daysBack * 86400000;
  backfillState = { running: true, done: 0, total: daysBack, inserted: 0, error: null };

  // Per-day cache of existing dateutc values so we don't write duplicates
  const existingByDay = new Map();
  function getExisting(day) {
    if (existingByDay.has(day)) return existingByDay.get(day);
    const set = new Set();
    try {
      const lines = fs.readFileSync(path.join(STATION_DIR, `${day}.jsonl`), 'utf8').split('\n').filter(Boolean);
      for (const l of lines) { try { set.add(JSON.parse(l).dateutc); } catch {} }
    } catch {}
    existingByDay.set(day, set);
    return set;
  }

  let endDate = Date.now();
  let inserted = 0;

  while (endDate > cutoff) {
    await new Promise(r => setTimeout(r, 1100)); // respect 1 req/sec rate limit
    try {
      const url = `https://rt.ambientweather.net/v1/devices/${encodeURIComponent(mac)}?apiKey=${encodeURIComponent(apiKey)}&applicationKey=${encodeURIComponent(appKey)}&limit=288&endDate=${endDate}`;
      const r = await fetchWithRetry(url, { attempts: 2, timeoutMs: 15000 });
      const records = await r.json();

      if (!Array.isArray(records) || records.length === 0) break;

      let oldest = Infinity;
      for (const rec of records) {
        if (!rec.dateutc) continue;
        if (rec.dateutc < oldest) oldest = rec.dateutc;
        if (rec.dateutc < cutoff) continue;
        const day = stationDateKey(rec.dateutc);
        const existing = getExisting(day);
        if (!existing.has(rec.dateutc)) {
          fs.appendFileSync(path.join(STATION_DIR, `${day}.jsonl`), JSON.stringify(rec) + '\n');
          existing.add(rec.dateutc);
          inserted++;
        }
      }

      backfillState.done = Math.min(daysBack, Math.ceil((Date.now() - oldest) / 86400000));
      backfillState.inserted = inserted;

      if (records.length < 288 || oldest <= cutoff) break;
      endDate = oldest - 1;
    } catch (e) {
      backfillState.error = e.message;
      break;
    }
  }

  backfillState.running = false;
  backfillState.done = daysBack;
  backfillState.inserted = inserted;
  console.log(`[backfill] complete — inserted ${inserted} records`);
}

app.post('/api/station/backfill', requireDashboardAuth, (req, res) => {
  if (backfillState.running) return res.json({ ok: false, error: 'Backfill already running' });
  const days = Math.min(Math.max(parseInt(req.body?.days || '30'), 1), 365);
  res.json({ ok: true, days });
  runBackfill(days).catch(e => {
    backfillState.error = e.message;
    backfillState.running = false;
  });
});

app.get('/api/station/backfill/status', requireDashboardAuth, (_req, res) => {
  res.json(backfillState);
});

// ── Station analytics ─────────────────────────────────────────────────────────

// Records — scan all JSONL, cache 1h
let recordsCache = null;
let recordsCacheAt = 0;

function computeStationRecords() {
  let files;
  try { files = fs.readdirSync(STATION_DIR).filter(f => f.endsWith('.jsonl')).sort(); } catch { return null; }
  if (!files.length) return null;
  const rec = {
    highTemp: null, highTempDate: null, lowTemp: null, lowTempDate: null,
    highGust: null, highGustDate: null,
    highRainRate: null, highRainRateDate: null, highDailyRain: null, highDailyRainDate: null,
    highUV: null, highUVDate: null, highSolar: null, highSolarDate: null,
    highPressure: null, highPressureDate: null, lowPressure: null, lowPressureDate: null,
    highHumidity: null, highHumidityDate: null, lowHumidity: null, lowHumidityDate: null,
    totalReadings: 0, firstReading: null, lastReading: null,
  };
  for (const file of files) {
    try {
      const lines = fs.readFileSync(path.join(STATION_DIR, file), 'utf8').split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const r = JSON.parse(line);
          if (!r.dateutc) continue;
          rec.totalReadings++;
          if (!rec.firstReading || r.dateutc < rec.firstReading) rec.firstReading = r.dateutc;
          if (!rec.lastReading || r.dateutc > rec.lastReading) rec.lastReading = r.dateutc;
          if (r.tempf != null) {
            if (rec.highTemp == null || r.tempf > rec.highTemp) { rec.highTemp = r.tempf; rec.highTempDate = r.dateutc; }
            if (rec.lowTemp == null || r.tempf < rec.lowTemp) { rec.lowTemp = r.tempf; rec.lowTempDate = r.dateutc; }
          }
          if (r.windgustmph != null && (rec.highGust == null || r.windgustmph > rec.highGust)) { rec.highGust = r.windgustmph; rec.highGustDate = r.dateutc; }
          if (r.rainratein != null && (rec.highRainRate == null || r.rainratein > rec.highRainRate)) { rec.highRainRate = r.rainratein; rec.highRainRateDate = r.dateutc; }
          if (r.dailyrainin != null && (rec.highDailyRain == null || r.dailyrainin > rec.highDailyRain)) { rec.highDailyRain = r.dailyrainin; rec.highDailyRainDate = r.dateutc; }
          if (r.uv != null && (rec.highUV == null || r.uv > rec.highUV)) { rec.highUV = r.uv; rec.highUVDate = r.dateutc; }
          if (r.solarradiation != null && (rec.highSolar == null || r.solarradiation > rec.highSolar)) { rec.highSolar = r.solarradiation; rec.highSolarDate = r.dateutc; }
          if (r.baromrelin != null) {
            if (rec.highPressure == null || r.baromrelin > rec.highPressure) { rec.highPressure = r.baromrelin; rec.highPressureDate = r.dateutc; }
            if (rec.lowPressure == null || r.baromrelin < rec.lowPressure) { rec.lowPressure = r.baromrelin; rec.lowPressureDate = r.dateutc; }
          }
          if (r.humidity != null) {
            if (rec.highHumidity == null || r.humidity > rec.highHumidity) { rec.highHumidity = r.humidity; rec.highHumidityDate = r.dateutc; }
            if (rec.lowHumidity == null || r.humidity < rec.lowHumidity) { rec.lowHumidity = r.humidity; rec.lowHumidityDate = r.dateutc; }
          }
        } catch {}
      }
    } catch {}
  }
  return rec;
}

app.get('/api/station/records', requireDashboardAuth, (_req, res) => {
  if (recordsCache && Date.now() - recordsCacheAt < 3600000) return res.json(recordsCache);
  recordsCache = computeStationRecords();
  recordsCacheAt = Date.now();
  res.json(recordsCache);
});

// Rain totals — max dailyrainin per calendar day, summed
app.get('/api/station/rain-totals', requireDashboardAuth, (_req, res) => {
  const now = Date.now();
  const ytdCutoff = new Date(new Date().getFullYear(), 0, 1).getTime();
  function sumDailyRain(readings) {
    const byDay = {};
    for (const r of readings) {
      if (r.dailyrainin == null || !r.dateutc) continue;
      const d = stationDateKey(r.dateutc);
      if (byDay[d] == null || r.dailyrainin > byDay[d]) byDay[d] = r.dailyrainin;
    }
    return +Object.values(byDay).reduce((a, b) => a + b, 0).toFixed(2);
  }
  res.json({
    rain7d: sumDailyRain(loadStationReadings(7 * 86400000)),
    rain30d: sumDailyRain(loadStationReadings(30 * 86400000)),
    rainYTD: sumDailyRain(loadStationReadings(now - ytdCutoff)),
  });
});

// Heating/cooling degree days
app.get('/api/station/degree-days', requireDashboardAuth, (req, res) => {
  const base = parseFloat(req.query.base || '65');
  const rangeMs = Math.min(parseInt(req.query.rangeMs || String(30 * 86400000)), 365 * 86400000);
  const readings = loadStationReadings(rangeMs);
  const byDay = {};
  for (const r of readings) {
    if (r.tempf == null || !r.dateutc) continue;
    const d = stationDateKey(r.dateutc);
    if (!byDay[d]) byDay[d] = [];
    byDay[d].push(r.tempf);
  }
  let hdd = 0, cdd = 0;
  for (const temps of Object.values(byDay)) {
    const avg = temps.reduce((a, b) => a + b, 0) / temps.length;
    hdd += Math.max(0, base - avg);
    cdd += Math.max(0, avg - base);
  }
  res.json({ hdd: +hdd.toFixed(1), cdd: +cdd.toFixed(1), base, days: Object.keys(byDay).length });
});

// CSV export
const RANGE_MS_MAP = { '1h': 3600000, '6h': 21600000, '24h': 86400000, '7d': 604800000, '30d': 2592000000, '90d': 7776000000, '1y': 31536000000, '2y': 63072000000, '3y': 94608000000 };
app.get('/api/station/export.csv', requireDashboardAuth, (req, res) => {
  const range = req.query.range || '30d';
  const readings = loadStationReadings(RANGE_MS_MAP[range] || RANGE_MS_MAP['30d']);
  const cols = ['date','tempf','feelsLike','humidity','dewPoint','windspeedmph','windgustmph','winddir','baromrelin','baromabsin','rainratein','dailyrainin','weeklyrainin','monthlyrainin','uv','solarradiation','battout'];
  const header = cols.join(',');
  const rows = readings.map(r => cols.map(c => {
    if (c === 'date') return new Date(r.dateutc).toISOString();
    return r[c] == null ? '' : r[c];
  }).join(','));
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="station-${range}-${new Date().toISOString().slice(0,10)}.csv"`);
  res.send([header, ...rows].join('\n'));
});

// Year-over-year: current range + same range 1 year prior (timestamps shifted forward 1yr for chart overlay)
app.get('/api/station/yoy', requireDashboardAuth, (req, res) => {
  const rangeMs = RANGE_MS_MAP[req.query.range] || RANGE_MS_MAP['1y'];
  const YEAR_MS = 365.25 * 86400000;
  const current = loadStationReadings(rangeMs);
  const priorEnd = Date.now() - YEAR_MS;
  const prior = loadStationReadings(rangeMs + YEAR_MS).filter(r => r.dateutc >= priorEnd - rangeMs && r.dateutc <= priorEnd);
  const priorShifted = prior.map(r => ({ dateutc: Math.round(r.dateutc + YEAR_MS), tempf: r.tempf, humidity: r.humidity, windspeedmph: r.windspeedmph, baromrelin: r.baromrelin }));
  res.json({ current: current.map(r => ({ dateutc: r.dateutc, tempf: r.tempf, humidity: r.humidity, windspeedmph: r.windspeedmph, baromrelin: r.baromrelin })), prior: priorShifted });
});

// Anomaly — hourly baseline from all historical data
app.get('/api/station/anomaly', requireDashboardAuth, (_req, res) => {
  const all = loadStationReadings(365 * 86400000);
  if (all.length < 200) return res.json({ available: false });
  const byHour = Array.from({ length: 24 }, () => []);
  for (const r of all) {
    if (r.tempf == null) continue;
    byHour[new Date(r.dateutc).getHours()].push(r.tempf);
  }
  const hourStats = byHour.map(temps => {
    if (temps.length < 10) return null;
    const mean = temps.reduce((a, b) => a + b) / temps.length;
    const stddev = Math.sqrt(temps.reduce((a, b) => a + (b - mean) ** 2, 0) / temps.length);
    return { mean: +mean.toFixed(1), stddev: +stddev.toFixed(1) };
  });
  const last = all[all.length - 1];
  const h = new Date(last.dateutc).getHours();
  const stat = hourStats[h];
  const z = (stat && stat.stddev > 0) ? (last.tempf - stat.mean) / stat.stddev : 0;
  res.json({ available: true, hourStats, anomaly: z > 2 ? 'above' : z < -2 ? 'below' : 'normal', currentTemp: last.tempf, currentHour: h, mean: stat?.mean, stddev: stat?.stddev });
});

// Public conditions page + API (no auth required)
app.get('/conditions', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'conditions.html'));
});
app.get('/api/conditions/public', (_req, res) => {
  if (!ambientServerConfig.apiKey) return res.status(503).json({ error: 'Not configured' });
  const cached = ambientCaches.get(ambientServerConfig.apiKey);
  const data = cached?.data?.[0]?.lastData || null;
  if (!data) return res.json(null);
  res.json({ ...data, stationName: dashAuth?.stationName || 'Genesis 8:22' });
});

// ── Dashboard management APIs ─────────────────────────────────────────────────

// Change password
app.post('/api/dashboard/change-password', requireDashboardAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword || newPassword.length < 6)
    return res.status(400).json({ error: 'Invalid input' });
  const hash = hashPassword(currentPassword, dashAuth.salt);
  let match = false;
  try { match = crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(dashAuth.hash, 'hex')); } catch {}
  if (!match) return res.status(403).json({ error: 'Current password incorrect' });
  const salt = crypto.randomBytes(16).toString('hex');
  dashAuth = { ...dashAuth, salt, hash: hashPassword(newPassword, salt) };
  try { fs.writeFileSync(DASH_AUTH_FILE, JSON.stringify(dashAuth)); } catch {}
  res.json({ ok: true });
});

// Station name
app.get('/api/dashboard/station-name', requireDashboardAuth, (_req, res) => {
  res.json({ name: dashAuth?.stationName || 'Genesis 8:22' });
});
app.post('/api/dashboard/station-name', requireDashboardAuth, (req, res) => {
  const { name } = req.body || {};
  if (!name || typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'Invalid name' });
  dashAuth = { ...dashAuth, stationName: name.trim().slice(0, 60) };
  try { fs.writeFileSync(DASH_AUTH_FILE, JSON.stringify(dashAuth)); } catch {}
  res.json({ ok: true, name: dashAuth.stationName });
});

// Monthly summary — avg temp, total rain, high temp, high gust per month
app.get('/api/station/monthly-summary', requireDashboardAuth, (_req, res) => {
  let files;
  try { files = fs.readdirSync(STATION_DIR).filter(f => f.endsWith('.jsonl')).sort(); } catch { return res.json([]); }
  const months = {};
  for (const file of files) {
    try {
      const lines = fs.readFileSync(path.join(STATION_DIR, file), 'utf8').split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const r = JSON.parse(line);
          if (!r.dateutc) continue;
          const key = new Date(r.dateutc).toISOString().slice(0, 7); // YYYY-MM
          if (!months[key]) months[key] = { temps: [], highTemp: null, highGust: null, dailyRainMax: {} };
          const m = months[key];
          if (r.tempf != null) {
            m.temps.push(r.tempf);
            if (m.highTemp == null || r.tempf > m.highTemp) m.highTemp = r.tempf;
          }
          if (r.windgustmph != null && (m.highGust == null || r.windgustmph > m.highGust)) m.highGust = r.windgustmph;
          if (r.dailyrainin != null) {
            const day = stationDateKey(r.dateutc);
            if (m.dailyRainMax[day] == null || r.dailyrainin > m.dailyRainMax[day]) m.dailyRainMax[day] = r.dailyrainin;
          }
        } catch {}
      }
    } catch {}
  }
  const result = Object.entries(months).sort(([a], [b]) => a.localeCompare(b)).map(([key, m]) => ({
    month: key,
    avgTemp: m.temps.length ? +(m.temps.reduce((a, b) => a + b, 0) / m.temps.length).toFixed(1) : null,
    highTemp: m.highTemp != null ? +m.highTemp.toFixed(1) : null,
    highGust: m.highGust != null ? +m.highGust.toFixed(0) : null,
    totalRain: +Object.values(m.dailyRainMax).reduce((a, b) => a + b, 0).toFixed(2),
    readings: m.temps.length,
  }));
  res.json(result);
});

// Subscriptions list (for reading thresholds in dashboard)
app.get('/api/subscriptions', requireDashboardAuth, (_req, res) => {
  res.json(pushSubscriptions.map(s => ({ ntfyTopic: s.ntfyTopic, thresholds: s.thresholds || {}, hasWebPush: !!s.subscription })));
});

// Update thresholds on all subscriptions at once
app.post('/api/subscriptions/thresholds', requireDashboardAuth, (req, res) => {
  const { thresholds } = req.body || {};
  if (!thresholds || typeof thresholds !== 'object') return res.status(400).json({ error: 'Invalid' });
  for (const sub of pushSubscriptions) sub.thresholds = { ...(sub.thresholds || {}), ...thresholds };
  saveSubs();
  res.json({ ok: true, updated: pushSubscriptions.length });
});

// Station location (for dashboard alerts)
app.get('/api/dashboard/location', requireDashboardAuth, (_req, res) => {
  if (dashAuth?.stationLat != null)
    return res.json({ lat: dashAuth.stationLat, lon: dashAuth.stationLon });
  if (pushSubscriptions.length)
    return res.json({ lat: pushSubscriptions[0].lat, lon: pushSubscriptions[0].lon, fromSubscription: true });
  res.json(null);
});
app.post('/api/dashboard/location', requireDashboardAuth, (req, res) => {
  const { lat, lon } = req.body || {};
  if (!isValidCoord(lat, -90, 90) || !isValidCoord(lon, -180, 180))
    return res.status(400).json({ error: 'Invalid coordinates' });
  dashAuth = { ...dashAuth, stationLat: +lat, stationLon: +lon };
  try { fs.writeFileSync(DASH_AUTH_FILE, JSON.stringify(dashAuth)); } catch {}
  res.json({ ok: true });
});

// NWS alerts for the station location (5-min cache)
const dashAlertCache = new Map();
app.get('/api/dashboard/alerts', requireDashboardAuth, async (_req, res) => {
  let lat = dashAuth?.stationLat;
  let lon = dashAuth?.stationLon;
  if (lat == null && pushSubscriptions.length) { lat = pushSubscriptions[0].lat; lon = pushSubscriptions[0].lon; }
  if (lat == null) return res.json({ features: [], noLocation: true });
  const cacheKey = `${lat},${lon}`;
  const cached = dashAlertCache.get(cacheKey);
  if (cached && Date.now() - cached.at < 5 * 60 * 1000) return res.json(cached.data);
  try {
    const r = await fetchWithRetry(`https://api.weather.gov/alerts/active?point=${lat},${lon}`, {
      attempts: 1, timeoutMs: 12000,
      fetchOptions: { headers: { 'User-Agent': 'weather-app-v2 (nate@necloud.us)', Accept: 'application/geo+json' } },
    });
    const data = await r.json();
    dashAlertCache.set(cacheKey, { data, at: Date.now() });
    res.json(data);
  } catch { res.json({ features: [] }); }
});

// Consecutive dry/wet streak (from daily rain totals)
app.get('/api/station/streak', requireDashboardAuth, (_req, res) => {
  const readings = loadStationReadings(60 * 86400000);
  const byDay = {};
  for (const r of readings) {
    if (r.dailyrainin == null || !r.dateutc) continue;
    const d = stationDateKey(r.dateutc);
    if (byDay[d] == null || r.dailyrainin > byDay[d]) byDay[d] = r.dailyrainin;
  }
  const days = Object.keys(byDay).sort().reverse();
  if (!days.length) return res.json({ type: null, count: 0 });
  const latestRain = byDay[days[0]];
  const streakType = latestRain >= 0.01 ? 'wet' : 'dry';
  let count = 0;
  for (const d of days) {
    const rain = byDay[d];
    if (streakType === 'wet' ? rain >= 0.01 : rain < 0.01) count++;
    else break;
  }
  res.json({ type: streakType, count });
});

// Trend data — last reading vs 1h ago for each tile
app.get('/api/station/trend', requireDashboardAuth, (_req, res) => {
  const hour = loadStationReadings(3600000);
  if (hour.length < 2) return res.json({});
  const now = hour[hour.length - 1];
  const hourAgo = hour[0];
  const diff = (field) => {
    const a = hourAgo[field], b = now[field];
    if (a == null || b == null) return null;
    const d = b - a;
    return d > 0.1 ? 'up' : d < -0.1 ? 'down' : 'flat';
  };
  res.json({
    tempf: diff('tempf'), humidity: diff('humidity'), dewPoint: diff('dewPoint'),
    windspeedmph: diff('windspeedmph'), baromrelin: diff('baromrelin'),
    uv: diff('uv'), solarradiation: diff('solarradiation'),
  });
});

app.listen(PORT, () => {
  console.log(`Weather app running on port ${PORT}`);
  if (dashAuth) {
    console.log(`Dashboard recovery token (changes daily): ${getDailyRecoveryToken()}`);
    console.log(`  Use at http://localhost:${PORT}/dashboard/recover`);
  }
});
