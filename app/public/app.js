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
  defaultCity: 'weather.defaultCity',
  highContrast: 'weather.highContrast',
  radarOpacity: 'weather.radarOpacity',
  lightningAgeMin: 'weather.lightningAgeMin',
};

function parseSavedCities(raw) {
  try {
    const parsed = JSON.parse(raw || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.map((entry) => {
      if (entry && entry.city && typeof entry.city === 'object') {
        return {
          city: entry.city,
          addedAt: entry.addedAt || Date.now(),
          lastViewedAt: entry.lastViewedAt || null,
          isDefault: Boolean(entry.isDefault),
        };
      }
      return {
        city: entry,
        addedAt: Date.now(),
        lastViewedAt: null,
        isDefault: false,
      };
    }).filter(e => e.city && e.city.latitude != null && e.city.longitude != null);
  } catch {
    return [];
  }
}

const state = {
  units: localStorage.getItem(STORAGE_KEYS.units) || 'us',
  autoDetect: localStorage.getItem(STORAGE_KEYS.autoDetect) !== 'false',
  showLightning: localStorage.getItem(STORAGE_KEYS.showLightning) !== 'false',
  showWind: localStorage.getItem(STORAGE_KEYS.showWind) !== 'false',
  highContrast: localStorage.getItem(STORAGE_KEYS.highContrast) === 'true',
  radarOpacity: Number(localStorage.getItem(STORAGE_KEYS.radarOpacity) || 65),
  lightningAgeMin: Number(localStorage.getItem(STORAGE_KEYS.lightningAgeMin) || 15),
  currentCity: null,
  currentWeather: null,
  currentAir: null,
  currentSource: 'startup',
  savedCities: parseSavedCities(localStorage.getItem(STORAGE_KEYS.savedCities)),
  alertIdsSeen: new Set(),
  autoRefreshTimer: null,
  lastRefreshAt: 0,
  lightningLayer: null,
  windArrows: [],
  dailyExpanded: false,
  pushSupported: false,
  pushEnabled: false,
};

const persistedDefaultKey = localStorage.getItem(STORAGE_KEYS.defaultCity);
if (persistedDefaultKey && state.savedCities.length && !state.savedCities.some(e => e.isDefault)) {
  state.savedCities = state.savedCities.map(e => ({ ...e, isDefault: cityKey(e.city) === persistedDefaultKey }));
}

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
const lightningStatus = document.getElementById('lightning-status');
const windStatus = document.getElementById('wind-status');
const dailyForecastLabel = document.getElementById('daily-forecast-label');
const dailyForecastToggle = document.getElementById('daily-forecast-toggle');
const pushTestBtn = document.getElementById('push-test-btn');
const hourlySummaryEl = document.getElementById('hourly-summary');
const defaultCityEl = document.getElementById('default-city');
const contrastToggle = document.getElementById('contrast-toggle');
const contrastStatus = document.getElementById('contrast-status');
const radarOpacityEl = document.getElementById('radar-opacity');
const lightningAgeEl = document.getElementById('lightning-age');
const mapsFullscreenBtn = document.getElementById('maps-fullscreen-btn');

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
  return Math.round(v);
}

function speedDisplay(v) {
  if (v == null || Number.isNaN(v)) return '--';
  return Math.round(v);
}

function precipDisplay(v) {
  if (v == null || Number.isNaN(v)) return '--';
  return Number(v).toFixed(1);
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
    if (pushTestBtn) pushTestBtn.disabled = true;
    return;
  }
  if (!window.isSecureContext) {
    notifyBtn.textContent = 'Needs HTTPS';
    notifyBtn.disabled = true;
    if (pushTestBtn) pushTestBtn.disabled = true;
    return;
  }

  notifyBtn.disabled = false;
  if (Notification.permission === 'granted') {
    notifyBtn.textContent = state.pushEnabled ? 'Push enabled' : 'Enable push';
  } else if (Notification.permission === 'denied') {
    notifyBtn.textContent = 'Notifications blocked';
  } else {
    notifyBtn.textContent = 'Enable notifications';
  }

  if (pushTestBtn) {
    pushTestBtn.disabled = !(Notification.permission === 'granted' && state.pushEnabled);
  }
}

