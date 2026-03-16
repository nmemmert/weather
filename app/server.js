const express = require('express');
const path = require('path');
const webpush = require('web-push');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '256kb' }));

// Lightweight request logging for observability.
app.use((req, res, next) => {
  const started = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - started;
    console.log(`${new Date().toISOString()} ${req.method} ${req.originalUrl} ${res.statusCode} ${ms}ms`);
  });
  next();
});

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchJsonWithRetry(url, options = {}, attempts = 3, initialDelayMs = 300) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(url, options);
      if (!r.ok) {
        const text = await r.text().catch(() => '');
        throw new Error(`Upstream status ${r.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
      }
      return await r.json();
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) {
        await sleep(initialDelayMs * Math.pow(2, i));
      }
    }
  }
  throw lastErr || new Error('Unknown upstream fetch error');
}

const subscriptions = new Map();

function getVapidConfig() {
  const publicKey = process.env.VAPID_PUBLIC_KEY || '';
  const privateKey = process.env.VAPID_PRIVATE_KEY || '';
  const subject = process.env.VAPID_SUBJECT || 'mailto:nate@necloud.us';
  return { publicKey, privateKey, subject };
}

function pushConfigured() {
  const cfg = getVapidConfig();
  return Boolean(cfg.publicKey && cfg.privateKey);
}

function ensurePushConfigured() {
  const cfg = getVapidConfig();
  if (!cfg.publicKey || !cfg.privateKey) {
    return false;
  }
  webpush.setVapidDetails(cfg.subject, cfg.publicKey, cfg.privateKey);
  return true;
}

app.use(express.static(path.join(__dirname, 'public')));

app.get('/healthz', (_req, res) => {
  res.json({
    ok: true,
    uptimeSec: Math.round(process.uptime()),
    pushConfigured: pushConfigured(),
    subscriptionCount: subscriptions.size,
    now: new Date().toISOString(),
  });
});

// Geocoding proxy
app.get('/api/geocode', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'Missing query' });
  try {
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=5&language=en&format=json`;
    const data = await fetchJsonWithRetry(url);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: 'Geocoding failed', detail: e.message });
  }
});

// Reverse geocoding proxy
app.get('/api/reverse-geocode', async (req, res) => {
  const { lat, lon } = req.query;
  if (!lat || !lon) return res.status(400).json({ error: 'Missing lat/lon' });

  try {
    // Prefer Open-Meteo reverse geocoding for stable city/region labels.
    const omParams = new URLSearchParams({
      latitude: String(lat),
      longitude: String(lon),
      count: '1',
      language: 'en',
      format: 'json',
    });

    const omData = await fetchJsonWithRetry(`https://geocoding-api.open-meteo.com/v1/reverse?${omParams}`, {}, 2, 200).catch(() => null);
    if (omData) {
      const top = omData?.results?.[0];
      if (top) {
        return res.json({
          name: top.name || top.admin2 || top.admin1 || top.country || 'Detected location',
          admin1: top.admin1 || top.admin2 || '',
          country: top.country || '',
          latitude: Number(lat),
          longitude: Number(lon),
          timezone: top.timezone || 'auto',
          display_name: [top.name, top.admin1, top.country].filter(Boolean).join(', '),
        });
      }
    }

    const params = new URLSearchParams({
      format: 'jsonv2',
      lat: String(lat),
      lon: String(lon),
      zoom: '10',
      addressdetails: '1',
    });

    const data = await fetchJsonWithRetry(`https://nominatim.openstreetmap.org/reverse?${params}`, {
      headers: {
        'User-Agent': 'weather-app-v2 (nate@necloud.us)',
        Accept: 'application/json',
      },
    });

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
    res.status(500).json({ error: 'Reverse geocoding failed', detail: e.message });
  }
});

// Weather proxy
app.get('/api/weather', async (req, res) => {
  const { lat, lon, tz, units } = req.query;
  if (!lat || !lon) return res.status(400).json({ error: 'Missing lat/lon' });
  const timezone = tz || 'auto';
  const useMetric = units === 'metric';
  try {
    const params = new URLSearchParams({
      latitude: lat, longitude: lon, timezone,
      current: [
        'temperature_2m','relative_humidity_2m','apparent_temperature',
        'is_day','precipitation','weather_code','cloud_cover',
        'wind_speed_10m','wind_direction_10m','surface_pressure','visibility'
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
    const data = await fetchJsonWithRetry(`https://api.open-meteo.com/v1/forecast?${params}`);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: 'Weather fetch failed', detail: e.message });
  }
});

// Open-Meteo Air Quality proxy
app.get('/api/air-quality', async (req, res) => {
  const { lat, lon, tz } = req.query;
  if (!lat || !lon) return res.status(400).json({ error: 'Missing lat/lon' });
  try {
    const params = new URLSearchParams({
      latitude: lat,
      longitude: lon,
      timezone: tz || 'auto',
      current: ['us_aqi', 'pm2_5', 'alder_pollen', 'birch_pollen', 'grass_pollen', 'mugwort_pollen', 'olive_pollen', 'ragweed_pollen'].join(','),
      forecast_days: 1,
    });
    const data = await fetchJsonWithRetry(`https://air-quality-api.open-meteo.com/v1/air-quality?${params}`);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: 'Air quality fetch failed', detail: e.message });
  }
});

