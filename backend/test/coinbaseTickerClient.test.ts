import { describe, expect, test } from "bun:test";
import { CoinbaseTickerClient } from "../src/coinbaseTickerClient";
import type { CoinbaseTickerChannel } from "../src/coinbaseTickerClient";
import type { PriceMessage } from "../src/priceMessageProcessor";

class FakeWebSocket {
  readonly sent: string[] = [];
  closed = false;
  private readonly listeners = new Map<string, Array<(event: { data?: unknown }) => void>>();

  addEventListener(type: string, listener: (event: { data?: unknown }) => void) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send(message: string) {
    this.sent.push(message);
  }

  close() {
    this.closed = true;
  }

  emit(type: string, data?: unknown) {
    for (const listener of this.listeners.get(type) ?? []) listener({ data });
  }
}

function createContext(channel?: CoinbaseTickerChannel) {
  const messages: PriceMessage[] = [];
  const socket = new FakeWebSocket();
  const client = new CoinbaseTickerClient({
    async process(message) {
      messages.push(message);
      return { resolvedCount: 0, resolvedGuessIds: [] };
    },
  }, {
    createWebSocket: () => socket as unknown as WebSocket,
    channel,
    logger: { info() {}, warn() {}, error() {} },
  });

  return { client, messages, socket };
}

function confirmSubscription(socket: FakeWebSocket) {
  socket.emit("open");
  socket.emit("message", JSON.stringify({
    type: "subscriptions",
    channels: [{ name: "ticker_1000", product_ids: ["BTC-USD"] }],
  }));
}

