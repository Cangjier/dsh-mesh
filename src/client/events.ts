import { useEffect, useRef } from 'react'

/**
 * One event pushed by the mesh host or the gateway.
 *
 * The panel does not poll any job state; it subscribes to these streams and
 * merges whatever arrives into the components that show it.
 */
export interface StreamEvent {
  type?: string
  id?: string
  job?: Record<string, unknown>
  lines?: string[]
  links?: unknown[]
  [key: string]: unknown
}

type Handler = (event: StreamEvent) => void

interface Subscription {
  handler: Handler
}

interface Stream {
  source: EventSource
  subscriptions: Set<Subscription>
}

/** One connection per endpoint, shared by every mounted component. */
const streams = new Map<string, Stream>()

/** Named SSE events the services emit (plus `ready` on connect/reconnect). */
const EVENT_NAMES = ['ready', 'build', 'build-log', 'deploy', 'deploy-log', 'hysteria'] as const

/**
 * Subscribe the calling component to a server-sent event stream.
 *
 * `path` may be `null` to stay disconnected (for example while a tab is not
 * visible). Re-renders keep the same connection: the latest handler is called
 * through a ref, so a component can close over fresh state without tearing the
 * stream down.
 * @param path endpoint to subscribe to, or null.
 * @param handler called with every parsed event.
 * @returns nothing.
 */
export function useEventStream(path: string | null, handler: Handler): void {
  const latest = useRef(handler)
  latest.current = handler

  useEffect(() => {
    if (path === null || typeof EventSource === 'undefined') return
    let stream = streams.get(path)
    if (stream === undefined) {
      const source = new EventSource(path)
      const created: Stream = { source, subscriptions: new Set() }
      for (const name of EVENT_NAMES) {
        source.addEventListener(name, (message) => {
          let event: StreamEvent
          try {
            event = JSON.parse((message as MessageEvent<string>).data) as StreamEvent
          } catch {
            return
          }
          for (const subscription of [...created.subscriptions]) {
            try {
              subscription.handler(event)
            } catch {
              // A panel handler must never take the whole stream down.
            }
          }
        })
      }
      // `onerror` is not fatal: the browser reconnects on its own and the
      // service sends `ready` again, which every handler treats as "resync".
      streams.set(path, created)
      stream = created
    }
    const subscription: Subscription = { handler: event => latest.current(event) }
    stream.subscriptions.add(subscription)
    return () => {
      stream?.subscriptions.delete(subscription)
      if (stream !== undefined && stream.subscriptions.size === 0) {
        stream.source.close()
        streams.delete(path)
      }
    }
  }, [path])
}
