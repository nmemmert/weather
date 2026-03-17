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

const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const STORAGE_KEYS = {
  lastCity: 'weather.lastCity',
  savedCities: 'weather.savedCities',
  units: 'weather.units',
  autoDetect: 'weather.autoDetect',
  showLightning: 'weather.showLightning',
  showWind: 'weather.showWind',
};

const state = {
  units: localStorage.getItem(STORAGE_KEYS.units) || 'us',
  autoDetect: localStorage.getItem(STORAGE_KEYS.autoDetect) !== 'false',
  showLightning: localStorage.getItem(STORAGE_KEYS.showLightning) !== 'false',
  showWind: localStorage.getItem(STORAGE_KEYS.showWind) !== 'false',
  currentCity: null,
  currentWeather: null,
  currentAir: null,
  currentSource: 'startup',
  savedCities: JSON.parse(localStorage.getItem(STORAGE_KEYS.savedCities) || '[]'),
  alertIdsSeen: new Set(),
  autoRefreshTimer: null,
  lastRefreshAt: 0,
  lightningMarkers: [],
  windArrows: [],
  showExtendedForecast: false,
};

// ── DOM ──────────────────────────────────────────────────────────────────────
const searchInput = document.getElementById('search-input');
const searchBtn = document.getElementById('search-btn');
const locateBtn = document.getElementById('locate-btn');
const suggestEl = document.getElementById('suggestions');
const errorMsg = document.getElementById('error-msg');
const loadingEl = document.getElementById('loading');
const weatherDiv = document.getElementById('weather');
const unitsBtn = document.getElementById('units-btn');
const unitsBtnSettings = document.getElementById('units-btn-settings');
const shareBtn = document.getElementById('share-btn');
const saveCurrentBtn = document.getElementById('save-current-btn');
const savedLocationsEl = document.getElementById('saved-locations');
const notifyBtn = document.getElementById('notify-btn');
const autoDetectToggle = document.getElementById('auto-detect-toggle');
const alertsEmptyEl = document.getElementById('alerts-empty');
const settingsLocationEl = document.getElementById('settings-location');
const mapsLocationEl = document.getElementById('maps-location');
const mapsWindEl = document.getElementById('maps-wind');
const lightningToggle = document.getElementById('lightning-toggle');
const windToggle = document.getElementById('wind-toggle');
const dailyToggleBtn = document.getElementById('daily-toggle-btn');
const dailyForecastLabel = document.getElementById('daily-forecast-label');

// ── Helpers ──────────────────────────────────────────────────────────────────
const show = el => el.classList.remove('hidden');
const hide = el => el.classList.add('hidden');
const showErr = msg => { errorMsg.textContent = msg; show(errorMsg); };
const clearErr = () => { errorMsg.textContent = ''; hide(errorMsg); };

function compassDir(deg) {
  return ['N','NE','E','SE','S','SW','W','NW'][Math.round(deg / 45) % 8];
}

function compassDirFull(deg) {
  return ['North','Northeast','East','Southeast','South','Southwest','West','Northwest'][Math.round(deg / 45) % 8];
}

function formatHour(iso) {
  const h = new Date(iso).getHours();
  return h === 0 ? '12 AM' : h < 12 ? `${h} AM` : h === 12 ? '12 PM' : `${h-12} PM`;
}

function formatDayShort(iso) {
  const d = new Date(iso + 'T00:00:00');
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === tomorrow.toDateString()) return 'Tomorrow';
  return DAYS[d.getDay()];
}