// NWS alerts proxy (US only)
app.get('/api/alerts', async (req, res) => {
  const { lat, lon } = req.query;
  if (!lat || !lon) return res.status(400).json({ error: 'Missing lat/lon' });
  try {
    const data = await fetchJsonWithRetry(`https://api.weather.gov/alerts/active?point=${lat},${lon}`, {
      headers: {
        'User-Agent': 'weather-app-v2 (nate@necloud.us)',
        Accept: 'application/geo+json',
      },
    });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: 'Alerts fetch failed', detail: e.message });
  }
});

// Lightning activity from active weather.gov thunderstorm alerts (real alert geometries).
app.get('/api/lightning', async (req, res) => {
  const { lat, lon, age } = req.query;
  if (!lat || !lon) return res.status(400).json({ error: 'Missing lat/lon' });
  const ageMinutes = Number(age || 15);

  try {
    const data = await fetchJsonWithRetry(`https://api.weather.gov/alerts/active?point=${lat},${lon}`, {
      headers: {
        'User-Agent': 'weather-app-v2 (nate@necloud.us)',
        Accept: 'application/geo+json',
      },
    });

    const cutoff = Date.now() - (Number.isFinite(ageMinutes) ? ageMinutes : 15) * 60 * 1000;
    const features = (data?.features || []).filter(f => {
      const p = f?.properties || {};
      const event = String(p.event || '').toLowerCase();
      const relevant = event.includes('thunderstorm') || event.includes('lightning');
      if (!relevant) return false;
      const ts = Date.parse(p.sent || p.onset || p.effective || '');
      if (Number.isNaN(ts)) return true;
      return ts >= cutoff;
    });

    res.json({
      source: 'weather.gov alerts',
      count: features.length,
      features,
      ageMinutes: Number.isFinite(ageMinutes) ? ageMinutes : 15,
    });
  } catch (e) {
    res.status(500).json({ error: 'Lightning fetch failed', detail: e.message });
  }
});

app.get('/api/push/public-key', (_req, res) => {
  const { publicKey } = getVapidConfig();
  res.json({
    enabled: pushConfigured(),
    publicKey: publicKey || null,
  });
});

app.post('/api/push/subscribe', (req, res) => {
  const { subscription, location } = req.body || {};
  if (!subscription?.endpoint) {
    return res.status(400).json({ error: 'Missing subscription endpoint' });
  }
  subscriptions.set(subscription.endpoint, {
    subscription,
    location: location || null,
    createdAt: Date.now(),
  });
  res.json({ ok: true, count: subscriptions.size });
});

app.post('/api/push/unsubscribe', (req, res) => {
  const { endpoint } = req.body || {};
  if (!endpoint) return res.status(400).json({ error: 'Missing endpoint' });
  subscriptions.delete(endpoint);
  res.json({ ok: true, count: subscriptions.size });
});

app.post('/api/push/test', async (req, res) => {
  if (!ensurePushConfigured()) {
    return res.status(400).json({
      error: 'Push is not configured. Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY.',
    });
  }

  const payload = JSON.stringify({
    title: req.body?.title || 'Weather test notification',
    body: req.body?.body || 'Push notifications are working.',
    url: req.body?.url || '/',
    ts: Date.now(),
  });

  let sent = 0;
  let removed = 0;
  const errors = [];

  const entries = Array.from(subscriptions.values());
  for (const entry of entries) {
    try {
      await webpush.sendNotification(entry.subscription, payload);
      sent++;
    } catch (e) {
      const statusCode = e?.statusCode;
      if (statusCode === 404 || statusCode === 410) {
        subscriptions.delete(entry.subscription.endpoint);
        removed++;
      } else {
        errors.push(String(e.message || e));
      }
    }
  }

  res.json({ ok: true, sent, removed, errors, count: subscriptions.size });
});

// RainViewer timestamps proxy
app.get('/api/radar/times', async (req, res) => {
  try {
    const data = await fetchJsonWithRetry('https://api.rainviewer.com/public/weather-maps.json');
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: 'Radar times failed', detail: e.message });
  }
});

app.listen(PORT, () => console.log(`Weather app running on port ${PORT}`));
