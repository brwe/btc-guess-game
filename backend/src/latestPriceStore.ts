export type LatestPrice = {
  price: number;
  observedAt: Date;
};

export interface LatestPriceReader {
  get(): LatestPrice | null;
}

export interface LatestPriceWriter {
  set(latestPrice: LatestPrice): void;
}

export class InMemoryLatestPriceStore implements LatestPriceReader, LatestPriceWriter {
  private latestPrice: LatestPrice | null = null;

  get() {
    return this.latestPrice;
  }

  set(latestPrice: LatestPrice) {
    this.latestPrice = latestPrice;
  }
}
