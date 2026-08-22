# epilot Bitcoin Guessing Game

## Overview

This app lets players guess whether the BTC price will be higher or lower after one minute.

## Assumptions

- The game uses the BTC/USD pair.

- If the exchange pair changes, both the displayed price and the resolution logic need to use the same pair to keep guesses fair.

- The backend uses Coinbase `ticker_batch` by default so the app receives at most one changed price update every five seconds. Set `COINBASE_TICKER_CHANNEL=ticker` to receive higher-frequency updates when matches happen; this increases database resolution checks and SSE traffic.

- The backend keeps the latest BTC/USD price and the timestamp of the most recent update in memory.

- The price displayed by the frontend is informational and can become stale while a guess request is in transit. The client sends only the player id and direction; when the backend accepts the request, it snapshots its latest known price, persists that value as the guess's entry price, and returns it in the response. That authoritative entry price can therefore differ slightly from the price the player saw when clicking. The frontend displays the returned entry price for the active guess. This tradeoff prevents clients from choosing or manipulating their own entry price.

- Pending guesses use PostgreSQL as the source of truth instead of being duplicated in an in-memory map. When a price update arrives, the resolution design queries indexed pending guesses whose `resolve_after` timestamp has passed and whose entry price differs from the new price. This avoids synchronizing an in-memory copy with the database during one backend run.

- Price updates are passed to a source-agnostic processor as `{ price, observedAt }`. Tests, simulations, and the Coinbase WebSocket adapter call the same method. `observedAt` is the exchange event timestamp used to decide whether `resolve_after` has passed.

- Resolved guesses store `resolved_at` and `resolved_price`. The result and score change are derived from `direction`, `entry_price`, and `resolved_price` instead of being persisted as duplicate data.

- This pet-project setup does not use database migrations. Local Docker sets `RESET_DATABASE_ON_START=true`, so local backend starts recreate the `guesses` table. The AWS task sets it to `false` and uses idempotent table initialization so ECS replacements do not erase RDS data. Versioned migrations should replace this initializer before evolving a deployed schema.

- This database-query approach has a scalability limitation: if every backend instance consumes the same price stream, every instance can query the same eligible guesses and attempt to resolve them. Conditional updates inside a transaction can preserve correctness, but the duplicated queries still waste database capacity. If horizontal scaling becomes necessary, price processing should move to one elected resolver or a dedicated worker; alternatively, workers can claim disjoint batches with PostgreSQL row locking such as `FOR UPDATE SKIP LOCKED`.

- The backend keeps one upstream WebSocket connection to Coinbase and exposes one player-scoped Server-Sent Events stream to each frontend. The stream carries live price updates and guess-resolution notifications.

- Anonymous players are identified by a generated player id stored in browser local storage, and that id is used to load the same score and guess history when the browser returns.

- The backend and frontend are written in TypeScript. The backend runs on Bun and uses Hono for HTTP routing, middleware, and request validation. The frontend is built as static files for S3, ideally with CloudFront in front of the bucket.

- The score starts at 0 for a new player and is calculated by the backend from that player's persisted resolved guesses. The frontend does not determine outcomes or increment score locally; it displays the result, wins, losses, and total score returned by the backend.

- A player can only have one active guess at a time.

- A guess resolves only after at least 60 seconds have passed and the price has changed.

## Run

From `/Users/a2tirb/robofarm/epilot-challenge`, run:

```bash
docker compose up --build
```

The guess duration is configured with `GUESS_DURATION_SECONDS` on the backend and defaults to `60`. For faster local testing, start the stack with `GUESS_DURATION_SECONDS=5 docker compose up --build`. The backend returns the resulting `resolveAfter` timestamp, which drives the frontend countdown.

The backend connects to Coinbase Exchange at `wss://ws-feed.exchange.coinbase.com` and subscribes to the unauthenticated channel selected by `COINBASE_TICKER_CHANNEL` for `BTC-USD`. It defaults to `ticker_batch`; accepted values are `ticker_batch` and `ticker`. The URL can be overridden with `COINBASE_WEBSOCKET_URL`, for example to use the Coinbase sandbox feed.

Then open:

- Frontend: `http://localhost:3000`
- Backend: `http://localhost:3001/api/hello`
- Postgres: `localhost:5432`

To run the short-duration local game with Coinbase's higher-frequency `ticker` channel:

```bash
make fullstack-up-realtime
```

## Local Docker Scaffold

The React frontend displays the latest BTC/USD price, score, wins, and losses. A player can submit one `up` or `down` guess at a time. Both buttons are disabled while the guess is pending.

The browser opens `GET /api/players/:playerId/events` as an SSE stream. `price-updated` events replace price polling, while player-scoped `guess-resolved` events tell the frontend to reload the latest guess and score. Guesses are ordered by `resolve_after DESC`, with `created_at DESC` and `id DESC` as deterministic tie-breakers. Only the anonymous player id is stored in browser storage; guesses and score are reloaded from the backend and are not stored or incremented by the browser.

The backend derives wins and losses from resolved guesses and returns the current score as `wins - losses`. It also determines whether each resolved guess was won or lost. This keeps all game calculations authoritative even if an event is delivered more than once or the application is open in multiple browser tabs.

The frontend reads the latest price from `GET /api/price`. Price updates enter the backend only through its Coinbase WebSocket connection; there is no public endpoint for injecting prices.

## Realtime Updates and SSE Decision

The displayed market price and a guess's settlement status are separate resources with independent timing. There are three relevant prices:

- The displayed price comes from `price-updated` SSE events, with `GET /api/price` used for initial and reconnection snapshots.
- The entry price is the backend's price snapshot when it accepts the guess. It is immutable and returned by `POST /api/guesses`.
- The resolution price is an eligible Coinbase price received after `resolve_after` whose value differs from the entry price.