function applyHighContrast() {
  document.body.classList.toggle('high-contrast', state.highContrast);
  if (contrastStatus) contrastStatus.textContent = state.highContrast ? 'On' : 'Off';
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

async function ensurePushSubscription() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return false;

  const keyResp = await fetch('/api/push/public-key').then(r => r.json()).catch(() => null);
  const publicKey = keyResp?.publicKey;
  if (!publicKey) return false;

  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
  }

  await fetch('/api/push/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      subscription: sub,
      location: state.currentCity ? {
        latitude: state.currentCity.latitude,
        longitude: state.currentCity.longitude,
      } : null,
    }),
  });

  state.pushEnabled = true;
  updateNotifyButton();
  return true;
}

async function sendTestPush() {
  const resp = await fetch('/api/push/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'Weather push test',
      body: state.currentCity ? `Alerts enabled for ${cityLabel(state.currentCity) || 'your location'}` : 'Push notifications are active.',
      url: window.location.pathname,
    }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error || 'Push test failed');
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
  const defaultEntry = state.savedCities.find(e => e.isDefault);
  localStorage.setItem(STORAGE_KEYS.defaultCity, defaultEntry ? cityKey(defaultEntry.city) : '');
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

function formatRelativeTime(ts) {
  if (!ts) return 'Never opened';
  const mins = Math.max(1, Math.round((Date.now() - ts) / 60000));
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}

function getDefaultSavedEntry() {
  return state.savedCities.find(e => e.isDefault) || null;
}

function updateDefaultCityLabel() {
  if (!defaultCityEl) return;
  const def = getDefaultSavedEntry();
  defaultCityEl.textContent = def?.city?.name || 'None';
}

function setDefaultCityByKey(key) {
  state.savedCities = state.savedCities.map(e => ({
    ...e,
    isDefault: cityKey(e.city) === key,
  }));
  persistSavedCities();
  updateDefaultCityLabel();
  renderSavedCities();
}

function moveSavedCity(index, direction) {
  const next = index + direction;
  if (next < 0 || next >= state.savedCities.length) return;
  const arr = [...state.savedCities];
  [arr[index], arr[next]] = [arr[next], arr[index]];
  state.savedCities = arr;
  persistSavedCities();
  renderSavedCities();
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
    updateDefaultCityLabel();
    return;
  }

  state.savedCities.forEach((entry, index) => {
    const city = entry.city;
    const wrap = document.createElement('div');
    wrap.className = 'saved-item';

    const chip = document.createElement('button');
    chip.className = 'saved-chip';
    chip.type = 'button';
    chip.textContent = city.name;
    chip.title = `${cityLabel(city)} • ${formatRelativeTime(entry.lastViewedAt)}`;
    chip.addEventListener('click', () => {
      entry.lastViewedAt = Date.now();
      persistSavedCities();
      loadAll(city, 'saved-location');
    });

    const defaultBtn = document.createElement('button');
    defaultBtn.className = 'saved-default';
    defaultBtn.type = 'button';
    defaultBtn.title = entry.isDefault ? 'Default city' : 'Set as default city';
    defaultBtn.textContent = entry.isDefault ? '★' : '☆';
    defaultBtn.addEventListener('click', () => setDefaultCityByKey(cityKey(city)));

    const upBtn = document.createElement('button');
    upBtn.className = 'saved-move';
    upBtn.type = 'button';
    upBtn.title = 'Move up';
    upBtn.textContent = '↑';
    upBtn.disabled = index === 0;
    upBtn.addEventListener('click', () => moveSavedCity(index, -1));

    const downBtn = document.createElement('button');
    downBtn.className = 'saved-move';
    downBtn.type = 'button';
    downBtn.title = 'Move down';
    downBtn.textContent = '↓';
    downBtn.disabled = index === state.savedCities.length - 1;
    downBtn.addEventListener('click', () => moveSavedCity(index, 1));

    const remove = document.createElement('button');
    remove.className = 'saved-remove';
    remove.type = 'button';
    remove.textContent = 'x';
    remove.addEventListener('click', (e) => {
      e.stopPropagation();
      state.savedCities = state.savedCities.filter(c => cityKey(c.city) !== cityKey(city));
      persistSavedCities();
      renderSavedCities();
    });

    const meta = document.createElement('span');
    meta.className = 'saved-meta';
    meta.textContent = formatRelativeTime(entry.lastViewedAt);

    wrap.appendChild(defaultBtn);
    wrap.appendChild(chip);
    wrap.appendChild(upBtn);
    wrap.appendChild(downBtn);
    wrap.appendChild(remove);
    wrap.appendChild(meta);
    savedLocationsEl.appendChild(wrap);
  });

  updateDefaultCityLabel();
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
    if (btn.dataset.tab === 'maps') {
      setTimeout(refreshMapsOverview, 80);
    } else {
      setMapsFullscreen(false);
    }
  });
});

