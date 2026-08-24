export type CoinbasePrice = {
  pair: "BTC/USD";
  price: number;
  observedAt: string;
};

type CoinbaseTickerHandlers = {
  onPrice: (price: CoinbasePrice) => void;
  onDisconnect: () => void;
};

type CoinbaseTickerOptions = {
  reconnectDelayMs?: number;
  staleAfterMs?: number;
  staleCheckIntervalMs?: number;
  now?: () => number;
};

const COINBASE_WEBSOCKET_URL = "wss://ws-feed.exchange.coinbase.com";
const PRODUCT_ID = "BTC-USD";
const RECONNECT_DELAY_MS = 1_000;
const STALE_AFTER_MS = 30_000;
const STALE_CHECK_INTERVAL_MS = 5_000;

export function subscribeToCoinbaseTicker(
  { onPrice, onDisconnect }: CoinbaseTickerHandlers,
  options: CoinbaseTickerOptions = {},
) {
  const reconnectDelayMs = options.reconnectDelayMs ?? RECONNECT_DELAY_MS;
  const staleAfterMs = options.staleAfterMs ?? STALE_AFTER_MS;
  const staleCheckIntervalMs =
    options.staleCheckIntervalMs ?? STALE_CHECK_INTERVAL_MS;
  const now = options.now ?? Date.now;
  let stopped = false;
  let socket: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let lastMessageAtMs: number | null = null;

  function connect() {
    if (stopped || socket) return;

    let connection: WebSocket;
    try {
      connection = new WebSocket(COINBASE_WEBSOCKET_URL);
    } catch {
      onDisconnect();
      scheduleReconnect();
      return;
    }
    socket = connection;
    lastMessageAtMs = now();

    connection.addEventListener("open", () => {
      try {
        connection.send(
          JSON.stringify({
            type: "subscribe",
            product_ids: [PRODUCT_ID],
            channels: ["ticker"],
          }),
        );
      } catch {
        reconnect(connection);
      }
    });

    connection.addEventListener("message", (event) => {
      const price = parseTickerMessage(event.data);
      if (!price) return;
      lastMessageAtMs = now();
      onPrice(price);
    });

    connection.addEventListener("error", () => reconnect(connection));
    connection.addEventListener("close", () => reconnect(connection));
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, reconnectDelayMs);
  }

  function reconnect(connection: WebSocket, immediately = false) {
    if (socket !== connection) return;
    socket = null;
    lastMessageAtMs = null;
    connection.close();
    if (stopped) return;
    onDisconnect();
    if (immediately) connect();
    else scheduleReconnect();
  }

  function reconnectIfStale() {
    if (stopped) return;
    if (!socket) {
      connect();
      return;
    }
    if (lastMessageAtMs !== null && now() - lastMessageAtMs > staleAfterMs) {
      reconnect(socket, true);
    }
  }

  function handleVisibilityChange() {
    if (document.visibilityState === "visible") reconnectIfStale();
  }
  function handleOnline() {
    if (socket) reconnect(socket, true);
    else connect();
  }

  document.addEventListener("visibilitychange", handleVisibilityChange);
  window.addEventListener("online", handleOnline);
  const staleCheckTimer = setInterval(reconnectIfStale, staleCheckIntervalMs);
  connect();
  return () => {
    stopped = true;
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    window.removeEventListener("online", handleOnline);
    clearInterval(staleCheckTimer);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    socket?.close();
    socket = null;
  };
}

function parseTickerMessage(data: unknown): CoinbasePrice | null {
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
    message.product_id !== PRODUCT_ID ||
    typeof message.price !== "string" ||
    typeof message.time !== "string"
  ) {
    return null;
  }

  const price = Number(message.price);
  if (
    !Number.isFinite(price) ||
    price <= 0 ||
    Number.isNaN(Date.parse(message.time))
  )
    return null;
  return {
    pair: "BTC/USD",
    price,
    observedAt: message.time,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
