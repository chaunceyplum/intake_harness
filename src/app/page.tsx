import { existsSync } from "node:fs";
import { join } from "node:path";
import { AudienceStudio } from "./studio/audience-studio";

/**
 * The official Comcast Business logo, when brand has supplied it: drop the
 * file at public/brand/comcast-business.svg (or .png) and it replaces the
 * text mark in the header. Never redrawn by hand - a trademark comes from
 * the brand team's own files.
 */
const LOGO_PATHS = ["/brand/comcast-business.svg", "/brand/comcast-business.png"];

// Read per request, so a logo added to a deployed build shows without a rebuild.
export const dynamic = "force-dynamic";

/**
 * The executive-facing Audience Studio (studio/audience-studio.tsx). The
 * operator views - runs, evals, agents, settings - live under the
 * (workbench) route group and are linked from Developer mode.
 */
export default function Home() {
  const brandLogo = LOGO_PATHS.find((p) => existsSync(join(process.cwd(), "public", p))) ?? null;
  return <AudienceStudio brandLogo={brandLogo} />;
}
