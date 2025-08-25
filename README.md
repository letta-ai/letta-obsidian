# Letta AI Agent - Obsidian Plugin

A powerful Obsidian plugin that integrates with [Letta](https://letta.com) to provide a stateful AI agent that knows your vault contents and remembers your conversations.

## Features

### Core Functionality
- **Stateful AI Agent**: Uses Letta's persistent memory system for conversation continuity across sessions
- **Automatic Vault Sync**: Automatically syncs your markdown files to Letta with directory structure preservation
- **Real-time Updates**: Auto-syncs file changes when files are created, modified, or deleted
- **Beautiful Chat Interface**: Modal chat UI with support for reasoning displays, tool calls, and rich responses
- **Intelligent File Change Detection**: Only syncs files that have actually changed (compares sizes and timestamps)
- **Directory Structure Preservation**: Encodes folder paths using `__` separators (e.g., `folder__subfolder__file.md`)

### Memory Management
- **Interactive Memory Blocks**: Create, edit, and delete agent memory blocks directly in Obsidian
- **Block Search & Attach**: Search through all available memory blocks and attach them to your agent
- **Visual Memory Editor**: Rich text editor with character counting and real-time updates
- **Conflict Resolution**: Handles memory conflicts with server-side changes gracefully
- **Atomic Operations**: Safe block attachment that preserves existing memory state

### Agent & Project Management
- **Project-Aware Interface**: Display current Letta project context in the chat panel
- **Agent Switching**: Switch between different agents within the same project
- **ADE Integration**: Direct link to Letta's Agent Development Environment (ADE) web interface
- **Agent Configuration**: Full agent setup with system instructions, tools, and memory configuration

### User Experience
- **Flexible Configuration**: Works with both Letta Cloud and self-hosted instances
- **Theme Integration**: Seamlessly matches Obsidian's light/dark theme preferences
- **Responsive Design**: Mobile-friendly interface with adaptive layouts
- **Copy/Paste Support**: Full text selection in chat messages for easy copying

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
- **Project Status**: Current connected project displayed in the header
- **Agent Controls**: Quick access to memory management and ADE

### Managing Agent Memory

1. Click the "Memory" button in the chat header to open the memory management interface
2. **View Memory Blocks**: See all memory blocks currently attached to your agent
3. **Edit Blocks**: Click on any memory block to edit its content with a visual editor
4. **Create New Blocks**: Add new memory blocks with custom labels and descriptions
5. **Search & Attach**: Use "Manage" to search through all available blocks and attach them
6. **Detach/Delete**: Remove blocks from the agent or delete them entirely

### ADE Integration

Click the "ADE" button in the chat header to open your agent in Letta's web-based Agent Development Environment for advanced configuration and debugging.

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
- **LettaChatView**: Sidebar chat interface with rich message display and controls
- **LettaMemoryView**: Memory block management interface with CRUD operations
- **AgentConfigModal**: Agent setup and configuration interface
- **BlockSearchModal**: Search and attach interface for memory blocks
- **LettaSettingTab**: Plugin settings page

## API Integration

The plugin uses Letta's v1 API for:
- **Agent Management**: Create, retrieve, and configure agents
- **Folder Management**: Create folders and attach them to agents
- **File Operations**: Upload, update, and delete vault files
- **Message Streaming**: Real-time chat with reasoning and tool call support
- **Memory Block Operations**: Full CRUD operations for agent memory blocks
- **Block Attachment**: Atomic operations for attaching/detaching memory blocks
- **Project Integration**: Project-aware API calls with proper scoping

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
- Ensure memory blocks are properly attached if using custom memory

### Memory Management Issues

- If memory blocks aren't saving, check the console for API errors
- Memory conflicts may occur if multiple users edit the same agent
- Use the conflict resolution dialog to merge changes safely
- Detached blocks remain available and can be re-attached later

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