function formatClock(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function tempDisplay(v) {
  if (v == null || Number.isNaN(v)) return '--';
  const n = state.units === 'us' ? v : ((v - 32) * 5) / 9;
  return Math.round(n);
}

function speedDisplay(v) {
  if (v == null || Number.isNaN(v)) return '--';
  const n = state.units === 'us' ? v : v * 1.60934;
  return Math.round(n);
}

function precipDisplay(v) {
  if (v == null || Number.isNaN(v)) return '--';
  const n = state.units === 'us' ? v : v * 25.4;
  return n.toFixed(1);
}

function visDisplay(vMeters) {
  if (vMeters == null || Number.isNaN(vMeters)) return '--';
  const miles = vMeters / 1609;
  if (state.units === 'us') return miles.toFixed(1);
  return (miles * 1.60934).toFixed(1);
}

function tempUnit() { return state.units === 'us' ? 'F' : 'C'; }
function speedUnit() { return state.units === 'us' ? 'mph' : 'km/h'; }
function visUnit() { return state.units === 'us' ? 'mi' : 'km'; }

function updateUnitsButton() {
  const label = state.units === 'us' ? 'US' : 'Metric';
  unitsBtn.textContent = label;
  if (unitsBtnSettings) unitsBtnSettings.textContent = label;
}

function syncAutoDetectToggle() {
  autoDetectToggle.checked = state.autoDetect;
}

function updateNotifyButton() {
  if (!('Notification' in window)) {
    notifyBtn.textContent = 'Notifications unsupported';
    notifyBtn.disabled = true;
    return;
  }
  if (!window.isSecureContext) {
    notifyBtn.textContent = 'Needs HTTPS';
    notifyBtn.disabled = true;
    return;
  }

  notifyBtn.disabled = false;
  if (Notification.permission === 'granted') {
    notifyBtn.textContent = 'Notifications enabled';
  } else if (Notification.permission === 'denied') {
    notifyBtn.textContent = 'Notifications blocked';
  } else {
    notifyBtn.textContent = 'Enable notifications';
  }
}

function moonPhase(dateLike) {
  const date = new Date(dateLike);
  const synodic = 29.53058867;
  const knownNewMoon = new Date('2000-01-06T18:14:00Z');
  const days = (date - knownNewMoon) / 86400000;
  const phase = ((days % synodic) + synodic) % synodic;
  const index = Math.floor((phase / synodic) * 8) % 8;
  return ['New', 'Waxing Crescent', 'First Quarter', 'Waxing Gibbous', 'Full', 'Waning Gibbous', 'Last Quarter', 'Waning Crescent'][index];
}

function precipType(code, tempF, rain, snowfall) {
  if ((snowfall ?? 0) > 0) return 'Snow';
  if ([56,57,66,67].includes(code) || ((rain ?? 0) > 0 && tempF <= 32)) return 'Sleet';
  if ((rain ?? 0) > 0 || [51,53,55,61,63,65,80,81,82].includes(code)) return 'Rain';
  return 'Dry';
}

function calcDewpoint(tempF, rh) {
  const tc = (tempF - 32) * 5 / 9;
  const alpha = Math.log(rh / 100) + (17.62 * tc) / (243.12 + tc);
  const dewC = (243.12 * alpha) / (17.62 - alpha);
  return state.units === 'us' ? Math.round(dewC * 9 / 5 + 32) : Math.round(dewC);
}

function humidityFeel(rh) {
  if (rh < 25) return 'Very dry';
  if (rh < 35) return 'Dry';
  if (rh < 55) return 'Comfortable';
  if (rh < 65) return 'Moderate';
  if (rh < 75) return 'Humid';
  return 'Very humid';
}

function renderRecommendations(data) {
  const c = data.current;
  const d = data.daily;
  const temp = c.temperature_2m;
  const code = c.weather_code;
  const uv = d.uv_index_max[0] ?? 0;
  const wind = c.wind_speed_10m;
  const items = [];

  if (temp <= 32) items.push({ icon: '🧥', label: 'Heavy coat' });
  else if (temp <= 50) items.push({ icon: '🧣', label: 'Jacket' });
  else if (temp >= 85) items.push({ icon: '👕', label: 'Light clothes' });

  if ([51,53,55,61,63,65,66,67,80,81,82].includes(code)) {
    items.push({ icon: '☂️', label: 'Umbrella' });
    items.push({ icon: '🥾', label: 'Waterproof\nshoes' });
  }
  if ([71,73,75,77,85,86].includes(code)) {
    items.push({ icon: '🥾', label: 'Snow boots' });
    items.push({ icon: '🧤', label: 'Gloves' });
  }
  if (code >= 95) items.push({ icon: '⚡', label: 'Stay\nindoors' });
  if (c.is_day && uv >= 6) {
    items.push({ icon: '🕶️', label: 'Sunglasses' });
    items.push({ icon: '🧴', label: 'Sunscreen' });
  }
  if (wind >= 20) items.push({ icon: '💨', label: 'Windbreaker' });
  items.push({ icon: '💧', label: 'Water bottle' });

  const grid = document.getElementById('recommendations');
  if (!grid) return;
  grid.innerHTML = items.map(it =>
    `<div class="rec-item"><span class="rec-icon">${it.icon}</span><span class="rec-label">${it.label}</span></div>`
  ).join('');
}

function apparentLabel(tempF, apparentF) {
  if (tempF <= 50 && apparentF <= tempF - 2) return 'Wind chill';
  if (tempF >= 80 && apparentF >= tempF + 2) return 'Heat index';
  return 'Feels like';
}

function cityKey(city) {
  return `${Number(city.latitude).toFixed(3)},${Number(city.longitude).toFixed(3)}`;
}

function persistSavedCities() {
  localStorage.setItem(STORAGE_KEYS.savedCities, JSON.stringify(state.savedCities));
}

function persistLastCity(city) {
  localStorage.setItem(STORAGE_KEYS.lastCity, JSON.stringify(city));
}

function getLastCity() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEYS.lastCity) || 'null'); }
  catch { return null; }
}

function cityLabel(city) {
  return [city?.name, city?.admin1, city?.country].filter(Boolean).join(', ');
}

function updateShareUrl(city) {
  if (!city) return;
  const params = new URLSearchParams(window.location.search);
  params.set('lat', city.latitude);
  params.set('lon', city.longitude);
  params.set('name', city.name || 'Location');
  history.replaceState(null, '', `${window.location.pathname}?${params.toString()}`);
}

function updateSourceLocation(city) {
  const label = cityLabel(city) || (city ? `${Number(city.latitude).toFixed(2)}, ${Number(city.longitude).toFixed(2)}` : '--');
  if (settingsLocationEl) settingsLocationEl.textContent = label;
  if (mapsLocationEl) mapsLocationEl.textContent = label;
}

function renderSavedCities() {
  savedLocationsEl.innerHTML = '';
  if (!state.savedCities.length) {
    savedLocationsEl.textContent = 'None yet';
    return;
  }

  state.savedCities.forEach(city => {
    const wrap = document.createElement('div');
    wrap.className = 'saved-item';

    const chip = document.createElement('button');
    chip.className = 'saved-chip';
    chip.type = 'button';
    chip.textContent = city.name;
    chip.addEventListener('click', () => loadAll(city, 'saved-location'));

    const remove = document.createElement('button');
    remove.className = 'saved-remove';
    remove.type = 'button';
    remove.textContent = 'x';
    remove.addEventListener('click', (e) => {
      e.stopPropagation();
      state.savedCities = state.savedCities.filter(c => cityKey(c) !== cityKey(city));
      persistSavedCities();
      renderSavedCities();
    });

    wrap.appendChild(chip);
    wrap.appendChild(remove);
    savedLocationsEl.appendChild(wrap);
  });
}

