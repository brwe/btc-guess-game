# epilot Bitcoin Guessing Game

## Overview

This app lets players guess whether the BTC price will be higher or lower after one minute.

## Assumptions

- The game uses the BTC/USD pair.

- If the exchange pair changes, both the displayed price and the resolution logic need to use the same pair to keep guesses fair.

- The backend subscribes to Coinbase `ticker_batch` instead of `ticker` so the app uses fewer live updates and keeps infrastructure cost lower; if we need a finer-grained stream later, we can switch to one.

- The backend keeps the latest BTC/USD price and the timestamp of the most recent update in memory.

- Pending guesses use PostgreSQL as the source of truth instead of being duplicated in an in-memory map. When a price update arrives, the intended resolution design queries indexed pending guesses whose `resolve_after` timestamp has passed and whose entry price differs from the new price. This keeps guess state available across backend restarts and avoids synchronizing an in-memory copy with the database.

- This database-query approach has a scalability limitation: if every backend instance consumes the same price stream, every instance can query the same eligible guesses and attempt to resolve them. Conditional updates inside a transaction can preserve correctness, but the duplicated queries still waste database capacity. If horizontal scaling becomes necessary, price processing should move to one elected resolver or a dedicated worker; alternatively, workers can claim disjoint batches with PostgreSQL row locking such as `FOR UPDATE SKIP LOCKED`.

- The backend keeps one upstream WebSocket connection to Coinbase, and the frontend can poll backend state instead of holding its own live socket unless we later add live push.

- Anonymous players are identified by a browser cookie that stores a generated player id, and that id is used to load the same score and guess history when the browser returns.

- The backend and frontend are written in TypeScript. The backend runs on Bun and uses Hono for HTTP routing, middleware, and request validation. The frontend is built as static files for S3, ideally with CloudFront in front of the bucket.

- The score starts at 0 for a new player and is persisted in the backend.

- A player can only have one active guess at a time.

- A guess resolves only after at least 60 seconds have passed and the price has changed.

## Run

From `/Users/a2tirb/robofarm/epilot-challenge`, run:

```bash
docker compose up --build
```

Then open:

- Frontend: `http://localhost:3000`
- Backend: `http://localhost:3001/api/hello`
- Postgres: `localhost:5432`

## Local Docker Scaffold

The frontend is a small React app that calls the backend hello-world endpoint and renders the JSON response.
