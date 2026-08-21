import { describe, expect, test } from "bun:test";
import { CoinbaseTickerClient } from "../src/coinbaseTickerClient";
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

function createContext() {
  const messages: PriceMessage[] = [];
  const socket = new FakeWebSocket();
  const client = new CoinbaseTickerClient({
    async process(message) {
      messages.push(message);
      return { resolvedCount: 0, resolvedGuessIds: [] };
    },
  }, {
    createWebSocket: () => socket as unknown as WebSocket,
    logger: { info() {}, warn() {}, error() {} },
  });

  return { client, messages, socket };
}

describe("CoinbaseTickerClient", () => {
  test("subscribes to BTC-USD ticker_batch when the socket opens", () => {
    const { client, socket } = createContext();

    client.start();
    socket.emit("open");

    expect(socket.sent).toEqual([JSON.stringify({
      type: "subscribe",
      product_ids: ["BTC-USD"],
      channels: ["ticker_batch"],
    })]);
    client.stop();
  });

  test("passes valid ticker prices and exchange timestamps to the processor", async () => {
    const { client, messages, socket } = createContext();
    client.start();

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
    sockets[0]?.emit("close");
    await Bun.sleep(5);

    expect(sockets).toHaveLength(2);
    client.stop();
  });
});
