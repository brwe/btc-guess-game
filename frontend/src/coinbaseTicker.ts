export type CoinbasePrice = {
  pair: "BTC/USD";
  price: number;
  observedAt: string;
};

type CoinbaseTickerHandlers = {
  onPrice: (price: CoinbasePrice) => void;
  onDisconnect: () => void;
};

const COINBASE_WEBSOCKET_URL = "wss://ws-feed.exchange.coinbase.com";
const PRODUCT_ID = "BTC-USD";
const RECONNECT_DELAY_MS = 1_000;

export function subscribeToCoinbaseTicker({
  onPrice,
  onDisconnect,
}: CoinbaseTickerHandlers) {
  let stopped = false;
  let socket: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleReconnect = () => {
    if (stopped || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, RECONNECT_DELAY_MS);
  };

  const connect = () => {
    if (stopped) return;
    const connection = new WebSocket(COINBASE_WEBSOCKET_URL);
    socket = connection;

    connection.addEventListener("open", () => {
      connection.send(JSON.stringify({
        type: "subscribe",
        product_ids: [PRODUCT_ID],
        channels: ["ticker"],
      }));
    });

    connection.addEventListener("message", (event) => {
      const price = parseTickerMessage(event.data);
      if (price) onPrice(price);
    });

    connection.addEventListener("close", () => {
      if (socket === connection) socket = null;
      if (stopped) return;
      onDisconnect();
      scheduleReconnect();
    });
  };

  connect();
  return () => {
    stopped = true;
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
  if (!isRecord(message)
    || message.type !== "ticker"
    || message.product_id !== PRODUCT_ID
    || typeof message.price !== "string"
    || typeof message.time !== "string") {
    return null;
  }

  const price = Number(message.price);
  if (!Number.isFinite(price) || price <= 0 || Number.isNaN(Date.parse(message.time))) return null;
  return {
    pair: "BTC/USD",
    price,
    observedAt: message.time,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
