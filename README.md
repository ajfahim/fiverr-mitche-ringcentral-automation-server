# RingCentral Automation Server

A comprehensive automation solution for handling RingCentral calls and SMS messages using OpenAI's Realtime API.

## Overview

This project provides an automated system for managing both voice calls and SMS messages through RingCentral's platform. It leverages OpenAI's advanced AI capabilities to deliver natural, context-aware responses to customer inquiries without human intervention, with the ability to transfer to human agents when necessary.

## Features

### Call Automation
- Automated voice responses using OpenAI's Realtime API
- Real-time speech-to-text and text-to-speech processing
- Call transfer to appropriate departments based on customer requests
- DTMF tone detection for keypad-based interactions
- Blocked number filtering

### SMS Automation
- Automated SMS responses using OpenAI
- Conversation context management
- Intelligent routing and escalation
- Multi-language support
- Analytics and reporting

## Project Structure

The project is organized into two main modules:

- `/call` - Contains all functionality related to voice call automation
- `/sms` - Contains all functionality related to SMS message automation

Each module can be configured and run independently.

## Prerequisites

- Node.js (v16 or higher)
- pnpm package manager
- RingCentral developer account with API credentials
- OpenAI API key with access to the Realtime API

## Installation

1. Clone the repository:
   ```
   git clone https://github.com/yourusername/ringcentral-automation-server.git
   cd ringcentral-automation-server
   ```

2. Install dependencies for both modules:
   ```
   cd call && pnpm install
   cd ../sms && pnpm install
   ```

3. Configure environment variables:
   ```
   cp call/.env.example call/.env
   cp sms/.env.example sms/.env
   ```

4. Edit the `.env` files in both directories with your RingCentral and OpenAI credentials.

## Configuration

### Call Module Configuration

Edit the `call/.env` file with your specific credentials:

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

### SMS Module Configuration

Edit the `sms/.env` file with similar credentials, adjusted for SMS functionality.

## Usage

### Starting the Call Automation Service

```
cd call
pnpm start
```

### Starting the SMS Automation Service

```
cd sms
pnpm start
```

For development with auto-restart:

```
pnpm dev
```

## How It Works

### Call Flow
1. The application registers a softphone with RingCentral
2. When a call is received, it's automatically answered
3. Audio from the caller is streamed to OpenAI's Realtime API
4. OpenAI processes the audio and generates appropriate responses
5. The responses are streamed back to the caller
6. If a transfer is requested or detected, the call is transferred to the appropriate department

### SMS Flow
1. Incoming SMS messages are received via RingCentral webhooks
2. Messages are processed by the OpenAI API
3. Contextual responses are generated based on message content
4. Responses are sent back through RingCentral's SMS API
5. Complex inquiries can be escalated to human agents

## Customization

You can customize the system prompts by editing:
- Call prompts: `call/prompts/call-prompt.js`
- SMS prompts: `sms/sms-prompt.js`

These prompts determine how the AI assistant responds to users.

## Development Roadmap

See [ROADMAP.md](sms/ROADMAP.md) for the current development status and upcoming features.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

ISC

## Support

For support, please contact [your-email@example.com](mailto:your-email@example.com).
