import { createServer } from "node:http"
import { attachAppContext, pool } from "./app/context.js"
import { reactiveNeonRouter } from "./generated/routes.js"

const port = Number(process.env.PORT ?? 4000)

const server = createServer((req, res) => {
  if (req.url === "/health") {
    res.statusCode = 200
    res.end("ok")
    return
  }
  attachAppContext(req)
  void reactiveNeonRouter(req, res)
})

server.listen(port, "127.0.0.1", () => {
  console.log(`Reactive Neon server listening on http://127.0.0.1:${port}`)
})

let shuttingDown = false
async function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  const closed = new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })
  server.closeAllConnections()
  await Promise.all([closed, pool.end()])
}

function exitAfterShutdown() {
  void shutdown().then(
    () => process.exit(0),
    (error) => {
      console.error(error)
      process.exit(1)
    },
  )
}

process.once("SIGINT", exitAfterShutdown)
process.once("SIGTERM", exitAfterShutdown)
