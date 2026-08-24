import { describe, expect, test } from "bun:test";
import { createApi } from "../src/api";
import { PendingGuessConflictError } from "../src/guessRepository";
import type { GuessRepository, GuessRow, NewGuess } from "../src/guessRepository";
import { InMemoryLatestPriceStore } from "../src/latestPriceStore";

const guessId = "6c3a2fc2-bcf5-4f5f-a755-21d91ff21973";
const createdAt = new Date("2026-08-19T10:00:00.000Z");
const latestPrice = 59_321.25;
type ApiGuessRepository = Pick<GuessRepository, "insert" | "findPlayerGuesses" | "getPlayerScore">;

function createApiGuessRepository(
  overrides: Partial<ApiGuessRepository> = {},
): ApiGuessRepository {
  return {
    async insert() {},
    async findPlayerGuesses() { return []; },
    async getPlayerScore() { return { wins: 0, losses: 0 }; },
    ...overrides,
  };
}

function createRequiredApiDependencies(
  latestPriceStore = createLatestPriceStore(),
) {
  return {
    latestPriceStore,
    isReady: () => true,
    guessRepository: createApiGuessRepository(),
    guessDurationSeconds: 60,
  };
}

describe("GET /health", () => {
  test("returns 503 until the ticker client is ready", async () => {
    const app = createApi({
      ...createRequiredApiDependencies(),
      isReady: () => false,
    });

    const response = await app.request("/health");

    expect(response.status).toBe(503);
  });

  test("returns 200 when the ticker client is ready", async () => {
    const app = createApi(createRequiredApiDependencies());

    const response = await app.request("/health");

    expect(response.status).toBe(200);
  });
});

function createLatestPriceStore() {
  const store = new InMemoryLatestPriceStore();
  store.set({ price: latestPrice, observedAt: createdAt });
  return store;
}

function createTestContext(existingRows: GuessRow[] = []) {
  const inserted: NewGuess[] = [];
  const rows = [...existingRows];
  const repository = createApiGuessRepository({
    async insert(guess) {
      inserted.push(guess);
      rows.push({
        id: guess.id,
        player_id: guess.playerId,
        direction: guess.direction,
        entry_price: guess.entryPrice,
        status: "pending",
        created_at: guess.createdAt,
        resolve_after: guess.resolveAfter,
        resolved_at: null,
        resolved_price: null,
      });
    },
    async findPlayerGuesses(playerId, limit) {
      return rows
        .filter((row) => row.player_id === playerId)
        .sort((left, right) => right.resolve_after.getTime() - left.resolve_after.getTime())
        .slice(0, limit);
    },
  });
  const app = createApi({
    ...createRequiredApiDependencies(),
    guessRepository: repository,
    createId: () => guessId,
    now: () => createdAt,
  });

  return { app, inserted };
}

describe("POST /api/guesses", () => {
  test("persists a pending guess and returns its id", async () => {
    const { app, inserted } = createTestContext();
    const response = await app.request("/api/guesses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ direction: "up", playerId: "player-1" }),
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      guessId,
      status: "pending",
      entryPrice: latestPrice,
      resolveAfter: "2026-08-19T10:01:00.000Z",
      remainingSeconds: 60,
    });
    expect(inserted).toEqual([{
      id: guessId,
      playerId: "player-1",
      direction: "up",
      entryPrice: latestPrice,
      createdAt,
      resolveAfter: new Date("2026-08-19T10:01:00.000Z"),
    }]);
  });

  test("allows only one concurrent pending guess per player", async () => {
    const inserted: NewGuess[] = [];
    const guessIds = [
      "6c3a2fc2-bcf5-4f5f-a755-21d91ff21973",
      "208d7707-9385-4f6e-8d41-c01272468d58",
    ];
    let nextGuessId = 0;
    const app = createApi({
      ...createRequiredApiDependencies(),
      guessRepository: createApiGuessRepository({
        async insert(guess) {
          if (inserted.some((existing) => existing.playerId === guess.playerId)) {
            throw new PendingGuessConflictError();
          }

          inserted.push(guess);
        },
      }),
      createId: () => guessIds[nextGuessId++]!,
      now: () => createdAt,
    });
    const registerGuess = (direction: "up" | "down") => app.request("/api/guesses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        direction,
        playerId: "player-1",
      }),
    });

    const responses = await Promise.all([
      registerGuess("up"),
      registerGuess("down"),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    const conflictResponse = responses.find((response) => response.status === 409);
    expect(await conflictResponse?.json()).toEqual({
      error: "player already has a pending guess",
    });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.playerId).toBe("player-1");
  });

  test("generates a UUID when no id factory is provided", async () => {
    const inserted: NewGuess[] = [];
    const app = createApi({
      ...createRequiredApiDependencies(),
      guessRepository: createApiGuessRepository({
        async insert(guess) {
          inserted.push(guess);
        },
      }),
      now: () => createdAt,
    });

    const response = await app.request("/api/guesses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ direction: "up", playerId: "player-1" }),
    });
    const body = await response.json() as { guessId: string };

    expect(response.status).toBe(201);
    expect(body.guessId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(inserted[0]?.id).toBe(body.guessId);
  });

  test("uses the configured guess duration", async () => {
    const inserted: NewGuess[] = [];
    const app = createApi({
      ...createRequiredApiDependencies(),
      guessRepository: createApiGuessRepository({
        async insert(guess) {
          inserted.push(guess);
        },
      }),
      createId: () => guessId,
      now: () => createdAt,
      guessDurationSeconds: 5,
    });

    const response = await app.request("/api/guesses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ direction: "up", playerId: "player-1" }),
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      guessId,
      status: "pending",
      entryPrice: latestPrice,
      resolveAfter: "2026-08-19T10:00:05.000Z",
      remainingSeconds: 5,
    });
    expect(inserted[0]?.resolveAfter).toEqual(new Date("2026-08-19T10:00:05.000Z"));
  });

  test("ignores a client-supplied entry price", async () => {
    const { app, inserted } = createTestContext();
    const response = await app.request("/api/guesses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        direction: "up",
        playerId: "player-1",
        entryPrice: 1,
      }),
    });

    expect(response.status).toBe(201);
    expect(inserted[0]?.entryPrice).toBe(latestPrice);
    expect(await response.json()).toMatchObject({ entryPrice: latestPrice });
  });

  test.each([
    [{ direction: "sideways", playerId: "player-1" }, "direction must be 'up' or 'down'"],
    [{ direction: "down" }, "playerId must be a non-empty string"],
    [{ direction: "down", playerId: "   " }, "playerId must be a non-empty string"],
    [{ direction: "down", playerId: 123 }, "playerId must be a non-empty string"],
  ])("rejects invalid input", async (body, error) => {
    const { app, inserted } = createTestContext();
    const response = await app.request("/api/guesses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error });
    expect(inserted).toHaveLength(0);
  });

  test("rejects malformed JSON", async () => {
    const { app } = createTestContext();
    const response = await app.request("/api/guesses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid JSON body" });
  });

  test("returns 503 instead of accepting a guess before a price is available", async () => {
    const latestPriceStore = new InMemoryLatestPriceStore();
    const inserted: NewGuess[] = [];
    const app = createApi({
      ...createRequiredApiDependencies(latestPriceStore),
      guessRepository: createApiGuessRepository({
        async insert(guess) { inserted.push(guess); },
      }),
    });

    const response = await app.request("/api/guesses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ direction: "up", playerId: "player-1" }),
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "authoritative price temporarily unavailable",
    });
    expect(inserted).toHaveLength(0);
  });

  test("returns 503 instead of accepting a guess when the stored price is stale", async () => {
    const inserted: NewGuess[] = [];
    const app = createApi({
      ...createRequiredApiDependencies(),
      isReady: () => false,
      guessRepository: createApiGuessRepository({
        async insert(guess) { inserted.push(guess); },
      }),
    });

    const response = await app.request("/api/guesses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ direction: "up", playerId: "player-1" }),
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "authoritative price temporarily unavailable",
    });
    expect(inserted).toHaveLength(0);
  });
});

