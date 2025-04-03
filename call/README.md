# RingCentral Call Automation with OpenAI Realtime API

This project implements an automated call handling system using RingCentral's API and OpenAI's Realtime API. It provides automated responses to customer inquiries and can transfer calls to human agents when needed.

## Features

- Automated voice responses using OpenAI's Realtime API
- Real-time speech-to-text and text-to-speech processing
- Call transfer to appropriate departments based on customer requests
- DTMF tone detection for keypad-based interactions
- Blocked number filtering

## Prerequisites

- Node.js (v16 or higher)
- pnpm package manager
- RingCentral developer account with API credentials
- OpenAI API key with access to the Realtime API

## Installation

1. Clone the repository
2. Install dependencies:
   ```
   pnpm install
   ```
3. Copy the `.env.example` file to `.env` and fill in your credentials:
   ```
   cp .env.example .env
   ```

## Configuration

Edit the `.env` file with your specific credentials:

```
# RingCentral API Credentials
RINGCENTRAL_SERVER_URL=https://platform.ringcentral.com
RINGCENTRAL_CLIENT_ID=your_ringcentral_client_id
RINGCENTRAL_CLIENT_SECRET=your_ringcentral_client_secret
RINGCENTRAL_JWT=your_ringcentral_jwt_token

# OpenAI API Credentials
OPENAI_API_KEY=your_openai_api_key

# Voice Configuration
OPENAI_VOICE=alloy
SYSTEM_PROMPT_FILE=./prompts/call-prompt.js

# Server Configuration
PORT=3000
```

## Usage

Start the application:

```
pnpm start
```

For development with auto-restart:

```
pnpm dev
```

## How It Works

1. The application registers a softphone with RingCentral
2. When a call is received, it's automatically answered
3. Audio from the caller is streamed to OpenAI's Realtime API
4. OpenAI processes the audio and generates appropriate responses
5. The responses are streamed back to the caller
6. If a transfer is requested or detected, the call is transferred to the appropriate department

## Customization

You can customize the system prompt by editing the file in `prompts/call-prompt.js`. This prompt determines how the AI assistant responds to callers.

## License

ISC
