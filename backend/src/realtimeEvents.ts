export type RealtimeEvent =
  {
    type: "guess-resolved";
    data: { guessId: string; playerId: string };
  };

type RealtimeEventListener = (event: RealtimeEvent) => void;

export interface RealtimeEventPublisher {
  publish(event: RealtimeEvent): void;
}

export interface RealtimeEventSubscriber {
  subscribe(playerId: string, listener: RealtimeEventListener): () => void;
}

export class InMemoryRealtimeEvents implements RealtimeEventPublisher, RealtimeEventSubscriber {
  private nextSubscriptionId = 0;
  private readonly subscriptions = new Map<
    number,
    { playerId: string; listener: RealtimeEventListener }
  >();

  publish(event: RealtimeEvent) {
    for (const subscription of this.subscriptions.values()) {
      if (event.data.playerId !== subscription.playerId) continue;

      subscription.listener(event);
    }
  }

  subscribe(playerId: string, listener: RealtimeEventListener) {
    const subscriptionId = this.nextSubscriptionId++;
    this.subscriptions.set(subscriptionId, { playerId, listener });
    return () => this.subscriptions.delete(subscriptionId);
  }
}

export const noRealtimeEvents: RealtimeEventPublisher = {
  publish() {},
};