describe("removed price endpoints", () => {
  test("does not expose GET /api/price", async () => {
    const app = createApi({
      ...createRequiredApiDependencies(),
      guessRepository: createApiGuessRepository(),
    });

    const response = await app.request("/api/price");

    expect(response.status).toBe(404);
  });

  test("does not expose POST /api/price-messages", async () => {
    const app = createApi({
      ...createRequiredApiDependencies(),
      guessRepository: createApiGuessRepository(),
    });

    const response = await app.request("/api/price-messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ price: 63_000 }),
    });

    expect(response.status).toBe(404);
  });
});

describe("GET /api/players/:playerId/guesses", () => {
  test("returns the player's latest guess", async () => {
    const { app } = createTestContext();
    await app.request("/api/guesses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ direction: "down", playerId: "player-1" }),
    });

    const response = await app.request("/api/players/player-1/guesses?limit=1");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([{
      guessId,
      playerId: "player-1",
      direction: "down",
      entryPrice: latestPrice,
      status: "pending",
      createdAt: "2026-08-19T10:00:00.000Z",
      resolveAfter: "2026-08-19T10:01:00.000Z",
      resolvedAt: null,
      resolvedPrice: null,
      result: null,
      remainingSeconds: 60,
    }]);
  });

  test("returns the backend-computed result", async () => {
    const resolvedGuess: GuessRow = {
      id: guessId,
      player_id: "player-1",
      direction: "up",
      entry_price: 60_000,
      status: "resolved",
      created_at: createdAt,
      resolve_after: new Date("2026-08-19T10:01:00.000Z"),
      resolved_at: new Date("2026-08-19T10:01:05.000Z"),
      resolved_price: 61_000,
    };
    const app = createApi({
      ...createRequiredApiDependencies(),
      guessRepository: createApiGuessRepository({
        async findPlayerGuesses(playerId, limit) {
          expect(playerId).toBe("player-1");
          expect(limit).toBe(1);
          return [resolvedGuess];
        },
      }),
    });

    const response = await app.request("/api/players/player-1/guesses?limit=1");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([expect.objectContaining({
      result: "won",
    })]);
  });

  test("returns an empty collection when the player has no guesses", async () => {
    const { app } = createTestContext();
    const response = await app.request("/api/players/player-1/guesses?limit=1");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
  });

  test.each(["0", "101", "1.5", "invalid"])('rejects invalid limit "%s"', async (limit) => {
    const { app } = createTestContext();
    const response = await app.request(`/api/players/player-1/guesses?limit=${limit}`);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "limit must be an integer between 1 and 100",
    });
  });
});

describe("GET /api/players/:playerId/score", () => {
  test("returns the score calculated by the backend", async () => {
    const app = createApi({
      ...createRequiredApiDependencies(),
      guessRepository: createApiGuessRepository({
        async getPlayerScore(playerId) {
          expect(playerId).toBe("player-1");
          return { wins: 4, losses: 2 };
        },
      }),
    });

    const response = await app.request("/api/players/player-1/score");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ wins: 4, losses: 2, score: 2 });
  });
});
