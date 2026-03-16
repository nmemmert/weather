# Weather App

Self-hosted weather app with animated radar. No API keys required.

## Data Sources
- **Weather**: [Open-Meteo](https://open-meteo.com) — free, no key
- **Radar**: [RainViewer](https://www.rainviewer.com) — free, no key
- **Map tiles**: CartoDB Dark Matter (free, no key)

## Features
- Current conditions (temp, feels-like, wind, humidity, pressure, visibility, UV, clouds)
- 24-hour hourly forecast
- 7-day daily forecast
- **Embedded radar panel** on the conditions page
- **Full-page radar tab** with animated past frames + nowcast
- Animated radar timeline with play/pause controls
- City search with autocomplete + GPS geolocation
- Auto-pans radar to searched city
- Dark mode (follows system preference)
- Responsive / mobile-friendly

## Quick Start

```bash
docker compose up -d
```

App runs at **http://localhost:3000**

## Pull prebuilt image

```bash
docker pull ghcr.io/nmemmert/weather:latest
docker run -d --name weather-app -p 3000:3000 ghcr.io/nmemmert/weather:latest
```

If the package is private, log in first:

```bash
echo "<GITHUB_PAT>" | docker login ghcr.io -u nmemmert --password-stdin
```

## Change the port

Edit `docker-compose.yml`:
```yaml
ports:
  - "8080:3000"
```

## Run without Docker

```bash
cd app
npm install
node server.js
```

## Project structure

```
weather-app/
├── docker-compose.yml
└── app/
    ├── Dockerfile
    ├── package.json
    ├── server.js           # Express — proxies Open-Meteo, RainViewer
    └── public/
        ├── index.html
        ├── style.css
        └── app.js          # Weather render + dual Leaflet radar
```

## Nginx reverse proxy

```nginx
server {
    listen 80;
    server_name weather.yourdomain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```