describe("CoinbaseTickerClient", () => {
  test("starts only one connection when start is called repeatedly", () => {
    const { client, socket } = createContext();

    client.start();
    client.start();

    confirmSubscription(socket);
    expect(socket.sent).toHaveLength(1);
    client.stop();
  });

  test("subscribes to ticker_batch and accepts Coinbase's ticker_1000 acknowledgement", () => {
    const { client, socket } = createContext();

    client.start();
    socket.emit("open");

    expect(socket.sent).toEqual([JSON.stringify({
      type: "subscribe",
      product_ids: ["BTC-USD"],
      channels: ["ticker_batch"],
    })]);
    socket.emit("message", JSON.stringify({
      type: "subscriptions",
      channels: [{ name: "ticker_1000", product_ids: ["BTC-USD"] }],
    }));
    client.stop();
  });

  test("can subscribe to the real-time ticker channel", () => {
    const { client, socket } = createContext("ticker");

    client.start();
    socket.emit("open");

    expect(socket.sent).toEqual([JSON.stringify({
      type: "subscribe",
      product_ids: ["BTC-USD"],
      channels: ["ticker"],
    })]);
    socket.emit("message", JSON.stringify({
      type: "subscriptions",
      channels: [{ name: "ticker", product_ids: ["BTC-USD"] }],
    }));
    client.stop();
  });

  test("passes valid ticker prices and exchange timestamps to the processor", async () => {
    const { client, messages, socket } = createContext();
    client.start();
    confirmSubscription(socket);

    socket.emit("message", JSON.stringify({
      type: "ticker",
      product_id: "BTC-USD",
      price: "62345.67",
      time: "2026-08-21T12:00:00.123Z",
    }));
    await Bun.sleep(0);

    expect(messages).toEqual([{
      price: 62_345.67,
      observedAt: new Date("2026-08-21T12:00:00.123Z"),
    }]);
    client.stop();
  });

  test("ignores unsupported, malformed, and out-of-order messages", async () => {
    const { client, messages, socket } = createContext();
    client.start();
    confirmSubscription(socket);

    socket.emit("message", JSON.stringify({ type: "subscriptions", channels: [] }));
    socket.emit("message", "not JSON");
    socket.emit("message", JSON.stringify({
      type: "ticker",
      product_id: "ETH-USD",
      price: "2000",
      time: "2026-08-21T12:00:00.000Z",
    }));
    socket.emit("message", JSON.stringify({
      type: "ticker",
      product_id: "BTC-USD",
      price: "62000",
      time: "2026-08-21T12:00:05.000Z",
    }));
    socket.emit("message", JSON.stringify({
      type: "ticker",
      product_id: "BTC-USD",
      price: "61000",
      time: "2026-08-21T12:00:00.000Z",
    }));
    await Bun.sleep(0);

    expect(messages).toEqual([{
      price: 62_000,
      observedAt: new Date("2026-08-21T12:00:05.000Z"),
    }]);
    client.stop();
  });

  test("closes the socket when stopped", () => {
    const { client, socket } = createContext();
    client.start();
    confirmSubscription(socket);

    client.stop();

    expect(socket.closed).toBe(true);
  });

  test("reconnects after the socket closes", async () => {
    const sockets: FakeWebSocket[] = [];
    const client = new CoinbaseTickerClient({
      async process() {
        return { resolvedCount: 0, resolvedGuessIds: [] };
      },
    }, {
      reconnectDelayMs: 1,
      createWebSocket: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
      logger: { info() {}, warn() {}, error() {} },
    });

    client.start();
    confirmSubscription(sockets[0]!);
    sockets[0]?.emit("close");
    await Bun.sleep(5);

    expect(sockets).toHaveLength(2);
    client.stop();
  });

  test("reconnects when creating the socket throws", async () => {
    const sockets: FakeWebSocket[] = [];
    let attempts = 0;
    const client = new CoinbaseTickerClient({
      async process() {
        return { resolvedCount: 0, resolvedGuessIds: [] };
      },
    }, {
      reconnectDelayMs: 1,
      createWebSocket: () => {
        attempts += 1;
        if (attempts === 1) throw new Error("DNS lookup failed");
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
      logger: { info() {}, warn() {}, error() {} },
    });

    client.start();
    await Bun.sleep(5);

    expect(attempts).toBe(2);
    expect(sockets).toHaveLength(1);
    client.stop();
  });

  test("is ready only after a valid price is processed on the current connection", async () => {
    const { client, socket } = createContext();
    client.start();
    confirmSubscription(socket);

    expect(client.isReady()).toBe(false);

    socket.emit("message", JSON.stringify({
      type: "ticker",
      product_id: "BTC-USD",
      price: "62345.67",
      time: "2026-08-21T12:00:00.123Z",
    }));
    await Bun.sleep(0);

    expect(client.isReady()).toBe(true);
    client.stop();
  });

  test("is not ready after the current connection disconnects", async () => {
    const { client, socket } = createContext();
    client.start();
    confirmSubscription(socket);
    socket.emit("message", JSON.stringify({
      type: "ticker",
      product_id: "BTC-USD",
      price: "62345.67",
      time: "2026-08-21T12:00:00.123Z",
    }));
    await Bun.sleep(0);
    expect(client.isReady()).toBe(true);

    socket.emit("close");

    expect(client.isReady()).toBe(false);
    client.stop();
  });

  test("is not ready when the last processed price becomes stale", async () => {
    let now = 1_000;
    const socket = new FakeWebSocket();
    const client = new CoinbaseTickerClient({
      async process() {
        return { resolvedCount: 0, resolvedGuessIds: [] };
      },
    }, {
      priceStaleAfterMs: 30_000,
      now: () => now,
      createWebSocket: () => socket as unknown as WebSocket,
      logger: { info() {}, warn() {}, error() {} },
    });
    client.start();
    confirmSubscription(socket);
    socket.emit("message", JSON.stringify({
      type: "ticker",
      product_id: "BTC-USD",
      price: "62345.67",
      time: "2026-08-21T12:00:00.123Z",
    }));
    await Bun.sleep(0);

    now += 30_001;

    expect(client.isReady()).toBe(false);
    client.stop();
  });
});
