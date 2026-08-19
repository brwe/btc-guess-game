import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";

type HelloResponse = {
  message: string;
};

function App() {
  const [data, setData] = useState<HelloResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    async function load() {
      setLoading(true);
      setError(null);

      try {
        const response = await fetch("/api/hello");
        if (!response.ok) {
          throw new Error(`Request failed with status ${response.status}`);
        }

        const json = (await response.json()) as HelloResponse;
        if (active) {
          setData(json);
        }
      } catch (err) {
        if (active) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    }

    load();

    return () => {
      active = false;
    };
  }, []);

  return (
    <main className="shell">
      <section className="card">
        <p className="eyebrow">Epilot challenge</p>
        <h1>React frontend scaffold</h1>
        <p className="lede">
          This page calls the backend hello world API through the local Docker stack.
        </p>

        {loading ? <p className="status">Loading...</p> : null}
        {error ? <p className="status error">{error}</p> : null}
        {data ? <pre className="output">{JSON.stringify(data, null, 2)}</pre> : null}
      </section>
    </main>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
