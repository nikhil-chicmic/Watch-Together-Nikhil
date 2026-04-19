# Deployment Guide

## Why Vercel Shows "Sync Connection Closed"

WatchTogether uses a persistent WebSocket connection:

```text
Browser <---- WebSocket ----> Node server
```

That is required so play, pause, seek, and video-load actions can be pushed instantly to the other viewer.

Vercel is serverless for backend functions. Serverless functions are designed to respond to a request and stop; they cannot keep a long-lived WebSocket server open for rooms. Because of that, the same code can work on `localhost` but fail after deploying the full app to Vercel.

## Correct Free Deployment

Deploy the full project to a Node server host. The easiest free option is Render.

### Render Steps

1. Push this project to GitHub.
2. Open `https://render.com`.
3. Click `New +`.
4. Choose `Web Service`.
5. Connect the GitHub repo.
6. Select the free plan.
7. Use these settings:

```text
Build command: npm install --omit=dev
Start command: npm start
Health check path: /api/health
```

The included `render.yaml` already contains these settings.

## After Deploying

1. Open the Render URL on your laptop.
2. Create a room.
3. Open the same Render URL on your phone.
4. Join using the room key.
5. Load a YouTube link.
6. Test play, pause, and seek from both devices.

## Can I Still Use Vercel?

Only if you split the app:

- Vercel hosts the static frontend.
- Render/Railway/Fly.io hosts the Node WebSocket backend.
- The frontend must be configured to call that backend URL.

For your current simple deployment, deploy the whole app to Render instead.
