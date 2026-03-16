const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

// Geocoding proxy
app.get('/api/geocode', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'Missing query' });
  try {
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=5&language=en&format=json`;
    const r = await fetch(url);
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: 'Geocoding failed', detail: e.message });
  }
});

// Weather proxy
app.get('/api/weather', async (req, res) => {
  const { lat, lon, tz } = req.query;
  if (!lat || !lon) return res.status(400).json({ error: 'Missing lat/lon' });
  const timezone = tz || 'auto';
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
        'wind_speed_10m','apparent_temperature'
      ].join(','),
      daily: [
        'weather_code','temperature_2m_max','temperature_2m_min',
        'precipitation_sum','precipitation_probability_max',
        'wind_speed_10m_max','sunrise','sunset','uv_index_max'
      ].join(','),
      forecast_days: 7,
      wind_speed_unit: 'mph',
      temperature_unit: 'fahrenheit',
      precipitation_unit: 'inch'
    });
    const r = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`);
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: 'Weather fetch failed', detail: e.message });
  }
});

// RainViewer timestamps proxy
app.get('/api/radar/times', async (req, res) => {
  try {
    const r = await fetch('https://api.rainviewer.com/public/weather-maps.json');
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: 'Radar times failed', detail: e.message });
  }
});

app.listen(PORT, () => console.log(`Weather app running on port ${PORT}`));
