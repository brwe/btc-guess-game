import type { PriceMessage, PriceProcessingResult } from "./priceMessageProcessor";

type PriceMessageHandler = {
  process(message: PriceMessage): Promise<PriceProcessingResult>;
};

type Logger = Pick<Console, "info" | "warn" | "error">;

export type CoinbaseTickerChannel = "ticker" | "ticker_batch";

type CoinbaseTickerClientOptions = {
  url?: string;
  productId?: string;
  channel?: CoinbaseTickerChannel;
  reconnectDelayMs?: number;
  startupTimeoutMs?: number;
  createWebSocket?: (url: string) => WebSocket;
  logger?: Logger;
};

type CoinbaseTickerMessage = {
  type: "ticker";
  product_id: string;
  price: string;
  time: string;
};

type StartupState = {
  resolve: () => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

export class CoinbaseTickerClient {
  private readonly url: string;
  private readonly productId: string;
  private readonly channel: CoinbaseTickerChannel;
  private readonly reconnectDelayMs: number;
  private readonly startupTimeoutMs: number;
  private readonly createWebSocket: (url: string) => WebSocket;
  private readonly logger: Logger;
  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private processing = Promise.resolve();
  private lastObservedAtMs: number | null = null;
  private started = false;
  private startPromise: Promise<void> | null = null;
  private startupState: StartupState | null = null;

  constructor(
    private readonly priceMessageHandler: PriceMessageHandler,
    options: CoinbaseTickerClientOptions = {},
  ) {
    this.url = options.url ?? "wss://ws-feed.exchange.coinbase.com";
    this.productId = options.productId ?? "BTC-USD";
    this.channel = options.channel ?? "ticker_batch";
    this.reconnectDelayMs = options.reconnectDelayMs ?? 1_000;
    this.startupTimeoutMs = options.startupTimeoutMs ?? 10_000;
    this.createWebSocket = options.createWebSocket ?? ((url) => new WebSocket(url));
    this.logger = options.logger ?? console;
  }

  start(): Promise<void> {
    if (this.started) return this.startPromise ?? Promise.resolve();
    this.started = true;
    this.startPromise = new Promise<void>((resolve, reject) => {
      this.startupState = {
        resolve,
        reject,
        timeout: setTimeout(() => {
          this.failStartup(new Error(
            `Coinbase WebSocket did not confirm the subscription within ${this.startupTimeoutMs}ms`,
          ));
        }, this.startupTimeoutMs),
      };
      this.connect();
    });
    return this.startPromise;
  }

  stop() {
    if (this.startupState) {
      this.failStartup(new Error("Coinbase WebSocket stopped during startup"));
      return;
    }
    this.started = false;
    this.startPromise = null;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.close();
    this.socket = null;
  }

  private connect() {
    if (!this.started) return;

    let socket: WebSocket;
    try {
      socket = this.createWebSocket(this.url);
    } catch (error) {
      this.logger.error("[coinbase] connection failed", error);
      if (!this.failStartup(toError(error, "Coinbase WebSocket connection failed"))) {
        this.scheduleReconnect();
      }
      return;
    }

    this.socket = socket;
    socket.addEventListener("open", () => {
      try {
        socket.send(JSON.stringify({
          type: "subscribe",
          product_ids: [this.productId],
          channels: [this.channel],
        }));
        this.logger.info(`[coinbase] requested ${this.channel} ${this.productId} subscription`);
      } catch (error) {
        this.logger.error("[coinbase] subscription request failed", error);
        if (!this.failStartup(toError(error, "Coinbase subscription request failed"))) {
          if (this.socket === socket) this.socket = null;
          socket.close();
          this.scheduleReconnect();
        }
      }
    });

    socket.addEventListener("message", (event) => {
      const controlMessage = parseControlMessage(event.data, this.productId, this.channel);
      if (controlMessage === "subscribed") {
        this.logger.info(`[coinbase] subscribed to ${this.channel} ${this.productId}`);
        this.completeStartup();
        return;
      }
      if (controlMessage instanceof Error) {
        this.logger.error("[coinbase] subscription rejected", controlMessage);
        if (!this.failStartup(controlMessage)) {
          if (this.socket === socket) this.socket = null;
          socket.close();
          this.scheduleReconnect();
        }
        return;
      }
      this.handleMessage(event.data);
    });

    socket.addEventListener("error", () => {
      this.logger.warn("[coinbase] websocket error");
      this.failStartup(new Error("Coinbase WebSocket emitted an error during startup"));
    });

    socket.addEventListener("close", () => {
      if (this.socket === socket) this.socket = null;
      if (!this.started) return;
      if (this.failStartup(new Error(
        "Coinbase WebSocket closed before confirming the subscription",
      ))) return;
      this.logger.warn(`[coinbase] disconnected; reconnecting in ${this.reconnectDelayMs}ms`);
      this.scheduleReconnect();
    });
  }

  private handleMessage(data: unknown) {
    const message = parseTickerMessage(data, this.productId);
    if (!message) return;

    const observedAt = new Date(message.time);
    const observedAtMs = observedAt.getTime();
    const price = Number(message.price);

    this.processing = this.processing
      .then(async () => {
        if (this.lastObservedAtMs !== null && observedAtMs <= this.lastObservedAtMs) return;
        await this.priceMessageHandler.process({ price, observedAt });
        this.lastObservedAtMs = observedAtMs;
      })
      .catch((error) => {
        this.logger.error("[coinbase] price processing failed", error);
      });
  }

  private scheduleReconnect() {
    if (!this.started || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelayMs);
  }

  private completeStartup() {
    const startupState = this.startupState;
    if (!startupState) return;
    clearTimeout(startupState.timeout);
    this.startupState = null;
    startupState.resolve();
  }

  private failStartup(error: Error) {
    const startupState = this.startupState;
    if (!startupState) return false;

    clearTimeout(startupState.timeout);
    this.startupState = null;
    this.started = false;
    this.startPromise = null;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const socket = this.socket;
    this.socket = null;
    socket?.close();
    startupState.reject(error);
    return true;
  }
}

function parseControlMessage(
  data: unknown,
  productId: string,
  channel: CoinbaseTickerChannel,
): "subscribed" | Error | null {
  if (typeof data !== "string") return null;

  let message: unknown;
  try {
    message = JSON.parse(data);
  } catch {
    return null;
  }
  if (!isRecord(message)) return null;

  if (message.type === "error") {
    const detail = typeof message.message === "string" ? `: ${message.message}` : "";
    return new Error(`Coinbase rejected the subscription${detail}`);
  }
  if (message.type !== "subscriptions" || !Array.isArray(message.channels)) return null;

  const subscribed = message.channels.some((subscription) => isRecord(subscription)
    && (subscription.name === channel
      || (channel === "ticker_batch" && subscription.name === "ticker_1000"))
    && Array.isArray(subscription.product_ids)
    && subscription.product_ids.includes(productId));
  return subscribed ? "subscribed" : null;
}

function parseTickerMessage(data: unknown, productId: string): CoinbaseTickerMessage | null {
  if (typeof data !== "string") return null;

  let message: unknown;
  try {
    message = JSON.parse(data);
  } catch {
    return null;
  }

  if (!isRecord(message)
    || message.type !== "ticker"
    || message.product_id !== productId
    || typeof message.price !== "string"
    || typeof message.time !== "string") {
    return null;
  }

  const price = Number(message.price);
  const observedAtMs = Date.parse(message.time);
  if (!Number.isFinite(price) || price <= 0 || Number.isNaN(observedAtMs)) return null;

  return message as CoinbaseTickerMessage;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toError(error: unknown, fallbackMessage: string) {
  return error instanceof Error ? error : new Error(fallbackMessage);
}
