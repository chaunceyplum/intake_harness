import { describe, it, expect } from "vitest";
import type { LlmClient, LlmCompletionRequest } from "@/lib/llm/types";
import { withGovernance } from "./governed-client";
import type { AuditEvent } from "./audit";

function fakeClient(reply: (req: LlmCompletionRequest) => string | Error) {
  const seen: LlmCompletionRequest[] = [];
  const client: LlmClient = {
    id: "fake:model",
    async complete(req) {
      seen.push(req);
      const out = reply(req);
      if (out instanceof Error) throw out;
      return { text: out, model: "fake-model-1", usage: { inputTokens: 10, outputTokens: 5 } };
    },
  };
  return { client, seen };
}

describe("withGovernance", () => {
  it("sends redacted text to the provider and restores it for the caller", async () => {
    const { client, seen } = fakeClient(() => '{"contact":"[EMAIL_1]"}');
    const events: AuditEvent[] = [];
    const governed = withGovernance(client, { redact: true, audit: async (e) => void events.push(e) });

    const res = await governed.complete({ system: "Owner is sam@corp.com", prompt: "Brief from sam@corp.com, call 212-555-0142" });

    expect(seen[0].system).toBe("Owner is [EMAIL_1]");
    expect(seen[0].prompt).toBe("Brief from [EMAIL_1], call [PHONE_1]");
    expect(res.text).toBe('{"contact":"sam@corp.com"}');

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: "llm.complete",
      actor: "system",
      model: "fake-model-1",
      details: { redactionEnabled: true, redactions: { EMAIL: 1, PHONE: 1 } },
    });
    expect(events[0].inputSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(events[0])).not.toContain("sam@corp.com");
  });

  it("passes text through untouched when redaction is off, but still audits", async () => {
    const { client, seen } = fakeClient(() => "ok");
    const events: AuditEvent[] = [];
    await withGovernance(client, { redact: false, audit: async (e) => void events.push(e) })
      .complete({ prompt: "sam@corp.com" });
    expect(seen[0].prompt).toBe("sam@corp.com");
    expect(events[0].details).toMatchObject({ redactionEnabled: false, redactions: {} });
  });

  it("audits a provider failure and rethrows it, so callers still fall back", async () => {
    const { client } = fakeClient(() => new Error("HTTP 529 overloaded"));
    const events: AuditEvent[] = [];
    const governed = withGovernance(client, { redact: true, audit: async (e) => void events.push(e) });
    await expect(governed.complete({ prompt: "x" })).rejects.toThrow("HTTP 529");
    expect(events[0]).toMatchObject({ action: "llm.error", details: { error: "HTTP 529 overloaded" } });
  });
});
