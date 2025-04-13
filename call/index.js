import fastifyWebsocket from "@fastify/websocket";
import "dotenv/config";
import Fastify from "fastify";
import { PhoneEngine } from "./phone-engine.js";

const PORT = process.env.PORT || 3000;

// Initialize the server
const fastify = Fastify({
  logger: true,
});

// Register WebSocket plugin
fastify.register(fastifyWebsocket);

// Initialize the phone engine
const phoneEngine = new PhoneEngine();

// Start the phone engine
await phoneEngine.initialize();

// Health check route
fastify.get("/", async (request, reply) => {
  return { status: "RingCentral Call Automation is running" };
});

// Start the server
const start = async () => {
  try {
    await fastify.listen({ port: PORT, host: "0.0.0.0" });
    console.log(`Server is running on port ${PORT}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
