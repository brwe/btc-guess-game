.PHONY: backend-test backend-integration-test fullstack-up-realtime

TEST_COMPOSE := docker compose -p btc-guess-game-test -f docker-compose.test.yml

backend-test:
	cd backend && bun install --frozen-lockfile && bun test

backend-integration-test:
	@set -e; \
	cleanup() { $(TEST_COMPOSE) down --volumes --remove-orphans; }; \
	trap cleanup EXIT INT TERM; \
	$(TEST_COMPOSE) build backend-test; \
	$(TEST_COMPOSE) up -d --wait postgres-test; \
	$(TEST_COMPOSE) run --rm --no-deps backend-test

fullstack-up-realtime:
	COINBASE_TICKER_CHANNEL=ticker GUESS_DURATION_SECONDS=60 docker compose up --build
