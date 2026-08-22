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
  result: "won" | "lost" | null;
};

type ActiveGuess = {
  guessId: string;
  direction: Direction;
  resolveAfter: string;
  entryPrice: number;
};

type ResolvedGuess = {
  guessId: string;
  direction: Direction;
  entryPrice: number;
  resolvedPrice: number;
  result: "won" | "lost";
};

type Score = {
  wins: number;
  losses: number;
  score: number;
};

const PLAYER_ID_KEY = "btc-game-player-id";

const usdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

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

async function getPlayerScore() {
  const playerId = encodeURIComponent(getPlayerId());
  return getJson<Score>(`/api/players/${playerId}/score`);
}

async function getLatestGuess() {
  const playerId = encodeURIComponent(getPlayerId());
  const guesses = await getJson<GuessResponse[]>(`/api/players/${playerId}/guesses?limit=1`);
  return guesses[0] ?? null;
}

function App() {
  const [latestPrice, setLatestPrice] = useState<PriceResponse | null>(null);
  const [activeGuess, setActiveGuess] = useState<ActiveGuess | null>(null);
  const [lastResolvedGuess, setLastResolvedGuess] = useState<ResolvedGuess | null>(null);
  const [score, setScore] = useState<Score>({ wins: 0, losses: 0, score: 0 });
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
    let active = true;

    async function loadPlayerData() {
      try {
        const [backendScore, guess] = await Promise.all([
          getPlayerScore(),
          getLatestGuess(),
        ]);
        if (!active) return;

        setScore(backendScore);
        if (guess?.status === "pending") {
          setActiveGuess({
            guessId: guess.guessId,
            direction: guess.direction,
            resolveAfter: guess.resolveAfter,
            entryPrice: guess.entryPrice,
          });
          setLastResolvedGuess(null);
        } else if (guess && guess.resolvedPrice !== null && guess.result !== null) {
          setActiveGuess(null);
          setLastResolvedGuess({
            guessId: guess.guessId,
            direction: guess.direction,
            entryPrice: guess.entryPrice,
            resolvedPrice: guess.resolvedPrice,
            result: guess.result,
          });
        }
      } catch (requestError) {
        if (active) {
          setError(requestError instanceof Error ? requestError.message : String(requestError));
        }
      }
    }

    void loadPlayerData();
    return () => {
      active = false;
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
    let checking = false;
    let completed = false;
    const delay = Math.max(0, Date.parse(activeGuess.resolveAfter) - Date.now());

    async function checkGuess() {
      if (!active || checking || completed) return;
      checking = true;

      try {
        const guess = await getLatestGuess();
        if (!active) return;
        if (!guess) {
          const backendScore = await getPlayerScore();
          if (!active) return;
          completed = true;
          if (interval !== undefined) window.clearInterval(interval);
          setScore(backendScore);
          setActiveGuess(null);
          setLastResolvedGuess(null);
          return;
        }
        if (guess.status === "pending"
          || guess.resolvedPrice === null
          || guess.result === null) return;

        const backendScore = await getPlayerScore();
        if (!active) return;
        completed = true;
        if (interval !== undefined) window.clearInterval(interval);

        const resolvedGuess = {
          guessId: guess.guessId,
          direction: guess.direction,
          entryPrice: guess.entryPrice,
          resolvedPrice: guess.resolvedPrice,
          result: guess.result,
        };
        setScore(backendScore);
        setLastResolvedGuess(resolvedGuess);
        setActiveGuess(null);
        setLatestPrice((current) => current
          ? { ...current, price: guess.resolvedPrice as number }
          : current);
        setError(null);
      } catch (requestError) {
        if (active) {
          setError(requestError instanceof Error ? requestError.message : String(requestError));
        }
      } finally {
        checking = false;
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
        entryPrice: number;
        resolveAfter: string;
      }>("/api/guesses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          direction,
          playerId: getPlayerId(),
        }),
      });
      const guess = {
        guessId: result.guessId,
        direction,
        resolveAfter: result.resolveAfter,
        entryPrice: result.entryPrice,
      };
      setActiveGuess(guess);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setSubmitting(false);
    }
  }

  const waiting = submitting || activeGuess !== null;
  return (
    <main className="game">
      <p className="label">BTC / USD</p>
      <h1>{latestPrice ? `$${latestPrice.price.toLocaleString("en-US")}` : "Waiting for price"}</h1>

      {activeGuess ? (
        <section className="guess-card pending" aria-live="polite">
          <p className="guess-card-title">Current guess</p>
          <strong className={`direction ${activeGuess.direction}`}>
            {activeGuess.direction === "up" ? "Up" : "Down"}
          </strong>
          <dl>
            <div>
              <dt>Guessed at</dt>
              <dd>{usdFormatter.format(activeGuess.entryPrice)}</dd>
            </div>
          </dl>
        </section>
      ) : lastResolvedGuess ? (
        <section className={`guess-card resolved ${lastResolvedGuess.result}`}>
          <p className="guess-card-title">Last result</p>
          <strong className="result">{lastResolvedGuess.result === "won" ? "Won" : "Lost"}</strong>
          <p className="resolved-direction">
            Guessed {lastResolvedGuess.direction === "up" ? "up" : "down"}
          </p>
          <dl>
            <div>
              <dt>Guessed at</dt>
              <dd>{usdFormatter.format(lastResolvedGuess.entryPrice)}</dd>
            </div>
            <div>
              <dt>Resolved at</dt>
              <dd>{usdFormatter.format(lastResolvedGuess.resolvedPrice)}</dd>
            </div>
          </dl>
        </section>
      ) : null}

      <div className="score" aria-label="Score">
        <strong>{score.score}</strong>
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
            : null}
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
