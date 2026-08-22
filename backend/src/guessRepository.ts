import type postgres from "postgres";

export type Direction = "up" | "down";
export type GuessStatus = "pending" | "resolved";

export type PendingGuess = {
  id: string;
  playerId: string;
  direction: Direction;
  entryPrice: number;
  createdAt: Date;
  resolveAfter: Date;
};

export type GuessRow = {
  id: string;
  player_id: string;
  direction: Direction;
  entry_price: number;
  status: GuessStatus;
  created_at: Date;
  resolve_after: Date;
  resolved_at: Date | null;
  resolved_price: number | null;
};

export type ResolvedGuess = {
  id: string;
  playerId: string;
};

export type PlayerScore = {
  wins: number;
  losses: number;
};

export class PendingGuessConflictError extends Error {
  constructor() {
    super("player already has a pending guess");
    this.name = "PendingGuessConflictError";
  }
}

type ResolvedGuessRow = {
  id: string;
  player_id: string;
};

const pendingGuessConstraint = "guesses_one_pending_per_player_idx";

export interface GuessRepository {
  insert(guess: PendingGuess): Promise<void>;
  findById(guessId: string): Promise<GuessRow | null>;
}

export interface GuessResolutionRepository {
  resolveEligible(price: number, observedAt: Date): Promise<ResolvedGuess[]>;
}

export interface PlayerScoreReader {
  getPlayerScore(playerId: string): Promise<PlayerScore>;
}

export interface PlayerGuessReader {
  findPlayerGuesses(playerId: string, limit: number): Promise<GuessRow[]>;
}

export class PostgresGuessRepository implements GuessRepository, GuessResolutionRepository, PlayerScoreReader, PlayerGuessReader {
  constructor(private readonly sql: postgres.Sql) { }

  async initialize({ reset = false }: { reset?: boolean } = {}) {
    if (reset) {
      console.log("############ WARNING! guesses TABLE IS DROPPED! ")
      await this.sql`
        DROP TABLE IF EXISTS guesses
      `;
    }

    await this.sql`
      CREATE TABLE IF NOT EXISTS guesses (
        id UUID PRIMARY KEY,
        player_id TEXT NOT NULL,
        direction TEXT NOT NULL CHECK (direction IN ('up', 'down')),
        entry_price DOUBLE PRECISION NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        resolve_after TIMESTAMPTZ NOT NULL,
        resolved_at TIMESTAMPTZ NULL,
        resolved_price DOUBLE PRECISION NULL
      )
    `;

    await this.sql`
      ALTER TABLE guesses
      ALTER COLUMN player_id SET NOT NULL
    `;

    await this.sql`
      CREATE INDEX IF NOT EXISTS guesses_status_resolve_after_idx
      ON guesses (status, resolve_after)
    `;

    await this.sql`
      CREATE UNIQUE INDEX IF NOT EXISTS guesses_one_pending_per_player_idx
      ON guesses (player_id)
      WHERE status = 'pending'
    `;

    await this.sql`
      CREATE INDEX IF NOT EXISTS guesses_player_resolve_after_idx
      ON guesses (player_id, resolve_after DESC, created_at DESC, id DESC)
    `;
  }

  async insert(guess: PendingGuess) {
    try {
      await this.sql`
        INSERT INTO guesses (id, player_id, direction, entry_price, status, created_at, resolve_after)
        VALUES (
          ${guess.id}, ${guess.playerId}, ${guess.direction}, ${guess.entryPrice},
          'pending', ${guess.createdAt}, ${guess.resolveAfter}
        )
      `;
    } catch (error) {
      if (isUniqueViolation(error, pendingGuessConstraint)) {
        throw new PendingGuessConflictError();
      }

      throw error;
    }
  }

  async findById(guessId: string) {
    const rows = await this.sql<GuessRow[]>`
      SELECT id, player_id, direction, entry_price, status, created_at, resolve_after,
             resolved_at, resolved_price
      FROM guesses
      WHERE id = ${guessId}
      LIMIT 1
    `;
    return rows[0] ?? null;
  }

  async findPlayerGuesses(playerId: string, limit: number) {
    return this.sql<GuessRow[]>`
      SELECT id, player_id, direction, entry_price, status, created_at, resolve_after,
             resolved_at, resolved_price
      FROM guesses
      WHERE player_id = ${playerId}
      ORDER BY resolve_after DESC, created_at DESC, id DESC
      LIMIT ${limit}
    `;
  }

  async getPlayerScore(playerId: string) {
    const rows = await this.sql<PlayerScore[]>`
      SELECT
        COUNT(*) FILTER (
          WHERE status = 'resolved'
            AND (
              (direction = 'up' AND resolved_price > entry_price)
              OR (direction = 'down' AND resolved_price < entry_price)
            )
        )::INTEGER AS wins,
        COUNT(*) FILTER (
          WHERE status = 'resolved'
            AND (
              (direction = 'up' AND resolved_price < entry_price)
              OR (direction = 'down' AND resolved_price > entry_price)
            )
        )::INTEGER AS losses
      FROM guesses
      WHERE player_id = ${playerId}
    `;

    return rows[0] ?? { wins: 0, losses: 0 };
  }

  async resolveEligible(price: number, observedAt: Date) {
    const rows = await this.sql<ResolvedGuessRow[]>`
      UPDATE guesses
      SET
        status = 'resolved',
        resolved_at = ${observedAt},
        resolved_price = ${price}
      WHERE status = 'pending'
        AND resolve_after <= ${observedAt}
        AND entry_price <> ${price}
      RETURNING id, player_id
    `;

    return rows.map((row) => ({ id: row.id, playerId: row.player_id }));
  }
}

function isUniqueViolation(error: unknown, constraintName: string) {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const postgresError = error as { code?: unknown; constraint_name?: unknown };
  return postgresError.code === "23505" && postgresError.constraint_name === constraintName;
}
