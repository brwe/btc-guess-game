import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { GuessRepository, GuessRow } from "./guessRepository";

type ApiDependencies = {
  guessRepository: GuessRepository;
  createId?: () => string;
  now?: () => Date;
};

const registerGuessSchema = z.object({
  direction: z.enum(["up", "down"]),
  entryPrice: z.number().positive(),
  playerId: z.unknown().optional(),
});

export function createApi({
  guessRepository,
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
    if (error instanceof HTTPException && error.status === 400) {
      return context.json({ error: "invalid JSON body" }, 400);
    }

    console.error(error);
    return context.json({ error: "internal server error" }, 500);
  });

  app.get("/health", (context) => context.text("ok"));

  app.get("/api/hello", (context) => {
    console.log("[api] GET /api/hello");
    return context.json({ message: "hello world from the backend" });
  });

  app.post(
    "/api/guesses",
    zValidator("json", registerGuessSchema, (result, context) => {
      if (result.success) {
        return;
      }

      const invalidField = result.error.issues[0]?.path[0];
      const error = invalidField === "entryPrice"
        ? "entryPrice must be a positive number"
        : "direction must be 'up' or 'down'";

      return context.json({ error }, 400);
    }),
    async (context) => {
      const body = context.req.valid("json");
      const guessId = createId();
      const createdAt = now();
      const resolveAfter = new Date(createdAt.getTime() + 60_000);
      const playerId = typeof body.playerId === "string" && body.playerId.trim().length > 0
        ? body.playerId
        : null;

      await guessRepository.insert({
        id: guessId,
        playerId,
        direction: body.direction,
        entryPrice: body.entryPrice,
        createdAt,
        resolveAfter,
      });

      console.log(`[api] POST /api/guesses ${guessId}`);

      return context.json({
        guessId,
        status: "pending" as const,
        resolveAfter: resolveAfter.toISOString(),
      }, 201);
    },
  );

  app.get("/api/guesses/:guessId", async (context) => {
    const guessId = context.req.param("guessId");
    const guess = await guessRepository.findById(guessId);

    if (!guess) {
      return context.json({ error: "guess not found" }, 404);
    }

    console.log(`[api] GET /api/guesses/${guessId}`);
    return context.json(serializeGuess(guess));
  });

  app.notFound((context) => context.text("Not found", 404));

  return app;
}

function serializeGuess(guess: GuessRow) {
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
  };
}