// ── Tab switching ─────────────────────────────────────────────────────────────
function activateTab(tabName) {
  document.querySelectorAll('.tab, .bottom-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach(p => hide(p));
  document.querySelectorAll(`[data-tab="${tabName}"]`).forEach(t => t.classList.add('active'));
  show(document.getElementById('tab-' + tabName));

  if (tabName === 'conditions') {
    setTimeout(() => { radarEmbed.refresh && radarEmbed.refresh(); }, 60);
  }
  if (tabName === 'radar-full') {
    setTimeout(() => { radarFull.refresh && radarFull.refresh(); }, 50);
  }
  if (tabName === 'maps') {
    setTimeout(refreshMapsOverview, 80);
  }
}

document.querySelectorAll('.tab, .bottom-tab').forEach(btn => {
  btn.addEventListener('click', () => activateTab(btn.dataset.tab));
});

document.getElementById('open-radar-tab').addEventListener('click', () => {
  activateTab('radar-full');
});

// ── APIs ─────────────────────────────────────────────────────────────────────
async function geocode(q) {
  const r = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`);
  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    throw new Error(`Geocoding failed (${r.status})${detail ? `: ${detail.slice(0, 180)}` : ''}`);
  }
  return r.json();
}

async function reverseGeocode(lat, lon) {
  const r = await fetch(`/api/reverse-geocode?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`);
  if (!r.ok) throw new Error('Reverse geocoding failed');
  return r.json();
}

async function fetchJsonWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const response = await fetch(url, { cache: 'no-store', signal: controller.signal });
  clearTimeout(timeoutId);

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Request failed (${response.status})${detail ? `: ${detail.slice(0, 180)}` : ''}`);
  }
  return response.json();
}

async function fetchWeather(lat, lon, tz) {
  const proxyUrl = `/api/weather?lat=${lat}&lon=${lon}&tz=${encodeURIComponent(tz||'auto')}&units=${encodeURIComponent(state.units)}`;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await fetchJsonWithTimeout(proxyUrl, 22000);
    } catch (err) {
      const reason = err?.name === 'AbortError' ? 'timeout' : (err?.message || err);
      if (attempt >= 3) {
        throw new Error(`Weather proxy failed after ${attempt} attempts: ${reason}`);
      }
      await new Promise(resolve => setTimeout(resolve, 500 * attempt));
    }
  }
}

async function fetchAirQuality(lat, lon, tz) {
  const url = `/api/air-quality?lat=${lat}&lon=${lon}&tz=${encodeURIComponent(tz||'auto')}`;
  console.log('Fetching air quality from:', url);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Air quality fetch failed with status ${r.status}`);
  return r.json();
}

async function fetchAlerts(lat, lon) {
  const r = await fetch(`/api/alerts?lat=${lat}&lon=${lon}`);
  if (!r.ok) throw new Error('Alerts fetch failed');
  return r.json();
}

function detectedCityFallback(lat, lon) {
  return {
    name: `Detected location (${lat.toFixed(2)}, ${lon.toFixed(2)})`,
    latitude: lat,
    longitude: lon,
    country: '',
    admin1: '',
    timezone: 'auto',
  };
}

async function buildDetectedCity(lat, lon) {
  const fallback = detectedCityFallback(lat, lon);

  try {
    const place = await reverseGeocode(lat, lon);
    return {
      ...fallback,
      ...place,
      latitude: lat,
      longitude: lon,
      timezone: place.timezone || 'auto',
    };
  } catch {
    return fallback;
  }
}

// ── Radar engine ──────────────────────────────────────────────────────────────
function createRadar(mapEl, timelineEl, playBtn, tsEl, layerBtn) {
  const FRAME_INTERVAL_MS = 650;
  const FRAME_FADE_MS = 240;

  const map = L.map(mapEl, {
    center: [39.5, -98.35],
    zoom: 4,
    zoomControl: true,
    attributionControl: false,
  });

  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    maxZoom: 19,
  }).addTo(map);

  let radarFrames = [];
  let satelliteFrames = [];
  let mode = 'radar';
  let currentIdx = 0;
  let layers = { radar: {}, satellite: {} };
  let playing = false;
  let animTimer = null;
  let locationMarker = null;
  let visibleLayer = null;
  let framesReady = false;
  let loadingFrames = false;

  function activeFrames() {
    return mode === 'radar' ? radarFrames : satelliteFrames;
  }

  function tsLabel(unixSec) {
    const d = new Date(unixSec * 1000);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) +
      ' ' + MONTHS[d.getMonth()] + ' ' + d.getDate();
  }

  function frameTileUrl(frame) {
    if (mode === 'satellite') {
      return `https://tilecache.rainviewer.com${frame.path}/256/{z}/{x}/{y}/0/0_0.png`;
    }
    return `https://tilecache.rainviewer.com${frame.path}/256/{z}/{x}/{y}/2/1_1.png`;
  }

  function showFrame(idx) {
    const frames = activeFrames();
    currentIdx = idx;
    const frame = frames[idx];
    if (!frame) return;

    if (!layers[mode][frame.time]) {
      layers[mode][frame.time] = L.tileLayer(frameTileUrl(frame), { opacity: 0, maxZoom: 17 });
    }

    Object.values(layers.radar).forEach(l => {
      if (l !== visibleLayer && map.hasLayer(l)) map.removeLayer(l);
    });
    Object.values(layers.satellite).forEach(l => {
      if (l !== visibleLayer && map.hasLayer(l)) map.removeLayer(l);
    });

    const nextLayer = layers[mode][frame.time];
    if (!map.hasLayer(nextLayer)) {
      nextLayer.setOpacity(0);
      nextLayer.addTo(map);
    }

    nextLayer.setOpacity(0.78);

    if (visibleLayer && visibleLayer !== nextLayer && map.hasLayer(visibleLayer)) {
      visibleLayer.setOpacity(0.2);
      const prevLayer = visibleLayer;
      setTimeout(() => {
        if (prevLayer !== visibleLayer && map.hasLayer(prevLayer)) map.removeLayer(prevLayer);
      }, FRAME_FADE_MS);
    }

    visibleLayer = nextLayer;

    tsEl.textContent = tsLabel(frame.time);
    document.querySelectorAll(`#${timelineEl.id} .tl-tick`).forEach((el, i) => {
      el.classList.toggle('active', i === idx);
    });
  }

  function buildTimeline() {
    timelineEl.innerHTML = '';
    activeFrames().forEach((f, i) => {
      const tick = document.createElement('div');
      tick.className = 'tl-tick' + (f.isForecast ? ' forecast' : '');
      tick.title = tsLabel(f.time);
      tick.addEventListener('click', () => { stopPlay(); showFrame(i); });
      timelineEl.appendChild(tick);
    });
  }

  function step() {
    const frames = activeFrames();
    if (!frames.length) return;
    const next = (currentIdx + 1) % frames.length;
    showFrame(next);
    if (next === 0) {
      stopPlay();
      setTimeout(startPlay, 800);
    }
  }

  function startPlay() {
    playing = true;
    playBtn.textContent = '⏸';
    animTimer = setInterval(step, FRAME_INTERVAL_MS);
  }

  function stopPlay() {
    playing = false;
    playBtn.textContent = '▶';
    clearInterval(animTimer);
  }

  playBtn.addEventListener('click', () => playing ? stopPlay() : startPlay());

  if (layerBtn) {
    layerBtn.addEventListener('click', () => {
      if (!(radarFrames.length && satelliteFrames.length)) return;
      mode = mode === 'radar' ? 'satellite' : 'radar';
      layerBtn.textContent = mode === 'radar' ? 'R' : 'S';
      visibleLayer = null;
      buildTimeline();
      const idx = Math.min(currentIdx, activeFrames().length - 1);
      showFrame(Math.max(idx, 0));
    });
  }

  async function loadFrames() {
    if (loadingFrames || framesReady) return;
    loadingFrames = true;
    let retries = 0;
    const maxRetries = 2;

    try {
      while (retries < maxRetries) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 20000);
        
        const r = await fetch('/api/radar/times', { signal: controller.signal });
        clearTimeout(timeoutId);
        
        if (!r.ok) {
          throw new Error(`Radar fetch returned ${r.status}`);
        }
        const data = await r.json();

        radarFrames = [];
        satelliteFrames = [];
        (data.radar?.past || []).forEach(f => radarFrames.push({ time: f.time, path: f.path, isForecast: false }));
        (data.radar?.nowcast || []).forEach(f => radarFrames.push({ time: f.time, path: f.path, isForecast: true }));
        (data.satellite?.infrared || []).forEach(f => satelliteFrames.push({ time: f.time, path: f.path, isForecast: false }));

        if (!radarFrames.length && satelliteFrames.length) mode = 'satellite';
        if (!radarFrames.length && !satelliteFrames.length) {
          console.warn('No radar or satellite frames available');
          return;
        }

        if (layerBtn) {
          layerBtn.disabled = !(radarFrames.length && satelliteFrames.length);
          layerBtn.textContent = mode === 'radar' ? 'R' : 'S';
        }

        buildTimeline();
        const frames = activeFrames();
        showFrame(Math.max(frames.length - 1, 0));
        framesReady = true;
        return;
      } catch (e) {
        retries++;
        if (e.name === 'AbortError') {
          console.warn(`Radar load attempt ${retries} timed out - API slow or unavailable`);
        } else {
          console.error(`Radar load attempt ${retries} failed:`, e.message);
        }
        
        if (retries >= maxRetries) {
          console.error('Radar load failed after', maxRetries, 'attempts');
          return;
        }
        
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    } finally {
      loadingFrames = false;
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

  function isMapVisible() {
    return mapEl.offsetWidth > 0 && mapEl.offsetHeight > 0;
  }

  function refresh() {
    if (!isMapVisible()) return;
    map.invalidateSize();
    loadFrames();
  }

  // Wait for visibility before first load to avoid zero-size Leaflet rendering.
  setTimeout(() => {
    let tries = 0;
    const maxTries = 40; // ~10 seconds at 250ms interval
    const timer = setInterval(() => {
      tries++;
      if (isMapVisible()) {
        refresh();
        clearInterval(timer);
      } else if (tries >= maxTries) {
        clearInterval(timer);
      }
    }, 250);
  }, 100);

  return { map, panTo, startPlay, stopPlay, refresh };
}

