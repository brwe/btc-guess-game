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

## Test

Run the unit and component tests:

```bash
make backend-test
cd frontend
bun install --frozen-lockfile
bun run test
```

Run the PostgreSQL repository integration tests using Docker Compose:

```bash
make backend-integration-test
```

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

The application uses two communication mechanisms, each for a distinct purpose:

| Abbreviation | Mechanism          | Direction                       | Purpose                                      |
| ------------ | ------------------ | ------------------------------- | -------------------------------------------- |
| `WS`         | WebSocket          | Coinbase → Backend and frontend | Independent BTC/USD price streams            |
| `REST`       | REST API over HTTP | Frontend ↔ Backend              | Submit commands and load authoritative state |

### Price flow

```text
Frontend                    Backend                     Coinbase
   │                           │                           │
   │                           │  BTC/USD price [WS]       │
   │                           │◄──────────────────────────┤
   │  BTC/USD price [WS]       │                           │
   │◄──────────────────────────────────────────────────────┤
```
Both the frontend and backend independently subscribe to the Coinbase WebSocket ticker. The frontend connection is used only to display the live price. The backend connection remains authoritative for entry prices and guess resolution. This avoids relaying every price update through the application's AWS infrastructure.

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
   │ countdown reaches zero    │                           │                           │
   │ GET latest guess + score [REST]                       │                           │
   ├──────────────────────────►│                           │                           │
   │                           │ query authoritative state │                           │
   │                           ├──────────────────────────►│                           │
   │                           │◄──────────────────────────┤                           │
   │◄──────────────────────────┤                           │                           │
```

The frontend submits a new guess to the backend via REST.

The backend resolves guesses as follows: Whenever a new price update arrives, it checks the database for guesses eligible for resolution, meaning it checks if 60s have passed since the guess was received. If a guess can be resolved, the backend resolves it and stores the result. The frontend then observes the resolved state on its next REST request.

After the countdown reaches zero, the frontend checks the authoritative state through REST every two seconds until the guess is resolved. The frontend is not involved in the logic for resolving guesses.


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

**The current design allows for only one backend instance** In more than one backend instance all instances would consume the price stream and update the guesses. Conditional updates inside a transaction can be used to preserve correctness, but the duplicated queries still waste database capacity. For horizontal scaling, we could for example have dedicated workers that work on disjoint batches.



