import { SDK as RingCentral } from "@ringcentral/sdk";
import Softphone from "ringcentral-softphone";
import WebSocket from "ws";
import { CALL_PROMPT } from "./prompts/call-prompt.js";
import { sendGuestInfoEmail } from "./utils/email.js";

console.log("prompt: ", CALL_PROMPT);

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
  { name: "Reservation Team", extensionNumber: "103" },
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
      // First check if we already have a valid token
      if (this.platform.auth().accessTokenValid()) {
        console.log("Access token is valid, no need to login again");
        return;
      }

      // Check if we have a refresh token and it's not expired
      const auth = this.platform.auth();
      if (auth.refreshToken() && !auth.refreshTokenExpired()) {
        console.log("Attempting to refresh token...");
        try {
          await this.platform.refresh();
          console.log("Token refreshed successfully");
          this.loginAttempts = 0;
          return;
        } catch (refreshError) {
          console.error(
            "Failed to refresh token, will try full login:",
            refreshError
          );
          // Continue to full login below
        }
      }

      // If we reach here, we need to do a full login with JWT
      console.log("Performing full login with JWT...");
      if (!process.env.RINGCENTRAL_JWT) {
        throw new Error("RINGCENTRAL_JWT environment variable is not set");
      }

      await this.platform.login({ jwt: process.env.RINGCENTRAL_JWT });
      console.log("Successfully logged in to RingCentral using JWT");
      this.loginAttempts = 0;
    } catch (e) {
      this.loginAttempts = (this.loginAttempts || 0) + 1;
      console.error(`Login error (attempt ${this.loginAttempts}):`, e);

      if (this.loginAttempts <= 3) {
        console.log("Retrying login after error...");
        try {
          // Implement exponential backoff for retries
          const backoffTime = Math.pow(2, this.loginAttempts) * 1000; // 2s, 4s, 8s
          console.log(`Waiting ${backoffTime}ms before retry`);
          await new Promise((resolve) => setTimeout(resolve, backoffTime));

          // Try full login again with JWT
          await this.platform.login({ jwt: process.env.RINGCENTRAL_JWT });
          console.log("Successfully logged in on retry");
          this.loginAttempts = 0;
        } catch (retryError) {
          console.error("Login retry failed:", retryError);
          throw retryError;
        }
      } else {
        console.error("Max login attempts reached, giving up");
        throw e;
      }
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

      // Add debug logging for audio
      console.log(`Setting up audio debug for call ${activeCall.id}`);
      let lastAudioDebugTime = Date.now();
      let audioBufferCount = 0;
      let emptyBufferCount = 0;

      // Track audio buffers
      callSession.on("audioBuffer", (buffer) => {
        // Debug logging for audio buffers
        audioBufferCount++;
        const now = Date.now();

        // Check for empty buffers
        if (!buffer || buffer.length === 0) {
          emptyBufferCount++;
          // Log every 100 empty buffers
          if (emptyBufferCount % 100 === 0) {
            console.log(
              `Received ${emptyBufferCount} empty audio buffers for call ${activeCall.id}`
            );
          }
          return; // Skip processing empty buffers
        }

        // Log audio stats every few seconds
        if (now - lastAudioDebugTime > 5000) {
          console.log(
            `[AUDIO DEBUG] Call ${activeCall.id}: Received ${audioBufferCount} audio buffers in last 5s. Current buffer size: ${buffer.length} bytes`
          );
          lastAudioDebugTime = now;
          audioBufferCount = 0;
        }

        // Process audio for OpenAI
        if (
          activeCall.openAIWs &&
          activeCall.openAIWs.readyState === WebSocket.OPEN
        ) {
          try {
            const base64Audio = buffer.toString("base64");
            const audioMessage = {
              type: "input_audio.chunk",
              input_audio: {
                format: "g711_ulaw",
                chunk: base64Audio,
              },
            };

            activeCall.openAIWs.send(JSON.stringify(audioMessage));

            // Track number of packets sent for debugging
            if (!activeCall.packetCount) {
              activeCall.packetCount = 0;
            }

            activeCall.packetCount++;

            // Log every 100 packets for debugging
            if (activeCall.packetCount % 100 === 0) {
              console.log(
                `Sent ${activeCall.packetCount} audio packets to OpenAI for call ${activeCall.id}`
              );
            }
          } catch (error) {
            console.error(
              `Error sending audio to OpenAI for call ${activeCall.id}:`,
              error
            );
          }
        } else {
          // Log WebSocket issues
          if (!activeCall.openAIWs) {
            console.log(
              `[ERROR] OpenAI WebSocket not initialized for call ${activeCall.id}`
            );
          } else {
            console.log(
              `[ERROR] OpenAI WebSocket not open for call ${activeCall.id}. State: ${activeCall.openAIWs.readyState}`
            );
          }
        }
      });

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
      isEnding: false,
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
      "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17",
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

    // Enhanced audio buffer for jitter reduction
    activeCall.audioBuffer = [];
    activeCall.isPlayingAudio = false;
    activeCall.audioBufferSize = 8; // Increased buffer size for smoother playback
    activeCall.audioPlaybackInterval = null;
    activeCall.lastPacketTime = Date.now();
    activeCall.packetGapThreshold = 80; // Reduced threshold to respond faster to network changes
    activeCall.audioStatsReported = 0; // Track for periodic reporting
    activeCall.userIsSpeaking = false; // Track if user is currently speaking

    // Handle WebSocket open
    openAIWs.on("open", () => {
      console.log(`OpenAI WebSocket connected for call ${activeCall.id}`);

      // Send session update to configure the call
      setTimeout(() => {
        try {
          const sessionUpdate = {
            type: "session.update",
            session: {
              "turn_detection": {
              "type": "server_vad",
                "threshold": 0.5,
                "prefix_padding_ms": 300,
                "silence_duration_ms": 500,
                "create_response": true, // only in conversation mode
                "interrupt_response": true, // only in conversation mode
              },  
              input_audio_format: "g711_ulaw",
              output_audio_format: "g711_ulaw",
              input_audio_transcription: {
                model: "whisper-1",
              },
              voice: OPENAI_VOICE,
              instructions: CALL_PROMPT,
              modalities: ["text", "audio"],
              temperature: 0.6,
              tools: [
                {
                  type: "function",
                  name: "end_call",
                  description:
                    "End the current call when the conversation is complete",
                  parameters: {
                    type: "object",
                    properties: {
                      reason: {
                        type: "string",
                        description:
                          "The reason for ending the call (e.g., 'conversation_complete', 'customer_request', etc.)",
                      },
                    },
                    required: ["reason"],
                  },
                },
                {
                  type: "function",
                  name: "collect_guest_info_send_email",
                  description:
                    "Collect essential guest information for booking and send it via email",
                 
                  parameters: {
                    type: "object",
                    properties: {
                      guestName: {
                        type: "string",
                        description: "The full name of the guest for the reservation",
                      },
                      email: {
                        type: "string",
                        description: "The guest's email address",
                      },
                      tourType: {
                        type: "string",
                        description:
                          "The specific type of tour the guest is interested in",
                      },
                      tourDate: {
                        type: "string",
                        description:
                          "The date of the tour (format: YYYY-MM-DD)",
                      },
                      tourTime: {
                        type: "string",
                        description: "The time of the tour (e.g., '9:00 AM')",
                      },
                      numberOfGuests: {
                        type: "integer",
                        description: "Total number of guests in the party",
                      },
                      notes: {
                        type: "string",
                        description: "Additional information including: breakdown of adults/children, weight of riders (for horseback tours), transportation needs and hotel name, special requests",
                      },
                    },
                    required: ["guestName", "email", "tourType", "tourDate", "tourTime", "numberOfGuests", "notes"],
                  },
                },
                {
                  type: "function",
                  name: "transfer_call",
                  description:
                    "Transfer the call to a human agent. Use this when caller requests to speak to an agent or when you cannot answer their questions.",
                  
                  parameters: {
                    type: "object",
                    properties: {
                      reason: {
                        type: "string",
                        description: "The reason for transferring the call, e.g. 'customer request', 'complex inquiry', etc.",
                      },
                    },
                    required: ["reason"],
                  },
                },
              ],
              tool_choice: "auto",
            },
          };

          console.log("Sending session update to OpenAI");
          openAIWs.send(JSON.stringify(sessionUpdate));
        } catch (error) {
          console.error("Error sending session update:", error);
          // Attempt to reset the connection
          this.resetOpenAIConnection(
            activeCall,
            "Error sending session update"
          );
        }
      }, 250);
    });

    // Handle WebSocket errors
    openAIWs.on("error", (error) => {
      console.error(`OpenAI WebSocket error for call ${activeCall.id}:`, error);
      this.resetOpenAIConnection(activeCall, "WebSocket error");
    });

    // Handle WebSocket close events
    openAIWs.on("close", (code, reason) => {
      console.log(
        `OpenAI WebSocket closed for call ${activeCall.id} with code: ${code}, reason: ${reason}`
      );

      // Only auto reconnect for unexpected closure
      if (code !== 1000) {
        // 1000 is normal closure
        this.resetOpenAIConnection(
          activeCall,
          `Unexpected WebSocket close: ${code}`
        );
      }
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
                          text: "Repeat this: Hello, welcome to Unique Tours and Rentals. How can I help you today? At any point if you are not satisfied with the service, please press '0' to speak to another agent.",
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
            `Received audio from OpenAI (packet #${audioDeltaCount}), adding to buffer`
          );

          const audioBuffer = Buffer.from(response.delta, "base64");

          try {
            // Concatenate small packets if they arrive too quickly
            const now = Date.now();
            const timeSinceLastPacket = now - activeCall.lastPacketTime;

            // G.711 uses 8kHz sampling rate, which is 160 bytes per 20ms frame
            // Instead of combining based on arbitrary timing, respect G.711 frame boundaries
            // Only normalize packets to proper G.711 frame sizes

            // If this is a standard G.711 packet (should be around 160 bytes), add it directly
            if (audioBuffer.length >= 80 && audioBuffer.length <= 240) {
              activeCall.audioBuffer.push(audioBuffer);

              // Log packet size occasionally for monitoring
              if (audioDeltaCount % 20 === 0) {
                console.log(
                  `Added normal G.711 packet: ${audioBuffer.length} bytes`
                );
              }
            }
            // If it's a very small packet, try to combine to match G.711 frame size
            else if (
              audioBuffer.length < 80 &&
              activeCall.audioBuffer.length > 0
            ) {
              const lastBuffer =
                activeCall.audioBuffer[activeCall.audioBuffer.length - 1];

              // Only combine if it would create a more standard sized packet
              if (lastBuffer.length + audioBuffer.length <= 240) {
                const combinedBuffer = Buffer.concat([lastBuffer, audioBuffer]);
                activeCall.audioBuffer[activeCall.audioBuffer.length - 1] =
                  combinedBuffer;
                console.log(
                  `Combined small audio packet (${audioBuffer.length} bytes) with previous packet, new size: ${combinedBuffer.length} bytes`
                );
              } else {
                // If combining would make it too large, add as separate packet
                activeCall.audioBuffer.push(audioBuffer);
                console.log(
                  `Added small packet separately: ${audioBuffer.length} bytes`
                );
              }
            }
            // If it's a large packet, split it into standard-sized chunks
            else if (audioBuffer.length > 240) {
              console.log(
                `Splitting large packet of ${audioBuffer.length} bytes into standard frames`
              );

              // Split into ~160 byte chunks to match G.711 frame size
              const chunkSize = 160;
              for (let i = 0; i < audioBuffer.length; i += chunkSize) {
                const end = Math.min(i + chunkSize, audioBuffer.length);
                const chunk = audioBuffer.subarray(i, end);
                activeCall.audioBuffer.push(chunk);
              }
            }
            // Anything else just add normally
            else {
              activeCall.audioBuffer.push(audioBuffer);
            }

            // Start audio playback if not already playing
            this.processAudioBuffer(activeCall);
          } catch (error) {
            console.error("Error processing audio packet:", error);
          }
        }

        // Handle text response from OpenAI (for logging and detecting transfer requests)
        if (response.type === "response.audio_transcript.done") {
          console.log("==============AI==============: ", response.transcript);
          // Check for transfer requests in the text
          const text = response.transcript;
          // // if (!activeCall.transferRequested && this.shouldTransferCall(text)) {
          // //   activeCall.transferRequested = true;
          // //   activeCall.transferTarget = this.determineTransferTarget(text);

          // //   // Initiate transfer after a short delay
          // //   setTimeout(() => {
          // //     this.transferCall(activeCall);
          // //   }, 5000);
          // }
        }

        // Handle function calls from OpenAI
        if (response.type === "response.function_call_arguments.done") {
          console.log("Function called:", response);
          const functionName = response.name;
          const args = JSON.parse(response.arguments);

          if (functionName === "end_call") {
            try {
              console.log(`Call end requested by AI. Reason: ${args.reason}`);

              // Check if call is already in the process of ending
              if (activeCall.isEnding) {
                console.log(
                  `Call ${activeCall.id} is already being ended, ignoring duplicate end request`
                );

                // Still send the function output to avoid API errors
                const functionOutputEvent = {
                  type: "conversation.item.create",
                  item: {
                    type: "function_call_output",
                    call_id: response.call_id,
                    output: "Call is already in the process of ending.",
                  },
                };
                openAIWs.send(JSON.stringify(functionOutputEvent));
                return;
              }

              // Mark call as ending
              activeCall.isEnding = true;

              // Send function output back to OpenAI
              const functionOutputEvent = {
                type: "conversation.item.create",
                item: {
                  type: "function_call_output",
                  call_id: response.call_id,
                  output:
                    "Call will be ended. Sending goodbye message to the caller.",
                },
              };
              openAIWs.send(JSON.stringify(functionOutputEvent));

              // Send a goodbye message before ending the call
              const goodbyeMessage =
                "Thank you for calling Unique Tours and Rentals. Have a great day!";
              console.log(`Sending goodbye message: ${goodbyeMessage}`);

              // Create a response with the goodbye message
              const finalResponse = {
                type: "response.create",
                response: {
                  modalities: ["audio", "text"],
                  instructions: `Say goodbye to the caller with this message: ${goodbyeMessage}`,
                },
              };

              openAIWs.send(JSON.stringify(finalResponse));

              // Wait a moment for the goodbye message to be played
              setTimeout(() => {
                console.log("Ending call after goodbye message");
                this.cleanupCall(activeCall);

                // Hang up the call
                if (activeCall.callSession) {
                  activeCall.callSession.hangup();
                  console.log(`Call ${activeCall.id} has been hung up by AI`);
                }
              }, 5000);
            } catch (error) {
              console.error("Error processing end_call function:", error);
            }
          } else if (functionName === "transfer_call") {
            try {
              console.log("Call transfer requested by AI:", args.reason);
              
              // Set transfer properties
              activeCall.transferRequested = true;
              activeCall.transferTarget = AGENTS[0]; // Use the Reservation Team
              
              // Send function output back to OpenAI
              const functionOutputEvent = {
                type: "conversation.item.create",
                item: {
                  type: "function_call_output",
                  call_id: response.call_id,
                  output: `Transfer initiated to ${AGENTS[0].name} (Extension ${AGENTS[0].extensionNumber})`,
                },
              };
              openAIWs.send(JSON.stringify(functionOutputEvent));
              
              // Create a response to inform the caller
              const transferResponse = {
                type: "response.create",
                response: {
                  modalities: ["audio", "text"],
                  instructions: `Inform the caller that you'll be transferring them to our ${AGENTS[0].name}. Be polite and professional.`,
                },
              };
              
              openAIWs.send(JSON.stringify(transferResponse));
              
              // Wait for the goodbye message to be played, then transfer the call
              setTimeout(() => {
                console.log("Transferring call after AI request");
                this.transferCall(activeCall);
              }, 5000); // Wait 5 seconds before transferring
              
            } catch (error) {
              console.error("Error processing transfer_call function:", error);
            }
          } else if (functionName === "collect_guest_info_send_email") {
            try {
              console.log("Guest information collected:", args);

              // Format the data with all required fields
              const formattedInfo = {
                guestName: args.guestName || 'Not provided',
                email: args.email || 'Not provided',
                phoneNumber: activeCall.fromNumber, // Add phone number automatically from call data
                tourType: args.tourType || 'Not provided',
                tourDate: args.tourDate || 'Not provided',
                tourTime: args.tourTime || 'Not provided',
                numberOfGuests: args.numberOfGuests || 'Not provided',
                notes: args.notes || 'None provided'
              };

              // Store the formatted guest information in the active call object
              activeCall.guestInfo = formattedInfo;
              
              console.log("Formatted guest information:", formattedInfo);
              console.log("Phone number added automatically:", activeCall.fromNumber);

              // Send the email with the complete guest information
              sendGuestInfoEmail(formattedInfo)
                .then((success) => {
                  const resultMessage = success
                    ? "Your booking information has been sent successfully. Our team will contact you soon to confirm your reservation."
                    : "I've recorded your booking information, but there was an issue sending the email. Don't worry, our team will still receive your request and contact you soon.";

                  // Send function output back to OpenAI
                  const functionOutputEvent = {
                    type: "conversation.item.create",
                    item: {
                      type: "function_call_output",
                      call_id: response.call_id,
                      role:"system",
                      output: success
                        ? "Guest information collected and email sent successfully."
                        : "Guest information collected but there was an issue sending the email.",
                    },
                  };
                  openAIWs.send(JSON.stringify(functionOutputEvent));

                  // Create a response to inform the caller
                  const infoResponse = {
                    type: "response.create",
                    response: {
                      modalities: ["audio", "text"],
                      instructions: `Thank the guest for providing their information and let them know: ${resultMessage}`,
                    },
                  };

                  openAIWs.send(JSON.stringify(infoResponse));

                  // Wait a moment for the goodbye message to be played, then end the call
                  setTimeout(() => {
                    console.log(
                      "Ending call after sending booking confirmation"
                    );

                    // Mark call as ending to avoid double hangup
                    activeCall.isEnding = true;

                    // Create end call response
                    const endCallResponse = {
                      type: "response.create",
                      response: {
                        modalities: ["audio", "text"],
                        instructions:
                          "Say goodbye and let the caller know you're ending the call after a brief pause.",
                      },
                    };

                    openAIWs.send(JSON.stringify(endCallResponse));

                    // Add a delay before hanging up
                    setTimeout(() => {
                      console.log("Hanging up call after final message");

                      // Only proceed if call is still active
                      if (this.activeCalls.has(activeCall.id)) {
                        this.cleanupCall(activeCall);

                        // Hang up the call
                        if (activeCall.callSession) {
                          activeCall.callSession.hangup();
                          console.log(
                            `Call ${activeCall.id} has been hung up automatically after booking`
                          );
                        }
                      } else {
                        console.log(
                          `Call ${activeCall.id} already ended, skipping automatic hangup`
                        );
                      }
                    }, 10000); // 10 second delay to allow final message to play
                  }, 5000);
                })
                .catch((error) => {
                  console.error("Error in email sending process:", error);

                  // Send function output back to OpenAI
                  const functionOutputEvent = {
                    type: "conversation.item.create",
                    item: {
                      type: "function_call_output",
                      call_id: response.call_id,
                      output:
                        "There was an error processing the guest information.",
                    },
                  };
                  openAIWs.send(JSON.stringify(functionOutputEvent));

                  // Create a response to inform the caller of the error
                  const errorResponse = {
                    type: "response.create",
                    response: {
                      modalities: ["audio", "text"],
                      instructions:
                        "Apologize to the guest for the technical issue and assure them that their information has been recorded. Let them know that our team will contact them soon.",
                    },
                  };

                  openAIWs.send(JSON.stringify(errorResponse));

                  // Wait a moment for the error message to be played, then end the call
                  setTimeout(() => {
                    console.log(
                      "Ending call after sending booking error message"
                    );

                    // Mark call as ending to avoid double hangup
                    activeCall.isEnding = true;

                    // Create end call response
                    const endCallResponse = {
                      type: "response.create",
                      response: {
                        modalities: ["audio", "text"],
                        instructions:
                          "Say goodbye and let the caller know you're ending the call after a brief pause.",
                      },
                    };

                    openAIWs.send(JSON.stringify(endCallResponse));

                    // Add a delay before hanging up
                    setTimeout(() => {
                      console.log("Hanging up call after final error message");

                      // Only proceed if call is still active
                      if (this.activeCalls.has(activeCall.id)) {
                        this.cleanupCall(activeCall);

                        // Hang up the call
                        if (activeCall.callSession) {
                          activeCall.callSession.hangup();
                          console.log(
                            `Call ${activeCall.id} has been hung up automatically after booking error`
                          );
                        }
                      } else {
                        console.log(
                          `Call ${activeCall.id} already ended, skipping automatic hangup`
                        );
                      }
                    }, 10000); // 10 second delay to allow final message to play
                  }, 5000);
                });
            } catch (error) {
              console.error(
                "Error processing collect_guest_info_send_email function:",
                error
              );
            }
          }
        }

        // Also handle function calls from OpenAI via tool_calls (alternative event type)
        if (response.type === "response.tool_calls") {
          console.log("Received tool call from OpenAI:", response.tool_calls);

          // This is a fallback handler in case the function_call_arguments.done event is not triggered
          // The implementation is similar to the one above
        }

        // Handle speech detection events for interruption
        if (response.type === "input_audio_buffer.speech_started") {
          console.log("User started speaking, stopping AI audio playback");
          activeCall.userIsSpeaking = true;
          // Clear the audio playback interval to stop playing AI audio
          if (activeCall.audioPlaybackInterval) {
            clearInterval(activeCall.audioPlaybackInterval);
            activeCall.audioPlaybackInterval = null;
          }
          // Reset audio buffer and mark as not playing
          activeCall.audioBuffer = [];
          activeCall.isPlayingAudio = false;

          // Send cancel signal to OpenAI to stop generating audio
          try {
            const cancelMessage = {
              type: "response.cancel",
            };
            openAIWs.send(JSON.stringify(cancelMessage));
            console.log("Sent response cancel signal to OpenAI");
          } catch (error) {
            console.error("Error sending interrupt signal:", error);
          }
        }

        // Log when speech stops
        if (response.type === "input_audio_buffer.speech_stopped") {
          console.log("User stopped speaking");
          activeCall.userIsSpeaking = false;
        }

        if (
          response.type ===
          "conversation.item.input_audio_transcription.completed"
        ) {
          console.log(
            `==============User===============: ${response.transcript}`
          );
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

    // Transfer call if 0 is pressed
    if (digit === "0") {
      console.log("Transfer to Reservation Team requested via DTMF");
      activeCall.transferRequested = true;
      activeCall.transferTarget = AGENTS[0]; // Reservation Team
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
    // With only one human agent, always return that agent
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
    // If the call is already cleaned up, skip
    if (!this.activeCalls.has(activeCall.id)) {
      console.log(
        `Call ${activeCall.id} is already cleaned up, skipping duplicate cleanup`
      );
      return;
    }

    // Close OpenAI WebSocket if it's open
    if (
      activeCall.openAIWs &&
      activeCall.openAIWs.readyState === WebSocket.OPEN
    ) {
      try {
        activeCall.openAIWs.close(1000, "Call ended normally");
      } catch (err) {
        console.error(
          `Error closing WebSocket for call ${activeCall.id}:`,
          err
        );
      }
    }

    // Clear any audio playback interval
    if (activeCall.audioPlaybackInterval) {
      clearInterval(activeCall.audioPlaybackInterval);
      activeCall.audioPlaybackInterval = null;
    }

    // Remove from active calls
    this.activeCalls.delete(activeCall.id);

    console.log(`Call ${activeCall.id} cleaned up`);
  }

  isBlockedCaller(fromNumber) {
    return BLOCKED_NUMBERS.includes(fromNumber);
  }

  resetOpenAIConnection(activeCall, reason) {
    console.log(
      `Resetting OpenAI connection for call ${activeCall.id}. Reason: ${reason}`
    );

    // Track reconnection attempts
    if (!activeCall.reconnectAttempts) {
      activeCall.reconnectAttempts = 0;
    }

    // Implement exponential backoff for reconnection attempts
    if (activeCall.reconnectAttempts >= 3) {
      console.error(
        `Too many reconnection attempts (${activeCall.reconnectAttempts}) for call ${activeCall.id}, giving up`
      );

      // Inform caller about the technical difficulties
      try {
        const errorMessage =
          "I'm sorry, but we're experiencing some technical difficulties with this call. Please try again later.";
        const errorMessageBuffer = Buffer.from(errorMessage);
        activeCall.callSession.streamAudio(errorMessageBuffer);
      } catch (err) {
        console.error("Error sending technical difficulties message:", err);
      }

      // Clean up the call
      setTimeout(() => this.cleanupCall(activeCall), 5000);
      return;
    }

    // Close existing connection if it's still open
    if (
      activeCall.openAIWs &&
      activeCall.openAIWs.readyState !== WebSocket.CLOSED
    ) {
      try {
        activeCall.openAIWs.close(1000, "Reconnecting");
      } catch (err) {
        console.error("Error closing WebSocket for reconnection:", err);
      }
    }

    // Clear any existing audio playback
    if (activeCall.audioPlaybackInterval) {
      clearInterval(activeCall.audioPlaybackInterval);
      activeCall.audioPlaybackInterval = null;
    }

    // Reset audio buffer
    activeCall.audioBuffer = [];
    activeCall.isPlayingAudio = false;

    // Increment reconnection attempts
    activeCall.reconnectAttempts++;

    // Calculate backoff time (2^attempt * 1000ms)
    const backoffTime = Math.min(
      Math.pow(2, activeCall.reconnectAttempts) * 1000,
      10000
    );
    console.log(
      `Reconnecting in ${backoffTime}ms (attempt ${activeCall.reconnectAttempts})`
    );

    // Let the caller know we're reconnecting
    try {
      const reconnectMessage = "Please hold while I reconnect to our system...";
      const reconnectMessageBuffer = Buffer.from(reconnectMessage);
      activeCall.callSession.streamAudio(reconnectMessageBuffer);
    } catch (err) {
      console.error("Error sending reconnect message:", err);
    }

    // Attempt to reconnect after backoff time
    setTimeout(() => {
      try {
        console.log(
          `Attempting to reconnect OpenAI WebSocket for call ${activeCall.id}`
        );
        this.setupOpenAIRealtime(activeCall);
      } catch (err) {
        console.error("Error in reconnection attempt:", err);
        // If reconnection fails, we'll try again recursively via the error handlers
      }
    }, backoffTime);
  }

  processAudioBuffer(activeCall) {
    const now = Date.now();
    const timeSinceLastPacket = now - activeCall.lastPacketTime;

    // Update last packet time
    activeCall.lastPacketTime = now;

    // If already playing audio, just let the buffer accumulate
    if (activeCall.isPlayingAudio) {
      return;
    }

    // Adaptive buffer size based on network conditions
    // If packets are arriving with large gaps, increase buffer size
    if (
      timeSinceLastPacket > activeCall.packetGapThreshold &&
      activeCall.audioBufferSize < 12
    ) {
      activeCall.audioBufferSize += 1;
      console.log(
        `Increasing buffer size to ${activeCall.audioBufferSize} due to packet delay of ${timeSinceLastPacket}ms`
      );
    }

    // If we have enough audio in the buffer or it's been a while since last packet, start playback
    if (
      activeCall.audioBuffer.length >= activeCall.audioBufferSize ||
      (activeCall.audioBuffer.length > 0 && timeSinceLastPacket > 500)
    ) {
      // Mark as playing
      activeCall.isPlayingAudio = true;

      // Create a consistent playback interval with dynamic timing
      if (!activeCall.audioPlaybackInterval) {
        // Fixed 20ms playback interval for G.711 standards (8000 samples per second = 160 samples per 20ms)
        // This maintains proper timing for standard PCMU frames
        const playbackInterval = 20; // Fixed at 20ms for G.711 standard timing

        console.log(
          `Starting audio playback with ${activeCall.audioBuffer.length} packets at ${playbackInterval}ms intervals`
        );

        activeCall.audioPlaybackInterval = setInterval(() => {
          if (activeCall.audioBuffer.length > 0) {
            try {
              // If user is currently speaking (detected by OpenAI), stop playing audio
              if (activeCall.userIsSpeaking) {
                console.log("User is speaking, pausing AI audio playback");
                return;
              }

              // Get the next audio packet
              const audioPacket = activeCall.audioBuffer.shift();

              // Validate packet size - G.711 standard expects 160 bytes for 20ms of audio at 8kHz
              // If packet is much larger or smaller, it could cause timing issues
              if (audioPacket.length > 0) {
                // Stream to caller with error handling
                activeCall.callSession.streamAudio(audioPacket);

                // No logging of individual audio packets to reduce console noise
              } else {
                console.warn("Skipping empty audio packet");
              }

              // Dynamically adjust buffer size if we have too many packets
              if (
                activeCall.audioBuffer.length > 15 &&
                activeCall.audioBufferSize > 5
              ) {
                activeCall.audioBufferSize -= 1;
                console.log(
                  `Decreasing buffer size to ${activeCall.audioBufferSize} due to buffer overflow`
                );
              }
            } catch (error) {
              console.error("Error streaming audio packet:", error);
            }
          } else {
            // No more audio in buffer, mark as not playing but don't clear interval yet
            activeCall.isPlayingAudio = false;
          }
        }, playbackInterval);
      }
    }
  }

  async readPhoneSettings() {
    try {
      // Ensure we have a fresh login before attempting to get phone settings
      console.log(
        "Performing full login with JWT before fetching phone settings..."
      );
      if (!process.env.RINGCENTRAL_JWT) {
        throw new Error("RINGCENTRAL_JWT environment variable is not set");
      }

      await this.platform.login({ jwt: process.env.RINGCENTRAL_JWT });
      console.log("Login successful, now fetching phone settings");

      // Get device information
      const resp = await this.platform.get(
        "/restapi/v1.0/account/~/extension/~/device"
      );
      const jsonObj = await resp.json();
      console.log(`Found ${jsonObj.records.length} devices`);

      for (const device of jsonObj.records) {
        console.log(`Checking device: ${device.name} (${device.id})`);
        if (device.name === "My SIP Phone") {
          console.log("Found My SIP Phone device, fetching SIP info");
          const sipInfoResp = await this.platform.get(
            `/restapi/v1.0/account/~/device/${device.id}/sip-info`
          );
          const ivrPhone = await sipInfoResp.json();
          console.log("Successfully retrieved SIP phone settings");
          return {
            username: ivrPhone.userName,
            password: ivrPhone.password,
            authorizationId: ivrPhone.authorizationId,
            codec: "PCMU/8000",
          };
        }
      }

      console.error("No My SIP Phone device found in account");
      return null;
    } catch (error) {
      console.error("Failed to read phone settings:", error);
      // Add fallback for testing environments
      if (
        process.env.NODE_ENV === "development" ||
        process.env.MOCK_PHONE_SETTINGS === "true"
      ) {
        console.log("Using mock phone settings for development");
        return {
          username: "mockuser",
          password: "mockpassword",
          authorizationId: "mockauth",
          codec: "PCMU/8000",
        };
      }
      return null;
    }
  }
}