const radarEmbed = createRadar(
  document.getElementById('radar-embed'),
  document.getElementById('embed-timeline'),
  document.getElementById('embed-play'),
  document.getElementById('embed-timestamp'),
  document.getElementById('embed-layer')
);

const radarFull = createRadar(
  document.getElementById('radar-full'),
  document.getElementById('full-timeline'),
  document.getElementById('full-play'),
  document.getElementById('full-timestamp'),
  document.getElementById('full-layer')
);

function createOverviewMap(mapEl) {
  const map = L.map(mapEl, {
    center: [39.5, -98.35],
    zoom: 4,
    zoomControl: true,
    attributionControl: false,
  });

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18,
  }).addTo(map);

  let marker = null;

  function panTo(lat, lon, zoom) {
    map.setView([lat, lon], zoom || map.getZoom());
    if (marker) map.removeLayer(marker);
    marker = L.circleMarker([lat, lon], {
      radius: 7,
      fillColor: '#e07848',
      fillOpacity: 1,
      color: '#fff',
      weight: 2,
    }).addTo(map);
  }

  return { map, panTo };
}

function clearLightningMarkers() {
  if (!mapsOverview.map) return;
  state.lightningMarkers.forEach(marker => mapsOverview.map.removeLayer(marker));
  state.lightningMarkers = [];
}

function clearWindArrows() {
  if (!mapsOverview.map) return;
  state.windArrows.forEach(arrow => mapsOverview.map.removeLayer(arrow));
  state.windArrows = [];
}

function refreshMapsOverview() {
  if (!mapsOverview.map) return;

  mapsOverview.map.invalidateSize();

  if (!state.currentCity) return;

  mapsOverview.panTo(state.currentCity.latitude, state.currentCity.longitude, 6);

  clearLightningMarkers();
  clearWindArrows();

  if (state.showLightning) renderLightningStrikes(state.currentCity);
  if (state.showWind && state.currentWeather) renderWindArrows(state.currentCity);
}

