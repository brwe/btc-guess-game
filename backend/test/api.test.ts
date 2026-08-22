import { describe, expect, test } from "bun:test";
import { createApi } from "../src/api";
import type { GuessRepository, GuessRow, PendingGuess } from "../src/guessRepository";
import { InMemoryLatestPriceStore } from "../src/latestPriceStore";
import { PriceMessageProcessor } from "../src/priceMessageProcessor";

const guessId = "6c3a2fc2-bcf5-4f5f-a755-21d91ff21973";
const createdAt = new Date("2026-08-19T10:00:00.000Z");

function createRequiredApiDependencies(
  latestPriceStore = new InMemoryLatestPriceStore(),
) {
  return {
    latestPriceStore,
    priceMessageProcessor: new PriceMessageProcessor({
      async resolveEligible() {
        return [];
      },
    }, latestPriceStore),
    guessDurationSeconds: 60,
  };
}

function createTestContext(existingRows: GuessRow[] = []) {
  const inserted: PendingGuess[] = [];
  const rows = [...existingRows];
  const repository: GuessRepository = {
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
    async findById(id) {
      return rows.find((row) => row.id === id) ?? null;
    },
  };
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
      body: JSON.stringify({ direction: "up", entryPrice: 59_321.25, playerId: "player-1" }),
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      guessId,
      status: "pending",
      resolveAfter: "2026-08-19T10:01:00.000Z",
    });
    expect(inserted).toEqual([{
      id: guessId,
      playerId: "player-1",
      direction: "up",
      entryPrice: 59_321.25,
      createdAt,
      resolveAfter: new Date("2026-08-19T10:01:00.000Z"),
    }]);
  });

  test("allows only one concurrent pending guess per player", async () => {
    const inserted: PendingGuess[] = [];
    const guessIds = [
      "6c3a2fc2-bcf5-4f5f-a755-21d91ff21973",
      "208d7707-9385-4f6e-8d41-c01272468d58",
    ];
    let nextGuessId = 0;
    const app = createApi({
      ...createRequiredApiDependencies(),
      guessRepository: {
        async insert(guess) {
          inserted.push(guess);
        },
        async findById() {
          return null;
        },
      },
      createId: () => guessIds[nextGuessId++]!,
      now: () => createdAt,
    });
    const registerGuess = (direction: "up" | "down") => app.request("/api/guesses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        direction,
        entryPrice: 59_321.25,
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
    const inserted: PendingGuess[] = [];
    const app = createApi({
      ...createRequiredApiDependencies(),
      guessRepository: {
        async insert(guess) {
          inserted.push(guess);
        },
        async findById() {
          return null;
        },
      },
      now: () => createdAt,
    });

    const response = await app.request("/api/guesses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ direction: "up", entryPrice: 59_321.25, playerId: "player-1" }),
    });
    const body = await response.json() as { guessId: string };

    expect(response.status).toBe(201);
    expect(body.guessId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(inserted[0]?.id).toBe(body.guessId);
  });

  test("uses the configured guess duration", async () => {
    const inserted: PendingGuess[] = [];
    const app = createApi({
      ...createRequiredApiDependencies(),
      guessRepository: {
        async insert(guess) {
          inserted.push(guess);
        },
        async findById() {
          return null;
        },
      },
      createId: () => guessId,
      now: () => createdAt,
      guessDurationSeconds: 5,
    });

    const response = await app.request("/api/guesses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ direction: "up", entryPrice: 59_321.25, playerId: "player-1" }),
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      guessId,
      status: "pending",
      resolveAfter: "2026-08-19T10:00:05.000Z",
    });
    expect(inserted[0]?.resolveAfter).toEqual(new Date("2026-08-19T10:00:05.000Z"));
  });

  test.each([
    [{ direction: "sideways", entryPrice: 59_321.25, playerId: "player-1" }, "direction must be 'up' or 'down'"],
    [{ direction: "down", entryPrice: 0, playerId: "player-1" }, "entryPrice must be a positive number"],
    [{ direction: "down", entryPrice: 59_321.25 }, "playerId must be a non-empty string"],
    [{ direction: "down", entryPrice: 59_321.25, playerId: "   " }, "playerId must be a non-empty string"],
    [{ direction: "down", entryPrice: 59_321.25, playerId: 123 }, "playerId must be a non-empty string"],
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
});

describe("GET /api/price", () => {
  test("returns the latest stored BTC/USD price", async () => {
    const latestPriceStore = new InMemoryLatestPriceStore();
    latestPriceStore.set({
      price: 62_345.67,
      observedAt: new Date("2026-08-21T12:00:00.000Z"),
    });
    const app = createApi({
      ...createRequiredApiDependencies(latestPriceStore),
      guessRepository: {
        async insert() {},
        async findById() { return null; },
      },
    });

    const response = await app.request("/api/price");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      pair: "BTC/USD",
      price: 62_345.67,
      observedAt: "2026-08-21T12:00:00.000Z",
    });
  });

  test("returns 503 before a price has been received", async () => {
    const { app } = createTestContext();

    const response = await app.request("/api/price");

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "price not available" });
  });
});

describe("POST /api/price-messages", () => {
  test("processes a simulated message and makes it available as the latest price", async () => {
    const latestPriceStore = new InMemoryLatestPriceStore();
    const priceMessageProcessor = new PriceMessageProcessor({
      async resolveEligible() {
        return [{ id: guessId }];
      },
    }, latestPriceStore);
    const app = createApi({
      guessRepository: {
        async insert() {},
        async findById() { return null; },
      },
      latestPriceStore,
      priceMessageProcessor,
      guessDurationSeconds: 60,
    });

    const response = await app.request("/api/price-messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        price: 63_000,
        observedAt: "2026-08-21T12:02:00.000Z",
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      resolvedCount: 1,
      resolvedGuessIds: [guessId],
    });
    expect(latestPriceStore.get()).toEqual({
      price: 63_000,
      observedAt: new Date("2026-08-21T12:02:00.000Z"),
    });
  });
});

describe("GET /api/guesses/:id", () => {
  test("returns a persisted guess from the repository", async () => {
    const { app } = createTestContext();
    await app.request("/api/guesses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ direction: "down", entryPrice: 60_000, playerId: "player-1" }),
    });

    const response = await app.request(`/api/guesses/${guessId}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      guessId,
      playerId: "player-1",
      direction: "down",
      entryPrice: 60_000,
      status: "pending",
      createdAt: "2026-08-19T10:00:00.000Z",
      resolveAfter: "2026-08-19T10:01:00.000Z",
      resolvedAt: null,
      resolvedPrice: null,
    });
  });

  test("returns 404 for an unknown guess", async () => {
    const { app } = createTestContext();
    const response = await app.request(`/api/guesses/${guessId}`);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "guess not found" });
  });
});
