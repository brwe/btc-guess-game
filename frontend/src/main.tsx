import React, { useCallback, useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import { subscribeToCoinbaseTicker } from "./coinbaseTicker";
import type { CoinbasePrice } from "./coinbaseTicker";
import "./styles.css";

type Direction = "up" | "down";

type PriceResponse = CoinbasePrice;

type GuessResponse = {
  guessId: string;
  direction: Direction;
  entryPrice: number;
  status: "pending" | "resolved";
  resolveAfter: string;
  remainingSeconds: number;
  resolvedPrice: number | null;
  result: "won" | "lost" | null;
};

type ActiveGuess = {
  guessId: string;
  direction: Direction;
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
  const body = (await response.json()) as T | { error?: string };

  if (!response.ok) {
    throw new Error(
      "error" in body && body.error
        ? body.error
        : `Request failed: ${response.status}`,
    );
  }

  return body as T;
}

async function getPlayerScore() {
  const playerId = encodeURIComponent(getPlayerId());
  return getJson<Score>(`/api/players/${playerId}/score`);
}

async function getLatestGuess() {
  const playerId = encodeURIComponent(getPlayerId());
  const guesses = await getJson<GuessResponse[]>(
    `/api/players/${playerId}/guesses?limit=1`,
  );
  return guesses[0] ?? null;
}

type AppProps = {
  subscribeToTicker?: typeof subscribeToCoinbaseTicker;
};

export function App({
  subscribeToTicker = subscribeToCoinbaseTicker,
}: AppProps = {}) {
  const playerDataGeneration = useRef(0);
  const [latestPrice, setLatestPrice] = useState<PriceResponse | null>(null);
  const [activeGuess, setActiveGuess] = useState<ActiveGuess | null>(null);
  const [lastResolvedGuess, setLastResolvedGuess] =
    useState<ResolvedGuess | null>(null);
  const [score, setScore] = useState<Score>({ wins: 0, losses: 0, score: 0 });
  const [secondsRemaining, setSecondsRemaining] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const applyPlayerData = useCallback(
    (backendScore: Score, guess: GuessResponse | null) => {
      setScore(backendScore);
      if (guess?.status === "pending") {
        setSecondsRemaining(guess.remainingSeconds);
        setActiveGuess({
          guessId: guess.guessId,
          direction: guess.direction,
          entryPrice: guess.entryPrice,
        });
        setLastResolvedGuess(null);
      } else if (
        guess &&
        guess.resolvedPrice !== null &&
        guess.result !== null
      ) {
        setSecondsRemaining(0);
        setActiveGuess(null);
        setLastResolvedGuess({
          guessId: guess.guessId,
          direction: guess.direction,
          entryPrice: guess.entryPrice,
          resolvedPrice: guess.resolvedPrice,
          result: guess.result,
        });
      } else {
        setSecondsRemaining(0);
        setActiveGuess(null);
        setLastResolvedGuess(null);
      }
      setError(null);
    },
    [],
  );

  const loadPlayerData = useCallback(async () => {
    const requestGeneration = ++playerDataGeneration.current;
    try {
      const [backendScore, guess] = await Promise.all([
        getPlayerScore(),
        getLatestGuess(),
      ]);
      if (requestGeneration !== playerDataGeneration.current) return;

      applyPlayerData(backendScore, guess);
    } catch (requestError) {
      if (requestGeneration === playerDataGeneration.current) {
        setError(
          requestError instanceof Error
            ? requestError.message
            : String(requestError),
        );
      }
    }
  }, [applyPlayerData]);

  useEffect(() => {
    void loadPlayerData();
  }, [loadPlayerData]);

  useEffect(
    () =>
      subscribeToTicker({
        onPrice: (price) => {
          setLatestPrice(price);
          setError(null);
        },
        onDisconnect: () => {
          setError("price updates disconnected; reconnecting...");
        },
      }),
    [subscribeToTicker],
  );

  useEffect(() => {
    if (!activeGuess) {
      setSecondsRemaining(0);
      return;
    }
    const interval = window.setInterval(() => {
      setSecondsRemaining((remaining) => Math.max(0, remaining - 1));
    }, 1_000);
    return () => window.clearInterval(interval);
  }, [activeGuess?.guessId]);

  useEffect(() => {
    if (!activeGuess || secondsRemaining > 0) return;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    const checkResolution = async () => {
      try {
        const guess = await getLatestGuess();
        if (cancelled) return;

        if (guess?.status === "pending") {
          retryTimer = setTimeout(checkResolution, 2_000);
          return;
        }

        const backendScore = await getPlayerScore();
        if (cancelled) return;

        playerDataGeneration.current++;
        applyPlayerData(backendScore, guess);
      } catch (requestError) {
        if (cancelled) return;
        setError(
          requestError instanceof Error
            ? requestError.message
            : String(requestError),
        );
        retryTimer = setTimeout(checkResolution, 2_000);
      }
    };

    void checkResolution();
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [activeGuess?.guessId, secondsRemaining === 0, applyPlayerData]);

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
        remainingSeconds: number;
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
        entryPrice: result.entryPrice,
      };
      playerDataGeneration.current++;
      setSecondsRemaining(result.remainingSeconds);
      setActiveGuess(guess);
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : String(requestError),
      );
    } finally {
      setSubmitting(false);
    }
  }

  const waiting = submitting || activeGuess !== null;
  const currentMove =
    activeGuess && latestPrice
      ? latestPrice.price - activeGuess.entryPrice
      : null;
  const currentMoveLabel =
    currentMove === null
      ? "Waiting for price"
      : currentMove === 0
        ? usdFormatter.format(0)
        : `${currentMove > 0 ? "↑" : "↓"} ${usdFormatter.format(Math.abs(currentMove))}`;
  const currentMoveTone =
    currentMove === null || currentMove === 0
      ? ""
      : currentMove > 0
        ? "movement-up"
        : "movement-down";
  const finalMove = lastResolvedGuess
    ? lastResolvedGuess.resolvedPrice - lastResolvedGuess.entryPrice
    : null;
  const finalMoveLabel =
    finalMove === null
      ? null
      : finalMove === 0
        ? usdFormatter.format(0)
        : `${finalMove > 0 ? "↑" : "↓"} ${usdFormatter.format(Math.abs(finalMove))}`;
  const finalMoveTone =
    finalMove === null || finalMove === 0
      ? ""
      : finalMove > 0
        ? "movement-up"
        : "movement-down";
  const countdownLabel =
    secondsRemaining > 0
      ? `${secondsRemaining}s remaining`
      : "Awaiting settlement";

  return (
    <main className="game">
      <header className="price-header">
        <div>
          <p className="label">BTC / USD</p>
          <h1>
            {latestPrice
              ? usdFormatter.format(latestPrice.price)
              : "Waiting for price"}
          </h1>
        </div>
      </header>

      <h2 className="question">
        Where will Bitcoin be when this round settles?
      </h2>
      <div className="actions">
        <button
          className="up"
          disabled={waiting || !latestPrice}
          onClick={() => registerGuess("up")}
        >
          ↑ Higher
        </button>
        <button
          className="down"
          disabled={waiting || !latestPrice}
          onClick={() => registerGuess("down")}
        >
          ↓ Lower
        </button>
      </div>
      <p className="action-help">
        {activeGuess ? "You can guess again after this round settles." : null}
      </p>

      {activeGuess ? (
        <section className="guess-card pending" aria-live="polite">
          <div className="guess-card-header">
            <div className="guess-choice-block">
              <p className="guess-card-title">Your guess</p>
              <strong className={`direction ${activeGuess.direction}`}>
                {activeGuess.direction === "up" ? "↑ Higher" : "↓ Lower"}
              </strong>
            </div>
            <div className="current-move-block">
              <span className="current-move-label">Current move</span>
              <strong className={`current-move ${currentMoveTone}`}>
                {currentMoveLabel}
              </strong>
            </div>
          </div>
          <dl>
            <div>
              <dt>Entry price</dt>
              <dd>{usdFormatter.format(activeGuess.entryPrice)}</dd>
            </div>
            <div>
              <dt>Time remaining</dt>
              <dd>{countdownLabel}</dd>
            </div>
          </dl>
        </section>
      ) : lastResolvedGuess ? (
        <section className={`guess-card resolved ${lastResolvedGuess.result}`}>
          <div className="guess-card-header">
            <div className="guess-choice-block">
              <p className="guess-card-title">Your guess</p>
              <strong className={`direction ${lastResolvedGuess.direction}`}>
                {lastResolvedGuess.direction === "up" ? "↑ Higher" : "↓ Lower"}
              </strong>
            </div>
            <div className="current-move-block">
              <span className="current-move-label">Final move</span>
              <strong className={`current-move ${finalMoveTone}`}>
                {finalMoveLabel}
              </strong>
            </div>
          </div>
          <p className="round-result">
            {lastResolvedGuess.result === "won" ? "Won" : "Lost"}
          </p>
          <dl>
            <div>
              <dt>Entry price</dt>
              <dd>{usdFormatter.format(lastResolvedGuess.entryPrice)}</dd>
            </div>
            <div>
              <dt>Settlement price</dt>
              <dd>{usdFormatter.format(lastResolvedGuess.resolvedPrice)}</dd>
            </div>
          </dl>
        </section>
      ) : null}

      <section className="score" aria-label="Score">
        <div>
          <span className="score-label">Score</span>
          <strong>{score.score >= 0 ? `+${score.score}` : score.score}</strong>
        </div>
        <div className="score-record">
          <span className="score-label">Record</span>
          <span className="score-math">
            {score.wins} wins − {score.losses} losses
          </span>
        </div>
      </section>

      {error ? <p className="error">{error}</p> : null}
    </main>
  );
}

const rootElement = document.getElementById("root");
if (rootElement) {
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
