import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { configureReactiveClient } from "../runtime/client.js"
import { App } from "./App.js"
import "./styles.css"

const authenticatedFetch: typeof fetch = (input, init = {}) => {
  const headers = new Headers(init.headers)
  headers.set("x-user-id", "user-1")
  return fetch(input, { ...init, headers })
}

configureReactiveClient({
  baseUrl: window.location.origin,
  fetch: authenticatedFetch,
})

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
