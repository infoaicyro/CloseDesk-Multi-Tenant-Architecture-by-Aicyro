// src/pages/api/version.js
import { getReleaseManifest } from "../../lib/releaseManifest";
import { withApiLogger } from "../../lib/apiMiddleware";

async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed. Use GET." });
  }

  const manifest = getReleaseManifest();

  return res.status(200).json({
    status: "healthy",
    release: manifest,
  });
}

export default withApiLogger(handler, "Version-API");
