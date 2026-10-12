/** Reconnect transport only; caller keeps terminal buffer and seq state. */
export function connectAuthenticatedSocket(options: {
  getToken: (rejected: boolean) => Promise<string>
  url: (token: string) => string
  opened: () => void
  message: (event: MessageEvent) => void
  reconnecting: () => void
  failed: (error: unknown) => void
  shouldReconnect: () => boolean
  create?: (url: string) => WebSocket
}) {
  let cancelled = false
  let socket: WebSocket | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let failures = 0
  let authRetried = false
  const schedule = (rejected: boolean) => {
    if (cancelled || !options.shouldReconnect()) return
    options.reconnecting()
    timer = setTimeout(() => { timer = null; void connect(rejected) }, Math.min(15_000, 500 * 2 ** Math.min(failures++, 5)))
  }
  const connect = async (rejected = false) => {
    try {
      const token = await options.getToken(rejected)
      if (cancelled || !options.shouldReconnect()) return
      const current = (options.create ?? ((url) => new WebSocket(url)))(options.url(token))
      socket = current
      current.onopen = () => {
        if (cancelled || socket !== current) return
        failures = 0; authRetried = false; options.opened()
      }
      current.onmessage = (event) => { if (!cancelled && socket === current) options.message(event) }
      // Browser error events have no HTTP status. onclose owns the retry.
      current.onerror = () => undefined
      current.onclose = (event) => {
        if (cancelled || socket !== current) return
        socket = null
        const rejected = !authRetried && [401, 4401, 1006].includes(event.code)
        if (rejected) authRetried = true
        schedule(rejected)
      }
    } catch (error) {
      if (cancelled) return
      options.failed(error); schedule(false)
    }
  }
  void connect()
  return {
    send: (value: string) => { if (socket?.readyState === 1) socket.send(value) },
    close: () => { cancelled = true; if (timer) clearTimeout(timer); socket?.close(); socket = null },
  }
}