document.getElementById('open-radar-tab').addEventListener('click', () => {
  document.querySelector('.tab[data-tab="radar-full"]').click();
});

// ── APIs ─────────────────────────────────────────────────────────────────────
async function geocode(q) {
  const r = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`);
  if (!r.ok) throw new Error('Geocoding failed');
  return r.json();
}

async function reverseGeocode(lat, lon) {
  const r = await fetch(`/api/reverse-geocode?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`);
  if (!r.ok) throw new Error('Reverse geocoding failed');
  return r.json();
}

async function fetchWeather(lat, lon, tz) {
  const r = await fetch(`/api/weather?lat=${lat}&lon=${lon}&tz=${encodeURIComponent(tz||'auto')}&units=${encodeURIComponent(state.units)}`);
  if (!r.ok) throw new Error('Weather fetch failed');
  return r.json();
}

async function fetchAirQuality(lat, lon, tz) {
  const r = await fetch(`/api/air-quality?lat=${lat}&lon=${lon}&tz=${encodeURIComponent(tz||'auto')}`);
  if (!r.ok) throw new Error('Air quality fetch failed');
  return r.json();
}

async function fetchAlerts(lat, lon) {
  const r = await fetch(`/api/alerts?lat=${lat}&lon=${lon}`);
  if (!r.ok) throw new Error('Alerts fetch failed');
  return r.json();
}

async function fetchLightning(lat, lon) {
  const ageMin = Number(state.lightningAgeMin || 15);
  const r = await fetch(`/api/lightning?lat=${lat}&lon=${lon}&age=${ageMin}`);
  if (!r.ok) throw new Error('Lightning fetch failed');
  return r.json();
}

function detectedCityFallback(lat, lon) {
  return {
    name: `Auto-detected (${lat.toFixed(2)}, ${lon.toFixed(2)})`,
    latitude: lat,
    longitude: lon,
    country: '',
    admin1: '',
    timezone: 'auto',
  };
}

function resolveDetectedName(place, fallback) {
  const raw = (place?.name || '').trim();
  const genericName = !raw || /current\s*location|detected\s*location/i.test(raw);
  if (!genericName) return raw;

  const displayRoot = (place?.display_name || '').split(',')[0]?.trim();
  if (displayRoot) return displayRoot;

  return fallback.name;
}

async function buildDetectedCity(lat, lon) {
  const fallback = detectedCityFallback(lat, lon);

  try {
    const place = await reverseGeocode(lat, lon);
    return {
      ...fallback,
      ...place,
      name: resolveDetectedName(place, fallback),
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
      layers[mode][frame.time] = L.tileLayer(frameTileUrl(frame), { opacity: 0.75, maxZoom: 15 });
    }

    Object.values(layers.radar).forEach(l => { if (map.hasLayer(l)) map.removeLayer(l); });
    Object.values(layers.satellite).forEach(l => { if (map.hasLayer(l)) map.removeLayer(l); });
    layers[mode][frame.time].addTo(map);

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
    animTimer = setInterval(step, 500);
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
      buildTimeline();
      const idx = Math.min(currentIdx, activeFrames().length - 1);
      showFrame(Math.max(idx, 0));
    });
  }

  async function loadFrames() {
    try {
      const r = await fetch('/api/radar/times');
      const data = await r.json();

      radarFrames = [];
      satelliteFrames = [];
      (data.radar?.past || []).forEach(f => radarFrames.push({ time: f.time, path: f.path, isForecast: false }));
      (data.radar?.nowcast || []).forEach(f => radarFrames.push({ time: f.time, path: f.path, isForecast: true }));
      (data.satellite?.infrared || []).forEach(f => satelliteFrames.push({ time: f.time, path: f.path, isForecast: false }));

      if (!radarFrames.length && satelliteFrames.length) mode = 'satellite';
      if (!radarFrames.length && !satelliteFrames.length) return;

      if (layerBtn) {
        layerBtn.disabled = !(radarFrames.length && satelliteFrames.length);
        layerBtn.textContent = mode === 'radar' ? 'R' : 'S';
      }

      buildTimeline();
      const frames = activeFrames();
      showFrame(frames.length - 1);
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

  const radarLayer = L.tileLayer('https://tilecache.rainviewer.com/v2/radar/nowcast_0/256/{z}/{x}/{y}/2/1_1.png', {
    maxZoom: 15,
    opacity: Math.max(0.25, Math.min(0.9, state.radarOpacity / 100)),
  }).addTo(map);

  let lastRadarFramePath = null;

  async function refreshRadarOverlay() {
    try {
      const r = await fetch('/api/radar/times');
      if (!r.ok) return;
      const data = await r.json();
      const frames = [
        ...(data?.radar?.past || []),
        ...(data?.radar?.nowcast || []),
      ];
      const latest = frames[frames.length - 1];
      const path = latest?.path;
      if (!path || path === lastRadarFramePath) return;
      lastRadarFramePath = path;
      radarLayer.setUrl(`https://tilecache.rainviewer.com${path}/256/{z}/{x}/{y}/2/1_1.png`);
    } catch (e) {
      console.warn('Maps radar overlay refresh failed', e);
    }
  }

  refreshRadarOverlay();
  setInterval(refreshRadarOverlay, 5 * 60 * 1000);

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

  function setRadarOpacity(opacityPct) {
    const normalized = Math.max(0.25, Math.min(0.9, Number(opacityPct) / 100));
    radarLayer.setOpacity(normalized);
  }

  return { map, panTo, setRadarOpacity, refreshRadarOverlay };
}

