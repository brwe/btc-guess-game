import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import "./styles.css";

type Direction = "up" | "down";

type PriceResponse = {
  pair: "BTC/USD";
  price: number;
  observedAt: string;
};

type GuessResponse = {
  guessId: string;
  direction: Direction;
  entryPrice: number;
  status: "pending" | "resolved";
  resolveAfter: string;
  resolvedPrice: number | null;
};

type ActiveGuess = {
  guessId: string;
  direction: Direction;
  resolveAfter: string;
};

type Score = {
  wins: number;
  losses: number;
};

const ACTIVE_GUESS_KEY = "btc-game-active-guess";
const PLAYER_ID_KEY = "btc-game-player-id";
const SCORE_KEY = "btc-game-score";

function readStoredValue<T>(key: string, fallback: T): T {
  const stored = localStorage.getItem(key);
  if (!stored) return fallback;

  try {
    return JSON.parse(stored) as T;
  } catch {
    return fallback;
  }
}

function getPlayerId() {
  const existing = localStorage.getItem(PLAYER_ID_KEY);
  if (existing) return existing;

  const playerId = crypto.randomUUID();
  localStorage.setItem(PLAYER_ID_KEY, playerId);
  return playerId;
}

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.json() as T | { error?: string };

  if (!response.ok) {
    throw new Error("error" in body && body.error ? body.error : `Request failed: ${response.status}`);
  }

  return body as T;
}

function App() {
  const [latestPrice, setLatestPrice] = useState<PriceResponse | null>(null);
  const [activeGuess, setActiveGuess] = useState<ActiveGuess | null>(() =>
    readStoredValue<ActiveGuess | null>(ACTIVE_GUESS_KEY, null)
  );
  const [score, setScore] = useState<Score>(() =>
    readStoredValue<Score>(SCORE_KEY, { wins: 0, losses: 0 })
  );
  const [secondsRemaining, setSecondsRemaining] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    async function loadPrice() {
      try {
        const price = await getJson<PriceResponse>("/api/price");
        if (active) {
          setLatestPrice(price);
          setError(null);
        }
      } catch (requestError) {
        if (active) {
          setError(requestError instanceof Error ? requestError.message : String(requestError));
        }
      }
    }

    void loadPrice();
    const interval = window.setInterval(loadPrice, 5_000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    if (!activeGuess) {
      setSecondsRemaining(0);
      return;
    }
    const resolveAfter = activeGuess.resolveAfter;

    function updateCountdown() {
      setSecondsRemaining(Math.max(
        0,
        Math.ceil((Date.parse(resolveAfter) - Date.now()) / 1_000),
      ));
    }

    updateCountdown();
    const interval = window.setInterval(updateCountdown, 1_000);
    return () => window.clearInterval(interval);
  }, [activeGuess]);

  useEffect(() => {
    if (!activeGuess) return;

    let active = true;
    let interval: number | undefined;
    const delay = Math.max(0, Date.parse(activeGuess.resolveAfter) - Date.now());

    async function checkGuess() {
      try {
        const guess = await getJson<GuessResponse>(`/api/guesses/${activeGuess.guessId}`);
        if (!active || guess.status === "pending" || guess.resolvedPrice === null) return;

        const won = guess.direction === "up"
          ? guess.resolvedPrice > guess.entryPrice
          : guess.resolvedPrice < guess.entryPrice;
        setScore((current) => {
          const next = won
            ? { ...current, wins: current.wins + 1 }
            : { ...current, losses: current.losses + 1 };
          localStorage.setItem(SCORE_KEY, JSON.stringify(next));
          return next;
        });
        localStorage.removeItem(ACTIVE_GUESS_KEY);
        setActiveGuess(null);
        setLatestPrice((current) => current
          ? { ...current, price: guess.resolvedPrice as number }
          : current);
        setError(null);
      } catch (requestError) {
        if (active) {
          setError(requestError instanceof Error ? requestError.message : String(requestError));
        }
      }
    }

    const timeout = window.setTimeout(() => {
      void checkGuess();
      interval = window.setInterval(checkGuess, 2_000);
    }, delay);

    return () => {
      active = false;
      window.clearTimeout(timeout);
      if (interval !== undefined) window.clearInterval(interval);
    };
  }, [activeGuess]);

  async function registerGuess(direction: Direction) {
    if (!latestPrice || activeGuess || submitting) return;

    setSubmitting(true);
    setError(null);
    try {
      const result = await getJson<{
        guessId: string;
        status: "pending";
        resolveAfter: string;
      }>("/api/guesses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          direction,
          entryPrice: latestPrice.price,
          playerId: getPlayerId(),
        }),
      });
      const guess = { guessId: result.guessId, direction, resolveAfter: result.resolveAfter };
      localStorage.setItem(ACTIVE_GUESS_KEY, JSON.stringify(guess));
      setActiveGuess(guess);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setSubmitting(false);
    }
  }

  const waiting = submitting || activeGuess !== null;
  const totalScore = score.wins - score.losses;

  return (
    <main className="game">
      <p className="label">BTC / USD</p>
      <h1>{latestPrice ? `$${latestPrice.price.toLocaleString("en-US")}` : "Waiting for price"}</h1>

      <div className="score" aria-label="Score">
        <strong>{totalScore}</strong>
        <span>{score.wins} wins</span>
        <span>{score.losses} losses</span>
      </div>

      <div className="actions">
        <button className="up" disabled={waiting || !latestPrice} onClick={() => registerGuess("up")}>
          Up
        </button>
        <button className="down" disabled={waiting || !latestPrice} onClick={() => registerGuess("down")}>
          Down
        </button>
      </div>

      <p className="status">
        {activeGuess && secondsRemaining > 0
          ? `${secondsRemaining} second${secondsRemaining === 1 ? "" : "s"} remaining`
          : activeGuess
            ? "Waiting for the next price change..."
            : "Will Bitcoin move up or down?"}
      </p>
      {error ? <p className="error">{error}</p> : null}
    </main>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
