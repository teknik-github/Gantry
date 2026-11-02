// Wire format of the Gantry agent tunnel. The agent (agent/gantry-agent.mjs,
// plain JavaScript without dependencies) has its own copy of this codec;
// tests/unit/agent-protocol.test.ts checks that both agree.
//
// Everything is carried over plain HTTP(S):
//   - downstream (Gantry -> agent): the response body of one long-lived
//     GET /api/agent/connect, a stream of frames;
//   - upstream (agent -> Gantry): POST /api/agent/upstream requests, each
//     body a batch of whole frames, numbered by X-Gantry-Agent-Seq. Gantry
//     applies the batches strictly in that order.
//
// Frame: type (u8) | stream id (u32 BE) | payload length (u32 BE) | payload.
// Stream 0 is the control channel (HELLO, PING/PONG, GOAWAY). Gantry opens
// every tunneled stream (one per Docker connection); the agent only ever
// connects them to its local Docker socket, so the protocol has no address.
//
// Optional features, negotiated without changing PROTOCOL_VERSION (the frames
// and their meaning are unchanged, so old and new agents and Gantrys keep
// working together; each feature is only used when both ends have it):
//   - The agent offers `upstreamInflight` (AgentInfo). Gantry answers in
//     HELLO with the number of upstream POSTs the agent may have in flight at
//     once (they may arrive out of order; Gantry waits for the missing ones),
//     and with `maxWindow`/`windowPool`. Without the offer (an agent before
//     this) HELLO has none of these: one POST at a time, fixed windows.
//   - Window growth: a receiver may grant more than it consumed, which every
//     sender accepts (a WINDOW increment is just added). Receivers that got
//     `maxWindow` in HELLO grow a busy stream's window, doubling it up to
//     maxWindow, out of a pool of `windowPool` bytes per session and
//     direction. So the bytes buffered per agent stay below
//     maxStreams * window + windowPool in each direction.
// An agent without these features (protocol 1 as first released) talking to
// this Gantry, or this agent talking to such a Gantry, falls back to one POST
// at a time and fixed 1 MiB windows.

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
/** Largest window a receiver grows a busy stream to (with window growth). */
export const MAX_WINDOW = 8 * 1024 * 1024
/** Window growth shared by the streams of one session, per direction. */
export const WINDOW_POOL = 32 * 1024 * 1024
/** Upstream POSTs an agent may have in flight at once (when it offers them). */
export const MAX_UPSTREAM_INFLIGHT = 4
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
  /** Only when the agent offered upstreamInflight: POSTs it may have in flight at once. */
  upstreamInflight?: number
  /** With upstreamInflight: windows may grow up to maxWindow, out of windowPool bytes per direction. */
  maxWindow?: number
  windowPool?: number
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
 *
 * With `splitData`, a DATA frame that doesn't arrive in one piece comes out
 * as several DATA frames for the same stream, one per piece as it arrives,
 * instead of being copied together: DATA is a byte stream, so receivers
 * treat the pieces like the frame (flow control counts bytes). This saves a
 * copy of almost every frame, whose 64 KiB payloads rarely line up with the
 * chunks a socket delivers.
 */
export class FrameDecoder {
  private chunks: Buffer[] = []
  private buffered = 0
  /** splitData: payload bytes still to come of the DATA frame being passed through, and its stream. */
  private dataLeft = 0
  private dataStream = 0
  private readonly head = Buffer.alloc(HEADER_BYTES)

  constructor(private readonly options: { splitData?: boolean } = {}) {}

