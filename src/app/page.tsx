import { AudienceStudio } from "./studio/audience-studio";

/**
 * The executive-facing Audience Studio (studio/audience-studio.tsx). The
 * operator views - runs, evals, agents, settings - live under the
 * (workbench) route group and are linked from Developer mode.
 */
export default function Home() {
  return <AudienceStudio />;
}
