// Wire format of the Gantry agent tunnel. The agent (agent/gantry-agent.mjs,
// plain JavaScript without dependencies) has its own copy of this codec;
// tests/unit/agent-protocol.test.ts checks that both agree.
//
// Everything is carried over plain HTTP(S):
//   - downstream (Gantry -> agent): the response body of one long-lived
//     GET /api/agent/connect, a stream of frames;
//   - upstream (agent -> Gantry): POST /api/agent/upstream requests, one at a
//     time, each body a batch of whole frames, numbered by X-Gantry-Agent-Seq.
//
// Frame: type (u8) | stream id (u32 BE) | payload length (u32 BE) | payload.
// Stream 0 is the control channel (HELLO, PING/PONG, GOAWAY). Gantry opens
// every tunneled stream (one per Docker connection); the agent only ever
// connects them to its local Docker socket, so the protocol has no address.

export const PROTOCOL_VERSION = 1

export const FrameType = {
  /** Gantry -> agent, stream 0: JSON AgentHello, first frame of a session. */
  HELLO: 1,
  /** Gantry -> agent: open stream <id> to the local Docker socket. */
  OPEN: 2,
  /** Both ways: bytes of a stream (at most MAX_DATA). */
  DATA: 3,
  /** Both ways: the sender won't write to the stream anymore (half close). */
  END: 4,
  /** Both ways: the stream is gone; optional UTF-8 reason. */
  RESET: 5,
  /** Both ways: u32 BE, more bytes the receiver accepts on the stream (flow control). */
  WINDOW: 6,
  /** Gantry -> agent, stream 0: heartbeat, 8-byte payload echoed by PONG. */
  PING: 7,
  /** Agent -> Gantry, stream 0: answer to PING. */
  PONG: 8,
  /** Gantry -> agent, stream 0: the session ends; JSON { reason, retry }. */
  GOAWAY: 9,
} as const

export type FrameTypeValue = (typeof FrameType)[keyof typeof FrameType]

export const HEADER_BYTES = 9
/** Largest DATA payload. */
export const MAX_DATA = 64 * 1024
/** Largest payload of any other frame. */
export const MAX_CONTROL = 4 * 1024
/** Bytes a receiver accepts per stream before it grants more with WINDOW. */
export const INITIAL_WINDOW = 1024 * 1024
/** Largest upstream POST body (the agent sends up to 1 MiB batches). */
export const MAX_UPSTREAM_BODY = 4 * 1024 * 1024
export const MAX_STREAM_ID = 0xffffffff

export type Frame = { type: FrameTypeValue; stream: number; payload: Buffer }

/** What the agent learns first: its session credentials and the limits. */
export type AgentHello = {
  protocol: number
  session: string
  secret: string
  environment: { id: number; name: string }
  maxStreams: number
  window: number
  maxData: number
  heartbeatMs: number
}

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ProtocolError"
  }
}

const TYPES = new Set<number>(Object.values(FrameType))

export function maxPayload(type: number) {
  return type === FrameType.DATA ? MAX_DATA : MAX_CONTROL
}

export function encodeFrame(type: FrameTypeValue, stream: number, payload: Uint8Array = Buffer.alloc(0)): Buffer {
  if (!Number.isInteger(stream) || stream < 0 || stream > MAX_STREAM_ID) throw new ProtocolError(`Invalid stream id ${stream}`)
  if (payload.length > maxPayload(type)) throw new ProtocolError(`Frame payload too large (${payload.length} bytes)`)
  const frame = Buffer.allocUnsafe(HEADER_BYTES + payload.length)
  frame.writeUInt8(type, 0)
  frame.writeUInt32BE(stream, 1)
  frame.writeUInt32BE(payload.length, 5)
  frame.set(payload, HEADER_BYTES)
  return frame
}

/** DATA frames for `data`, split at MAX_DATA. */
export function encodeData(stream: number, data: Buffer): Buffer[] {
  const frames: Buffer[] = []
  for (let off = 0; off < data.length; off += MAX_DATA) {
    frames.push(encodeFrame(FrameType.DATA, stream, data.subarray(off, off + MAX_DATA)))
  }
  return frames
}

export function encodeWindow(stream: number, increment: number): Buffer {
  const p = Buffer.allocUnsafe(4)
  p.writeUInt32BE(increment, 0)
  return encodeFrame(FrameType.WINDOW, stream, p)
}

export function encodeJson(type: FrameTypeValue, stream: number, value: unknown): Buffer {
  return encodeFrame(type, stream, Buffer.from(JSON.stringify(value), "utf8"))
}

/** RESET with a reason, shortened to fit a control frame. */
export function encodeReset(stream: number, reason = ""): Buffer {
  let text = Buffer.from(reason, "utf8")
  if (text.length > MAX_CONTROL) text = text.subarray(0, MAX_CONTROL)
  return encodeFrame(FrameType.RESET, stream, text)
}

export function readWindow(frame: Frame): number {
  if (frame.payload.length !== 4) throw new ProtocolError("WINDOW frame needs a 4-byte payload")
  const n = frame.payload.readUInt32BE(0)
  if (n === 0) throw new ProtocolError("WINDOW increment must be positive")
  return n
}

/**
 * Incremental decoder: feed it chunks as they arrive, get whole frames.
 * Unknown frame types and oversized payloads throw ProtocolError before any
 * of the payload is buffered.
 */
export class FrameDecoder {
  private chunks: Buffer[] = []
  private buffered = 0

  push(chunk: Uint8Array): Frame[] {
    if (chunk.length) {
      this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.length))
      this.buffered += chunk.length
    }
    const frames: Frame[] = []
    while (this.buffered >= HEADER_BYTES) {
      const head = this.peek(HEADER_BYTES)
      const type = head.readUInt8(0)
      const stream = head.readUInt32BE(1)
      const length = head.readUInt32BE(5)
      if (!TYPES.has(type)) throw new ProtocolError(`Unknown frame type ${type}`)
      if (length > maxPayload(type)) throw new ProtocolError(`Frame payload too large (${length} bytes)`)
      if (this.buffered < HEADER_BYTES + length) break
      const whole = this.take(HEADER_BYTES + length)
      frames.push({ type: type as FrameTypeValue, stream, payload: whole.subarray(HEADER_BYTES) })
    }
    return frames
  }

  /** Bytes of an incomplete frame still waiting for the rest. */
  get pending() {
    return this.buffered
  }

  private peek(n: number): Buffer {
    if (this.chunks[0].length >= n) return this.chunks[0].subarray(0, n)
    const joined = Buffer.concat(this.chunks)
    this.chunks = [joined]
    return joined.subarray(0, n)
  }

  private take(n: number): Buffer {
    if (this.chunks[0].length < n) this.chunks = [Buffer.concat(this.chunks)]
    const first = this.chunks[0]
    const out = first.subarray(0, n)
    if (first.length === n) this.chunks.shift()
    else this.chunks[0] = first.subarray(n)
    this.buffered -= n
    return out
  }
}
