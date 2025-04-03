import { SDK as RingCentral } from "@ringcentral/sdk";
import Softphone from "ringcentral-softphone";
import WebSocket from "ws";
import { CALL_PROMPT } from "./prompts/call-prompt.js";

// Constants
const OPENAI_VOICE = process.env.OPENAI_VOICE || "alloy";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// List of Event Types to log
const LOG_EVENT_TYPES = [
  "response.content.done",
  "rate_limits.updated",
  "response.done",
  "input_audio_buffer.committed",
  "input_audio_buffer.speech_stopped",
  "input_audio_buffer.speech_started",
  "session.created",
];

// Agent information
const AGENTS = [
  { name: "Ordering Department", extensionNumber: "102" },
  { name: "Billing Department", extensionNumber: "103" },
  { name: "Technical Support", extensionNumber: "104" },
];

// Blocked numbers (optional)
const BLOCKED_NUMBERS = ["234567890", "2092841212", "6505131145"];

export class PhoneEngine {
  constructor() {
    this.softphone = null;
    this.rcsdk = new RingCentral({
      server: process.env.RINGCENTRAL_SERVER_URL,
      clientId: process.env.RINGCENTRAL_CLIENT_ID,
      clientSecret: process.env.RINGCENTRAL_CLIENT_SECRET,
    });
    this.platform = this.rcsdk.platform();
    this.activeCalls = new Map();
  }

  async initialize() {
    try {
      // Login to RingCentral
      await this.login();

      // Get phone settings
      const deviceInfo = await this.readPhoneSettings();
      if (!deviceInfo) {
        console.error("Failed to get phone settings");
        return false;
      }

      // Initialize softphone
      this.softphone = new Softphone(deviceInfo);

      // Register softphone
      await this.softphone.register();
      console.log("Softphone registered successfully");

      // Set up call handler
      this.setupCallHandler();

      return true;
    } catch (error) {
      console.error("Failed to initialize phone engine:", error);
      return false;
    }
  }

  async login() {
    try {
      const loggedIn = await this.platform.loggedIn();
      if (!loggedIn) {
        await this.platform.login({ jwt: process.env.RINGCENTRAL_JWT });
        console.log("Logged in to RingCentral");
      } else {
        console.log("Already logged in to RingCentral");
      }
      return true;
    } catch (error) {
      console.error("Failed to login to RingCentral:", error);
      return false;
    }
  }

  setupCallHandler() {
    this.softphone.on("invite", async (sipMessage) => {
      console.log("Incoming call detected");

      // Extract caller number from SIP message
      const header = sipMessage.headers["Contact"];
      const fromNumber = header.substring(5, header.indexOf("@"));
      console.log(`Call from: ${fromNumber}`);

      // Check if caller is blocked
      if (this.isBlockedCaller(fromNumber)) {
        console.log(`Blocked caller ${fromNumber} - rejecting call`);
        return;
      }

      // Answer the call
      const callSession = await this.softphone.answer(sipMessage);
      console.log("Call answered");

      // Create active call object
      const activeCall = this.createActiveCall(callSession, fromNumber);

      // Set up OpenAI Realtime connection
      this.setupOpenAIRealtime(activeCall);

      // Set up DTMF handler
      callSession.on("dtmf", (digit) => {
        console.log(`DTMF received: ${digit}`);
        this.handleDTMF(activeCall, digit);
      });

      // Handle call end
      callSession.once("disposed", () => {
        console.log(`Call ended: ${activeCall.id}`);
        this.cleanupCall(activeCall);
      });
    });
  }

  createActiveCall(callSession, fromNumber) {
    const callId = `call_${Date.now()}`;

    const activeCall = {
      id: callId,
      fromNumber,
      callSession,
      openAIWs: null,
      transferRequested: false,
      transferTarget: null,
      telSessionId: null,
      partyId: null,
      isConnected: true,
    };

    this.activeCalls.set(callId, activeCall);

    // Get telephony session info for later use in transfers
    this.getCallInfo(activeCall);

    return activeCall;
  }

