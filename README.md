# Letta AI Agent - Obsidian Plugin

A powerful Obsidian plugin that integrates with [Letta](https://letta.com) to provide a stateful AI agent that knows your vault contents and remembers your conversations.

## Features

- **Stateful AI Agent**: Uses Letta's persistent memory system for conversation continuity across sessions
- **Automatic Vault Sync**: Automatically syncs your markdown files to Letta with directory structure preservation
- **Real-time Updates**: Auto-syncs file changes when files are created, modified, or deleted
- **Beautiful Chat Interface**: Modal chat UI with support for reasoning displays, tool calls, and rich responses
- **Intelligent File Change Detection**: Only syncs files that have actually changed (compares sizes and timestamps)
- **Directory Structure Preservation**: Encodes folder paths using `__` separators (e.g., `folder__subfolder__file.md`)
- **Flexible Configuration**: Works with both Letta Cloud and self-hosted instances
- **Agent Customization**: Configure agent behavior, memory blocks, and tool preferences

## Installation

### Manual Installation

1. Download the latest release from the [releases page](https://github.com/cpfiffer/letta-obsidian/releases)
2. Extract the files to your vault's `.obsidian/plugins/letta-ai-agent/` directory
3. Enable the plugin in Obsidian's Community Plugins settings

### Development Installation

1. Clone this repository into your vault's `.obsidian/plugins/` directory:
   ```bash
   git clone https://github.com/cpfiffer/letta-obsidian.git letta-ai-agent
   ```
2. Navigate to the plugin directory and install dependencies:
   ```bash
   cd letta-ai-agent
   npm install
   ```
3. Build the plugin:
   ```bash
   npm run build
   ```
4. Enable the plugin in Obsidian's Community Plugins settings

## Configuration

### Letta Cloud Setup

1. Sign up for [Letta Cloud](https://app.letta.com) and obtain your API key
2. Open Obsidian Settings → Community Plugins → Letta AI Agent
3. Configure the following:
   - **Letta API Key**: Your Letta Cloud API key (`sk-let-...`)
   - **Letta Base URL**: `https://api.letta.com` (default)
   - **Project Slug**: Your Letta project identifier
   - **Agent Name**: Display name for your AI agent
   - **Source Name**: Name for the Letta source containing your vault files

### Self-Hosted Letta Setup

1. Set up your own [Letta instance](https://docs.letta.com/install)
2. Configure the plugin with:
   - **Letta API Key**: Leave empty if your instance doesn't require authentication
   - **Letta Base URL**: Your Letta instance URL (e.g., `http://localhost:8283`)
   - **Project Slug**: Not required for self-hosted instances
   - **Agent Name**: Display name for your AI agent
   - **Source Name**: Name for the Letta source containing your vault files

### Sync Settings

- **Auto Sync**: Automatically sync file changes as you edit (recommended)
- **Sync on Startup**: Sync all vault files when Obsidian starts

## Usage

### Initial Setup

1. Configure your API connection in settings
2. Click "Connect to Letta" to establish the connection
3. If no agent exists, you'll be prompted to configure a new one with:
   - Agent type (MemGPT, ReAct, etc.)
   - System instructions and behavior
   - Tool configurations
   - Memory block settings

### Chatting with Your Agent

1. Click the chat bubble icon in the ribbon, or
2. Use the command palette: "Open Letta Chat", or
3. Use the hotkey (if configured)

The chat interface displays:
- **User messages**: Your questions and requests
- **Agent reasoning**: Internal thought processes (when available)
- **Tool calls**: Actions the agent takes
- **Tool results**: Results from agent actions
- **Assistant responses**: The agent's replies to you

### File Synchronization

The plugin automatically:
- Uploads new markdown files to Letta
- Updates changed files (based on size and modification time)
- Removes deleted files from Letta
- Preserves your vault's directory structure

You can also manually sync using:
- The "Sync Vault" command in the command palette
- The "Sync Now" button in settings

## Development

### Prerequisites

- Node.js v16 or higher
- npm or yarn

### Development Commands

- **Start development**: `npm run dev` - Compiles TypeScript and watches for changes
- **Build for production**: `npm run build` - Type checks and builds production bundle
- **Install dependencies**: `npm install` - Installs required packages

### Project Structure

```
├── main.ts              # Main plugin logic and API integration
├── styles.css           # Chat interface and modal styling
├── manifest.json        # Plugin metadata
├── package.json         # Dependencies and scripts
└── README.md           # This file
```

### Key Components

- **LettaPlugin**: Main plugin class with connection and sync logic
- **LettaChatModal**: Chat interface modal with rich message display
- **AgentConfigModal**: Agent setup and configuration interface
- **LettaSettingTab**: Plugin settings page

## API Integration

The plugin uses Letta's v1 API for:
- **Agent Management**: Create, retrieve, and configure agents
- **Source Management**: Create sources and attach them to agents
- **File Operations**: Upload, update, and delete vault files
- **Message Streaming**: Real-time chat with reasoning and tool call support

## Troubleshooting

### Connection Issues

- Verify your API key and base URL are correct
- Check that your Letta instance is running and accessible
- For self-hosted instances, ensure the API endpoints are available

### File Upload Problems

- Check the plugin console logs for detailed error messages
- Verify your source exists and is attached to the agent
- Ensure you have proper permissions for file operations

### Chat Not Working

- Confirm your agent is created and connected
- Check that the source is properly attached to the agent
- Verify your vault files have been synced to Letta

## Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Support

- **Issues**: Report bugs on the [GitHub Issues page](https://github.com/cpfiffer/letta-obsidian/issues)
- **Documentation**: Visit the [Letta documentation](https://docs.letta.com)
- **Community**: Join the [Letta Discord](https://discord.gg/letta) for community support

## Acknowledgments

- Built on the [Letta](https://letta.com) platform for stateful AI agents
- Uses the [Obsidian Plugin API](https://docs.obsidian.md/Plugins)
- Inspired by the need for AI agents that truly understand and remember your knowledge base