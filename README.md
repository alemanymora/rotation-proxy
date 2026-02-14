# The Rotation — Data Proxy

Fetches congressional trades (Capitol Trades) and insider trades (OpenInsider)
and serves them with CORS headers so Mission Control can access them from the browser.

## Endpoints

- `GET /` — health check
- `GET /congress` — congressional trades (last 96, both House + Senate)
- `GET /insiders/parsed` — corporate insider trades clustered by ticker

## Deploy to Render.com (free)

1. Push this folder to a GitHub repo (see steps below)
2. Go to render.com → New → Web Service
3. Connect your GitHub repo
4. Settings:
   - **Name:** rotation-proxy
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free
5. Click Deploy
6. Copy your URL (looks like `https://rotation-proxy-xxxx.onrender.com`)
7. Paste that URL into Mission Control

## Local test

```bash
npm install
npm start
# Visit http://localhost:3000/congress
```