After a player submits `up` or `down`, the frontend moves through `submitting`, `pending countdown`, `awaiting settlement`, and finally `won` or `lost`. Market prices received before `resolve_after` update the displayed ticker but cannot resolve the guess. The backend publishes price events only after it finishes processing database resolutions for that price. If a guess resolves, the subsequent player-scoped notification makes the frontend reload the authoritative guess and score. A visible price change is never used by the frontend to infer a result.

SSE was chosen over WebSockets because updates flow only from the backend to the browser. The browser performs REST snapshot reads when it first loads and whenever the SSE connection opens or reconnects, so temporary disconnections and missed or duplicate notifications recover from PostgreSQL. A 15-second heartbeat keeps idle streams active.

The current event broadcaster is intentionally in-memory and therefore matches the current single-backend deployment. SSE solves only the connection between one backend instance and one browser. In a multi-instance deployment, the instance that resolves a guess may not hold that player's browser connection. Correct cross-instance delivery would require shared Pub/Sub such as PostgreSQL `LISTEN/NOTIFY`, Redis, or a message broker. Strong delivery guarantees may additionally require a transactional outbox so a committed resolution cannot lose its notification.

Streamed guess events remain disposable notifications rather than the source of truth. A `guess-resolved` event tells the frontend to reload the latest guess and score through REST. Price events carry display data, while `GET /api/price` supplies the initial and reconnection snapshot. This hybrid snapshot-plus-notification model recovers safely from missed or duplicate events.

## Deploy to AWS

The CDK stack in `infra/` creates:

- A two-AZ VPC with public subnets and isolated database subnets, without NAT gateways.
- One public ECS Fargate task with `0.25` vCPU and `0.5 GB` memory.
- An internet-facing Application Load Balancer.
- A private, encrypted, Single-AZ PostgreSQL `db.t4g.micro` RDS instance with 20 GB GP3 storage.
- A private S3 frontend bucket and CloudFront distribution.
- CloudFront routing from `/api/*` to the load balancer and all other paths to S3.
- A generated Secrets Manager database credential injected into the ECS task.

Prerequisites are Docker, Bun, AWS credentials, and a CDK-bootstrapped AWS account. The default deployment region is `eu-central-1`.

### AWS credentials

CDK uses the standard AWS SDK credential chain. Do not put AWS access keys in this repository. Configure credentials with one of these options:

1. For an IAM access key created for local development, store it in the AWS CLI credentials file:

   ```bash
   aws configure --profile epilot
   ```

   `aws configure` writes the credentials to `~/.aws/credentials` and configuration to `~/.aws/config`; neither file belongs in the project.

2. In CI, use the CI provider's secret store or OpenID Connect integration to supply short-lived AWS credentials. Do not commit credentials or place them in frontend environment variables.

Confirm the selected identity and account before deploying:

```bash
aws sts get-caller-identity --profile epilot
```

The infrastructure package scripts and every AWS CLI example below select `--profile epilot` explicitly, so exporting `AWS_PROFILE` is not required.

### Deploy

```bash
cd infra
bun install
bun run bootstrap
bun run synth
bun run deploy
```

The deployment outputs `ApplicationUrl`, which is the public CloudFront URL. The frontend build is produced inside a Bun Docker container during synthesis, and the backend image is built and uploaded as a CDK Docker asset.

### After deployment

1. Copy the `ApplicationUrl` value printed under `Outputs` by `bun run deploy`, or retrieve it later:

   ```bash
   aws cloudformation describe-stacks \
     --stack-name EpilotChallengeStack \
     --query "Stacks[0].Outputs[?OutputKey=='ApplicationUrl'].OutputValue" \
     --output text \
     --profile epilot
   ```

2. Open `ApplicationUrl`. CloudFront can take several minutes to finish distributing a new deployment.

3. Verify the backend through the same CloudFront domain:

   ```bash
   APPLICATION_URL=$(aws cloudformation describe-stacks \
     --stack-name EpilotChallengeStack \
     --query "Stacks[0].Outputs[?OutputKey=='ApplicationUrl'].OutputValue" \
     --output text \
     --profile epilot)
   curl "$APPLICATION_URL/health"
   curl "$APPLICATION_URL/api/price"
   ```

4. In the frontend, wait until a BTC/USD price appears, submit an `up` or `down` guess, and confirm that it resolves after the configured 60-second duration and a subsequent price change.

5. If the health check or price endpoint fails, inspect the `EpilotChallengeStack` ECS service events and the `/aws/ecs/` CloudWatch log group created by the stack. The backend creates its database table on startup; no manual SQL setup is required for this schema.

This short-lived challenge stack uses `RemovalPolicy.DESTROY` for RDS, S3, and log storage. Destroying it permanently deletes the database and frontend files:

```bash
cd infra
bun run destroy
```

The RDS instance is not publicly accessible. The ECS service can connect on the PostgreSQL port, while the public Fargate address provides outbound access to Coinbase without a NAT gateway.

TODOS:

- make the app work:
  - ~~concurrency issues~~ -> don't do
  - ~~migration handling~~ -> don't do
  - ~~authorizaton and authentication~~ -> don't do
  - deployment 
  - design
  - documentation
  - code review
  - ~~stale state frontend if db was dropped~~ -> don't do


4. ~~Entry price is controlled by the client~~ -> solved by letting the backend snapshot and return the authoritative entry price. The client sends only:

```json
{
  "playerId": "...",
  "direction": "up"
}
```


5. ~~Frontend polling can count a result twice~~ -> solved by making the backend authoritative for outcomes and score, then replacing price and guess polling with SSE notifications plus authoritative REST snapshot reads.
