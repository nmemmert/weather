'use strict';

// ── WMO codes ────────────────────────────────────────────────────────────────
const WMO = {
  0:{desc:'Clear sky',icon:'☀️'},1:{desc:'Mainly clear',icon:'🌤️'},
  2:{desc:'Partly cloudy',icon:'⛅'},3:{desc:'Overcast',icon:'☁️'},
  45:{desc:'Foggy',icon:'🌫️'},48:{desc:'Icy fog',icon:'🌫️'},
  51:{desc:'Light drizzle',icon:'🌦️'},53:{desc:'Drizzle',icon:'🌦️'},
  55:{desc:'Heavy drizzle',icon:'🌧️'},56:{desc:'Freezing drizzle',icon:'🌨️'},
  57:{desc:'Heavy freezing drizzle',icon:'🌨️'},
  61:{desc:'Light rain',icon:'🌧️'},63:{desc:'Rain',icon:'🌧️'},
  65:{desc:'Heavy rain',icon:'🌧️'},66:{desc:'Freezing rain',icon:'🌨️'},
  67:{desc:'Heavy freezing rain',icon:'🌨️'},
  71:{desc:'Light snow',icon:'🌨️'},73:{desc:'Snow',icon:'❄️'},
  75:{desc:'Heavy snow',icon:'❄️'},77:{desc:'Snow grains',icon:'🌨️'},
  80:{desc:'Light showers',icon:'🌦️'},81:{desc:'Showers',icon:'🌧️'},
  82:{desc:'Heavy showers',icon:'⛈️'},85:{desc:'Snow showers',icon:'🌨️'},
  86:{desc:'Heavy snow showers',icon:'❄️'},
  95:{desc:'Thunderstorm',icon:'⛈️'},96:{desc:'Thunderstorm w/ hail',icon:'⛈️'},
  99:{desc:'Severe thunderstorm',icon:'⛈️'},
};

function wmo(code) { return WMO[code] || { desc: 'Unknown', icon: '🌡️' }; }

const DAYS   = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// ── DOM ──────────────────────────────────────────────────────────────────────
const searchInput = document.getElementById('search-input');
const searchBtn   = document.getElementById('search-btn');
const locateBtn   = document.getElementById('locate-btn');
const suggestEl   = document.getElementById('suggestions');
const errorMsg    = document.getElementById('error-msg');
const loadingEl   = document.getElementById('loading');
const weatherDiv  = document.getElementById('weather');

// ── Helpers ──────────────────────────────────────────────────────────────────
const show = el => el.classList.remove('hidden');
const hide = el => el.classList.add('hidden');
const showErr = msg => { errorMsg.textContent = msg; show(errorMsg); };
const clearErr = () => { errorMsg.textContent = ''; hide(errorMsg); };

function compassDir(deg) {
  return ['N','NE','E','SE','S','SW','W','NW'][Math.round(deg / 45) % 8];
}

function formatHour(iso) {
  const h = new Date(iso).getHours();
  return h === 0 ? '12 AM' : h < 12 ? `${h} AM` : h === 12 ? '12 PM' : `${h-12} PM`;
}

function formatDayShort(iso) {
  const d = new Date(iso + 'T00:00:00');
  const today    = new Date();
  const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
  if (d.toDateString() === today.toDateString())    return 'Today';
  if (d.toDateString() === tomorrow.toDateString()) return 'Tomorrow';
  return DAYS[d.getDay()];
}

// ── Tab switching ─────────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => hide(p));
    btn.classList.add('active');
    show(document.getElementById('tab-' + btn.dataset.tab));
    if (btn.dataset.tab === 'radar-full') {
      setTimeout(() => { radarFull.map && radarFull.map.invalidateSize(); }, 50);
    }
  });
});

document.getElementById('open-radar-tab').addEventListener('click', () => {
  document.querySelector('.tab[data-tab="radar-full"]').click();
});