function clearLightningLayer() {
  if (!mapsOverview.map) return;
  if (state.lightningLayer) {
    mapsOverview.map.removeLayer(state.lightningLayer);
    state.lightningLayer = null;
  }
}

function clearWindArrows() {
  if (!mapsOverview.map) return;
  state.windArrows.forEach(arrow => mapsOverview.map.removeLayer(arrow));
  state.windArrows = [];
}

function refreshMapsOverview() {
  if (!mapsOverview.map) return;

  mapsOverview.map.invalidateSize();
  mapsOverview.refreshRadarOverlay();

  if (!state.currentCity) return;

  mapsOverview.panTo(state.currentCity.latitude, state.currentCity.longitude, 6);

  clearLightningLayer();
  clearWindArrows();

  if (state.showLightning) renderLightningStrikes(state.currentCity);
  if (state.showWind && state.currentWeather) renderWindArrows(state.currentCity);
}

function circleCenter(coords) {
  let sumLat = 0;
  let sumLon = 0;
  let count = 0;
  coords.forEach(([lon, lat]) => {
    sumLat += lat;
    sumLon += lon;
    count += 1;
  });
  if (!count) return null;
  return [sumLat / count, sumLon / count];
}

async function renderLightningStrikes(city) {
  if (!mapsOverview.map || !state.showLightning) return;
  clearLightningLayer();

  try {
    const data = await fetchLightning(city.latitude, city.longitude);
    const features = data?.features || [];
    if (!features.length) return;

    const layers = [];
    features.forEach((feature) => {
      const geom = feature?.geometry;
      const event = feature?.properties?.event || 'Thunderstorm activity';
      const severity = feature?.properties?.severity || 'Unknown severity';
      if (!geom) return;

      const polygonSets = [];
      if (geom.type === 'Polygon' && Array.isArray(geom.coordinates?.[0])) {
        polygonSets.push(geom.coordinates[0]);
      }
      if (geom.type === 'MultiPolygon' && Array.isArray(geom.coordinates)) {
        geom.coordinates.forEach(poly => {
          if (Array.isArray(poly?.[0])) polygonSets.push(poly[0]);
        });
      }

      polygonSets.forEach((polyCoords, idx) => {
        const ring = polyCoords.map(([lon, lat]) => [lat, lon]);
        const poly = L.polygon(ring, {
          color: '#ff8b1a',
          weight: 1.5,
          opacity: 0.8,
          fillColor: '#ffd34d',
          fillOpacity: 0.18,
        }).bindPopup(`${event} • ${severity}`);
        layers.push(poly);

        const center = circleCenter(polyCoords);
        if (center) {
          const strike = L.circleMarker(center, {
            radius: 5,
            fillColor: '#ffe066',
            fillOpacity: 0.95,
            color: '#ff6f00',
            weight: 2,
          }).bindPopup(`${event} area ${idx + 1}`);
          layers.push(strike);
        }
      });
    });

    if (!layers.length) return;
    state.lightningLayer = L.layerGroup(layers).addTo(mapsOverview.map);
  } catch (e) {
    console.warn('Lightning overlay unavailable', e);
  }
}

