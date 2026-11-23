# AIRTON API

Node.js/Express API for the AIRTON demonstration interface.

## Run
```bash
npm install
npm start
```

## Required environment variable
- `ADMIN_SECRET`: private administrator login secret. Set it only in the Render Environment dashboard. Never put it in frontend HTML or commit it to GitHub.

## Endpoints
- `GET /health` — health check
- `GET /api/config` — app mode and server state
- `GET /api/user/:id` — demo account state
- `POST /api/admin/login` — exchange ADMIN_SECRET for a short-lived bearer token
- `GET /api/admin/overview` — admin overview
- `POST /api/admin/server-status` — set ONLINE / OFFLINE / MAINTENANCE
- `POST /api/admin/credit` — add demo balance
- `POST /api/admin/ban` and `POST /api/admin/unban` — demo account moderation
- `GET /api/admin/logs` — audit log

## Important limitations
This version is a demonstration only. Balances are not TON, no blockchain or wallet is connected, and no real transfers or mining occur. Data is held in memory and is lost when the service restarts or redeploys. Add a persistent database before using this for real accounts or important records.