// ── Geocoding ─────────────────────────────────────────────────────────────────
async function geocode(q) {
  const r = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`);
  if (!r.ok) throw new Error('Geocoding failed');
  return r.json();
}

async function fetchWeather(lat, lon, tz) {
  const r = await fetch(`/api/weather?lat=${lat}&lon=${lon}&tz=${encodeURIComponent(tz||'auto')}`);
  if (!r.ok) throw new Error('Weather fetch failed');
  return r.json();
}

// ── Radar engine ──────────────────────────────────────────────────────────────
// Creates a self-contained animated radar on a Leaflet map
function createRadar(mapEl, timelineEl, playBtn, tsEl) {
  const map = L.map(mapEl, {
    center: [39.5, -98.35],
    zoom: 4,
    zoomControl: true,
    attributionControl: false,
  });

  // Dark basemap
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    maxZoom: 19,
  }).addTo(map);

  let frames = [];       // [{time, path, isForcast}]
  let currentIdx = 0;
  let layers = {};       // time → L.TileLayer
  let playing = false;
  let animTimer = null;
  let locationMarker = null;

  function tsLabel(unixSec) {
    const d = new Date(unixSec * 1000);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) +
      ' ' + MONTHS[d.getMonth()] + ' ' + d.getDate();
  }

  function showFrame(idx) {
    currentIdx = idx;
    const frame = frames[idx];
    if (!frame) return;

    // Add layer if not cached
    if (!layers[frame.time]) {
      layers[frame.time] = L.tileLayer(
        `https://tilecache.rainviewer.com${frame.path}/256/{z}/{x}/{y}/2/1_1.png`,
        { opacity: 0.75, maxZoom: 15 }
      );
    }

    // Hide all, show current
    Object.values(layers).forEach(l => { if (map.hasLayer(l)) map.removeLayer(l); });
    layers[frame.time].addTo(map);

    // Update UI
    tsEl.textContent = tsLabel(frame.time);
    document.querySelectorAll(`#${timelineEl.id} .tl-tick`).forEach((el, i) => {
      el.classList.toggle('active', i === idx);
    });
  }

  function buildTimeline() {
    timelineEl.innerHTML = '';
    frames.forEach((f, i) => {
      const tick = document.createElement('div');
      tick.className = 'tl-tick' + (f.isForecast ? ' forecast' : '');
      tick.title = tsLabel(f.time);
      tick.addEventListener('click', () => { stopPlay(); showFrame(i); });
      timelineEl.appendChild(tick);
    });
  }

  function step() {
    const next = (currentIdx + 1) % frames.length;
    showFrame(next);
    if (next === 0) {
      // pause at loop end briefly
      stopPlay();
      setTimeout(startPlay, 800);
    }
  }

  function startPlay() {
    playing = true;
    playBtn.textContent = '⏸';
    animTimer = setInterval(step, 500);
  }

  function stopPlay() {
    playing = false;
    playBtn.textContent = '▶';
    clearInterval(animTimer);
  }

  playBtn.addEventListener('click', () => playing ? stopPlay() : startPlay());

  async function loadFrames() {
    try {
      const r = await fetch('/api/radar/times');
      const data = await r.json();
      frames = [];

      // Past frames
      (data.radar?.past || []).forEach(f => frames.push({ time: f.time, path: f.path, isForecast: false }));
      // Forecast frames
      (data.radar?.nowcast || []).forEach(f => frames.push({ time: f.time, path: f.path, isForecast: true }));

      if (frames.length === 0) return;

      buildTimeline();
      showFrame(frames.length - 1); // show most recent
    } catch (e) {
      console.error('Radar load failed', e);
    }
  }

  function panTo(lat, lon, zoom) {
    map.setView([lat, lon], zoom || map.getZoom());
    if (locationMarker) map.removeLayer(locationMarker);
    locationMarker = L.circleMarker([lat, lon], {
      radius: 6,
      fillColor: '#e07848',
      fillOpacity: 1,
      color: '#fff',
      weight: 2,
    }).addTo(map);
  }

  loadFrames();

  return { map, panTo, startPlay, stopPlay };
}