function renderLightningStrikes(city) {
  if (!mapsOverview.map || !state.showLightning) return;
  clearLightningMarkers();

  // Simulate lightning strikes in the vicinity of the city
  // In production, this would fetch from a real lightning API like Blitzortung
  const strokeCount = 5 + Math.random() * 3; // Random 5-8 strikes
  const maxRadius = 0.35;

  for (let i = 0; i < strokeCount; i++) {
    const angle = Math.random() * Math.PI * 2;
    const radius = Math.random() * maxRadius;
    const latOffset = Math.cos(angle) * radius;
    const lonOffset = Math.sin(angle) * radius;
    const lat = parseFloat(city.latitude) + latOffset;
    const lon = parseFloat(city.longitude) + lonOffset;

    const marker = L.circleMarker([lat, lon], {
      radius: 3 + Math.random() * 3,
      fillColor: '#ffeb3b',
      fillOpacity: 0.7 + Math.random() * 0.3,
      color: '#ff6f00',
      weight: 1.5,
      className: 'lightning-marker',
    }).bindPopup('⚡ Lightning strike (simulated)');

    marker.addTo(mapsOverview.map);
    state.lightningMarkers.push(marker);

    // Animate the marker to fade out
    setTimeout(() => {
      if (marker && mapsOverview.map.hasLayer(marker)) {
        const fade = setInterval(() => {
          const opacity = parseFloat(marker.options.fillOpacity) - 0.05;
          if (opacity <= 0) {
            clearInterval(fade);
            mapsOverview.map.removeLayer(marker);
          } else {
            marker.setStyle({ fillOpacity: opacity });
          }
        }, 200);
      }
    }, 3000);
  }
}

function renderWindArrows(city) {
  if (!mapsOverview.map || !state.showWind || !state.currentWeather) return;
  clearWindArrows();
  
  // Get current wind data
  const current = state.currentWeather.current;
  if (!current || current.wind_speed_10m == null) return;
  
  const windSpeed = current.wind_speed_10m;
  const windGust = current.wind_gusts_10m || 0;
  const windDir = current.wind_direction_10m || 0;
  
  // Update wind data display
  document.getElementById('wind-speed').textContent = `${speedDisplay(windSpeed)} ${speedUnit()}`;
  document.getElementById('wind-gust').textContent = windGust > 0 ? `${speedDisplay(windGust)} ${speedUnit()}` : '--';
  document.getElementById('wind-direction').textContent = compassDirFull(windDir);
  
  // Draw multiple wind barbs around the city center to show wind strength
  const lat = parseFloat(city.latitude);
  const lon = parseFloat(city.longitude);
  const arrowCount = Math.min(Math.ceil(windSpeed / 5), 5); // More arrows = stronger wind
  const baseRadius = 0.15;
  
  for (let i = 0; i < arrowCount; i++) {
    const offset = (i - arrowCount / 2) * 0.08;
    const offsetLat = lat + offset;
    const offsetLon = lon;
    
    // Calculate arrow end point based on wind direction
    const radians = (windDir * Math.PI) / 180;
    const arrowLength = 0.15 + i * 0.05;
    const endLat = offsetLat + arrowLength * Math.cos(radians);
    const endLon = offsetLon + arrowLength * Math.sin(radians);
    
    // Draw arrow line with gradient color based on wind speed
    const color = windSpeed > 20 ? '#ff3333' : windSpeed > 10 ? '#ffaa00' : '#4a90e2';
    const weight = 2.5 + (i % 2);
    
    const arrow = L.polyline(
      [[offsetLat, offsetLon], [endLat, endLon]],
      {
        color: color,
        weight: weight,
        opacity: 1.0,
        smooth: true,
      }
    ).bindPopup(`💨 Wind: ${speedDisplay(windSpeed)} ${speedUnit()}<br>Direction: ${compassDirFull(windDir)}`);
    
    arrow.addTo(mapsOverview.map);
    state.windArrows.push(arrow);
    
    // Draw arrow head
    const headSize = 0.05;
    const arrowHeadLat1 = endLat - headSize * Math.cos(radians + Math.PI * 0.15);
    const arrowHeadLon1 = endLon - headSize * Math.sin(radians + Math.PI * 0.15);
    const arrowHeadLat2 = endLat - headSize * Math.cos(radians - Math.PI * 0.15);
    const arrowHeadLon2 = endLon - headSize * Math.sin(radians - Math.PI * 0.15);
    
    const arrowHead = L.polyline(
      [[arrowHeadLat1, arrowHeadLon1], [endLat, endLon], [arrowHeadLat2, arrowHeadLon2]],
      {
        color: color,
        weight: weight,
        opacity: 1.0,
      }
    );
    
    arrowHead.addTo(mapsOverview.map);
    state.windArrows.push(arrowHead);
  }
}

const mapsOverview = createOverviewMap(document.getElementById('map-overview'));

