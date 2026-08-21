const [priceArgument, observedAtArgument] = Bun.argv.slice(2);

if (!priceArgument) {
  throw new Error("Usage: bun run simulate:price -- <price> [observed-at]");
}

const apiUrl = process.env.API_URL ?? "http://localhost:3001";
const response = await fetch(`${apiUrl}/api/price-messages`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    price: Number(priceArgument),
    observedAt: observedAtArgument ?? new Date().toISOString(),
  }),
});
const result = await response.json();

if (!response.ok) {
  throw new Error(`Price simulation failed with status ${response.status}: ${JSON.stringify(result)}`);
}

console.log(JSON.stringify(result, null, 2));
