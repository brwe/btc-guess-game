.PHONY: backend-test fullstack-up-realtime

backend-test:
	cd backend && bun install --frozen-lockfile && bun test

fullstack-up-realtime:
	COINBASE_TICKER_CHANNEL=ticker GUESS_DURATION_SECONDS=20 docker compose up --build