// ── Rendering ────────────────────────────────────────────────────────────────
function renderWeather(data, city) {
  const c = data.current;
  const h = data.hourly;
  const d = data.daily;

  document.getElementById('loc-name').textContent = city.name;
  document.getElementById('loc-sub').textContent = [city.admin1, city.country].filter(Boolean).join(', ');

  const now = new Date();
  document.getElementById('loc-time').innerHTML =
    `${DAYS[now.getDay()]}, ${MONTHS[now.getMonth()]} ${now.getDate()}<br>` +
    now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  const w = wmo(c.weather_code);
  document.getElementById('cur-icon').textContent = w.icon;
  document.getElementById('cur-desc').textContent = w.desc;
  document.getElementById('cur-temp').textContent = tempDisplay(c.temperature_2m);
  document.querySelector('.deg').textContent = `°${tempUnit()}`;
  document.querySelector('.feels').innerHTML = `${apparentLabel(c.temperature_2m, c.apparent_temperature)} <span id="cur-feels">${tempDisplay(c.apparent_temperature)}</span>°${tempUnit()}`;
  document.getElementById('cur-hi').textContent = tempDisplay(d.temperature_2m_max[0]);
  document.getElementById('cur-lo').textContent = tempDisplay(d.temperature_2m_min[0]);
  document.getElementById('cur-precip').textContent = c.precipitation > 0 ? `${precipDisplay(c.precipitation)} ${state.units === 'us' ? 'in' : 'mm'} precip` : 'No precipitation';
  document.getElementById('cur-hum').textContent = c.relative_humidity_2m;
  document.getElementById('hum-feel').textContent = humidityFeel(c.relative_humidity_2m);
  document.getElementById('cur-wind').textContent = speedDisplay(c.wind_speed_10m);
  document.getElementById('cur-wind-dir').textContent = compassDirFull(c.wind_direction_10m);
  document.getElementById('cur-gust').textContent = c.wind_gusts_10m != null ? speedDisplay(c.wind_gusts_10m) : '—';
  document.getElementById('cur-dew').textContent = calcDewpoint(c.temperature_2m, c.relative_humidity_2m);
  document.getElementById('cur-pres').textContent = Math.round(c.surface_pressure);
  document.getElementById('cur-vis').textContent = visDisplay(c.visibility);
  document.getElementById('cur-uv').textContent = Math.round(d.uv_index_max[0] ?? 0);
  document.getElementById('cur-cloud').textContent = c.cloud_cover;
  document.querySelectorAll('.wind-unit, .gust-unit').forEach(el => el.textContent = speedUnit());
  document.querySelectorAll('.vis-unit').forEach(el => el.textContent = visUnit());

  document.getElementById('sunrise-val').textContent = formatClock(d.sunrise[0]);
  document.getElementById('sunset-val').textContent = formatClock(d.sunset[0]);
  document.getElementById('moon-phase-val').textContent = moonPhase(d.time[0]);

  // Sun timeline progress
  const sunriseMs = new Date(d.sunrise[0]).getTime();
  const sunsetMs  = new Date(d.sunset[0]).getTime();
  const nowMs     = Date.now();
  const totalMs   = sunsetMs - sunriseMs;
  const sunPct    = Math.max(0, Math.min(100, ((nowMs - sunriseMs) / totalMs) * 100));
  const progressEl = document.getElementById('sun-progress');
  const dotEl = document.getElementById('sun-dot');
  if (progressEl) progressEl.style.width = sunPct + '%';
  if (dotEl) dotEl.style.left = sunPct + '%';
  const daylightEl = document.getElementById('daylight-info');
  if (daylightEl) daylightEl.textContent = `${(totalMs / 3600000).toFixed(1)}h daylight`;

  renderRecommendations(data);

  const nowTs = Date.now();
  let startIdx = h.time.findIndex(t => new Date(t).getTime() >= nowTs);
  if (startIdx < 0) startIdx = 0;

  const track = document.getElementById('hourly-track');
  track.innerHTML = '';
  for (let i = startIdx; i < Math.min(startIdx + 24, h.time.length); i++) {
    const hw = wmo(h.weather_code[i]);
    const pp = h.precipitation_probability[i];
    const ptype = precipType(h.weather_code[i], h.temperature_2m[i], h.rain?.[i], h.snowfall?.[i]);
    const cell = document.createElement('div');
    cell.className = 'hour-cell' + (i === startIdx ? ' now' : '');
    cell.innerHTML = `
      <div class="hour-time">${i === startIdx ? 'Now' : formatHour(h.time[i])}</div>
      <div class="hour-icon">${hw.icon}</div>
      <div class="hour-temp">${tempDisplay(h.temperature_2m[i])}°</div>
      <div class="hour-precip">${pp > 0 ? `${pp}% ${ptype}` : ptype}</div>
    `;
    track.appendChild(cell);
  }

  state.showExtendedForecast = false;
  renderDailyForecast(d);

  document.getElementById('updated-at').textContent =
    new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  radarEmbed.panTo(city.latitude, city.longitude, 6);
  radarFull.panTo(city.latitude, city.longitude, 6);
  mapsOverview.panTo(city.latitude, city.longitude, 6);
  if (mapsWindEl) mapsWindEl.textContent = `${speedDisplay(c.wind_speed_10m)} ${speedUnit()} ${compassDir(c.wind_direction_10m)}`;
  updateSourceLocation(city);
  updateShareUrl(city);
  persistLastCity(city);
  refreshMapsOverview();

  show(weatherDiv);
  setTimeout(() => { radarEmbed.refresh && radarEmbed.refresh(); }, 80);
}

function renderDailyForecast(daily) {
  const list = document.getElementById('daily-list');
  if (!list || !daily?.time?.length) return;

  const totalDays = daily.time.length;
  const maxDays = state.showExtendedForecast ? Math.min(16, totalDays) : Math.min(7, totalDays);

  list.innerHTML = '';
  for (let i = 0; i < maxDays; i++) {
    const dw = wmo(daily.weather_code[i]);
    const row = document.createElement('div');
    row.className = 'day-row' + (i === 0 ? ' today' : '');
    row.innerHTML = `
      <div class="day-name">${formatDayShort(daily.time[i])}</div>
      <div class="day-icon">${dw.icon}</div>
      <div class="day-desc">${dw.desc}</div>
      <div class="day-temps">${tempDisplay(daily.temperature_2m_max[i])}°<span class="day-lo"> / ${tempDisplay(daily.temperature_2m_min[i])}°</span></div>
      <div class="day-meta">${daily.precipitation_probability_max[i] > 0 ? daily.precipitation_probability_max[i] + '% rain<br>' : ''}${speedDisplay(daily.wind_speed_10m_max[i])} ${speedUnit()}</div>
    `;
    list.appendChild(row);
  }

  if (dailyForecastLabel) {
    dailyForecastLabel.textContent = state.showExtendedForecast ? '16-Day Forecast' : '7-Day Forecast';
  }

  if (dailyToggleBtn) {
    if (totalDays > 7) {
      show(dailyToggleBtn);
      dailyToggleBtn.textContent = state.showExtendedForecast ? 'Show 7-day' : 'Show 16-day';
    } else {
      hide(dailyToggleBtn);
    }
  }
}

