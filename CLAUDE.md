# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with this Obsidian plugin.

## Project Overview
This is a Letta AI Agent plugin for Obsidian that allows users to chat with a stateful AI agent that knows their vault contents and remembers conversations. The plugin automatically syncs vault files to Letta and provides an integrated chat interface within Obsidian.

## Key Features
- **Stateful AI Agent**: Uses Letta's persistent memory system for conversation continuity
- **Automatic Vault Sync**: Syncs markdown files to Letta with directory structure preservation
- **Real-time Updates**: Auto-syncs file changes when files are created, modified, or deleted
- **Chat Interface**: Beautiful modal chat UI with support for reasoning, tool calls, and responses
- **File Change Detection**: Only syncs files that have actually changed (compares sizes and timestamps)
- **Directory Structure Preservation**: Encodes paths using `__` separators (e.g., `folder__subfolder__file.md`)

## Development Commands
- **Start development**: `npm run dev` - Compiles TypeScript and watches for changes
- **Build for production**: `npm run build` - Type checks and builds production bundle
- **Install dependencies**: `npm install` - Installs letta-client and dev dependencies

## Code Architecture

### Main Plugin Classes
- **LettaPlugin**: Main plugin class extending Obsidian's Plugin
- **LettaChatModal**: Modal dialog for the chat interface
- **LettaSettingTab**: Settings configuration page

### Key Components
1. **Letta Client Integration**: Handles API communication with Letta service
2. **File Sync System**: Manages uploading and updating vault files to Letta
3. **Chat Interface**: Rich modal dialog with message history and real-time responses
4. **Settings Management**: Configurable API keys, agent names, and sync behavior

### Plugin Lifecycle
- `onload()`: Initialize Letta connection, setup file watchers, create UI elements
- `onunload()`: Clean up connections and resources
- Settings are persisted using Obsidian's `loadData()`/`saveData()` methods

### File Sync Logic
- Watches for file create/modify/delete events in the vault
- Compares local file modification times with Letta's `updated_at` timestamps
- Only uploads files that have changed to minimize API calls
- Preserves directory structure by encoding paths in filenames

### Chat System
- Displays different message types (user, assistant, reasoning, tool calls)
- Real-time streaming of agent responses
- Handles errors gracefully with user feedback
- Maintains conversation history within the modal session

## Configuration
The plugin requires these settings:
- **Letta API Key**: Authentication token for Letta service
- **Project Slug**: Letta project identifier
- **Template ID**: Agent template to use (default: `obsidian-agent:latest`)
- **Agent Name**: Display name for the AI agent
- **Source Name**: Name for the Letta source containing vault files
- **Auto Sync**: Toggle for automatic file synchronization
- **Sync on Startup**: Whether to sync all files when Obsidian starts

## Usage Patterns
1. **Initial Setup**: Configure API key and connection settings
2. **First Sync**: Run manual sync to upload all vault files
3. **Chat Interaction**: Use ribbon icon or command palette to open chat
4. **Automatic Updates**: Files sync automatically as you edit them
5. **Agent Memory**: Agent remembers context across conversation sessions

## File Structure
- `main.ts`: Core plugin logic and API integration
- `styles.css`: Chat interface styling with dark/light theme support
- `manifest.json`: Plugin metadata and compatibility info
- `package.json`: Dependencies including letta-client

## API Integration
The plugin uses the official `letta-client` package for:
- Agent management (create, retrieve, message)
- Source management (create, attach to agent)
- File operations (upload, delete, list with metadata)
- Message streaming with support for reasoning and tool calls

## Error Handling
- Graceful connection failures with user notifications
- Retry logic for temporary network issues
- Fallback behaviors when Letta service is unavailable
- Clear error messages in both console and UI

## Security Considerations
- API keys are stored securely in Obsidian's data directory
- No sensitive vault content is logged to console
- File uploads use secure HTTPS endpoints
- User can control which files are synced via auto-sync toggle