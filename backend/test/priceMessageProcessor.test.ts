import { describe, expect, test } from "bun:test";
import type { GuessResolutionRepository, ResolvedGuess } from "../src/guessRepository";
import { PriceMessageProcessor } from "../src/priceMessageProcessor";

describe("PriceMessageProcessor", () => {
  test("passes a price message to the repository and reports resolved guesses", async () => {
    const calls: Array<{ price: number; observedAt: Date }> = [];
    const resolvedGuesses: ResolvedGuess[] = [
      { id: "guess-up", result: "win", scoreDelta: 1 },
      { id: "guess-down", result: "loss", scoreDelta: -1 },
    ];
    const repository: GuessResolutionRepository = {
      async resolveEligible(price, observedAt) {
        calls.push({ price, observedAt });
        return resolvedGuesses;
      },
    };
    const processor = new PriceMessageProcessor(repository);
    const observedAt = new Date("2026-08-21T12:01:00.000Z");

    const result = await processor.process({ price: 62_000, observedAt });

    expect(calls).toEqual([{ price: 62_000, observedAt }]);
    expect(result).toEqual({
      resolvedCount: 2,
      resolvedGuessIds: ["guess-up", "guess-down"],
    });
  });

  test.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid price %p",
    async (price) => {
      const processor = new PriceMessageProcessor({
        async resolveEligible() {
          throw new Error("repository should not be called");
        },
      });

      await expect(processor.process({ price, observedAt: new Date() }))
        .rejects.toThrow("price must be a positive number");
    },
  );

  test("rejects an invalid observation timestamp", async () => {
    const processor = new PriceMessageProcessor({
      async resolveEligible() {
        throw new Error("repository should not be called");
      },
    });

    await expect(processor.process({ price: 62_000, observedAt: new Date("invalid") }))
      .rejects.toThrow("observedAt must be a valid Date");
  });
});