// ── Instantiate both radar instances ─────────────────────────────────────────
const radarEmbed = createRadar(
  document.getElementById('radar-embed'),
  document.getElementById('embed-timeline'),
  document.getElementById('embed-play'),
  document.getElementById('embed-timestamp')
);

const radarFull = createRadar(
  document.getElementById('radar-full'),
  document.getElementById('full-timeline'),
  document.getElementById('full-play'),
  document.getElementById('full-timestamp')
);

// ── Render weather data ───────────────────────────────────────────────────────
function render(data, city) {
  const c = data.current;
  const h = data.hourly;
  const d = data.daily;

  document.getElementById('loc-name').textContent = city.name;
  document.getElementById('loc-sub').textContent  = [city.admin1, city.country].filter(Boolean).join(', ');

  const now = new Date();
  document.getElementById('loc-time').innerHTML =
    `${DAYS[now.getDay()]}, ${MONTHS[now.getMonth()]} ${now.getDate()}<br>` +
    now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  const w = wmo(c.weather_code);
  document.getElementById('cur-icon').textContent  = w.icon;
  document.getElementById('cur-desc').textContent  = w.desc;
  document.getElementById('cur-temp').textContent  = Math.round(c.temperature_2m);
  document.getElementById('cur-feels').textContent = Math.round(c.apparent_temperature);
  document.getElementById('cur-hi').textContent    = Math.round(d.temperature_2m_max[0]);
  document.getElementById('cur-lo').textContent    = Math.round(d.temperature_2m_min[0]);
  document.getElementById('cur-precip').textContent = c.precipitation > 0 ? `${c.precipitation.toFixed(2)}" precip` : 'No precipitation';
  document.getElementById('cur-hum').textContent   = c.relative_humidity_2m;
  document.getElementById('cur-wind').textContent  = `${Math.round(c.wind_speed_10m)} ${compassDir(c.wind_direction_10m)}`;
  document.getElementById('cur-pres').textContent  = Math.round(c.surface_pressure);
  document.getElementById('cur-vis').textContent   = c.visibility != null ? (c.visibility / 1609).toFixed(1) : '--';
  document.getElementById('cur-uv').textContent    = Math.round(d.uv_index_max[0] ?? 0);
  document.getElementById('cur-cloud').textContent = c.cloud_cover;

  // Hourly
  const nowHour = new Date().toISOString().slice(0, 13);
  const startIdx = h.time.findIndex(t => t >= nowHour);
  const track = document.getElementById('hourly-track');
  track.innerHTML = '';
  for (let i = startIdx; i < Math.min(startIdx + 24, h.time.length); i++) {
    const hw = wmo(h.weather_code[i]);
    const pp = h.precipitation_probability[i];
    const cell = document.createElement('div');
    cell.className = 'hour-cell' + (i === startIdx ? ' now' : '');
    cell.innerHTML = `
      <div class="hour-time">${i === startIdx ? 'Now' : formatHour(h.time[i])}</div>
      <div class="hour-icon">${hw.icon}</div>
      <div class="hour-temp">${Math.round(h.temperature_2m[i])}°</div>
      <div class="hour-precip">${pp > 0 ? pp + '%' : ''}</div>
    `;
    track.appendChild(cell);
  }

  // Daily
  const list = document.getElementById('daily-list');
  list.innerHTML = '';
  for (let i = 0; i < d.time.length; i++) {
    const dw = wmo(d.weather_code[i]);
    const row = document.createElement('div');
    row.className = 'day-row' + (i === 0 ? ' today' : '');
    row.innerHTML = `
      <div class="day-name">${formatDayShort(d.time[i])}</div>
      <div class="day-icon">${dw.icon}</div>
      <div class="day-desc">${dw.desc}</div>
      <div class="day-temps">${Math.round(d.temperature_2m_max[i])}°<span class="day-lo"> / ${Math.round(d.temperature_2m_min[i])}°</span></div>
      <div class="day-meta">${d.precipitation_probability_max[i] > 0 ? d.precipitation_probability_max[i] + '% rain<br>' : ''}${Math.round(d.wind_speed_10m_max[i])} mph</div>
    `;
    list.appendChild(row);
  }

  document.getElementById('updated-at').textContent =
    new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  // Pan both radar maps to the city
  const zoom = 6;
  radarEmbed.panTo(city.latitude, city.longitude, zoom);
  radarFull.panTo(city.latitude, city.longitude, zoom);

  show(weatherDiv);
}

