// A separate production server process: no test layers, service replacements, or Core calls.
console.log("Loading production server")
const { Server } = await import("../../src/server/server")

console.log("Starting production listener")
const server = await Server.listen({ hostname: "127.0.0.1", port: 0 })
console.log(`Listening at ${server.url}`)
await Bun.write(process.argv[2], server.url.toString())
