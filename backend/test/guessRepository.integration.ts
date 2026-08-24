import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import postgres from "postgres";
import {
  PendingGuessConflictError,
  PostgresGuessRepository,
  type Direction,
} from "../src/guessRepository";

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("TEST_DATABASE_URL or DATABASE_URL is required for repository integration tests");
}

const schemaName = `btc_guess_test_${crypto.randomUUID().replaceAll("-", "")}`;
const adminSql = postgres(databaseUrl, { max: 1, onnotice() {} });
const testSql = postgres(databaseUrl, {
  max: 5,
  connection: { search_path: schemaName },
});
const repository = new PostgresGuessRepository(testSql);
const createdAt = new Date("2026-08-24T10:00:00.000Z");
const resolveAfter = new Date("2026-08-24T10:01:00.000Z");

beforeAll(async () => {
  await adminSql.unsafe(`CREATE SCHEMA "${schemaName}"`);
  await repository.initialize();
});

beforeEach(async () => {
  await testSql`TRUNCATE TABLE guesses`;
});

afterAll(async () => {
  await testSql.end();
  await adminSql.unsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
  await adminSql.end();
});

function insertGuess({
  id,
  playerId,
  direction,
  entryPrice,
}: {
  id: string;
  playerId: string;
  direction: Direction;
  entryPrice: number;
}) {
  return repository.insert({
    id,
    playerId,
    direction,
    entryPrice,
    createdAt,
    resolveAfter,
  });
}

describe("PostgresGuessRepository", () => {
  test("resolves only after the deadline and only when the price has changed", async () => {
    await insertGuess({
      id: "10000000-0000-4000-8000-000000000001",
      playerId: "player-1",
      direction: "up",
      entryPrice: 60_000,
    });

    expect(await repository.resolveEligible(
      60_100,
      new Date(resolveAfter.getTime() - 1),
    )).toEqual([]);
    expect(await repository.resolveEligible(60_000, resolveAfter)).toEqual([]);

    const [pending] = await repository.findPlayerGuesses("player-1", 1);
    expect(pending?.status).toBe("pending");

    expect(await repository.resolveEligible(60_100, resolveAfter)).toEqual([{
      id: "10000000-0000-4000-8000-000000000001",
      playerId: "player-1",
    }]);

    const [resolved] = await repository.findPlayerGuesses("player-1", 1);
    expect(resolved).toMatchObject({
      status: "resolved",
      resolved_at: resolveAfter,
      resolved_price: 60_100,
    });
  });

  test("calculates wins, losses, and scores for both directions", async () => {
    const cases = [
      ["10000000-0000-4000-8000-000000000011", "up-winner", "up", 60_000, 1],
      ["10000000-0000-4000-8000-000000000012", "down-loser", "down", 60_000, -1],
      ["10000000-0000-4000-8000-000000000013", "up-loser", "up", 62_000, -1],
      ["10000000-0000-4000-8000-000000000014", "down-winner", "down", 62_000, 1],
    ] as const;

    for (const [id, playerId, direction, entryPrice] of cases) {
      await insertGuess({ id, playerId, direction, entryPrice });
    }

    expect(await repository.resolveEligible(61_000, resolveAfter)).toHaveLength(4);

    for (const [, playerId, , , expectedScore] of cases) {
      const score = await repository.getPlayerScore(playerId);
      expect(score.wins - score.losses).toBe(expectedScore);
      expect(score).toEqual(expectedScore === 1
        ? { wins: 1, losses: 0 }
        : { wins: 0, losses: 1 });
    }
    expect(await repository.getPlayerScore("new-player")).toEqual({ wins: 0, losses: 0 });
  });

  test("enforces one pending guess per player under concurrent inserts", async () => {
    const attempts = await Promise.allSettled([
      insertGuess({
        id: "10000000-0000-4000-8000-000000000021",
        playerId: "same-player",
        direction: "up",
        entryPrice: 60_000,
      }),
      insertGuess({
        id: "10000000-0000-4000-8000-000000000022",
        playerId: "same-player",
        direction: "down",
        entryPrice: 60_000,
      }),
    ]);

    expect(attempts.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find(({ status }) => status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: expect.any(PendingGuessConflictError),
    });
    expect(await repository.findPlayerGuesses("same-player", 10)).toHaveLength(1);

    await repository.resolveEligible(61_000, resolveAfter);
    await expect(insertGuess({
      id: "10000000-0000-4000-8000-000000000023",
      playerId: "same-player",
      direction: "up",
      entryPrice: 61_000,
    })).resolves.toBeUndefined();
  });

  test("allows different players to have pending guesses", async () => {
    await expect(Promise.all([
      insertGuess({
        id: "10000000-0000-4000-8000-000000000031",
        playerId: "player-a",
        direction: "up",
        entryPrice: 60_000,
      }),
      insertGuess({
        id: "10000000-0000-4000-8000-000000000032",
        playerId: "player-b",
        direction: "down",
        entryPrice: 60_000,
      }),
    ])).resolves.toEqual([undefined, undefined]);
  });
});
