import net from 'node:net'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/** The port to serve on: PORT if set, else 80. */
const WANT = Number(process.env.PORT) || 80
/** Where to go when that port can't be used (Vite moves on from here if this one is busy too). */
const FALLBACK = 5173

/**
 * Can this process listen on `port`? Ports below 1024 need admin rights on
 * Linux (and port 80 is often taken on Windows), and Vite gives up on a
 * permission error instead of trying the next port, so check first.
 */
function canListen(port: number) {
  return new Promise<boolean>((resolve) => {
    const s = net.createServer()
    s.once('error', () => resolve(false))
    s.once('listening', () => s.close(() => resolve(true)))
    s.listen(port, '0.0.0.0')
  })
}

export default defineConfig(async ({ command, isPreview }) => {
  let port = WANT
  if ((command === 'serve' || isPreview) && !(await canListen(WANT))) {
    port = FALLBACK
    console.warn(`\n  Port ${WANT} isn't available (taken, or it needs admin rights: try sudo). Serving on port ${FALLBACK} instead.\n`)
  }
  return {
    plugins: [react()],
    server: { port, host: true },
    preview: { port, host: true },
    build: {
      target: 'es2022',
      chunkSizeWarningLimit: 2500,
    },
  }
})
