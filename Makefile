.PHONY: backend-test backend-integration-test fullstack-up-realtime

backend-test:
	cd backend && bun install --frozen-lockfile && bun test

backend-integration-test:
	@set -e; \
	cleanup() { docker compose -p btc-guess-game-test -f docker-compose.test.yml down --volumes --remove-orphans; }; \
	trap cleanup EXIT INT TERM; \
	docker compose -p btc-guess-game-test -f docker-compose.test.yml up \
		--build --abort-on-container-exit --exit-code-from backend-test

fullstack-up-realtime:
	COINBASE_TICKER_CHANNEL=ticker GUESS_DURATION_SECONDS=60 docker compose up --build
