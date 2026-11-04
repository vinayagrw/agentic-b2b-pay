import { useEffect, useRef, useState } from "react";

export type SSEStatus = "connecting" | "open" | "closed";
export type SSEMessage<T = unknown> = { event: string; data: T; at: number };

/** Parse SSE data as JSON when it looks like JSON, else keep the raw text. */
export function parseData(raw: string): unknown {
  const t = raw.trim();
  if (!t || !"{[\"".includes(t[0])) return raw;
  try { return JSON.parse(t); } catch { return raw; }
}

/**
 * Subscribe to named events on an SSE endpoint. The handler ref is kept fresh so callers can pass inline functions
 * without reconnecting. Pass url null to stay disconnected.
 */
export function useSSE<T = unknown>(url: string | null, events: string[], onMessage: (m: SSEMessage<T>) => void) {
  const [status, setStatus] = useState<SSEStatus>("connecting");
  const handler = useRef(onMessage); handler.current = onMessage;
  const key = events.join(",");
  useEffect(() => {
    if (!url || typeof EventSource === "undefined") { setStatus("closed"); return; }
    const es = new EventSource(url, { withCredentials: true }); setStatus("connecting");
    const on = (name: string) => (e: MessageEvent) => { setStatus("open"); handler.current({ event: name, data: parseData(String(e.data)) as T, at: Date.now() }); };
    const subs = key.split(",").filter(Boolean).map((n) => [n, on(n)] as const);
    subs.forEach(([n, f]) => es.addEventListener(n, f as EventListener));
    es.onopen = () => setStatus("open");
    es.onerror = () => setStatus(es.readyState === EventSource.CLOSED ? "closed" : "connecting");
    return () => { subs.forEach(([n, f]) => es.removeEventListener(n, f as EventListener)); es.close(); };
  }, [url, key]);
  return status;
}

/**
 * Keep a bounded, newest last buffer of SSE messages. Meant for a future copilot panel that streams tokens or steps.
 * `filter` drops messages the caller does not want, `max` caps memory.
 */
export function useStream<T = unknown>(url: string | null, events: string[], opts: { max?: number; filter?: (m: SSEMessage<T>) => boolean } = {}) {
  const [messages, setMessages] = useState<SSEMessage<T>[]>([]);
  const max = opts.max ?? 200; const filter = useRef(opts.filter); filter.current = opts.filter;
  const status = useSSE<T>(url, events, (m) => { if (filter.current && !filter.current(m)) return; setMessages((xs) => appendBounded(xs, m, max)); });
  return { status, messages, last: messages[messages.length - 1] ?? null, clear: () => setMessages([]) };
}

export function appendBounded<T>(xs: T[], x: T, max: number): T[] {
  const next = [...xs, x]; return next.length > max ? next.slice(next.length - max) : next;
}
