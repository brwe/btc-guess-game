import { describe, expect, test } from "bun:test";
import type { GuessRepository, ResolvedGuess } from "../src/guessRepository";
import { PriceMessageProcessor } from "../src/priceMessageProcessor";
import { InMemoryRealtimeEvents } from "../src/realtimeEvents";
import { InMemoryLatestPriceStore } from "../src/latestPriceStore";

describe("PriceMessageProcessor", () => {
  test("passes a price message to the repository and reports resolved guesses", async () => {
    const calls: Array<{ price: number; observedAt: Date }> = [];
    const resolvedGuesses: ResolvedGuess[] = [
      { id: "guess-up", playerId: "player-1" },
      { id: "guess-down", playerId: "player-2" },
    ];
    const repository: Pick<GuessRepository, "resolveEligible"> = {
      async resolveEligible(price, observedAt) {
        calls.push({ price, observedAt });
        return resolvedGuesses;
      },
    };
    const processor = new PriceMessageProcessor(repository, new InMemoryLatestPriceStore());
    const observedAt = new Date("2026-08-21T12:01:00.000Z");

    const result = await processor.process({ price: 62_000, observedAt });

    expect(calls).toEqual([{ price: 62_000, observedAt }]);
    expect(result).toEqual({
      resolvedCount: 2,
      resolvedGuessIds: ["guess-up", "guess-down"],
    });
  });

  test("publishes player-scoped resolution events after resolving", async () => {
    const realtimeEvents = new InMemoryRealtimeEvents();
    const playerOneEvents: string[] = [];
    const playerTwoEvents: string[] = [];
    realtimeEvents.subscribe("player-1", (event) => playerOneEvents.push(event.type));
    realtimeEvents.subscribe("player-2", (event) => playerTwoEvents.push(event.type));
    const processor = new PriceMessageProcessor({
      async resolveEligible() {
        return [{ id: "guess-up", playerId: "player-1" }];
      },
    }, new InMemoryLatestPriceStore(), realtimeEvents);

    await processor.process({
      price: 62_000,
      observedAt: new Date("2026-08-21T12:01:00.000Z"),
    });

    expect(playerOneEvents).toEqual(["guess-resolved"]);
    expect(playerTwoEvents).toEqual([]);
  });

  test("stores the latest valid price message", async () => {
    const latestPriceStore = new InMemoryLatestPriceStore();
    const processor = new PriceMessageProcessor({
      async resolveEligible() {
        return [];
      },
    }, latestPriceStore);
    const message = {
      price: 62_000,
      observedAt: new Date("2026-08-21T12:01:00.000Z"),
    };

    await processor.process(message);

    expect(latestPriceStore.get()).toEqual(message);
  });

  test.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid price %p",
    async (price) => {
      const processor = new PriceMessageProcessor({
        async resolveEligible() {
          throw new Error("repository should not be called");
        },
      }, new InMemoryLatestPriceStore());

      await expect(processor.process({ price, observedAt: new Date() }))
        .rejects.toThrow("price must be a positive number");
    },
  );

  test("rejects an invalid observation timestamp", async () => {
    const processor = new PriceMessageProcessor({
      async resolveEligible() {
        throw new Error("repository should not be called");
      },
    }, new InMemoryLatestPriceStore());

    await expect(processor.process({ price: 62_000, observedAt: new Date("invalid") }))
      .rejects.toThrow("observedAt must be a valid Date");
  });
});
