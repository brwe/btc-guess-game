import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { App } from "../src/main";

type EventListener = (event: Event) => void;

class FakeWebSocket {
  static current: FakeWebSocket | null = null;
  static readonly OPEN = 1;

  readonly sent: string[] = [];
  private readonly listeners = new Map<string, EventListener[]>();

  constructor(readonly url: string) {
    FakeWebSocket.current = this;
  }

  addEventListener(type: string, listener: EventListener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send(data: string) {
    this.sent.push(data);
  }

  emit(type: string, data?: string) {
    const event = data === undefined
      ? new Event(type)
      : new MessageEvent(type, { data });
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  close() {}
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const originalFetch = globalThis.fetch;
const originalWebSocket = globalThis.WebSocket;
const originalSetInterval = window.setInterval;

beforeEach(() => {
  localStorage.clear();
  FakeWebSocket.current = null;
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  FakeWebSocket.current = null;
  globalThis.fetch = originalFetch;
  globalThis.WebSocket = originalWebSocket;
  window.setInterval = originalSetInterval;
});

describe("App player-data synchronization", () => {
  test("an older player-data response cannot clear a newly submitted pending guess", async () => {
    const staleScore = deferred<Response>();
    const staleGuess = deferred<Response>();

    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url === "/api/guesses" && init?.method === "POST") {
        return jsonResponse({
          guessId: "guess-b",
          status: "pending",
          entryPrice: 61_000,
          resolveAfter: "2026-08-22T18:01:00.000Z",
          remainingSeconds: 60,
        }, 201);
      }
      if (url.endsWith("/score")) return await staleScore.promise;
      if (url.includes("/guesses?limit=1")) return await staleGuess.promise;
      throw new Error(`unexpected request: ${url}`);
    }) as typeof fetch;
    localStorage.setItem("btc-game-player-id", "player-1");

    const view = render(<App />);
    const ticker = FakeWebSocket.current!;
    act(() => {
      ticker.emit("open");
      ticker.emit("message", JSON.stringify({
        type: "ticker",
        product_id: "BTC-USD",
        price: "61000",
        time: "2026-08-22T18:00:00.000Z",
      }));
    });
    expect(JSON.parse(ticker.sent[0]!)).toEqual({
      type: "subscribe",
      product_ids: ["BTC-USD"],
      channels: ["ticker"],
    });

    const upButton = await view.findByRole("button", { name: "↑ Higher" });
    await waitFor(() => expect((upButton as HTMLButtonElement).disabled).toBe(false));
    await act(async () => fireEvent.click(upButton));
    await view.findByText("Your guess");
    expect(view.queryByText("60s remaining")).not.toBeNull();

    act(() => {
      ticker.emit("message", JSON.stringify({
        type: "ticker",
        product_id: "BTC-USD",
        price: "61012.34",
        time: "2026-08-22T18:00:01.000Z",
      }));
    });
    expect(await view.findByText("↑ $12.34")).not.toBeNull();
    expect(view.queryByText("You can guess again after this round settles.")).not.toBeNull();

    await act(async () => {
      staleScore.resolve(jsonResponse({ wins: 1, losses: 0, score: 1 }));
      staleGuess.resolve(jsonResponse([{
        guessId: "guess-a",
        direction: "up",
        entryPrice: 60_000,
        status: "resolved",
        resolveAfter: "2026-08-22T17:59:00.000Z",
        resolvedPrice: 61_000,
        result: "won",
        remainingSeconds: 0,
      }]));
    });

    await waitFor(() => {
      expect(view.queryByText("Your guess")).not.toBeNull();
      expect((upButton as HTMLButtonElement).disabled).toBe(true);
    });
  });

  test("checks authoritative state after the countdown reaches zero", async () => {
    let scoreRequests = 0;
    let guessRequests = 0;
    let countdownTick: (() => void) | null = null;
    window.setInterval = ((handler: TimerHandler) => {
      countdownTick = handler as () => void;
      return 1;
    }) as typeof window.setInterval;
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url === "/api/guesses" && init?.method === "POST") {
        return jsonResponse({
          guessId: "guess-1",
          status: "pending",
          entryPrice: 61_000,
          resolveAfter: "2026-08-22T18:01:00.000Z",
          remainingSeconds: 1,
        }, 201);
      }
      if (url.endsWith("/score")) {
        scoreRequests++;
        return jsonResponse(scoreRequests === 1
          ? { wins: 0, losses: 0, score: 0 }
          : { wins: 1, losses: 0, score: 1 });
      }
      if (url.includes("/guesses?limit=1")) {
        guessRequests++;
        return jsonResponse(guessRequests === 1 ? [] : [{
          guessId: "guess-1",
          direction: "up",
          entryPrice: 61_000,
          status: "resolved",
          resolveAfter: "2026-08-22T18:01:00.000Z",
          resolvedPrice: 61_010,
          result: "won",
          remainingSeconds: 0,
        }]);
      }
      throw new Error(`unexpected request: ${url}`);
    }) as typeof fetch;
    localStorage.setItem("btc-game-player-id", "player-1");

    const view = render(<App />);
    const ticker = FakeWebSocket.current!;
    act(() => {
      ticker.emit("message", JSON.stringify({
        type: "ticker",
        product_id: "BTC-USD",
        price: "61000",
        time: "2026-08-22T18:00:00.000Z",
      }));
    });

    const higherButton = await view.findByRole("button", { name: "↑ Higher" });
    await waitFor(() => expect((higherButton as HTMLButtonElement).disabled).toBe(false));
    await act(async () => fireEvent.click(higherButton));

    expect(view.queryByText("1s remaining")).not.toBeNull();
    expect(scoreRequests).toBe(1);
    expect(guessRequests).toBe(1);

    await act(async () => countdownTick?.());

    expect(await view.findByText("Won")).not.toBeNull();
    expect(scoreRequests).toBe(2);
    expect(guessRequests).toBe(2);
  });
});
