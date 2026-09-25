import { describe, it, expect } from "vitest";
import {
  extractIntake,
  extractFromAnswer,
  parseExtractionResponse,
  toKnownFields,
  explainRejectedExtractions,
} from "./llm-extract";
import type { LlmClient, LlmCompletionResult } from "@/lib/llm";

/** A stub LlmClient that returns a canned response (or throws) — no network. */
function stubClient(reply: string | Error, model = "stub-model"): LlmClient {
  return {
    id: `stub:${model}`,
    async complete(): Promise<LlmCompletionResult> {
      if (reply instanceof Error) throw reply;
      return { text: reply, model, usage: { inputTokens: 100, outputTokens: 20 } };
    },
  };
}

/** One reply per call, in order - for exercising the reflection/revision path. */
function stubSequence(replies: string[], model = "stub-model"): LlmClient {
  let i = 0;
  return {
    id: `stub-seq:${model}`,
    async complete(): Promise<LlmCompletionResult> {
      const reply = replies[Math.min(i, replies.length - 1)];
      i++;
      return { text: reply, model, usage: { inputTokens: 100, outputTokens: 20 } };
    },
  };
}

describe("parseExtractionResponse - tolerant JSON extraction", () => {
  it("reads a bare JSON object", () => {
    const out = parseExtractionResponse('{"extractions":[{"key":"campaign_name","value":"Fall Save"}]}');
    expect(out).toHaveLength(1);
  });
  it("reads JSON inside a ```json fence with surrounding prose", () => {
    const out = parseExtractionResponse('Sure!\n```json\n{"extractions":[{"key":"region","value":"Northeast"}]}\n```');
    expect(out[0].key).toBe("region");
  });
  it("throws on non-JSON so the caller can fall back", () => {
    expect(() => parseExtractionResponse("I could not parse this brief.")).toThrow();
  });
});

describe("toKnownFields - never trust the model raw", () => {
  it("keeps only real FieldSpec keys and drops invented ones", () => {
    const { known } = toKnownFields([
      { key: "campaign_name", value: "Fall Save", provenance: "stated" },
      { key: "made_up_field", value: "x", provenance: "stated" },
    ]);
    expect(known.campaign_name).toBe("Fall Save");
    expect(known.made_up_field).toBeUndefined();
  });
  it("drops empty values and coerces to trimmed strings", () => {
    const { known } = toKnownFields([
      { key: "region", value: "  Northeast  " },
      { key: "offer", value: "" },
    ]);
    expect(known.region).toBe("Northeast");
    expect(known.offer).toBeUndefined();
  });
  it("preserves provenance, defaulting unknown provenance to inferred", () => {
    const { provenance } = toKnownFields([
      { key: "campaign_name", value: "X", provenance: "stated" },
      { key: "region", value: "West", provenance: "wild-guess" },
    ]);
    expect(provenance.campaign_name).toBe("stated");
    expect(provenance.region).toBe("inferred");
  });
});

describe("extractIntake - LLM preferred, deterministic always the floor", () => {
  const brief = "Fall Switch and Save. Growth/Upsell for existing Residential customers, in market 1 November.";

  it("uses the deterministic parser when no client is configured", async () => {
    const res = await extractIntake(brief, {}, null);
    expect(res.source).toBe("deterministic");
    expect(res.model).toBeNull();
    // still a real parse - cue-phrase fields extract deterministically...
    expect(res.parsed.fields.line_of_business).toBeTruthy();
    // ...but campaign_name is never guessed from the brief's opening clause
    // any more (explicit product direction: no invented campaign names).
    expect(res.parsed.fields.campaign_name).toBeUndefined();
  });

  it("uses the LLM when it returns usable extractions", async () => {
    const client = stubClient(
      JSON.stringify({
        extractions: [
          { key: "campaign_name", value: "Fall Switch and Save", provenance: "stated" },
          { key: "line_of_business", value: "Residential (RES)", provenance: "stated" },
        ],
      }),
    );
    const res = await extractIntake(brief, {}, client);
    expect(res.source).toBe("llm");
    expect(res.model).toBe("stub-model");
    expect(res.parsed.fields.line_of_business).toBe("Residential (RES)");
  });

  it("falls back to deterministic when the LLM throws", async () => {
    const res = await extractIntake(brief, {}, stubClient(new Error("boom")));
    expect(res.source).toBe("deterministic");
    expect(res.fallbackReason).toMatch(/LLM extraction failed/);
    expect(res.parsed.fields.line_of_business).toBeTruthy();
  });

  it("falls back when the LLM returns no usable fields", async () => {
    const res = await extractIntake(brief, {}, stubClient('{"extractions":[]}'));
    expect(res.source).toBe("deterministic");
    expect(res.fallbackReason).toMatch(/no usable field extractions/);
  });

  it("caller-supplied confirmed fields win over the model's extraction", async () => {
    const client = stubClient(
      JSON.stringify({ extractions: [{ key: "campaign_name", value: "Model Name", provenance: "inferred" }] }),
    );
    const res = await extractIntake(brief, { campaign_name: "Human Confirmed" }, client);
    expect(res.parsed.fields.campaign_name).toBe("Human Confirmed");
  });

  it("a clean first attempt takes exactly one call", async () => {
    const client = stubSequence([
      JSON.stringify({ extractions: [{ key: "campaign_name", value: "Fall Switch and Save", provenance: "stated" }] }),
    ]);
    const res = await extractIntake(brief, {}, client);
    expect(res.source).toBe("llm");
    expect(res.attempts).toBe(1);
    expect(res.revised).toBe(false);
  });
});

