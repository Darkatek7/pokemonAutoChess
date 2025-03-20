import express from "express";
import { initializeMetrics } from "./metrics";
import client from "prom-client";

const app = express();
const PORT = 9209; // Port for Prometheus metrics

const register = new client.Registry();
initializeMetrics(register);

// Expose /metrics endpoint for Prometheus
app.get("/metrics", async (_req, res) => {
  res.set("Content-Type", register.contentType);
  res.end(await register.metrics());
});

// Start the metrics server
app.listen(PORT, () => {
  console.log(`Prometheus metrics available at http://localhost:${PORT}/metrics`);
});
