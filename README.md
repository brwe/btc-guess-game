# Bitcoin Trend Guessing Game

## Overview

This app lets players guess whether the BTC price will be higher or lower after one minute.

The player can at all times see their current score and the latest available BTC price in USD.
The player can choose to enter a guess of either “up” or “down“
After a guess is entered, the player cannot make new guesses until the existing guess is resolved.
The guess is resolved when the price changes and at least 60 seconds have passed since the guess was made.
If the guess is correct (up = price went higher, down = price went lower), the user gets 1 point added to their score. If the guess is incorrect, the user loses 1 point.
Players can only make one guess at a time.
New players start with a score of 0.



## Run locally

uses docker compose to start up locally.
From root directory, run:

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

| Abbreviation | Mechanism          | Direction          | Purpose                                               |
| ------------ | ------------------ | ------------------ | ----------------------------------------------------- |
| `WS`         | WebSocket          | Coinbase → Backend | Continuous BTC/USD price updates                      |
| `SSE`        | Server-Sent Events | Backend → Frontend | Live price updates and guess-resolution notifications |
| `REST`       | REST API over HTTP | Frontend ↔ Backend | Submit commands and load authoritative snapshots      |

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





## Limitations

This is a pet project written for an application process.

**No database migrations.** The `guesses` table that stores current guesses can be recreated with `RESET_DATABASE_ON_START=true` but there is no proper handling of schema updates. 

**The current design allows for only one backend instance** for the following reasons:

- In more than one backend instance all instances would consume the price stream and update the guesses. Conditional updates inside a transaction can be used to preserve correctness, but the duplicated queries still waste database capacity. For horizontal scaling , price processing should move to one elected resolver or a dedicated worker or workers can claim disjoint batches with PostgreSQL row locking such as `FOR UPDATE SKIP LOCKED`.


-  SSE solves only the connection between one backend instance and one browser. For several backend instances, the instance that resolves a guess may not hold that player's browser connection. Correct cross-instance delivery would require shared Pub/Sub such as PostgreSQL `LISTEN/NOTIFY`, Redis, or a message broker.







