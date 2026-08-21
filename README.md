# epilot Bitcoin Guessing Game

## Overview

This app lets players guess whether the BTC price will be higher or lower after one minute.

## Assumptions

- The game uses the BTC/USD pair.

- If the exchange pair changes, both the displayed price and the resolution logic need to use the same pair to keep guesses fair.

- The backend subscribes to Coinbase `ticker_batch` instead of `ticker` so the app uses fewer live updates and keeps infrastructure cost lower; if we need a finer-grained stream later, we can switch to one.

- The backend keeps the latest BTC/USD price and the timestamp of the most recent update in memory.

- Pending guesses use PostgreSQL as the source of truth instead of being duplicated in an in-memory map. When a price update arrives, the resolution design queries indexed pending guesses whose `resolve_after` timestamp has passed and whose entry price differs from the new price. This avoids synchronizing an in-memory copy with the database during one backend run.

- Price updates are passed to a source-agnostic processor as `{ price, observedAt }`. Tests, simulations, and the Coinbase WebSocket adapter call the same method. `observedAt` is the exchange event timestamp used to decide whether `resolve_after` has passed.

- Resolved guesses store `resolved_at` and `resolved_price`. The result and score change are derived from `direction`, `entry_price`, and `resolved_price` instead of being persisted as duplicate data.

- This pet-project setup does not use database migrations. Every backend start drops and recreates the `guesses` table, so all guess data is intentionally lost on restart. A deployed version with persistent player scores would replace this initializer with versioned migrations before storing user data.

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

The guess duration is configured with `GUESS_DURATION_SECONDS` on the backend and defaults to `60`. For faster local testing, start the stack with `GUESS_DURATION_SECONDS=5 docker compose up --build`. The backend returns the resulting `resolveAfter` timestamp, which drives the frontend countdown and polling delay.

The backend connects to Coinbase Exchange at `wss://ws-feed.exchange.coinbase.com` and subscribes to the unauthenticated `ticker_batch` channel for `BTC-USD`. Coinbase sends an update every five seconds when the latest trade price changes. The URL can be overridden with `COINBASE_WEBSOCKET_URL`, for example to use the Coinbase sandbox feed.

Then open:

- Frontend: `http://localhost:3000`
- Backend: `http://localhost:3001/api/hello`
- Postgres: `localhost:5432`

## Simulate a Price Update

With the Docker stack running, pass a price and an optional ISO 8601 exchange timestamp to the source-agnostic price processor:

```bash
docker compose exec backend bun run simulate:price -- 62000 2026-08-21T12:01:00.000Z
```

If the timestamp is omitted, the simulator uses the current time. The command prints the number and ids of guesses resolved by that price update.

## Local Docker Scaffold

The React frontend displays the latest BTC/USD price, score, wins, and losses. A player can submit one `up` or `down` guess at a time. Both buttons are disabled while the guess is pending.

The browser waits until the backend-provided `resolveAfter` timestamp, then polls the guess endpoint every two seconds until the backend resolves it. The active guess, anonymous player id, wins, and losses are stored in browser storage so refreshing the page does not discard the current browser session.

The current score is derived as `wins - losses`. Persisting score in PostgreSQL and loading it by anonymous player id remains backend work; browser storage is only the current frontend implementation.

The frontend reads the latest price from `GET /api/price`. During local development, `bun run simulate:price -- <price> [observed-at]` sends a price message through the running backend, updates the in-memory latest price, and resolves eligible guesses.
