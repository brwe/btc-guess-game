import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { App } from "../src/main";
import { subscribeToCoinbaseTicker } from "../src/coinbaseTicker";
import type { CoinbasePrice } from "../src/coinbaseTicker";

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
const originalSetInterval = window.setInterval;

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  globalThis.fetch = originalFetch;
  window.setInterval = originalSetInterval;
});

function createFakeTicker() {
  let priceHandler: ((price: CoinbasePrice) => void) | null = null;
  const subscribe: typeof subscribeToCoinbaseTicker = ({ onPrice }) => {
    priceHandler = onPrice;
    return () => {
      priceHandler = null;
    };
  };

  return {
    subscribe,
    emitPrice(price: number, observedAt: string) {
      if (!priceHandler) throw new Error("ticker is not subscribed");
      priceHandler({ pair: "BTC/USD", price, observedAt });
    },
  };
}

describe("App player-data synchronization", () => {
  test("an older player-data response cannot clear a newly submitted pending guess", async () => {
    // Keep the initial latest-guess request pending so the initial player-data
    // load can finish after the player submits a newer guess.
    const staleScore = deferred<Response>();
    const staleGuess = deferred<Response>();
    const ticker = createFakeTicker();
    const requests: Array<{ url: string; method: string; body: unknown }> = [];

    // Return a new pending guess immediately on POST, while holding the initial
    // latest-guess request until the test explicitly resolves it below.
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      requests.push({
        url,
        method,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (url === "/api/guesses" && init?.method === "POST") {
        return jsonResponse(
          {
            guessId: "guess-b",
            status: "pending",
            entryPrice: 61_000,
            resolveAfter: "2026-08-22T18:01:00.000Z",
            remainingSeconds: 60,
          },
          201,
        );
      }
      if (url.endsWith("/score")) return await staleScore.promise;
      if (url.includes("/guesses?limit=1")) return await staleGuess.promise;
      throw new Error(`unexpected request: ${url}`);
    }) as typeof fetch;

    // Use a stable identity so every request belongs to the same player.
    localStorage.setItem("btc-game-player-id", "player-1");

    // Rendering starts the held latest-guess request. The score request must not
    // start until that request finishes. Supplying a price enables the buttons.
    const view = render(<App subscribeToTicker={ticker.subscribe} />);
    await waitFor(() => {
      expect(requests).toContainEqual({
        url: "/api/players/player-1/guesses?limit=1",
        method: "GET",
        body: undefined,
      });
      expect(requests.some(({ url }) => url.endsWith("/score"))).toBe(false);
    });
    act(() => {
      ticker.emitPrice(61_000, "2026-08-22T18:00:00.000Z");
    });

    // Submit guess B while the older score and guess-A requests are still pending.
    const upButton = await view.findByRole("button", { name: "↑ Higher" });
    await waitFor(() =>
      expect((upButton as HTMLButtonElement).disabled).toBe(false),
    );
    await act(async () => fireEvent.click(upButton));
    expect(requests).toContainEqual({
      url: "/api/guesses",
      method: "POST",
      body: {
        direction: "up",
        playerId: "player-1",
      },
    });
    await view.findByText("Your guess");
    expect(view.queryByText("60s remaining")).not.toBeNull();

    // Confirm that the UI is tracking guess B's entry price and remains locked
    // while that guess is pending.
    act(() => {
      ticker.emitPrice(61_012.34, "2026-08-22T18:00:01.000Z");
    });
    expect(await view.findByText("↑ $12.34")).not.toBeNull();
    expect(
      view.queryByText("You can guess again after this round settles."),
    ).not.toBeNull();

    // Finish the older guess request with guess A already resolved. Only after
    // that response does the initial load request the corresponding score.
    await act(async () => {
      staleGuess.resolve(
        jsonResponse([
          {
            guessId: "guess-a",
            direction: "up",
            entryPrice: 60_000,
            status: "resolved",
            resolveAfter: "2026-08-22T17:59:00.000Z",
            resolvedPrice: 61_000,
            result: "won",
            remainingSeconds: 0,
          },
        ]),
      );
    });
    await waitFor(() => {
      expect(requests).toContainEqual({
        url: "/api/players/player-1/score",
        method: "GET",
        body: undefined,
      });
    });

    // Complete the old load. Both responses must be ignored because guess B was
    // submitted after that load began.
    await act(async () => {
      staleScore.resolve(jsonResponse({ wins: 1, losses: 0, score: 1 }));
    });

    // Guess B must still be active: its card remains visible and new guesses stay
    // disabled. Without the generation guard, guess A would clear this state.
    await waitFor(() => {
      expect(view.queryByText("Your guess")).not.toBeNull();
      expect((upButton as HTMLButtonElement).disabled).toBe(true);
    });
  });

  test("reloads the score and latest guess when the countdown reaches zero", async () => {
    // Count player-data requests so the fake backend can return initial state on
    // the first load and resolved state on the first post-countdown reload.
    let scoreRequests = 0;
    let guessRequests = 0;
    const playerDataRequests: Array<"guess" | "score"> = [];
    let countdownTick: (() => void) | null = null;
    const ticker = createFakeTicker();

    // Capture the countdown callback so the test can advance one second without
    // waiting for a real timer.
    window.setInterval = ((handler: TimerHandler) => {
      countdownTick = handler as () => void;
      return 1;
    }) as typeof window.setInterval;

    // The initial GETs return a new player's state. After submission, the next
    // GETs report that the pending guess won and increased the score.
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url === "/api/guesses" && init?.method === "POST") {
        return jsonResponse(
          {
            guessId: "guess-1",
            status: "pending",
            entryPrice: 61_000,
            resolveAfter: "2026-08-22T18:01:00.000Z",
            remainingSeconds: 1,
          },
          201,
        );
      }
      if (url.endsWith("/score")) {
        playerDataRequests.push("score");
        scoreRequests++;
        return jsonResponse(
          scoreRequests === 1
            ? { wins: 0, losses: 0, score: 0 }
            : { wins: 1, losses: 0, score: 1 },
        );
      }
      if (url.includes("/guesses?limit=1")) {
        playerDataRequests.push("guess");
        guessRequests++;
        return jsonResponse(
          guessRequests === 1
            ? []
            : [
                {
                  guessId: "guess-1",
                  direction: "up",
                  entryPrice: 61_000,
                  status: "resolved",
                  resolveAfter: "2026-08-22T18:01:00.000Z",
                  resolvedPrice: 61_010,
                  result: "won",
                  remainingSeconds: 0,
                },
              ],
        );
      }
      throw new Error(`unexpected request: ${url}`);
    }) as typeof fetch;

    // Use a stable identity for the initial load, submission, and settlement poll.
    localStorage.setItem("btc-game-player-id", "player-1");

    // Supply a market price so the Higher button becomes available.
    const view = render(<App subscribeToTicker={ticker.subscribe} />);
    act(() => {
      ticker.emitPrice(61_000, "2026-08-22T18:00:00.000Z");
    });

    // Submit a guess whose server-provided countdown starts at one second.
    const higherButton = await view.findByRole("button", { name: "↑ Higher" });
    await waitFor(() =>
      expect((higherButton as HTMLButtonElement).disabled).toBe(false),
    );
    expect(view.queryByText("Will Bitcoin go up or down?")).not.toBeNull();
    await act(async () => fireEvent.click(higherButton));

    // Before the countdown expires, the UI remains pending and no settlement
    // reload has occurred beyond the initial pair of GET requests.
    expect(
      view.queryByText("Waiting for the market to decide…"),
    ).not.toBeNull();
    expect(view.queryByText("1s remaining")).not.toBeNull();
    expect(scoreRequests).toBe(1);
    expect(guessRequests).toBe(1);
    expect(playerDataRequests).toEqual(["guess", "score"]);

    // Advance the captured countdown from one to zero, which starts the
    // authoritative player-data reload.
    await act(async () => countdownTick?.());

    // The second pair of GETs must be reflected as a resolved winning round.
    expect(await view.findByText("Won")).not.toBeNull();
    expect(scoreRequests).toBe(2);
    expect(guessRequests).toBe(2);
    expect(playerDataRequests).toEqual(["guess", "score", "guess", "score"]);
  });
});
