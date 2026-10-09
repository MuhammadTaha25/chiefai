"use client";

import { useRef, useState } from "react";
import { X, Sparkles, Send } from "lucide-react";

const PROMPT_CHIPS = ["Best leads today", "What is at risk?", "Summarize finances"];

interface Message {
  id: string;
  role: "user" | "assistant";
  text: string;
}

export function AssistantPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);
  const nextId = useRef(0);

  async function submit(text: string) {
    const value = text.trim();
    if (!value) return;
    nextId.current += 1;
    const userMsg: Message = { id: `u-${nextId.current}`, role: "user", text: value };
    setMessages((m) => [...m, userMsg]);
    setInput("");
    setLoading(true);
    try {
      // Same real, session-scoped Q&A the Dashboard's "Ask your company" uses
      // (src/app/api/company/ask/route.ts) — answers are grounded in this
      // client's own aggregate facts, never a canned/fabricated reply.
      const res = await fetch("/api/company/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: value }),
      });
      const data = await res.json();
      nextId.current += 1;
      const text = res.ok ? data.answer : data.error || "Could not answer right now. Please try again.";
      setMessages((m) => [...m, { id: `a-${nextId.current}`, role: "assistant", text }]);
    } catch {
      nextId.current += 1;
      setMessages((m) => [...m, { id: `a-${nextId.current}`, role: "assistant", text: "Could not reach the server. Please try again." }]);
    } finally {
      setLoading(false);
    }
  }

  if (!open) return null;

  return (
    <>
      <button
        aria-label="Close chief of staff panel"
        onClick={onClose}
        className="fixed inset-0 z-40 bg-black/20"
      />
      <aside
        className="ns-root fixed inset-y-0 right-0 z-50 flex w-full max-w-[400px] flex-col border-l shadow-2xl"
        style={{ background: "var(--ns-white)", borderColor: "var(--ns-border)" }}
        role="dialog"
        aria-label="Chief of staff assistant"
      >
        <div className="flex items-center justify-between border-b p-5" style={{ borderColor: "var(--ns-border)" }}>
          <div className="flex items-center gap-2">
            <span className="grid size-8 place-items-center rounded-full" style={{ background: "#F1F3F7" }}>
              <Sparkles className="size-4" style={{ color: "#7357FF" }} aria-hidden />
            </span>
            <div>
              <p className="ns-section-title text-[15px]">Chief of staff</p>
              <p className="ns-body text-[12px]">Ready to help</p>
            </div>
          </div>
          <button
            aria-label="Close panel"
            onClick={onClose}
            className="ns-focus grid size-8 place-items-center rounded-full hover:bg-[#F1F3F7]"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="ns-scrollbar flex-1 overflow-y-auto p-5">
          {messages.length === 0 && (
            <div className="ns-card p-4" style={{ background: "var(--ns-midnight)", borderColor: "var(--ns-midnight)" }}>
              <p className="text-[13px] font-semibold text-white">Ask anything about your business.</p>
              <p className="mt-1 text-[12px] text-white/70">
                Leads, revenue, projects, bookings — answered from your own data.
              </p>
            </div>
          )}

          <ul className="mt-4 space-y-3">
            {messages.map((m) => (
              <li
                key={m.id}
                className={`max-w-[85%] rounded-xl px-3 py-2 text-[13px] ${m.role === "user" ? "ml-auto" : ""}`}
                style={
                  m.role === "user"
                    ? { background: "#7357FF", color: "#fff" }
                    : { background: "#F1F3F7", color: "#101828" }
                }
              >
                {m.text}
              </li>
            ))}
            {loading && (
              <li className="max-w-[60%] rounded-xl px-3 py-2 text-[13px]" style={{ background: "#F1F3F7", color: "#98A2B3" }}>
                Thinking…
              </li>
            )}
          </ul>
        </div>

        <div className="border-t p-4" style={{ borderColor: "var(--ns-border)" }}>
          <div className="mb-3 flex flex-wrap gap-2">
            {PROMPT_CHIPS.map((chip) => (
              <button
                key={chip}
                onClick={() => submit(chip)}
                className="ns-focus rounded-full border px-3 py-1.5 text-[12px] font-medium hover:bg-[#F1F3F7]"
                style={{ borderColor: "var(--ns-border)", color: "#344054" }}
              >
                {chip}
              </button>
            ))}
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submit(input);
            }}
            className="flex items-center gap-2"
          >
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask a question..."
              aria-label="Ask the chief of staff a question"
              className="ns-focus h-10 flex-1 rounded-full border px-4 text-[13px]"
              style={{ borderColor: "var(--ns-border)" }}
            />
            <button
              type="submit"
              aria-label="Send"
              className="ns-focus grid size-10 shrink-0 place-items-center rounded-full disabled:opacity-40"
              style={{ background: "#7357FF", color: "#fff" }}
              disabled={!input.trim()}
            >
              <Send className="size-4" />
            </button>
          </form>
          <p className="mt-2 text-[11px]" style={{ color: "#98A2B3" }}>
            AI can make mistakes. Review important decisions.
          </p>
        </div>
      </aside>
    </>
  );
}

export default AssistantPanel;
