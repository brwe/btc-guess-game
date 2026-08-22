# epilot Bitcoin Guessing Game

## Overview

This app lets players guess whether the BTC price will be higher or lower after one minute.

## Assumptions

- The game uses the BTC/USD pair.

- If the exchange pair changes, both the displayed price and the resolution logic need to use the same pair to keep guesses fair.

- The backend subscribes to Coinbase `ticker_batch` instead of `ticker` so the app uses fewer live updates and keeps infrastructure cost lower; if we need a finer-grained stream later, we can switch to one.

- The backend keeps the latest BTC/USD price and the timestamp of the most recent update in memory.

- The price displayed by the frontend is informational and can become stale while a guess request is in transit. The client sends only the player id and direction; when the backend accepts the request, it snapshots its latest known price, persists that value as the guess's entry price, and returns it in the response. That authoritative entry price can therefore differ slightly from the price the player saw when clicking. The frontend displays the returned entry price for the active guess. This tradeoff prevents clients from choosing or manipulating their own entry price.

- Pending guesses use PostgreSQL as the source of truth instead of being duplicated in an in-memory map. When a price update arrives, the resolution design queries indexed pending guesses whose `resolve_after` timestamp has passed and whose entry price differs from the new price. This avoids synchronizing an in-memory copy with the database during one backend run.

- Price updates are passed to a source-agnostic processor as `{ price, observedAt }`. Tests, simulations, and the Coinbase WebSocket adapter call the same method. `observedAt` is the exchange event timestamp used to decide whether `resolve_after` has passed.

- Resolved guesses store `resolved_at` and `resolved_price`. The result and score change are derived from `direction`, `entry_price`, and `resolved_price` instead of being persisted as duplicate data.

- This pet-project setup does not use database migrations. Local Docker sets `RESET_DATABASE_ON_START=true`, so local backend starts recreate the `guesses` table. The AWS task sets it to `false` and uses idempotent table initialization so ECS replacements do not erase RDS data. Versioned migrations should replace this initializer before evolving a deployed schema.

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
  - deployment 
  - design
  - documentation
  - code review
  - ~~stale state frontend if db was dropped~~ -> don't do


4. Entry price is controlled by the client
The browser sends entryPrice. A malicious or merely stale client can submit a price unrelated to the backend’s current price.
There is also a timing race between displaying a price and submitting the guess. The backend should choose the authoritative entry price when inserting the guess; the client should send only:
{
  "playerId": "...",
  "direction": "up"
}


5. Frontend polling can count a result twice
The polling interval launches checkGuess() every two seconds without checking whether the previous request is still running. If a request takes longer than two seconds, two resolved responses can both increment the locally stored score.
Use an in-flight guard, or preferably calculate score on the backend from uniquely resolved guesses rather than incrementing it in browser storage.
