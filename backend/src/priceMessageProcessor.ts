import type { GuessRepository } from "./guessRepository";
import type { LatestPriceWriter } from "./latestPriceStore";
import { noRealtimeEvents } from "./realtimeEvents";
import type { RealtimeEventPublisher } from "./realtimeEvents";

export type PriceMessage = {
  price: number;
  observedAt: Date;
};

export type PriceProcessingResult = {
  resolvedCount: number;
  resolvedGuessIds: string[];
};

export class PriceMessageProcessor {
  constructor(
    private readonly guessRepository: Pick<GuessRepository, "resolveEligible">,
    private readonly latestPriceStore: LatestPriceWriter,
    private readonly realtimeEvents: RealtimeEventPublisher = noRealtimeEvents,
  ) { }

  async process(message: PriceMessage): Promise<PriceProcessingResult> {
    if (!Number.isFinite(message.price) || message.price <= 0) {
      throw new Error("price must be a positive number");
    }

    if (!(message.observedAt instanceof Date) || Number.isNaN(message.observedAt.getTime())) {
      throw new Error("observedAt must be a valid Date");
    }

    this.latestPriceStore.set(message);

    const resolvedGuesses = await this.guessRepository.resolveEligible(
      message.price,
      message.observedAt,
    );

    this.realtimeEvents.publish({
      type: "price-updated",
      data: {
        pair: "BTC/USD",
        price: message.price,
        observedAt: message.observedAt.toISOString(),
      },
    });
    for (const guess of resolvedGuesses) {
      this.realtimeEvents.publish({
        type: "guess-resolved",
        data: { guessId: guess.id, playerId: guess.playerId },
      });
    }

    return {
      resolvedCount: resolvedGuesses.length,
      resolvedGuessIds: resolvedGuesses.map((guess) => guess.id),
    };
  }
}
