// src/pages/api/superadmin/release-manifest.js
import { withApiLogger } from "../../../lib/apiMiddleware";
import { withSessionGuard } from "../../../lib/authSession";
import { getReleaseManifest, verifyReleaseManifest } from "../../../lib/releaseManifest";

async function handler(req, res, apiLogger) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed. Use GET." });
  }

  const manifest = getReleaseManifest();
  const verification = verifyReleaseManifest(manifest);

  apiLogger.info("release_audit", "manifest_inspected", {
    context: {
      release_id: manifest.release_id,
      application_version: manifest.versions.application_version,
      is_valid: verification.valid,
    },
  });

  return res.status(200).json({
    success: true,
    verification,
    manifest,
  });
}

export default withSessionGuard(withApiLogger(handler, "SuperAdmin-ReleaseManifest-API"), {
  requiredRole: "superadmin",
  requireStepUp: true,
});
