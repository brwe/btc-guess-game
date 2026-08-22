# epilot Bitcoin Guessing Game

## Overview

This app lets players guess whether the BTC price will be higher or lower after one minute.

## Run locally

From `/Users/a2tirb/robofarm/epilot-challenge`, run:

```bash
make fullstack-up-realtime
```

Then open `http://localhost:3000`

## Deploy to AWS


### AWS credentials

```bash
aws configure
```

### Deploy

```bash
cd infra
bun install
bun run bootstrap
bun run synth
bun run deploy
```

The deployment outputs `ApplicationUrl`. 

### Destroy

```bash
cd infra
bun run destroy
```




## Architecture

The application uses three communication mechanisms, each for a distinct purpose:

| Abbreviation | Mechanism | Direction | Purpose |
| --- | --- | --- | --- |
| `WS` | WebSocket | Coinbase → Backend | Continuous BTC/USD price updates |
| `SSE` | Server-Sent Events | Backend → Frontend | Live price updates and guess-resolution notifications |
| `REST` | REST API over HTTP | Frontend ↔ Backend | Submit commands and load authoritative snapshots |

### Price flow

```text
Frontend                    Backend                     Coinbase
   │                           │                           │
   │                           │  BTC/USD price [WS]       │
   │                           │◄──────────────────────────┤
   │  price-updated [SSE]      │                           │
   │◄──────────────────────────┤                           │
```

The price is delivered exclusively through the live SSE path. On initial load and after an SSE reconnection, the frontend waits for the next event from the high-frequency `ticker` stream.

### Guess lifecycle

```text
Browser                     Backend                    PostgreSQL                 Coinbase
   │                           │                           │                           │
   │ POST /api/guesses [REST]  │                           │                           │
   ├──────────────────────────►│                           │                           │
   │                           │ INSERT pending guess      │                           │
   │                           ├──────────────────────────►│                           │
   │ 201 + entryPrice          │                           │                           │
   │     + resolveAfter        │                           │                           │
   │◄──────────────────────────┤                           │                           │
   │                           │                           │                           │
   │                           │                           │ BTC/USD price  [WS]       │
   │                           │◄──────────────────────────────────────────────────────┤
   │                           │ resolve eligible guesses  │                           │
   │                           ├──────────────────────────►│                           │
   │                           │◄──────────────────────────┤                           │
   │ price-updated [SSE]       │                           │                           │
   │◄──────────────────────────┤                           │                           │
   │ guess-resolved [SSE]      │                           │                           │
   │◄──────────────────────────┤                           │                           │
   │ GET latest guess + score [REST]                       │                           │
   ├──────────────────────────►│                           │                           │
   │                           │ query authoritative state │                           │
   │                           ├──────────────────────────►│                           │
   │                           │◄──────────────────────────┤                           │
   │◄──────────────────────────┤                           │                           │
```

Prices received before `resolve_after` may update the displayed ticker but cannot settle the guess. The first eligible price after `resolve_after` whose value differs from the entry price resolves it.

PostgreSQL enforces at most one pending guess per player with a partial unique index on `player_id` where the status is `pending`. If concurrent requests try to create two guesses for one player, the database accepts one and the backend returns `409 Conflict` for the other.


### AWS request path

```text
Browser
   │
   ▼
CloudFront
   ├── static files ──► private S3 bucket
   │
   └── /api/* ───────► CloudFront VPC origin
                              │
                              ▼
                         internal ALB
                              │
                              ▼
                         ECS backend
                              │
                              ▼
                         private RDS
```





## Assumptions

- The game uses the BTC/USD pair.

- If the exchange pair changes, both the displayed price and the resolution logic need to use the same pair to keep guesses fair.

- The backend uses Coinbase `ticker_batch` by default so the app receives at most one changed price update every five seconds. Set `COINBASE_TICKER_CHANNEL=ticker` to receive higher-frequency updates when matches happen; this increases database resolution checks and SSE traffic.

- The backend keeps the latest BTC/USD price and the timestamp of the most recent update in memory.

