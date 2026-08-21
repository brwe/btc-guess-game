import { describe, expect, test } from "bun:test";
import { createApi } from "../src/api";
import type { GuessRepository, GuessRow, PendingGuess } from "../src/guessRepository";

const guessId = "6c3a2fc2-bcf5-4f5f-a755-21d91ff21973";
const createdAt = new Date("2026-08-19T10:00:00.000Z");

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
        result: null,
        score_delta: null,
      });
    },
    async findById(id) {
      return rows.find((row) => row.id === id) ?? null;
    },
  };
  const app = createApi({
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

  test("generates a UUID when no id factory is provided", async () => {
    const inserted: PendingGuess[] = [];
    const app = createApi({
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
      body: JSON.stringify({ direction: "up", entryPrice: 59_321.25 }),
    });
    const body = await response.json() as { guessId: string };

    expect(response.status).toBe(201);
    expect(body.guessId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(inserted[0]?.id).toBe(body.guessId);
  });

  test.each([
    [{ direction: "sideways", entryPrice: 59_321.25 }, "direction must be 'up' or 'down'"],
    [{ direction: "down", entryPrice: 0 }, "entryPrice must be a positive number"],
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

describe("GET /api/guesses/:id", () => {
  test("returns a persisted guess from the repository", async () => {
    const { app } = createTestContext();
    await app.request("/api/guesses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ direction: "down", entryPrice: 60_000 }),
    });

    const response = await app.request(`/api/guesses/${guessId}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      guessId,
      playerId: null,
      direction: "down",
      entryPrice: 60_000,
      status: "pending",
      createdAt: "2026-08-19T10:00:00.000Z",
      resolveAfter: "2026-08-19T10:01:00.000Z",
      resolvedAt: null,
      resolvedPrice: null,
      result: null,
      scoreDelta: null,
    });
  });

  test("returns 404 for an unknown guess", async () => {
    const { app } = createTestContext();
    const response = await app.request(`/api/guesses/${guessId}`);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "guess not found" });
  });
});
