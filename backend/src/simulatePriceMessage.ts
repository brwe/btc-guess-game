import postgres from "postgres";
import { PostgresGuessRepository } from "./guessRepository";
import { PriceMessageProcessor } from "./priceMessageProcessor";

const [priceArgument, observedAtArgument] = Bun.argv.slice(2);

if (!priceArgument) {
  throw new Error("Usage: bun run simulate:price -- <price> [observed-at]");
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

const sql = postgres(databaseUrl, { max: 1 });
const guessRepository = new PostgresGuessRepository(sql);
const processor = new PriceMessageProcessor(guessRepository);

try {
  const result = await processor.process({
    price: Number(priceArgument),
    observedAt: observedAtArgument ? new Date(observedAtArgument) : new Date(),
  });

  console.log(JSON.stringify(result, null, 2));
} finally {
  await sql.end();
}