  setupOpenAIRealtime(activeCall) {
    console.log("Setting up OpenAI Realtime connection...");
    // Create WebSocket connection to OpenAI
    const openAIWs = new WebSocket(
      "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01",
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "OpenAI-Beta": "realtime=v1",
        },
      }
    );

    activeCall.openAIWs = openAIWs;
    let sessionEstablished = false;
    let audioPacketCount = 0;
    let audioDeltaCount = 0;

    // Handle WebSocket open
    openAIWs.on("open", () => {
      console.log(`OpenAI WebSocket connected for call ${activeCall.id}`);

      // Send session update to configure the call
      setTimeout(() => {
        try {
          const sessionUpdate = {
            type: "session.update",
            session: {
              turn_detection: { type: "server_vad" },
              input_audio_format: "g711_ulaw",
              output_audio_format: "g711_ulaw",
              input_audio_transcription: {
                model: "whisper-1",
              },
              voice: OPENAI_VOICE,
              instructions: CALL_PROMPT,
              modalities: ["text", "audio"],
              temperature: 0.7,
            },
          };

          console.log("Sending session update to OpenAI");
          openAIWs.send(JSON.stringify(sessionUpdate));
        } catch (error) {
          console.error("Error sending session update:", error);
        }
      }, 250);
    });

    // Handle messages from OpenAI
    openAIWs.on("message", (data) => {
      try {
        const response = JSON.parse(data);

        // Log all events for debugging
        console.log(`OpenAI event received: ${response.type}`);

        // Track when session is established
        if (response.type === "session.updated") {
          console.log("Session successfully updated, ready for audio");
          // Verify the audio formats
          console.log(
            `Input format: ${response.session.input_audio_format}, Output format: ${response.session.output_audio_format}`
          );
          sessionEstablished = true;

          // Send a welcome message to start the conversation
          setTimeout(() => {
            try {
              console.log(
                "Starting conversation with OpenAI using direct response"
              );

              // Create a response with predefined assistant message
              const directResponse = {
                type: "response.create",
                response: {
                  modalities: ["audio", "text"],
                  input: [
                    {
                      role: "user",
                      type: "message",
                      content: [
                        {
                          type: "input_text",
                          text: "Hi",
                        },
                      ],
                    },
                  ],
                },
              };

              openAIWs.send(JSON.stringify(directResponse));
            } catch (error) {
              console.error("Error initiating OpenAI conversation:", error);
            }
          }, 1000);
        }

        // Log user input
        if (
          data.type === "conversation.item.created" &&
          data.item.role === "user"
        ) {
          data.item.content.forEach((contentItem) => {
            if (contentItem.type === "input_audio" && contentItem.transcript) {
              console.log("User said:", contentItem.transcript);
            }
          });
        }

        // Handle audio response from OpenAI
        if (response.type === "response.audio.delta") {
          audioDeltaCount++;
          console.log(
            `Received audio from OpenAI (packet #${audioDeltaCount}), streaming to caller`
          );

          const audioBuffer = Buffer.from(response.delta, "base64");
          activeCall.callSession.streamAudio(audioBuffer);
        }

        // Handle text response from OpenAI (for logging and detecting transfer requests)
        if (response.type === "response.audio_transcript.done") {
          console.log("AI:", response.transcript);
          // Check for transfer requests in the text
          const text = response.transcript;
          if (!activeCall.transferRequested && this.shouldTransferCall(text)) {
            activeCall.transferRequested = true;
            activeCall.transferTarget = this.determineTransferTarget(text);

            // Initiate transfer after a short delay
            setTimeout(() => {
              this.transferCall(activeCall);
            }, 5000);
          }
        }

        if (
          response.type ===
          "conversation.item.input_audio_transcription.completed"
        ) {
          console.log(`User: ${response.transcript}`);
        }

        // Handle error events
        if (response.type === "error") {
          console.error("OpenAI API error:", response.error || "Unknown error");
        }
      } catch (error) {
        console.error("Error processing OpenAI message:", error);
      }
    });

    // Handle audio from the call
    activeCall.callSession.on("audioPacket", (rtpPacket) => {
      try {
        if (openAIWs.readyState === WebSocket.OPEN && sessionEstablished) {
          // Only send audio after session is established
          audioPacketCount++;

          // Log audio packets periodically
          if (audioPacketCount % 100 === 0) {
            console.log(`Sent ${audioPacketCount} audio packets to OpenAI`);
          }

          const audioAppend = {
            type: "input_audio_buffer.append",
            audio: Buffer.from(rtpPacket.payload).toString("base64"),
          };

          openAIWs.send(JSON.stringify(audioAppend));
        }
      } catch (error) {
        console.error("Error sending audio to OpenAI:", error);
      }
    });

    // Handle WebSocket errors
    openAIWs.on("error", (error) => {
      console.error(`OpenAI WebSocket error for call ${activeCall.id}:`, error);
    });

    // Handle WebSocket close
    openAIWs.on("close", (code, reason) => {
      console.log(
        `OpenAI WebSocket closed for call ${
          activeCall.id
        } with code ${code} and reason: ${reason || "No reason provided"}`
      );
    });
  }

  handleDTMF(activeCall, digit) {
    // Handle DTMF tones (0-9, *, #)
    console.log(`Processing DTMF: ${digit} for call ${activeCall.id}`);

    // Example: Transfer call if # is pressed
    if (digit === "#") {
      console.log("Transfer requested via DTMF");
      activeCall.transferRequested = true;
      activeCall.transferTarget = AGENTS[0]; // Default to first agent
      this.transferCall(activeCall);
    }
  }

  shouldTransferCall(text) {
    // Check if the text indicates a transfer request
    const transferKeywords = [
      "transfer you",
      "connect you",
      "speak with a representative",
      "speak with an agent",
      "human agent",
      "transfer your call",
      "connect your call",
    ];

    return transferKeywords.some((keyword) =>
      text.toLowerCase().includes(keyword)
    );
  }

  determineTransferTarget(text) {
    // Determine which department to transfer to based on the text
    if (
      text.toLowerCase().includes("order") ||
      text.toLowerCase().includes("booking")
    ) {
      return AGENTS.find((agent) => agent.name.includes("Ordering"));
    } else if (
      text.toLowerCase().includes("bill") ||
      text.toLowerCase().includes("payment")
    ) {
      return AGENTS.find((agent) => agent.name.includes("Billing"));
    } else if (
      text.toLowerCase().includes("technical") ||
      text.toLowerCase().includes("support")
    ) {
      return AGENTS.find((agent) => agent.name.includes("Technical"));
    }

    // Default to the first agent if no match
    return AGENTS[0];
  }

  async transferCall(activeCall) {
    if (!activeCall.transferTarget) {
      console.error("No transfer target specified");
      return;
    }

    console.log(
      `Transferring call ${activeCall.id} to ${activeCall.transferTarget.name}`
    );

    try {
      // Ensure we have the telephony session info
      if (!activeCall.telSessionId || !activeCall.partyId) {
        console.log("Missing telephony session info, retrieving now");
        await this.getCallInfo(activeCall);
      }

      // Announce the transfer to the caller
      const transferMessage = `I'll transfer you to our ${activeCall.transferTarget.name}. Please hold while I connect you.`;
      const transferMessageBuffer = Buffer.from(transferMessage);
      activeCall.callSession.streamAudio(transferMessageBuffer);

      // Wait a moment for the message to be played
      await new Promise((resolve) => setTimeout(resolve, 3000));

      // Execute the transfer
      const endpoint = `/restapi/v1.0/account/~/telephony/sessions/${activeCall.telSessionId}/parties/${activeCall.partyId}/transfer`;
      const bodyParams = {
        extensionNumber: activeCall.transferTarget.extensionNumber,
      };

      await this.login(); // Ensure we're logged in
      const resp = await this.platform.post(endpoint, bodyParams);

      console.log(`Call ${activeCall.id} transferred successfully`);

      // Clean up the call
      this.cleanupCall(activeCall);
    } catch (error) {
      console.error(`Failed to transfer call ${activeCall.id}:`, error);

      // Inform the caller of the failure
      const failureMessage =
        "I apologize, but I was unable to transfer your call. Please try again later.";
      const failureMessageBuffer = Buffer.from(failureMessage);
      activeCall.callSession.streamAudio(failureMessageBuffer);
    }
  }

  async getCallInfo(activeCall) {
    try {
      await this.login();
      const endpoint = "/restapi/v1.0/account/~/extension/~/active-calls";
      const resp = await this.platform.get(endpoint, { view: "Detailed" });
      const jsonObj = await resp.json();

      for (const record of jsonObj.records) {
        if (record.result === "In Progress") {
          for (const leg of record.legs) {
            if (
              leg.direction === "Inbound" &&
              leg.from.phoneNumber.includes(activeCall.fromNumber)
            ) {
              activeCall.telSessionId = leg.telephonySessionId;
              activeCall.partyId = await this.getCallSessionInfo(
                record.telephonySessionId
              );
              return;
            }
          }
        }
      }
    } catch (error) {
      console.error("Failed to get call info:", error);
    }
  }

  async getCallSessionInfo(telSessionId) {
    try {
      const endpoint = `/restapi/v1.0/account/~/telephony/sessions/${telSessionId}`;
      const resp = await this.platform.get(endpoint);
      const jsonObj = await resp.json();

      for (const party of jsonObj.parties) {
        if (party.direction === "Inbound") {
          return party.id;
        }
      }
    } catch (error) {
      console.error("Failed to get call session info:", error);
    }
    return null;
  }

  cleanupCall(activeCall) {
    // Close OpenAI WebSocket if it's open
    if (
      activeCall.openAIWs &&
      activeCall.openAIWs.readyState === WebSocket.OPEN
    ) {
      activeCall.openAIWs.close();
    }

    // Remove from active calls
    this.activeCalls.delete(activeCall.id);

    console.log(`Call ${activeCall.id} cleaned up`);
  }

  isBlockedCaller(fromNumber) {
    return BLOCKED_NUMBERS.includes(fromNumber);
  }

  async readPhoneSettings() {
    try {
      await this.login();
      const resp = await this.platform.get(
        "/restapi/v1.0/account/~/extension/~/device"
      );
      const jsonObj = await resp.json();

      for (const device of jsonObj.records) {
        if (device.name === "My SIP Phone") {
          const sipInfoResp = await this.platform.get(
            `/restapi/v1.0/account/~/device/${device.id}/sip-info`
          );
          const ivrPhone = await sipInfoResp.json();
          return {
            username: ivrPhone.userName,
            password: ivrPhone.password,
            authorizationId: ivrPhone.authorizationId,
            codec: "PCMU/8000",
          };
        }
      }

      console.error("No My SIP Phone device found");
      return null;
    } catch (error) {
      console.error("Failed to read phone settings:", error);
      return null;
    }
  }
}
