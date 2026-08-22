.PHONY: backend-test

backend-test:
	cd backend && bun install --frozen-lockfile && bun test


fullstack-up:
	GUESS_DURATION_SECONDS=5 docker compose up --build 