describe("explainRejectedExtractions - the reflection critic", () => {
  it("is empty when every extraction would survive toKnownFields", () => {
    expect(explainRejectedExtractions([{ key: "campaign_name", value: "X", provenance: "stated" }])).toEqual([]);
  });
  it("flags an invented field key", () => {
    expect(explainRejectedExtractions([{ key: "made_up_field", value: "x" }])[0]).toMatch(/made_up_field.*not a real field/);
  });
  it("flags an empty value", () => {
    expect(explainRejectedExtractions([{ key: "region", value: "" }])[0]).toMatch(/region.*empty value/);
  });
});

describe("extractIntake - reflection: one chance to fix a rejected extraction", () => {
  const brief = "Fall Switch and Save. Growth/Upsell for existing Residential customers, in market 1 November.";

  it("revises a first attempt with an invented key, and accepts a clean second attempt", async () => {
    const client = stubSequence([
      JSON.stringify({ extractions: [{ key: "not_a_real_field", value: "Fall Switch and Save", provenance: "stated" }] }),
      JSON.stringify({ extractions: [{ key: "campaign_name", value: "Fall Switch and Save", provenance: "stated" }] }),
    ]);
    const res = await extractIntake(brief, {}, client);
    expect(res.source).toBe("llm");
    expect(res.attempts).toBe(2);
    expect(res.revised).toBe(true);
    expect(res.parsed.fields.campaign_name).toBe("Fall Switch and Save");
  });

  it("falls back to deterministic, with attempts:2, when the revision is also unusable", async () => {
    const client = stubSequence([
      JSON.stringify({ extractions: [{ key: "not_a_real_field", value: "x", provenance: "stated" }] }),
      JSON.stringify({ extractions: [{ key: "still_not_real", value: "y", provenance: "stated" }] }),
    ]);
    const res = await extractIntake(brief, {}, client);
    expect(res.source).toBe("deterministic");
    expect(res.attempts).toBe(2);
    expect(res.revised).toBe(true);
  });
});

describe("extractFromAnswer - one reply can fill several pending fields (B1 loop fix)", () => {
  it("mines extra fields out of a free-text answer, dropping invented keys", async () => {
    const client = stubClient(
      JSON.stringify({
        extractions: [
          { key: "line_of_business", value: "Residential (RES)", provenance: "stated" },
          { key: "region", value: "Northeast", provenance: "stated" },
          { key: "totally_made_up", value: "x", provenance: "stated" },
        ],
      }),
    );
    const { known, source } = await extractFromAnswer(
      "yeah, existing residential customers up in the Northeast",
      [{ key: "line_of_business", label: "Line of business" }],
      client,
    );
    expect(source).toBe("llm");
    expect(known.line_of_business).toMatch(/Residential/);
    expect(known.region).toBe("Northeast");
    expect(known.totally_made_up).toBeUndefined();
  });

  it("returns empty (no enrichment) when no client is configured", async () => {
    const { known, source } = await extractFromAnswer("residential, northeast", [], null);
    expect(known).toEqual({});
    expect(source).toBe("deterministic");
  });

  it("swallows an LLM error into empty enrichment so the literal merge stands", async () => {
    const { known } = await extractFromAnswer("residential", [], stubClient(new Error("boom")));
    expect(known).toEqual({});
  });
});