function renderWindArrows(city) {
  if (!mapsOverview.map || !state.showWind || !state.currentWeather) return;
  clearWindArrows();
  
  // Get current wind data
  const current = state.currentWeather.current;
  if (!current || !current.wind_speed_10m) return;
  
  const windSpeed = current.wind_speed_10m;
  const windDir = current.wind_direction_10m || 0;
  
  // Draw a wind barb pointing in the direction of wind movement
  const lat = parseFloat(city.latitude);
  const lon = parseFloat(city.longitude);
  const radius = 0.3;
  
  // Calculate arrow end point based on wind direction
  const radians = (windDir * Math.PI) / 180;
  const endLat = lat + radius * Math.cos(radians);
  const endLon = lon + radius * Math.sin(radians);
  
  // Draw arrow line
  const arrow = L.polyline(
    [[lat, lon], [endLat, endLon]],
    {
      color: '#4a90e2',
      weight: 2,
      opacity: 0.7,
    }
  ).bindPopup(`Wind: ${speedDisplay(windSpeed)} ${speedUnit()}`);
  
  arrow.addTo(mapsOverview.map);
  state.windArrows.push(arrow);
  
  // Draw arrow head as a small circle at the end
  const arrowHead = L.circleMarker([endLat, endLon], {
    radius: 3,
    fillColor: '#4a90e2',
    fillOpacity: 0.7,
    color: '#fff',
    weight: 1,
  });
  
  arrowHead.addTo(mapsOverview.map);
  state.windArrows.push(arrowHead);
}

const mapsOverview = createOverviewMap(document.getElementById('map-overview'));

function setMapsFullscreen(active) {
  const wrap = document.querySelector('#tab-maps .maps-wrap');
  if (!wrap) return;
  wrap.classList.toggle('is-fullscreen', active);
  document.body.classList.toggle('map-fullscreen-lock', active);
  if (mapsFullscreenBtn) {
    mapsFullscreenBtn.textContent = active ? 'Exit fullscreen' : 'Fullscreen map';
  }
  setTimeout(() => {
    if (mapsOverview?.map) mapsOverview.map.invalidateSize();
  }, 100);
}

if (mapsFullscreenBtn) {
  mapsFullscreenBtn.addEventListener('click', async () => {
    const wrap = document.querySelector('#tab-maps .maps-wrap');
    if (!wrap) return;

    if (document.fullscreenElement === wrap) {
      await document.exitFullscreen().catch(() => {});
      setMapsFullscreen(false);
      return;
    }

    if (wrap.requestFullscreen) {
      try {
        await wrap.requestFullscreen();
        setMapsFullscreen(true);
        return;
      } catch {
        // Some mobile browsers reject Fullscreen API; fallback below.
      }
    }

    setMapsFullscreen(!wrap.classList.contains('is-fullscreen'));
  });
}

document.addEventListener('fullscreenchange', () => {
  const wrap = document.querySelector('#tab-maps .maps-wrap');
  if (!wrap) return;
  setMapsFullscreen(document.fullscreenElement === wrap);
});

