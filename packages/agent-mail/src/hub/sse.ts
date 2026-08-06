import type http from "node:http";

import type { OutboxEventRow } from "../store/sqlite-store.js";

export const MAX_SSE_RESPONSE_BYTES = 64 * 1024;

export function encodeSseEvent(event: OutboxEventRow): string {
  return (
    `id: ${event.sequence}\n` +
    `event: ${event.kind}\n` +
    `data: ${JSON.stringify(event)}\n\n`
  );
}

export async function writeSseChunk(
  response: http.ServerResponse,
  chunk: string,
  timeoutMs: number,
): Promise<boolean> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new Error("SSE drain timeout must be between 1 and 60000 milliseconds");
  }
  if (response.destroyed || response.writableEnded) return false;
  if (response.write(chunk)) return true;
  return await new Promise<boolean>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      clearTimeout(timer);
      response.removeListener("drain", onDrain);
      response.removeListener("close", onClose);
      response.removeListener("error", onError);
    };
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const onDrain = (): void => finish(true);
    const onClose = (): void => finish(false);
    const onError = (): void => finish(false);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("SSE client did not drain before timeout"));
    }, timeoutMs);
    response.once("drain", onDrain);
    response.once("close", onClose);
    response.once("error", onError);
  });
}

function parseEventData(value: unknown): OutboxEventRow {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Hub returned a malformed SSE event");
  }
  const event = value as Record<string, unknown>;
  if (
    !Number.isInteger(event.sequence) ||
    (event.sequence as number) < 1 ||
    typeof event.id !== "string" ||
    typeof event.ts !== "string" ||
    typeof event.kind !== "string" ||
    typeof event.recipient !== "string" ||
    typeof event.message_id !== "string" ||
    !event.payload ||
    typeof event.payload !== "object" ||
    Array.isArray(event.payload)
  ) {
    throw new Error("Hub returned a malformed SSE event");
  }
  return event as unknown as OutboxEventRow;
}

export function parseSseEvents(
  raw: Buffer,
  expectedRecipient: string,
): OutboxEventRow[] {
  if (raw.length > MAX_SSE_RESPONSE_BYTES) {
    throw new Error("Hub SSE response exceeded size limit");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    throw new Error("Hub SSE is not valid UTF-8");
  }
  const events: OutboxEventRow[] = [];
  let lastSequence = 0;
  for (const frame of text.replace(/\r\n/g, "\n").split("\n\n")) {
    const lines = frame.split("\n");
    if (!frame.trim() || lines.every((line) => line.startsWith(":"))) continue;
    let eventName: string | null = null;
    let eventId: string | null = null;
    const data: string[] = [];
    for (const line of lines) {
      if (!line || line.startsWith(":")) continue;
      const separator = line.indexOf(":");
      const field = separator < 0 ? line : line.slice(0, separator);
      let value = separator < 0 ? "" : line.slice(separator + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") eventName = value;
      if (field === "id") eventId = value;
      if (field === "data") data.push(value);
    }
    if (data.length === 0) continue;
    let event: OutboxEventRow;
    try {
      event = parseEventData(JSON.parse(data.join("\n")) as unknown);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Hub returned")) {
        throw error;
      }
      throw new Error("Hub returned a malformed SSE event");
    }
    const sequence = Number(eventId);
    if (
      eventName !== event.kind ||
      !Number.isInteger(sequence) ||
      sequence !== event.sequence
    ) {
      throw new Error("Hub SSE envelope does not match event data");
    }
    if (event.recipient !== expectedRecipient) {
      throw new Error("Hub SSE recipient mismatch");
    }
    if (event.sequence <= lastSequence) {
      throw new Error("Hub SSE sequences are not strictly increasing");
    }
    lastSequence = event.sequence;
    events.push(event);
  }
  return events;
}
