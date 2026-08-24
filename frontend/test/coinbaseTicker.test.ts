import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { subscribeToCoinbaseTicker } from "../src/coinbaseTicker";

type EventListener = (event: Event) => void;

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

  readonly sent: string[] = [];
  closed = false;
  private readonly listeners = new Map<string, EventListener[]>();

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: EventListener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.closed = true;
  }

  emit(type: string, data?: string) {
    const event = data === undefined
      ? new Event(type)
      : new MessageEvent(type, { data });
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const originalWebSocket = globalThis.WebSocket;

beforeEach(() => {
  FakeWebSocket.instances = [];
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
});

afterEach(() => {
  globalThis.WebSocket = originalWebSocket;
  delete (document as Document & { visibilityState?: DocumentVisibilityState }).visibilityState;
});

describe("subscribeToCoinbaseTicker", () => {
  test("reconnects a stale connection when a background tab becomes visible", () => {
    let now = 1_000;
    let disconnects = 0;
    const unsubscribe = subscribeToCoinbaseTicker({
      onPrice() {},
      onDisconnect() { disconnects += 1; },
    }, {
      now: () => now,
      staleAfterMs: 30_000,
      staleCheckIntervalMs: 60_000,
    });
    const firstSocket = FakeWebSocket.instances[0]!;
    firstSocket.emit("message", tickerMessage("61000"));

    now += 30_001;
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));

    expect(firstSocket.closed).toBe(true);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(disconnects).toBe(1);
    unsubscribe();
  });

  test("reconnects after a websocket error", async () => {
    let disconnects = 0;
    const unsubscribe = subscribeToCoinbaseTicker({
      onPrice() {},
      onDisconnect() { disconnects += 1; },
    }, {
      reconnectDelayMs: 1,
      staleCheckIntervalMs: 60_000,
    });
    const firstSocket = FakeWebSocket.instances[0]!;

    firstSocket.emit("error");
    await Bun.sleep(5);

    expect(firstSocket.closed).toBe(true);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(disconnects).toBe(1);
    unsubscribe();
  });

  test("reconnects immediately when the browser comes back online", () => {
    const unsubscribe = subscribeToCoinbaseTicker({
      onPrice() {},
      onDisconnect() {},
    }, {
      staleCheckIntervalMs: 60_000,
    });
    const firstSocket = FakeWebSocket.instances[0]!;

    window.dispatchEvent(new Event("online"));

    expect(firstSocket.closed).toBe(true);
    expect(FakeWebSocket.instances).toHaveLength(2);
    unsubscribe();
  });
});

function tickerMessage(price: string) {
  return JSON.stringify({
    type: "ticker",
    product_id: "BTC-USD",
    price,
    time: "2026-08-24T12:00:00.000Z",
  });
}