- The price displayed by the frontend is informational and can become stale while a guess request is in transit. The client sends only the player id and direction; when the backend accepts the request, it snapshots its latest known price, persists that value as the guess's entry price, and returns it in the response. That authoritative entry price can therefore differ slightly from the price the player saw when clicking. The frontend displays the returned entry price for the active guess. This tradeoff prevents clients from choosing or manipulating their own entry price.

- Pending guesses use PostgreSQL as the source of truth instead of being duplicated in an in-memory map. When a price update arrives, the resolution design queries indexed pending guesses whose `resolve_after` timestamp has passed and whose entry price differs from the new price. This avoids synchronizing an in-memory copy with the database during one backend run.

- Price updates are passed to a source-agnostic processor as `{ price, observedAt }`. Tests and the Coinbase WebSocket adapter call the same method. `observedAt` is the exchange event timestamp used to decide whether `resolve_after` has passed.

- Resolved guesses store `resolved_at` and `resolved_price`. The result and score change are derived from `direction`, `entry_price`, and `resolved_price` instead of being persisted as duplicate data.

- This pet-project setup does not use database migrations. Local Docker sets `RESET_DATABASE_ON_START=true`, so local backend starts recreate the `guesses` table. The AWS task sets it to `false` and uses idempotent table initialization so ECS replacements do not erase RDS data. Versioned migrations should replace this initializer before evolving a deployed schema.

- This database-query approach has a scalability limitation: if every backend instance consumes the same price stream, every instance can query the same eligible guesses and attempt to resolve them. Conditional updates inside a transaction can preserve correctness, but the duplicated queries still waste database capacity. If horizontal scaling becomes necessary, price processing should move to one elected resolver or a dedicated worker; alternatively, workers can claim disjoint batches with PostgreSQL row locking such as `FOR UPDATE SKIP LOCKED`.

- The backend keeps one upstream WebSocket connection to Coinbase and exposes one player-scoped Server-Sent Events stream to each frontend. The stream carries live price updates and guess-resolution notifications.

- Anonymous players are identified by a generated player id stored in browser local storage, and that id is used to load the same score and guess history when the browser returns.

- The backend and frontend are written in TypeScript. The backend runs on Bun and uses Hono for HTTP routing, middleware, and request validation. The frontend is built as static files for S3, ideally with CloudFront in front of the bucket.

- The score starts at 0 for a new player and is calculated by the backend from that player's persisted resolved guesses. The frontend does not determine outcomes or increment score locally; it displays the result, wins, losses, and total score returned by the backend.

- A player can only have one active guess at a time.

- A guess resolves only after at least 60 seconds have passed and the price has changed.




## Realtime Updates and SSE Decision

SSE was chosen over WebSockets because updates flow only from the backend to the browser. The browser loads the authoritative guess and score through REST when it first loads and whenever SSE connects or reconnects, so temporary disconnections and missed or duplicate resolution notifications recover from PostgreSQL. The high-frequency ticker supplies the displayed price. A 15-second heartbeat keeps idle streams active.

The current event broadcaster is intentionally in-memory and therefore matches the current single-backend deployment. SSE solves only the connection between one backend instance and one browser. In a multi-instance deployment, the instance that resolves a guess may not hold that player's browser connection. Correct cross-instance delivery would require shared Pub/Sub such as PostgreSQL `LISTEN/NOTIFY`, Redis, or a message broker. Strong delivery guarantees may additionally require a transactional outbox so a committed resolution cannot lose its notification.

## Backend as the soucre of truth



TODOS:

- make the app work:
  - ~~concurrency issues~~ -> don't do
  - ~~migration handling~~ -> don't do
  - ~~authorizaton and authentication~~ -> don't do
  - deployment -> done
  - ~~design~~ -> don't do
  - documentation
  - code review
  - ~~stale state frontend if db was dropped~~ -> don't do
  - ~~the game would be more fun if one could see the graph~~ -> don't do


4. ~~Entry price is controlled by the client~~ -> solved by letting the backend snapshot and return the authoritative entry price. The client sends only:

```json
{
  "playerId": "...",
  "direction": "up"
}
```


5. ~~Frontend polling can count a result twice~~ -> solved by making the backend authoritative for outcomes and score, then replacing price and guess polling with SSE notifications plus authoritative REST snapshot reads.