// ── Load weather for a city ───────────────────────────────────────────────────
async function loadWeather(city) {
  clearErr();
  hide(suggestEl);
  hide(weatherDiv);
  show(loadingEl);
  try {
    const data = await fetchWeather(city.latitude, city.longitude, city.timezone);
    render(data, city);
  } catch (e) {
    showErr('Failed to load weather data. Please try again.');
    console.error(e);
  } finally {
    hide(loadingEl);
  }
}

// ── Search autocomplete ───────────────────────────────────────────────────────
let debounceTimer = null;

searchInput.addEventListener('input', () => {
  clearTimeout(debounceTimer);
  const q = searchInput.value.trim();
  if (q.length < 2) { hide(suggestEl); return; }
  debounceTimer = setTimeout(async () => {
    try {
      const data = await geocode(q);
      const results = data.results || [];
      suggestEl.innerHTML = '';
      if (!results.length) { hide(suggestEl); return; }
      results.forEach(r => {
        const li = document.createElement('li');
        li.innerHTML = `${r.name}<span class="sug-country">${r.admin1 ? r.admin1 + ', ' : ''}${r.country || ''}</span>`;
        li.addEventListener('click', () => {
          searchInput.value = r.name;
          hide(suggestEl);
          loadWeather(r);
        });
        suggestEl.appendChild(li);
      });
      show(suggestEl);
    } catch { hide(suggestEl); }
  }, 300);
});

document.addEventListener('click', e => {
  if (!e.target.closest('.search-wrap')) hide(suggestEl);
});

function doSearch() {
  const q = searchInput.value.trim();
  if (!q) { showErr('Please enter a city name.'); return; }
  clearErr();
  hide(suggestEl);
  geocode(q).then(data => {
    const results = data.results || [];
    if (!results.length) { showErr(`No results found for "${q}".`); return; }
    loadWeather(results[0]);
  }).catch(() => showErr('Search failed. Please try again.'));
}

searchBtn.addEventListener('click', doSearch);
searchInput.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });

// ── Geolocation ───────────────────────────────────────────────────────────────
locateBtn.addEventListener('click', () => {
  if (!navigator.geolocation) { showErr('Geolocation not supported.'); return; }
  clearErr();
  hide(weatherDiv);
  show(loadingEl);
  navigator.geolocation.getCurrentPosition(async pos => {
    const { latitude: lat, longitude: lon } = pos.coords;
    try {
      const geoData = await geocode(`${lat.toFixed(2)},${lon.toFixed(2)}`);
      const city = geoData.results?.[0] || {
        name: `${lat.toFixed(2)}, ${lon.toFixed(2)}`,
        latitude: lat, longitude: lon,
        country: '', admin1: '', timezone: 'auto'
      };
      city.latitude = lat; city.longitude = lon;
      const data = await fetchWeather(lat, lon, city.timezone || 'auto');
      render(data, city);
    } catch (e) {
      showErr('Could not fetch weather for your location.');
    } finally {
      hide(loadingEl);
    }
  }, () => { hide(loadingEl); showErr('Location access denied.'); });
});

// ── Default city ──────────────────────────────────────────────────────────────
(async () => {
  try {
    const data = await geocode('New York');
    const city = (data.results || [])[0];
    if (city) { searchInput.value = city.name; await loadWeather(city); }
  } catch { /* silent */ }
})();
