const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const weatherCache = new Map();

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
    for (let attempt = 1; attempt <= 2; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 9000);
      try {
        const r = await fetch(url, { signal: controller.signal });
        clearTimeout(timeoutId);
        if (!r.ok) throw new Error(`Open-Meteo geocode status ${r.status}`);
        openMeteoData = await r.json();
        break;
      } catch (err) {
        clearTimeout(timeoutId);
        if (attempt === 2) {
          console.warn('Open-Meteo geocode failed after retries:', err.message);
        } else {
          await new Promise(resolve => setTimeout(resolve, 300 * attempt));
        }
      }
    }

    if (openMeteoData?.results?.length) {
      return res.json(openMeteoData);
    }

    // Fallback to Nominatim when Open-Meteo geocoding is empty/unavailable.
    const nomParams = new URLSearchParams({ q: String(q), format: 'jsonv2', limit: '5', addressdetails: '1' });
    const nom = await fetch(`https://nominatim.openstreetmap.org/search?${nomParams}`, {
      headers: {
        'User-Agent': 'weather-app-v2 (nate@necloud.us)',
        Accept: 'application/json',
      },
    });

    if (!nom.ok) {
      throw new Error(`Nominatim geocode status ${nom.status}`);
    }

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
    res.status(500).json({ error: 'Geocoding failed', detail: e.message });
  }
});

// Reverse geocoding proxy
app.get('/api/reverse-geocode', async (req, res) => {
  const { lat, lon } = req.query;
  if (!lat || !lon) return res.status(400).json({ error: 'Missing lat/lon' });

  try {
    const params = new URLSearchParams({
      format: 'jsonv2',
      lat: String(lat),
      lon: String(lon),
      zoom: '10',
      addressdetails: '1',
    });

    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?${params}`, {
      headers: {
        'User-Agent': 'weather-app-v2 (nate@necloud.us)',
        Accept: 'application/json',
      },
    });

    if (!r.ok) {
      throw new Error(`Reverse geocoding failed with status ${r.status}`);
    }

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
    res.status(500).json({ error: 'Reverse geocoding failed', detail: e.message });
  }
});

// Weather proxy
app.get('/api/weather', async (req, res) => {
  const { lat, lon, tz, units } = req.query;
  if (!lat || !lon) return res.status(400).json({ error: 'Missing lat/lon' });
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

    let lastError = null;
    const upstreamTimeoutMs = 12000;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), upstreamTimeoutMs);
      try {
        const r = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`, { signal: controller.signal });
        clearTimeout(timeoutId);
        const body = await r.text();

        if (!r.ok) {
          throw new Error(`Open-Meteo status ${r.status}: ${body.slice(0, 200)}`);
        }

        const data = JSON.parse(body);
        weatherCache.set(cacheKey, { data, at: Date.now() });
        return res.json(data);
      } catch (err) {
        clearTimeout(timeoutId);
        lastError = err;
        const reason = err?.name === 'AbortError' ? `timeout after ${upstreamTimeoutMs}ms` : (err?.message || 'unknown error');
        console.warn(`Weather upstream attempt ${attempt}/3 failed: ${reason}`);
        if (attempt < 3) {
          await new Promise(resolve => setTimeout(resolve, 500 * attempt));
        }
      }
    }

    throw lastError || new Error('Weather upstream failed');
  } catch (e) {
    const cached = weatherCache.get(cacheKey);
    if (cached && Date.now() - cached.at < 45 * 60 * 1000) {
      res.setHeader('X-Weather-Cache', 'stale-fallback');
      console.warn('Weather proxy using stale cache for', cacheKey);
      return res.json(cached.data);
    }
    console.error('Weather proxy failed:', e.message);
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
    let lastError = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 12000);
      try {
        const r = await fetch(`https://air-quality-api.open-meteo.com/v1/air-quality?${params}`, {
          signal: controller.signal,
        });
        clearTimeout(timeoutId);
        if (!r.ok) {
          throw new Error(`Open-Meteo status ${r.status}`);
        }
        const data = await r.json();
        return res.json(data);
      } catch (err) {
        clearTimeout(timeoutId);
        lastError = err;
        if (attempt < 2) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }
    }

    throw lastError || new Error('Air quality upstream failed');
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
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000);
    
    const r = await fetch(`https://api.weather.gov/alerts/active?point=${lat},${lon}`, {
      headers: {
        'User-Agent': 'weather-app-v2 (nate@necloud.us)',
        Accept: 'application/geo+json',
      },
      signal: controller.signal,
    });
    
    clearTimeout(timeoutId);
    
    if (!r.ok) {
      throw new Error(`NWS API returned ${r.status}`);
    }
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
      provider: 'iem-radar-rainviewer-sat',
      radar: {
        past: radarPast,
        nowcast: [],
      },
      satellite: {
        infrared: satelliteInfrared,
      },
    });
  } catch (e) {
    console.error('Radar config error:', e.message);
    res.status(500).json({ error: 'Radar times failed', detail: e.message });
  }
});

app.listen(PORT, () => console.log(`Weather app running on port ${PORT}`));
