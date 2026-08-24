import type {
  PriceMessage,
  PriceProcessingResult,
} from "./priceMessageProcessor";

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
  priceStaleAfterMs?: number;
  createWebSocket?: (url: string) => WebSocket;
  logger?: Logger;
  now?: () => number;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
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
  private readonly channel: CoinbaseTickerChannel;
  private readonly reconnectDelayMs: number;
  private readonly priceStaleAfterMs: number;
  private readonly createWebSocket: (url: string) => WebSocket;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly setTimeout: typeof setTimeout;
  private readonly clearTimeout: typeof clearTimeout;
  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private processing = Promise.resolve();
  private lastObservedAtMs: number | null = null;
  private lastProcessedAtMs: number | null = null;
  private running = false;

  constructor(
    private readonly priceMessageHandler: PriceMessageHandler,
    options: CoinbaseTickerClientOptions = {},
  ) {
    this.url = options.url ?? "wss://ws-feed.exchange.coinbase.com";
    this.productId = options.productId ?? "BTC-USD";
    this.channel = options.channel ?? "ticker_batch";
    this.reconnectDelayMs = options.reconnectDelayMs ?? 1_000;
    this.priceStaleAfterMs = options.priceStaleAfterMs ?? 30_000;
    this.createWebSocket =
      options.createWebSocket ?? ((url) => new WebSocket(url));
    this.logger = options.logger ?? console;
    this.now = options.now ?? Date.now;
    this.setTimeout = options.setTimeout ?? globalThis.setTimeout;
    this.clearTimeout = options.clearTimeout ?? globalThis.clearTimeout;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.connect();
  }

  stop() {
    this.running = false;
    this.lastProcessedAtMs = null;
    if (this.reconnectTimer) {
      this.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.close();
    this.socket = null;
  }

  waitForIdle(): Promise<void> {
    return this.processing;
  }

  isReady() {
    return (
      this.lastProcessedAtMs !== null &&
      this.socket !== null &&
      this.now() - this.lastProcessedAtMs <= this.priceStaleAfterMs
    );
  }

  private connect() {
    if (!this.running) return;

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
      try {
        socket.send(
          JSON.stringify({
            type: "subscribe",
            product_ids: [this.productId],
            channels: [this.channel],
          }),
        );
        this.logger.info(
          `[coinbase] requested ${this.channel} ${this.productId} subscription`,
        );
      } catch (error) {
        this.logger.error("[coinbase] subscription request failed", error);
        this.disconnectAndReconnect(socket);
      }
    });

    socket.addEventListener("message", (event) => {
      const controlMessage = parseControlMessage(
        event.data,
        this.productId,
        this.channel,
      );
      if (controlMessage === "subscribed") {
        this.logger.info(
          `[coinbase] subscribed to ${this.channel} ${this.productId}`,
        );
        return;
      }
      if (controlMessage instanceof Error) {
        this.logger.error("[coinbase] subscription rejected", controlMessage);
        this.disconnectAndReconnect(socket);
        return;
      }
      this.handleMessage(socket, event.data);
    });

    socket.addEventListener("error", () => {
      if (this.socket !== socket) return;
      this.logger.warn("[coinbase] websocket error");
      this.disconnectAndReconnect(socket);
    });

    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.lastProcessedAtMs = null;
      if (!this.running) return;
      this.logger.warn(
        `[coinbase] disconnected; reconnecting in ${this.reconnectDelayMs}ms`,
      );
      this.scheduleReconnect();
    });
  }

  private handleMessage(socket: WebSocket, data: unknown) {
    const message = parseTickerMessage(data, this.productId);
    if (!message) return;

    const observedAt = new Date(message.time);
    const observedAtMs = observedAt.getTime();
    const price = Number(message.price);

    this.processing = this.processing
      .then(async () => {
        if (
          this.lastObservedAtMs !== null &&
          observedAtMs <= this.lastObservedAtMs
        )
          return;
        await this.priceMessageHandler.process({ price, observedAt });
        this.lastObservedAtMs = observedAtMs;
        if (this.socket === socket) this.lastProcessedAtMs = this.now();
      })
      .catch((error) => {
        if (this.socket === socket) this.lastProcessedAtMs = null;
        this.logger.error("[coinbase] price processing failed", error);
      });
  }

  private scheduleReconnect() {
    if (!this.running || this.reconnectTimer) return;
    this.reconnectTimer = this.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelayMs);
  }

  private disconnectAndReconnect(socket: WebSocket) {
    if (this.socket !== socket) return;
    this.socket = null;
    this.lastProcessedAtMs = null;
    socket.close();
    this.scheduleReconnect();
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
    const detail =
      typeof message.message === "string" ? `: ${message.message}` : "";
    return new Error(`Coinbase rejected the subscription${detail}`);
  }
  if (message.type !== "subscriptions" || !Array.isArray(message.channels))
    return null;

  const subscribed = message.channels.some(
    (subscription) =>
      isRecord(subscription) &&
      (subscription.name === channel ||
        (channel === "ticker_batch" && subscription.name === "ticker_1000")) &&
      Array.isArray(subscription.product_ids) &&
      subscription.product_ids.includes(productId),
  );
  return subscribed ? "subscribed" : null;
}

function parseTickerMessage(
  data: unknown,
  productId: string,
): CoinbaseTickerMessage | null {
  if (typeof data !== "string") return null;

  let message: unknown;
  try {
    message = JSON.parse(data);
  } catch {
    return null;
  }

  if (
    !isRecord(message) ||
    message.type !== "ticker" ||
    message.product_id !== productId ||
    typeof message.price !== "string" ||
    typeof message.time !== "string"
  ) {
    return null;
  }

  const price = Number(message.price);
  const observedAtMs = Date.parse(message.time);
  if (!Number.isFinite(price) || price <= 0 || Number.isNaN(observedAtMs))
    return null;

  return message as CoinbaseTickerMessage;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
