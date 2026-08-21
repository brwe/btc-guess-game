import postgres from "postgres";
import { createApi } from "./api";
import { PostgresGuessRepository } from "./guessRepository";
import { InMemoryLatestPriceStore } from "./latestPriceStore";
import { PriceMessageProcessor } from "./priceMessageProcessor";

const port = Number(process.env.PORT ?? 3001);
const host = process.env.HOST ?? "0.0.0.0";
const databaseUrl = process.env.DATABASE_URL;
const guessDurationSeconds = Number(process.env.GUESS_DURATION_SECONDS ?? 60);

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

if (!Number.isInteger(guessDurationSeconds) || guessDurationSeconds <= 0) {
  throw new Error("GUESS_DURATION_SECONDS must be a positive integer");
}

const sql = postgres(databaseUrl, { max: 5 });
const guessRepository = new PostgresGuessRepository(sql);
const latestPriceStore = new InMemoryLatestPriceStore();
const priceMessageProcessor = new PriceMessageProcessor(guessRepository, latestPriceStore);

await guessRepository.initialize();

const app = createApi({
  guessRepository,
  latestPriceStore,
  priceMessageProcessor,
  guessDurationSeconds,
});

Bun.serve({ port, hostname: host, fetch: app.fetch });

console.log(`Backend listening on http://${host}:${port}`);
