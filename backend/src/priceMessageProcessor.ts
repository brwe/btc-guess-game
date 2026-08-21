import type { GuessResolutionRepository } from "./guessRepository";

export type PriceMessage = {
  price: number;
  observedAt: Date;
};

export type PriceProcessingResult = {
  resolvedCount: number;
  resolvedGuessIds: string[];
};

export class PriceMessageProcessor {
  constructor(private readonly guessRepository: GuessResolutionRepository) {}

  async process(message: PriceMessage): Promise<PriceProcessingResult> {
    if (!Number.isFinite(message.price) || message.price <= 0) {
      throw new Error("price must be a positive number");
    }

    if (!(message.observedAt instanceof Date) || Number.isNaN(message.observedAt.getTime())) {
      throw new Error("observedAt must be a valid Date");
    }

    const resolvedGuesses = await this.guessRepository.resolveEligible(
      message.price,
      message.observedAt,
    );

    return {
      resolvedCount: resolvedGuesses.length,
      resolvedGuessIds: resolvedGuesses.map((guess) => guess.id),
    };
  }
}
