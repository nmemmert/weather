const express = require('express');
const path = require('path');
const fs = require('fs');
const webpush = require('web-push');

const app = express();
const PORT = process.env.PORT || 3000;
const weatherCache = new Map();
const WEATHER_CACHE_MAX_ENTRIES = 500;

// ── Persistent data directory ─────────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

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
app.post('/api/ambient-config', (req, res) => {
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
  if (!pushSubscriptions.length) return;
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
        if (d?.dateutc && Date.now() - d.dateutc < 15 * 60 * 1000) stationObs = d;
      }
    } catch {}
  }

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
setInterval(alertWatcherCron, 10 * 60 * 1000);

app.listen(PORT, () => console.log(`Weather app running on port ${PORT}`));
