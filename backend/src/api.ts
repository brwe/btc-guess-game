import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { PendingGuessConflictError } from "./guessRepository";
import type { GuessRepository, GuessRow, PlayerScore } from "./guessRepository";
import type { LatestPriceLocalStore } from "./latestPriceStore";

type ApiDependencies = {
  guessRepository: Pick<GuessRepository, "insert" | "findPlayerGuesses" | "getPlayerScore">;
  latestPriceStore: LatestPriceLocalStore;
  isReady: () => boolean;
  guessDurationSeconds: number;
  createId?: () => string;
  now?: () => Date;
};

const registerGuessSchema = z.object({
  direction: z.enum(["up", "down"]),
  playerId: z.string().trim().min(1),
});

export function createApi({
  guessRepository,
  latestPriceStore,
  isReady,
  guessDurationSeconds,
  createId = () => crypto.randomUUID(),
  now = () => new Date(),
}: ApiDependencies) {
  const app = new Hono();

  app.use("*", cors({
    origin: (origin) => origin || "*",
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type"],
  }));

  app.onError((error, context) => {
    if (error instanceof PendingGuessConflictError) {
      return context.json({ error: error.message }, 409);
    }

    if (error instanceof HTTPException && error.status === 400) {
      return context.json({ error: "invalid JSON body" }, 400);
    }

    console.error(error);
    return context.json({ error: "internal server error" }, 500);
  });

  app.get("/health", (context) => isReady()
    ? context.text("ok")
    : context.text("service unavailable", 503));

  app.post(
    "/api/guesses",
    zValidator("json", registerGuessSchema, (result, context) => {
      if (result.success) {
        return;
      }

      const invalidField = result.error.issues[0]?.path[0];
      const error = invalidField === "playerId"
        ? "playerId must be a non-empty string"
        : "direction must be 'up' or 'down'";

      return context.json({ error }, 400);
    }),
    async (context) => {
      const body = context.req.valid("json");
      const latestPrice = latestPriceStore.get();
      if (!latestPrice) {
        return context.json({ error: "price not available" }, 503);
      }

      const guessId = createId();
      const createdAt = now();
      const resolveAfter = new Date(createdAt.getTime() + guessDurationSeconds * 1_000);

      await guessRepository.insert({
        id: guessId,
        playerId: body.playerId,
        direction: body.direction,
        entryPrice: latestPrice.price,
        createdAt,
        resolveAfter,
      });

      console.log(`[api] POST /api/guesses ${guessId}`);

      return context.json({
        guessId,
        status: "pending" as const,
        entryPrice: latestPrice.price,
        resolveAfter: resolveAfter.toISOString(),
        remainingSeconds: guessDurationSeconds,
      }, 201);
    },
  );

  app.get("/api/players/:playerId/guesses", async (context) => {
    const playerId = context.req.param("playerId").trim();
    const rawLimit = context.req.query("limit") ?? "20";
    const limit = Number(rawLimit);
    if (!playerId) {
      return context.json({ error: "playerId must be a non-empty string" }, 400);
    }
    if (!/^\d+$/.test(rawLimit) || !Number.isInteger(limit) || limit < 1 || limit > 100) {
      return context.json({ error: "limit must be an integer between 1 and 100" }, 400);
    }

    const guesses = await guessRepository.findPlayerGuesses(playerId, limit);
    const responseTime = now();
    return context.json(guesses.map((guess) => serializeGuess(guess, responseTime)));
  });

  app.get("/api/players/:playerId/score", async (context) => {
    const playerId = context.req.param("playerId").trim();
    if (!playerId) {
      return context.json({ error: "playerId must be a non-empty string" }, 400);
    }

    const score = await guessRepository.getPlayerScore(playerId);
    return context.json(serializeScore(score));
  });

  app.notFound((context) => context.text("Not found", 404));
  return app;
}

function serializeGuess(guess: GuessRow, currentTime: Date) {
  return {
    guessId: guess.id,
    playerId: guess.player_id,
    direction: guess.direction,
    entryPrice: guess.entry_price,
    status: guess.status,
    createdAt: guess.created_at.toISOString(),
    resolveAfter: guess.resolve_after.toISOString(),
    resolvedAt: guess.resolved_at?.toISOString() ?? null,
    resolvedPrice: guess.resolved_price,
    result: getGuessResult(guess),
    remainingSeconds: guess.status === "pending"
      ? getRemainingSeconds(guess.resolve_after, currentTime)
      : 0,
  };
}

function getRemainingSeconds(resolveAfter: Date, currentTime: Date) {
  return Math.max(0, Math.ceil(
    (resolveAfter.getTime() - currentTime.getTime()) / 1_000,
  ));
}

function getGuessResult(guess: GuessRow) {
  if (guess.status !== "resolved" || guess.resolved_price === null) return null;

  const won = guess.direction === "up"
    ? guess.resolved_price > guess.entry_price
    : guess.resolved_price < guess.entry_price;
  return won ? "won" as const : "lost" as const;
}

function serializeScore(score: PlayerScore) {
  return {
    wins: score.wins,
    losses: score.losses,
    score: score.wins - score.losses,
  };
}