function renderAirQuality(data) {
  const cur = data?.current || {};
  const pollen = ['alder_pollen', 'birch_pollen', 'grass_pollen', 'mugwort_pollen', 'olive_pollen', 'ragweed_pollen']
    .map(k => cur[k] || 0)
    .reduce((max, v) => Math.max(max, v), 0);

  document.getElementById('aqi-us').textContent = cur.us_aqi ?? '--';
  document.getElementById('pm25').textContent = cur.pm2_5 != null ? `${Number(cur.pm2_5).toFixed(1)} ug/m3` : '--';
  document.getElementById('pollen').textContent = pollen > 0 ? pollen.toFixed(1) : '--';
}

function renderAlerts(data) {
  const wrap = document.getElementById('alerts-wrap');
  const list = document.getElementById('alerts-list');
  const features = data?.features || [];
  list.innerHTML = '';

  if (!features.length) {
    hide(wrap);
    if (alertsEmptyEl) show(alertsEmptyEl);
    return;
  }

  if (alertsEmptyEl) hide(alertsEmptyEl);

  features.slice(0, 5).forEach(f => {
    const p = f.properties || {};
    const item = document.createElement('div');
    item.className = 'alert-item';
    item.innerHTML = `<strong>${p.event || 'Alert'}</strong><span>${p.severity || 'Unknown severity'}</span><span>${p.headline || p.description || ''}</span>`;
    list.appendChild(item);
  });
  show(wrap);

  if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    features.forEach(f => {
      const id = f.id || f.properties?.id;
      if (!id || state.alertIdsSeen.has(id)) return;
      state.alertIdsSeen.add(id);
      const p = f.properties || {};
      new Notification(`Weather alert: ${p.event || 'Severe weather'}`, {
        body: p.headline || p.description || 'An alert was issued for your selected location.',
      });
    });
  }
}

async function loadAll(city, source) {
  state.currentCity = city;
  if (source) state.currentSource = source;
  clearErr();
  hide(suggestEl);
  hide(weatherDiv);
  show(loadingEl);

  try {
    let weather;
    try {
      weather = await fetchWeather(city.latitude, city.longitude, city.timezone);
    } catch (weatherErr) {
      console.error('Primary weather fetch failed:', weatherErr?.message || weatherErr);
      if (state.currentWeather) {
        weather = state.currentWeather;
        showErr('Live weather update failed. Showing last available data.');
      } else {
        throw weatherErr;
      }
    }

    const [airResult, alertsResult] = await Promise.allSettled([
      fetchAirQuality(city.latitude, city.longitude, city.timezone),
      fetchAlerts(city.latitude, city.longitude),
    ]);

    const air = airResult.status === 'fulfilled' ? airResult.value : { current: {} };
    if (airResult.status !== 'fulfilled') {
      console.warn('Air quality fetch failed:', airResult.reason?.message || airResult.reason);
    }

    const alerts = alertsResult.status === 'fulfilled' ? alertsResult.value : { features: [] };
    if (alertsResult.status !== 'fulfilled') {
      console.warn('Alerts fetch failed:', alertsResult.reason?.message || alertsResult.reason);
    }

    state.currentWeather = weather;
    state.currentAir = air;
    state.lastRefreshAt = Date.now();

    // Keep weather load resilient: map/radar/render hiccups should not fail the whole page.
    try {
      renderWeather(weather, city);
    } catch (renderErr) {
      console.error('Weather render error:', renderErr);
      show(weatherDiv);
    }

    try {
      renderAirQuality(air);
    } catch (airRenderErr) {
      console.warn('Air quality render error:', airRenderErr);
    }

    try {
      renderAlerts(alerts);
    } catch (alertsRenderErr) {
      console.warn('Alerts render error:', alertsRenderErr);
    }
    
    try {
      if (state.showLightning) renderLightningStrikes(city);
      if (state.showWind) renderWindArrows(city);
    } catch (mapOverlayErr) {
      console.warn('Map overlay render error:', mapOverlayErr);
    }
  } catch (e) {
    showErr('Failed to load weather data. Please try again.');
    console.error(e);
  } finally {
    hide(loadingEl);
  }
}

function getPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('Geolocation not supported'));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: false,
      timeout: 8000,
      maximumAge: 10 * 60 * 1000,
    });
  });
}

async function autoLocateAndLoad() {
  try {
    const pos = await getPosition();
    const { latitude: lat, longitude: lon } = pos.coords;
    const city = await buildDetectedCity(lat, lon);
    searchInput.value = city.name;
    await loadAll(city, 'auto-detect');
    return true;
  } catch {
    return false;
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
          loadAll(r, 'search-result');
        });
        suggestEl.appendChild(li);
      });
      show(suggestEl);
    } catch (err) {
      console.warn('Autocomplete geocode failed:', err?.message || err);
      hide(suggestEl);
    }
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
    loadAll(results[0], 'search-result');
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
      const city = await buildDetectedCity(lat, lon);
      await loadAll(city, 'gps-button');
    } catch {
      showErr('Could not fetch weather for your location.');
    } finally {
      hide(loadingEl);
    }
  }, () => {
    hide(loadingEl);
    showErr('Location access denied.');
  });
});

unitsBtn.addEventListener('click', () => {
  state.units = state.units === 'us' ? 'metric' : 'us';
  localStorage.setItem(STORAGE_KEYS.units, state.units);
  updateUnitsButton();
  if (state.currentWeather && state.currentCity) {
    renderWeather(state.currentWeather, state.currentCity);
    renderAirQuality(state.currentAir);
    // Update maps overlays if they're visible
    if (state.showWind && mapsOverview.map) {
      clearWindArrows();
      renderWindArrows(state.currentCity);
    }
  }
});

if (unitsBtnSettings) {
  unitsBtnSettings.addEventListener('click', () => unitsBtn.click());
}