  push(chunk: Uint8Array): Frame[] {
    if (chunk.length) {
      this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.length))
      this.buffered += chunk.length
    }
    const frames: Frame[] = []
    for (;;) {
      if (this.dataLeft > 0) {
        if (!this.buffered) break
        // The next piece of the DATA frame being passed through, without a copy.
        const piece = this.take(Math.min(this.dataLeft, this.chunks[0].length))
        this.dataLeft -= piece.length
        frames.push({ type: FrameType.DATA, stream: this.dataStream, payload: piece })
        continue
      }
      if (this.buffered < HEADER_BYTES) break
      const head = this.peekHeader()
      const type = head.readUInt8(0)
      const stream = head.readUInt32BE(1)
      const length = head.readUInt32BE(5)
      if (!TYPES.has(type)) throw new ProtocolError(`Unknown frame type ${type}`)
      if (length > maxPayload(type)) throw new ProtocolError(`Frame payload too large (${length} bytes)`)
      if (this.options.splitData && type === FrameType.DATA && length > 0 && this.chunks[0].length < HEADER_BYTES + length) {
        this.skip(HEADER_BYTES)
        this.dataLeft = length
        this.dataStream = stream
        continue
      }
      if (this.buffered < HEADER_BYTES + length) break
      this.skip(HEADER_BYTES)
      frames.push({ type: type as FrameTypeValue, stream, payload: this.take(length) })
    }
    return frames
  }

  /** Bytes of an incomplete frame still waiting for the rest. */
  get pending() {
    return this.buffered + this.dataLeft
  }

  /** The next header, copied out only when it spans chunks. */
  private peekHeader(): Buffer {
    if (this.chunks[0].length >= HEADER_BYTES) return this.chunks[0]
    let off = 0
    for (const c of this.chunks) {
      off += c.copy(this.head, off, 0, Math.min(c.length, HEADER_BYTES - off))
      if (off === HEADER_BYTES) break
    }
    return this.head
  }

  private skip(n: number) {
    while (n > 0) {
      const first = this.chunks[0]
      if (first.length > n) {
        this.chunks[0] = first.subarray(n)
        this.buffered -= n
        return
      }
      this.chunks.shift()
      this.buffered -= first.length
      n -= first.length
    }
  }

  /** The next n buffered bytes: a view when they are in one chunk, else one copy of just these bytes. */
  private take(n: number): Buffer {
    if (n === 0) return Buffer.alloc(0)
    const first = this.chunks[0]
    if (first.length >= n) {
      if (first.length === n) this.chunks.shift()
      else this.chunks[0] = first.subarray(n)
      this.buffered -= n
      return first.subarray(0, n)
    }
    const out = Buffer.allocUnsafe(n)
    let off = 0
    let i = 0
    while (off < n) {
      const c = this.chunks[i]
      const k = Math.min(c.length, n - off)
      c.copy(out, off, 0, k)
      off += k
      if (k === c.length) i++
      else this.chunks[i] = c.subarray(k)
    }
    // One splice: a frame fed byte by byte spans thousands of chunks.
    this.chunks.splice(0, i)
    this.buffered -= n
    return out
  }
}

/**
 * The receiving side of flow control for one session: per-stream receive
 * windows, grown for busy streams out of a shared pool. A stream's window
 * doubles (up to `max`) when it has carried a whole window since it last
 * grew and its local consumer keeps up (little received data still waits to
 * be written). Without growth (`max` equal to `initial`) every window stays
 * `initial`, as in the first protocol release.
 *
 * agent/gantry-agent.mjs has the same logic; keep both in sync.
 */
export class ReceiveWindows {
  available: number

  constructor(
    readonly initial: number,
    readonly max: number,
    pool: number
  ) {
    this.available = max > initial ? pool : 0
  }

  /** State for a new stream. */
  open(): RecvState {
    return { window: this.initial, outstanding: 0, credit: 0, sinceGrowth: 0 }
  }

  /** Received `n` bytes; false when the sender overran the window. */
  received(s: RecvState, n: number): boolean {
    s.outstanding += n
    return s.outstanding <= s.window + MAX_DATA
  }

  /** `n` received bytes were consumed; returns the increment to grant now, or 0. */
  consumed(s: RecvState, n: number): number {
    s.credit += n
    s.sinceGrowth += n
    if (s.credit < s.window / 4) return 0
    let extra = 0
    if (this.available > 0 && s.window < this.max && s.sinceGrowth >= s.window && s.outstanding - s.credit < s.window / 4) {
      extra = Math.min(s.window, this.max - s.window, this.available)
      this.available -= extra
      s.window += extra
      s.sinceGrowth = 0
    }
    const grant = s.credit + extra
    s.outstanding -= s.credit
    s.credit = 0
    return grant
  }

  /** The stream is gone: its growth returns to the pool. */
  close(s: RecvState) {
    this.available += s.window - this.initial
    s.window = this.initial
  }
}

export type RecvState = {
  /** Bytes the sender may have outstanding (received and not granted back). */
  window: number
  /** Received and not yet granted back. */
  outstanding: number
  /** Consumed (written onward) and not yet granted back. */
  credit: number
  /** Consumed since the window last grew. */
  sinceGrowth: number
}
