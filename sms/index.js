require("dotenv").config();

const RingCentral = require("@ringcentral/sdk").SDK;
const Subscriptions = require("@ringcentral/subscriptions").Subscriptions;
const { SMS_PROMPT } = require("./sms-prompt");
const { OpenAI } = require("openai");

// Validate environment variables
const requiredEnvVars = {
  RINGCENTRAL_CLIENT_ID: process.env.RINGCENTRAL_CLIENT_ID,
  RINGCENTRAL_CLIENT_SECRET: process.env.RINGCENTRAL_CLIENT_SECRET,
  RINGCENTRAL_USER_JWT: process.env.RINGCENTRAL_USER_JWT,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
};

// Check for missing environment variables
const missingEnvVars = Object.entries(requiredEnvVars)
  .filter(([key, value]) => !value)
  .map(([key]) => key);

if (missingEnvVars.length > 0) {
  console.error(
    "Missing required environment variables:",
    missingEnvVars.join(", ")
  );
  process.exit(1);
}

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const RINGCENTRAL_SERVER = "https://platform.ringcentral.com";

const rcsdk = new RingCentral({
  server: RINGCENTRAL_SERVER,
  clientId: requiredEnvVars.RINGCENTRAL_CLIENT_ID,
  clientSecret: requiredEnvVars.RINGCENTRAL_CLIENT_SECRET,
});

const platform = rcsdk.platform();

// Improved login handling with async/await
async function initializeRingCentral() {
  try {
    await platform.login({ jwt: requiredEnvVars.RINGCENTRAL_USER_JWT });
    console.log("Login successful");
    await subscribe_for_sms_notification();
  } catch (error) {
    console.error("Login failed:", error.message);
    process.exit(1);
  }
}

// Platform event handlers
platform.on(platform.events.loginSuccess, (e) => {
  console.log("Login success event received");
});

platform.on(platform.events.logoutSuccess, () => {
  console.log("Logged out successfully");
});

platform.on(platform.events.refreshError, async (e) => {
  console.error("Token refresh failed:", e.message);
  // Check if already logged in, if not then login
  const loggedIn = await platform.loggedIn();
  if (!loggedIn) {
    initializeRingCentral().catch((error) => {
      console.error("Failed to initialize RingCentral:", error.message);
      process.exit(1);
    });
  }
});

const subscriptions = new Subscriptions({
  sdk: rcsdk,
});

const subscription = subscriptions.createSubscription();

async function subscribe_for_sms_notification() {
  const eventFilters = [
    "/restapi/v1.0/account/~/extension/~/message-store/instant?type=SMS",
  ];

  try {
    const subscriptionResponse = await subscription
      .setEventFilters(eventFilters)
      .register();
    console.log("Successfully subscribed to SMS notifications via WebSocket");

    return subscriptionResponse;
  } catch (error) {
    console.error("Failed to subscribe to SMS notifications:", error.message);
    throw error;
  }
}

subscription.on(subscription.events.notification, async (msg) => {
  try {
    console.log("Received SMS notification:", JSON.stringify(msg, null, 2));
    await send_reply(msg.body);
  } catch (error) {
    console.error("Error processing notification:", error.message);
  }
});

subscription.on(subscription.events.subscribeError, (error) => {
  console.error("Subscription error:", error.message);
});

subscription.on(subscription.events.renewError, (error) => {
  console.error("Subscription renewal error:", error.message);
});

async function send_reply(body) {
  if (!body?.from?.phoneNumber || !body?.to?.[0]?.phoneNumber) {
    console.error("Invalid message body structure:", body);
    return;
  }

  const prompt = SMS_PROMPT;
  const aiResponse = await openai.chat.completions.create({
    model: "gpt-3.5-turbo", // Change to GPT-3.5 Turbo to reduce cost
    messages: [
      { role: "system", content: prompt },
      { role: "user", content: body.subject },
    ],
    // max_tokens: 100, // Limit response length to control cost
    temperature: 0.7,
  });
  console.log(aiResponse.choices[0]);

  const params = {
    from: { phoneNumber: body.to[0].phoneNumber },
    to: [{ phoneNumber: body.from.phoneNumber }],
    text: aiResponse.choices[0].message.content,
  };

  try {
    const resp = await platform.post(
      "/restapi/v1.0/account/~/extension/~/sms",
      params
    );
    const jsonObj = await resp.json();
    console.log(
      "SMS sent successfully. Message status:",
      jsonObj.messageStatus
    );
    return jsonObj;
  } catch (error) {
    console.error("Failed to send SMS:", error.message);
    throw error;
  }
}

// Handle process termination
process.on("SIGTERM", async () => {
  console.log("Received SIGTERM. Cleaning up...");
  try {
    await subscription.remove();
    await platform.logout();
  } catch (error) {
    console.error("Error during cleanup:", error.message);
  }
  process.exit(0);
});

// Start the application
initializeRingCentral().catch((error) => {
  console.error("Application failed to start:", error.message);
  process.exit(1);
});
