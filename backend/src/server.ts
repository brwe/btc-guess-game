import postgres from "postgres";
import { createApi } from "./api";
import { CoinbaseTickerClient } from "./coinbaseTickerClient";
import { PostgresGuessRepository } from "./guessRepository";
import { InMemoryLatestPriceStore } from "./latestPriceStore";
import { PriceMessageProcessor } from "./priceMessageProcessor";

const port = Number(process.env.PORT ?? 3001);
const host = process.env.HOST ?? "0.0.0.0";
const databaseUrl = process.env.DATABASE_URL;
const guessDurationSeconds = Number(process.env.GUESS_DURATION_SECONDS ?? 60);
const coinbaseWebSocketUrl = process.env.COINBASE_WEBSOCKET_URL
  ?? "wss://ws-feed.exchange.coinbase.com";

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
const coinbaseTickerClient = new CoinbaseTickerClient(priceMessageProcessor, {
  url: coinbaseWebSocketUrl,
});

await guessRepository.initialize();

const app = createApi({
  guessRepository,
  latestPriceStore,
  priceMessageProcessor,
  guessDurationSeconds,
});

const server = Bun.serve({ port, hostname: host, fetch: app.fetch });
coinbaseTickerClient.start();

console.log(`Backend listening on http://${host}:${port}`);

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  coinbaseTickerClient.stop();
  server.stop(true);
  await sql.end();
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
