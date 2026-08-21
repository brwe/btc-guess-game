import type { PriceMessage, PriceProcessingResult } from "./priceMessageProcessor";

type PriceMessageHandler = {
  process(message: PriceMessage): Promise<PriceProcessingResult>;
};

type Logger = Pick<Console, "info" | "warn" | "error">;

type CoinbaseTickerClientOptions = {
  url?: string;
  productId?: string;
  reconnectDelayMs?: number;
  createWebSocket?: (url: string) => WebSocket;
  logger?: Logger;
};

type CoinbaseTickerMessage = {
  type: "ticker";
  product_id: string;
  price: string;
  time: string;
};

export class CoinbaseTickerClient {
  private readonly url: string;
  private readonly productId: string;
  private readonly reconnectDelayMs: number;
  private readonly createWebSocket: (url: string) => WebSocket;
  private readonly logger: Logger;
  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private processing = Promise.resolve();
  private lastObservedAtMs: number | null = null;
  private started = false;

  constructor(
    private readonly priceMessageHandler: PriceMessageHandler,
    options: CoinbaseTickerClientOptions = {},
  ) {
    this.url = options.url ?? "wss://ws-feed.exchange.coinbase.com";
    this.productId = options.productId ?? "BTC-USD";
    this.reconnectDelayMs = options.reconnectDelayMs ?? 1_000;
    this.createWebSocket = options.createWebSocket ?? ((url) => new WebSocket(url));
    this.logger = options.logger ?? console;
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.connect();
  }

  stop() {
    this.started = false;
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
      this.scheduleReconnect();
      return;
    }

    this.socket = socket;
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({
        type: "subscribe",
        product_ids: [this.productId],
        channels: ["ticker_batch"],
      }));
      this.logger.info(`[coinbase] subscribed to ticker_batch ${this.productId}`);
    });

    socket.addEventListener("message", (event) => {
      this.handleMessage(event.data);
    });

    socket.addEventListener("error", () => {
      this.logger.warn("[coinbase] websocket error");
    });

    socket.addEventListener("close", () => {
      if (this.socket === socket) this.socket = null;
      if (!this.started) return;
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