shareBtn.addEventListener('click', async () => {
  if (!state.currentCity) return;
  try {
    await navigator.clipboard.writeText(window.location.href);
    shareBtn.textContent = 'Copied link';
    setTimeout(() => { shareBtn.textContent = 'Share location'; }, 1500);
  } catch {
    showErr('Could not copy URL to clipboard.');
  }
});

saveCurrentBtn.addEventListener('click', () => {
  if (!state.currentCity) return;
  const key = cityKey(state.currentCity);
  if (state.savedCities.some(c => cityKey(c) === key)) return;
  state.savedCities.push(state.currentCity);
  persistSavedCities();
  renderSavedCities();
});

notifyBtn.addEventListener('click', async () => {
  if (!('Notification' in window)) {
    showErr('Notifications are not supported in this browser.');
    return;
  }
  if (!window.isSecureContext) {
    showErr('Notifications require HTTPS (or localhost).');
    updateNotifyButton();
    return;
  }

  try {
    const permission = await Notification.requestPermission();
    updateNotifyButton();
    if (permission === 'granted') {
      // Re-fetch current alerts immediately so permission change can trigger notifications.
      if (state.currentCity) {
        const alerts = await fetchAlerts(state.currentCity.latitude, state.currentCity.longitude).catch(() => ({ features: [] }));
        renderAlerts(alerts);
      }
    } else if (permission === 'denied') {
      showErr('Notifications are blocked in browser settings for this site.');
    }
  } catch {
    showErr('Could not request notification permission.');
    updateNotifyButton();
  }
});

autoDetectToggle.addEventListener('change', () => {
  state.autoDetect = autoDetectToggle.checked;
  localStorage.setItem(STORAGE_KEYS.autoDetect, String(state.autoDetect));
});

lightningToggle.addEventListener('change', () => {
  state.showLightning = lightningToggle.checked;
  localStorage.setItem(STORAGE_KEYS.showLightning, String(state.showLightning));
  if (state.currentCity && mapsOverview.map) {
    clearLightningMarkers();
    if (state.showLightning) renderLightningStrikes(state.currentCity);
  }
});

windToggle.addEventListener('change', () => {
  state.showWind = windToggle.checked;
  localStorage.setItem(STORAGE_KEYS.showWind, String(state.showWind));
  if (state.currentCity && mapsOverview.map) {
    clearWindArrows();
    if (state.showWind && state.currentWeather) renderWindArrows(state.currentCity);
  }
});

// Maps tab quick toggles
const mapsLightningToggle = document.getElementById('maps-lightning-toggle');
const mapsWindToggle = document.getElementById('maps-wind-toggle');

if (mapsLightningToggle) {
  mapsLightningToggle.addEventListener('click', () => {
    state.showLightning = !state.showLightning;
    localStorage.setItem(STORAGE_KEYS.showLightning, String(state.showLightning));
    mapsLightningToggle.classList.toggle('active', state.showLightning);
    lightningToggle.checked = state.showLightning;
    if (state.currentCity && mapsOverview.map) {
      clearLightningMarkers();
      if (state.showLightning) renderLightningStrikes(state.currentCity);
    }
  });
  // Set initial state
  mapsLightningToggle.classList.toggle('active', state.showLightning);
}

if (mapsWindToggle) {
  mapsWindToggle.addEventListener('click', () => {
    state.showWind = !state.showWind;
    localStorage.setItem(STORAGE_KEYS.showWind, String(state.showWind));
    mapsWindToggle.classList.toggle('active', state.showWind);
    windToggle.checked = state.showWind;
    if (state.currentCity && mapsOverview.map) {
      clearWindArrows();
      if (state.showWind && state.currentWeather) renderWindArrows(state.currentCity);
    }
  });
  // Set initial state
  mapsWindToggle.classList.toggle('active', state.showWind);
}

if (dailyToggleBtn) {
  dailyToggleBtn.addEventListener('click', () => {
    state.showExtendedForecast = !state.showExtendedForecast;
    if (state.currentWeather) {
      renderDailyForecast(state.currentWeather.daily);
    }
  });
}

function startAutoRefresh() {
  clearInterval(state.autoRefreshTimer);
  state.autoRefreshTimer = setInterval(() => {
    if (state.currentCity) loadAll(state.currentCity, state.currentSource || 'auto-refresh');
  }, 10 * 60 * 1000);

  // Refresh shortly after users return to the tab if data is stale.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (!state.currentCity) return;
    if (Date.now() - state.lastRefreshAt > 10 * 60 * 1000) {
      loadAll(state.currentCity, state.currentSource || 'tab-resume-refresh');
    }
  });
}

// ── Default city / query link load ───────────────────────────────────────────
(async () => {
  updateUnitsButton();
  updateNotifyButton();
  syncAutoDetectToggle();
  
  // Sync lightning and wind toggle states
  lightningToggle.checked = state.showLightning;
  windToggle.checked = state.showWind;
  
  renderSavedCities();
  startAutoRefresh();

  const qs = new URLSearchParams(window.location.search);
  const qLat = Number(qs.get('lat'));
  const qLon = Number(qs.get('lon'));
  const qName = qs.get('name');
  if (!Number.isNaN(qLat) && !Number.isNaN(qLon) && qs.get('lat') && qs.get('lon')) {
    const city = {
      name: qName || `${qLat.toFixed(2)}, ${qLon.toFixed(2)}`,
      latitude: qLat,
      longitude: qLon,
      timezone: 'auto',
      country: '',
      admin1: ''
    };
    searchInput.value = city.name;
    await loadAll(city, 'shared-link');
    return;
  }

  if (state.autoDetect) {
    const autoLocated = await autoLocateAndLoad();
    if (autoLocated) return;
  }

  const lastCity = getLastCity();
  if (lastCity) {
    searchInput.value = lastCity.name;
    await loadAll(lastCity, 'last-city');
    return;
  }

  try {
    const data = await geocode('New York');
    const city = (data.results || [])[0];
    if (city) {
      searchInput.value = city.name;
      await loadAll(city, 'default-city');
    }
  } catch {
    // silent startup fallback
  }
})();
