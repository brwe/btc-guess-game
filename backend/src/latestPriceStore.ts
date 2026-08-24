export type LatestPrice = {
  price: number;
  observedAt: Date;
};

export interface LatestPriceLocalStore {
  get(): LatestPrice | null;
}

export interface LatestPriceWriter {
  set(latestPrice: LatestPrice): void;
}

export class InMemoryLatestPriceStore
  implements LatestPriceLocalStore, LatestPriceWriter
{
  private latestPrice: LatestPrice | null = null;

  get() {
    return this.latestPrice;
  }

  set(latestPrice: LatestPrice) {
    this.latestPrice = latestPrice;
  }
}
