import postgres from "postgres";
import { createApi } from "./api";
import { PostgresGuessRepository } from "./guessRepository";

const port = Number(process.env.PORT ?? 3001);
const host = process.env.HOST ?? "0.0.0.0";
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

const sql = postgres(databaseUrl, { max: 5 });
const guessRepository = new PostgresGuessRepository(sql);

await guessRepository.initialize();

const app = createApi({ guessRepository });

Bun.serve({ port, hostname: host, fetch: app.fetch });

console.log(`Backend listening on http://${host}:${port}`);
