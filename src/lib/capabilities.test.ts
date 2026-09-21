import { describe, it, expect, afterEach } from "vitest";
import { getCapabilities } from "./capabilities";

const VARS = ["LLM_PROVIDER", "OLLAMA_HOST", "OLLAMA_MODEL", "ANTHROPIC_API_KEY", "AWS_REGION", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "MCP_GATEWAY_URL", "MCP_ENDPOINT_URL"];
afterEach(() => { for (const v of VARS) delete process.env[v]; });

describe("getCapabilities - the LLM block", () => {
  it("reports LLM unconfigured when LLM_PROVIDER is unset", async () => {
    const cap = await getCapabilities();
    expect(cap.llm.configured).toBe(false);
    expect(cap.llm.provider).toBeNull();
    expect(cap.llm.reachable).toBe("unknown");
  });

  it("reports anthropic configured with a present key (reachability unknown, no paid probe)", async () => {
    process.env.LLM_PROVIDER = "anthropic";
    process.env.ANTHROPIC_API_KEY = "sk-test";
    const cap = await getCapabilities();
    expect(cap.llm).toMatchObject({ configured: true, provider: "anthropic", reachable: "unknown" });
    expect(cap.llm.note).toMatch(/key present/i);
  });

  it("flags incomplete bedrock credentials", async () => {
    process.env.LLM_PROVIDER = "bedrock";
    process.env.AWS_REGION = "us-east-1"; // missing keys
    const cap = await getCapabilities();
    expect(cap.llm.note).toMatch(/incomplete/i);
  });

  it("flags ollama configured but with no host", async () => {
    process.env.LLM_PROVIDER = "ollama"; // no OLLAMA_HOST
    const cap = await getCapabilities();
    expect(cap.llm).toMatchObject({ configured: true, provider: "ollama", reachable: false });
    expect(cap.llm.note).toMatch(/OLLAMA_HOST is not set/);
  });

  it("flags ollama configured with a host but no model, rather than reporting reachable", async () => {
    process.env.LLM_PROVIDER = "ollama";
    process.env.OLLAMA_HOST = "10.0.0.5"; // no OLLAMA_MODEL - getLlmClient() requires it too
    const cap = await getCapabilities();
    expect(cap.llm).toMatchObject({ configured: true, provider: "ollama", reachable: false });
    expect(cap.llm.note).toMatch(/OLLAMA_MODEL is not set/);
  });
});
