import postgres from "postgres";
import { createApi } from "./api";
import { CoinbaseTickerClient } from "./coinbaseTickerClient";
import type { CoinbaseTickerChannel } from "./coinbaseTickerClient";
import { PostgresGuessRepository } from "./guessRepository";
import { InMemoryLatestPriceStore } from "./latestPriceStore";
import { PriceMessageProcessor } from "./priceMessageProcessor";

const port = Number(process.env.PORT ?? 3001);
const host = process.env.HOST ?? "0.0.0.0";
const databaseUrl = process.env.DATABASE_URL;
const guessDurationSeconds = Number(process.env.GUESS_DURATION_SECONDS ?? 60);
const coinbaseWebSocketUrl =
  process.env.COINBASE_WEBSOCKET_URL ?? "wss://ws-feed.exchange.coinbase.com";
const coinbaseTickerChannel = parseCoinbaseTickerChannel(
  process.env.COINBASE_TICKER_CHANNEL ?? "ticker_batch",
);
const resetDatabaseOnStart = process.env.RESET_DATABASE_ON_START === "true";

if (!Number.isInteger(guessDurationSeconds) || guessDurationSeconds <= 0) {
  throw new Error("GUESS_DURATION_SECONDS must be a positive integer");
}

const sql = databaseUrl
  ? postgres(databaseUrl, { max: 5 })
  : postgres({
      host: requiredEnvironmentVariable("DB_HOST"),
      port: Number(process.env.DB_PORT ?? 5432),
      database: requiredEnvironmentVariable("DB_NAME"),
      username: requiredEnvironmentVariable("DB_USER"),
      password: requiredEnvironmentVariable("DB_PASSWORD"),
      ssl: "require",
      max: 5,
    });
const guessRepository = new PostgresGuessRepository(sql);
const latestPriceStore = new InMemoryLatestPriceStore();
const priceMessageProcessor = new PriceMessageProcessor(
  guessRepository,
  latestPriceStore,
);
const coinbaseTickerClient = new CoinbaseTickerClient(priceMessageProcessor, {
  url: coinbaseWebSocketUrl,
  channel: coinbaseTickerChannel,
});

await guessRepository.initialize({ reset: resetDatabaseOnStart });
coinbaseTickerClient.start();

const app = createApi({
  guessRepository,
  latestPriceStore,
  isReady: () => coinbaseTickerClient.isReady(),
  guessDurationSeconds,
});

const server = Bun.serve({ port, hostname: host, fetch: app.fetch });

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

function requiredEnvironmentVariable(name: string) {
  const value = process.env[name];
  if (!value)
    throw new Error(`${name} is required when DATABASE_URL is not set`);
  return value;
}

function parseCoinbaseTickerChannel(value: string): CoinbaseTickerChannel {
  if (value === "ticker" || value === "ticker_batch") return value;
  throw new Error("COINBASE_TICKER_CHANNEL must be 'ticker' or 'ticker_batch'");
}
