.PHONY: backend-test backend-integration-test fullstack-up-realtime

backend-test:
	cd backend && bun install --frozen-lockfile && bun test

backend-integration-test:
	docker compose up -d --wait postgres
	docker compose run --rm backend bun run test:integration

fullstack-up-realtime:
	COINBASE_TICKER_CHANNEL=ticker GUESS_DURATION_SECONDS=60 docker compose up --build