// ── Rendering ────────────────────────────────────────────────────────────────
function renderDailyForecast(daily) {
  const list = document.getElementById('daily-list');
  const totalDays = daily?.time?.length || 0;
  const defaultDays = Math.min(7, totalDays);
  const visibleDays = state.dailyExpanded ? totalDays : defaultDays;

  list.innerHTML = '';
  for (let i = 0; i < visibleDays; i++) {
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
    dailyForecastLabel.textContent = `${visibleDays}-Day Forecast`;
  }

  if (dailyForecastToggle) {
    if (totalDays > defaultDays) {
      show(dailyForecastToggle);
      dailyForecastToggle.textContent = state.dailyExpanded
        ? 'Show 7-day view'
        : `Show full ${totalDays}-day forecast`;
    } else {
      hide(dailyForecastToggle);
    }
  }
}

function summarizeHourly(hourly, startIdx) {
  if (!hourly?.time?.length || !hourly?.precipitation_probability?.length) {
    return 'Hourly details unavailable.';
  }

  let rainIdx = -1;
  for (let i = startIdx; i < Math.min(startIdx + 24, hourly.time.length); i++) {
    const pp = Number(hourly.precipitation_probability[i] || 0);
    const rain = Number(hourly.rain?.[i] || 0);
    if (pp >= 45 || rain > 0.1) {
      rainIdx = i;
      break;
    }
  }

  if (rainIdx === -1) {
    return 'No notable rain expected in the next 24 hours.';
  }
  return `Rain likely around ${formatHour(hourly.time[rainIdx])}.`;
}

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
  document.getElementById('cur-wind').textContent = `${speedDisplay(c.wind_speed_10m)} ${compassDir(c.wind_direction_10m)}`;
  document.getElementById('cur-pres').textContent = Math.round(c.surface_pressure);
  document.getElementById('cur-vis').textContent = visDisplay(c.visibility);
  document.getElementById('cur-uv').textContent = Math.round(d.uv_index_max[0] ?? 0);
  document.getElementById('cur-cloud').textContent = c.cloud_cover;
  document.querySelector('.stat:nth-child(2) .unit').textContent = speedUnit();
  document.querySelector('.stat:nth-child(4) .unit').textContent = visUnit();

  document.getElementById('sunrise-val').textContent = formatClock(d.sunrise[0]);
  document.getElementById('sunset-val').textContent = formatClock(d.sunset[0]);
  document.getElementById('moon-phase-val').textContent = moonPhase(d.time[0]);

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
      <div class="hour-feels">Feels ${tempDisplay(h.apparent_temperature?.[i])}°</div>
      <div class="hour-precip">${pp > 0 ? `${pp}% ${ptype}` : ptype}</div>
    `;
    track.appendChild(cell);
  }

  if (hourlySummaryEl) {
    hourlySummaryEl.textContent = summarizeHourly(h, startIdx);
  }

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

  const saved = state.savedCities.find(e => cityKey(e.city) === cityKey(city));
  if (saved) {
    saved.lastViewedAt = Date.now();
    persistSavedCities();
    renderSavedCities();
  }

  clearErr();
  hide(suggestEl);
  hide(weatherDiv);
  show(loadingEl);

  try {
    const [weather, air, alerts] = await Promise.all([
      fetchWeather(city.latitude, city.longitude, city.timezone),
      fetchAirQuality(city.latitude, city.longitude, city.timezone),
      fetchAlerts(city.latitude, city.longitude).catch(() => ({ features: [] })),
    ]);

    state.currentWeather = weather;
    state.currentAir = air;
    state.lastRefreshAt = Date.now();
    renderWeather(weather, city);
    renderAirQuality(air);
    renderAlerts(alerts);
    
    // Render map overlays
    if (state.showLightning) renderLightningStrikes(city);
    if (state.showWind) renderWindArrows(city);
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
    } catch {
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
  if (state.savedCities.some(c => cityKey(c.city) === key)) return;
  state.savedCities.push({
    city: state.currentCity,
    addedAt: Date.now(),
    lastViewedAt: Date.now(),
    isDefault: state.savedCities.length === 0,
  });
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
    if (permission === 'granted') {
      const subscribed = await ensurePushSubscription();
      if (!subscribed) {
        showErr('Push needs VAPID keys configured on server.');
      }
      if (state.currentCity) {
        const alerts = await fetchAlerts(state.currentCity.latitude, state.currentCity.longitude).catch(() => ({ features: [] }));
        renderAlerts(alerts);
      }
    } else if (permission === 'denied') {
      showErr('Notifications are blocked in browser settings for this site.');
    }
  } catch {
    showErr('Could not request notification permission.');
  } finally {
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
  lightningStatus.textContent = state.showLightning ? 'On' : 'Off';
  if (state.currentCity && mapsOverview.map) {
    clearLightningLayer();
    if (state.showLightning) renderLightningStrikes(state.currentCity);
  }
});

windToggle.addEventListener('change', () => {
  state.showWind = windToggle.checked;
  localStorage.setItem(STORAGE_KEYS.showWind, String(state.showWind));
  windStatus.textContent = state.showWind ? 'On' : 'Off';
  if (state.currentCity && mapsOverview.map) {
    clearWindArrows();
    if (state.showWind && state.currentWeather) renderWindArrows(state.currentCity);
  }
});

if (dailyForecastToggle) {
  dailyForecastToggle.addEventListener('click', () => {
    if (!state.currentWeather?.daily) return;
    state.dailyExpanded = !state.dailyExpanded;
    renderDailyForecast(state.currentWeather.daily);
  });
}

if (contrastToggle) {
  contrastToggle.addEventListener('change', () => {
    state.highContrast = contrastToggle.checked;
    localStorage.setItem(STORAGE_KEYS.highContrast, String(state.highContrast));
    applyHighContrast();
  });
}

if (radarOpacityEl) {
  radarOpacityEl.addEventListener('input', () => {
    state.radarOpacity = Number(radarOpacityEl.value || 65);
    localStorage.setItem(STORAGE_KEYS.radarOpacity, String(state.radarOpacity));
    mapsOverview.setRadarOpacity(state.radarOpacity);
  });
}

if (lightningAgeEl) {
  lightningAgeEl.addEventListener('change', () => {
    state.lightningAgeMin = Number(lightningAgeEl.value || 15);
    localStorage.setItem(STORAGE_KEYS.lightningAgeMin, String(state.lightningAgeMin));
    if (state.showLightning && state.currentCity) {
      renderLightningStrikes(state.currentCity);
    }
  });
}

if (pushTestBtn) {
  pushTestBtn.addEventListener('click', async () => {
    try {
      await sendTestPush();
      pushTestBtn.textContent = 'Push sent';
      setTimeout(() => { pushTestBtn.textContent = 'Send test push'; }, 1500);
    } catch (e) {
      showErr(e.message || 'Push test failed.');
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

  // Sync lightning/wind and UI polish toggles.
  lightningToggle.checked = state.showLightning;
  lightningStatus.textContent = state.showLightning ? 'On' : 'Off';
  windToggle.checked = state.showWind;
  windStatus.textContent = state.showWind ? 'On' : 'Off';
  if (contrastToggle) contrastToggle.checked = state.highContrast;
  if (lightningAgeEl) lightningAgeEl.value = String(state.lightningAgeMin || 15);
  if (radarOpacityEl) radarOpacityEl.value = String(state.radarOpacity || 65);
  applyHighContrast();
  mapsOverview.setRadarOpacity(state.radarOpacity);

  renderSavedCities();
  startAutoRefresh();

  // Restore push state if already subscribed.
  if ('serviceWorker' in navigator && 'PushManager' in window) {
    try {
      const reg = await navigator.serviceWorker.ready;
      const existingSub = await reg.pushManager.getSubscription();
      state.pushEnabled = Boolean(existingSub);
    } catch {
      state.pushEnabled = false;
    }
    updateNotifyButton();
  }

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

  const defaultSaved = getDefaultSavedEntry();
  if (defaultSaved?.city) {
    searchInput.value = defaultSaved.city.name;
    await loadAll(defaultSaved.city, 'default-saved-city');
    return;
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
