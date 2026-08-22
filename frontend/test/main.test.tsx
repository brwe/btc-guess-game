import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { App } from "../src/main";

type EventListener = (event: Event) => void;

class FakeEventSource {
  static current: FakeEventSource | null = null;

  readonly readyState = EventSource.OPEN;
  onerror: ((event: Event) => void) | null = null;
  private readonly listeners = new Map<string, EventListener[]>();

  constructor(readonly url: string) {
    FakeEventSource.current = this;
  }

  addEventListener(type: string, listener: EventListener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  emit(type: string, data?: object) {
    const event = data === undefined
      ? new Event(type)
      : new MessageEvent(type, { data: JSON.stringify(data) });
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

afterEach(() => {
  cleanup();
  localStorage.clear();
  FakeEventSource.current = null;
});

describe("App player-data synchronization", () => {
  test("an older player-data response cannot clear a newly submitted pending guess", async () => {
    const staleScore = deferred<Response>();
    const staleGuess = deferred<Response>();
    const freshScore = deferred<Response>();
    const freshGuess = deferred<Response>();
    const scoreResponses = [staleScore.promise, freshScore.promise];
    const guessResponses = [staleGuess.promise, freshGuess.promise];

    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url === "/api/guesses" && init?.method === "POST") {
        return jsonResponse({
          guessId: "guess-b",
          status: "pending",
          entryPrice: 61_000,
          resolveAfter: "2026-08-22T18:01:00.000Z",
        }, 201);
      }
      if (url.endsWith("/score")) return await scoreResponses.shift()!;
      if (url.includes("/guesses?limit=1")) return await guessResponses.shift()!;
      throw new Error(`unexpected request: ${url}`);
    }) as typeof fetch;
    localStorage.setItem("btc-game-player-id", "player-1");

    const view = render(<App />);
    const events = FakeEventSource.current!;
    act(() => {
      events.emit("price-updated", {
        pair: "BTC/USD",
        price: 61_000,
        observedAt: "2026-08-22T18:00:00.000Z",
      });
      events.emit("guess-resolved");
    });

    await act(async () => {
      freshScore.resolve(jsonResponse({ wins: 1, losses: 0, score: 1 }));
      freshGuess.resolve(jsonResponse([{
        guessId: "guess-a",
        direction: "up",
        entryPrice: 60_000,
        status: "resolved",
        resolveAfter: "2026-08-22T17:59:00.000Z",
        resolvedPrice: 61_000,
        result: "won",
      }]));
    });

    const upButton = await view.findByRole("button", { name: "Up" });
    await waitFor(() => expect((upButton as HTMLButtonElement).disabled).toBe(false));
    await act(async () => fireEvent.click(upButton));
    await view.findByText("Current guess");

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
      }]));
    });

    await waitFor(() => {
      expect(view.queryByText("Current guess")).not.toBeNull();
      expect((upButton as HTMLButtonElement).disabled).toBe(true);
    });
  });
});
