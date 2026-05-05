# Hyperbeam Shared Browser

## Overview
A shared virtual browser application using the Hyperbeam API. Users can start a cloud browser session that is embedded directly in the page via WebRTC (with iframe fallback).

## Architecture
- **Runtime**: Node.js 20
- **Framework**: Express 5
- **Frontend**: Vanilla HTML/JS served by Express
- **Port**: 7860

## Key Files
- `server.js` — Express server; serves `index.html` and proxies Hyperbeam API calls
- `index.html` — Frontend UI with Hyperbeam Web SDK integration

## API Endpoints
- `GET /` — Serves the main page
- `GET /get-browser-session` — Creates a new Hyperbeam VM session
- `GET /get-active-sessions` — Lists all active Hyperbeam sessions
- `POST /close-all-sessions` — Terminates all active sessions

## Environment Variables / Secrets
- API Key dropdown at the top left — switch between:
🔑 Test (2 sessions) — uses your HB_TEST_KEY
🚀 Production (10 sessions) — uses your HB_PROD_KEY
Every action — Launch, Connect, Refresh Active, Close Session, Close All — automatically uses whichever key you have selected. Just switch the dropdown before you act and it applies to everything.
## Running Locally
```bash
npm install
node server.js
```

## Dependencies
- `express` ^5.2.1 — Web framework
- `node-fetch` ^2.7.0 — HTTP client for Hyperbeam API calls
- `dotenv` ^17.4.2 — Environment variable loading
- `@hyperbeam/web` ^0.0.38 — Hyperbeam Web SDK
