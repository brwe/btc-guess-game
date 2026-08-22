import type postgres from "postgres";

export type Direction = "up" | "down";
export type GuessStatus = "pending" | "resolved";

export type PendingGuess = {
  id: string;
  playerId: string | null;
  direction: Direction;
  entryPrice: number;
  createdAt: Date;
  resolveAfter: Date;
};

export type GuessRow = {
  id: string;
  player_id: string | null;
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
};

type ResolvedGuessRow = {
  id: string;
};

export interface GuessRepository {
  insert(guess: PendingGuess): Promise<void>;
  findById(guessId: string): Promise<GuessRow | null>;
}

export interface GuessResolutionRepository {
  resolveEligible(price: number, observedAt: Date): Promise<ResolvedGuess[]>;
}

export class PostgresGuessRepository implements GuessRepository, GuessResolutionRepository {
  constructor(private readonly sql: postgres.Sql) { }

  async initialize({ reset = false }: { reset?: boolean } = {}) {
    if (reset) {
      await this.sql`
        DROP TABLE IF EXISTS guesses
      `;
    }

    await this.sql`
      CREATE TABLE IF NOT EXISTS guesses (
        id UUID PRIMARY KEY,
        player_id TEXT NULL,
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
      CREATE INDEX IF NOT EXISTS guesses_status_resolve_after_idx
      ON guesses (status, resolve_after)
    `;
  }

  async insert(guess: PendingGuess) {
    await this.sql`
      INSERT INTO guesses (id, player_id, direction, entry_price, status, created_at, resolve_after)
      VALUES (
        ${guess.id}, ${guess.playerId}, ${guess.direction}, ${guess.entryPrice},
        'pending', ${guess.createdAt}, ${guess.resolveAfter}
      )
    `;
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
      RETURNING id
    `;

    return rows.map((row) => ({ id: row.id }));
  }
}
