import { callLeadsMcpTool } from "@/lib/leads-mcp";
import type { FrontageCall } from "@/lib/frontage-prospecting";

export function frontageCallerFor(redirectUri: string): FrontageCall {
  return async (tool, args) => {
    const result = await callLeadsMcpTool<{ structuredContent?: Record<string, unknown>; content?: { type: string; text?: string }[] }>(
      tool,
      args,
      redirectUri
    );
    if (result.structuredContent) return result.structuredContent;
    const text = result.content?.find((c) => c.type === "text")?.text;
    if (text) return JSON.parse(text) as Record<string, unknown>;
    throw new Error(`Frontage Leads "${tool}" returned no payload`);
  };
}
