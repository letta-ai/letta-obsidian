import { 
	App, 
	Editor, 
	MarkdownView, 
	Modal, 
	Notice, 
	Plugin, 
	PluginSettingTab, 
	Setting,
	TFile,
	requestUrl
} from 'obsidian';

interface LettaPluginSettings {
	lettaApiKey: string;
	lettaBaseUrl: string;
	lettaProjectSlug: string;
	agentName: string;
	sourceName: string;
	autoSync: boolean;
	syncOnStartup: boolean;
}

const DEFAULT_SETTINGS: LettaPluginSettings = {
	lettaApiKey: '',
	lettaBaseUrl: 'https://api.letta.com',
	lettaProjectSlug: 'obsidian-vault',
	agentName: 'Obsidian Assistant',
	sourceName: 'obsidian-vault-files',
	autoSync: true,
	syncOnStartup: true
}

interface LettaAgent {
	id: string;
	name: string;
}

interface LettaSource {
	id: string;
	name: string;
}

interface LettaMessage {
	message_type: string;
	content?: string;
	reasoning?: string;
	tool_call?: any;
	tool_return?: any;
}

export default class LettaPlugin extends Plugin {
	settings: LettaPluginSettings;
	agent: LettaAgent | null = null;
	source: LettaSource | null = null;
	statusBarItem: HTMLElement | null = null;

	async onload() {
		await this.loadSettings();

		// Add ribbon icon for chat
		this.addRibbonIcon('message-circle', 'Chat with Letta Agent', (evt: MouseEvent) => {
			this.openChatModal();
		});

		// Add status bar
		this.statusBarItem = this.addStatusBarItem();
		this.updateStatusBar('Disconnected');

		// Add commands
		this.addCommand({
			id: 'open-letta-chat',
			name: 'Open Letta Chat',
			callback: () => {
				this.openChatModal();
			}
		});

		this.addCommand({
			id: 'sync-vault-to-letta',
			name: 'Sync Vault to Letta',
			callback: async () => {
				await this.syncVaultToLetta();
			}
		});

		this.addCommand({
			id: 'connect-to-letta',
			name: 'Connect to Letta',
			callback: async () => {
				await this.connectToLetta();
			}
		});

		// Add settings tab
		this.addSettingTab(new LettaSettingTab(this.app, this));

		// Auto-connect on startup if configured
		if (this.settings.lettaApiKey && this.settings.syncOnStartup) {
			await this.connectToLetta();
		}

		// Auto-sync on file changes if configured
		if (this.settings.autoSync) {
			this.registerEvent(
				this.app.vault.on('create', (file) => {
					if (file instanceof TFile) {
						this.onFileChange(file);
					}
				}),
			);
			this.registerEvent(
				this.app.vault.on('modify', (file) => {
					if (file instanceof TFile) {
						this.onFileChange(file);
					}
				}),
			);
			this.registerEvent(
				this.app.vault.on('delete', (file) => {
					if (file instanceof TFile) {
						this.onFileDelete(file);
					}
				}),
			);
		}
	}

	onunload() {
		this.agent = null;
		this.source = null;
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	updateStatusBar(status: string) {
		if (this.statusBarItem) {
			this.statusBarItem.setText(`Letta: ${status}`);
		}
	}

	private async makeRequest(path: string, options: any = {}) {
		const url = `${this.settings.lettaBaseUrl}${path}`;
		const headers: any = {
			'Content-Type': 'application/json',
			...options.headers
		};

		// Only add Authorization header if API key is provided
		if (this.settings.lettaApiKey) {
			headers['Authorization'] = `Bearer ${this.settings.lettaApiKey}`;
		}

		// Debug logging
		console.log(`[Letta Plugin] Making ${options.method || 'GET'} request to: ${url}`);
		console.log(`[Letta Plugin] Headers:`, headers);
		if (options.body) {
			console.log(`[Letta Plugin] Request body:`, options.body);
		}

		try {
			const response = await requestUrl({
				url,
				method: options.method || 'GET',
				headers,
				body: options.body ? JSON.stringify(options.body) : undefined,
				throw: false
			});

			// Debug logging for response
			console.log(`[Letta Plugin] Response status: ${response.status}`);
			console.log(`[Letta Plugin] Response headers:`, response.headers);
			console.log(`[Letta Plugin] Response text:`, response.text);
			if (response.json) {
				console.log(`[Letta Plugin] Response JSON:`, response.json);
			}

			if (response.status >= 400) {
				let errorMessage = `HTTP ${response.status}: ${response.text}`;
				
				console.log(`[Letta Plugin] Error response for path ${path}:`, {
					status: response.status,
					text: response.text,
					headers: response.headers
				});
				
				if (response.status === 404) {
					if (path === '/v1/models/embedding') {
						errorMessage = 'Cannot connect to Letta API. Please verify:\n• Base URL is correct\n• Letta service is running\n• Network connectivity is available';
					} else if (path.includes('/v1/sources')) {
						errorMessage = 'Source not found. This may indicate:\n• Invalid project configuration\n• Missing permissions\n• Source was deleted externally';
					} else if (path.includes('/v1/agents')) {
						errorMessage = 'Agent not found. This may indicate:\n• Invalid project configuration\n• Missing permissions\n• Agent was deleted externally';
					} else if (path.includes('/v1/models/embedding')) {
						errorMessage = 'Embedding models endpoint not found. This may indicate:\n• Outdated Letta API version\n• Server configuration issue\n• Invalid base URL';
					} else {
						errorMessage = `Endpoint not found (${path}). This may indicate:\n• Incorrect base URL configuration\n• Outdated plugin version\n• API endpoint has changed`;
					}
				} else if (response.status === 401) {
					const isCloudInstance = this.settings.lettaBaseUrl.includes('api.letta.com');
					if (isCloudInstance && !this.settings.lettaApiKey) {
						errorMessage = 'Authentication required for Letta Cloud. Please provide an API key in settings.';
					} else if (!this.settings.lettaApiKey) {
						errorMessage = 'Authentication failed. If using a self-hosted instance with auth enabled, please provide an API key in settings.';
					} else {
						errorMessage = 'Authentication failed. Please verify your API key is correct and has proper permissions.';
					}
				}
				
				console.log(`[Letta Plugin] Enhanced error message: ${errorMessage}`);
				throw new Error(errorMessage);
			}

			return response.json;
		} catch (error: any) {
			console.log(`[Letta Plugin] Caught exception:`, error);
			console.log(`[Letta Plugin] Exception type:`, error.constructor.name);
			console.log(`[Letta Plugin] Exception message:`, error.message);
			console.log(`[Letta Plugin] Exception stack:`, error.stack);
			
			// Check if this is a network/connection error that might indicate the same issues as a 404
			if (error.message && (error.message.includes('fetch') || error.message.includes('network') || error.message.includes('ECONNREFUSED'))) {
				console.log(`[Letta Plugin] Detected network error for path: ${path}`);
				if (path === '/v1/models/embedding') {
					const enhancedError = new Error('Cannot connect to Letta API. Please verify:\n• Base URL is correct\n• Letta service is running\n• Network connectivity is available');
					console.error('[Letta Plugin] Enhanced network error:', enhancedError);
					throw enhancedError;
				}
			}
			
			console.error('[Letta Plugin] Letta API request failed:', error);
			throw error;
		}
	}

	async connectToLetta(): Promise<boolean> {
		const isCloudInstance = this.settings.lettaBaseUrl.includes('api.letta.com');
		
		console.log(`[Letta Plugin] Starting connection to Letta...`);
		console.log(`[Letta Plugin] Base URL: ${this.settings.lettaBaseUrl}`);
		console.log(`[Letta Plugin] Is cloud instance: ${isCloudInstance}`);
		console.log(`[Letta Plugin] Has API key: ${!!this.settings.lettaApiKey}`);
		
		if (isCloudInstance && !this.settings.lettaApiKey) {
			console.log(`[Letta Plugin] Cloud instance detected but no API key provided`);
			new Notice('API key required for Letta Cloud. Please configure it in settings.');
			return false;
		}

		try {
			this.updateStatusBar('Connecting...');
			
			console.log(`[Letta Plugin] Testing connection with /v1/models/embedding endpoint...`);
			// Test connection by trying to list embedding models (this endpoint should exist)
			await this.makeRequest('/v1/models/embedding');

			console.log(`[Letta Plugin] Connection test successful, setting up source...`);
			// Setup source and agent
			await this.setupSource();
			
			console.log(`[Letta Plugin] Source setup successful, setting up agent...`);
			await this.setupAgent();

			console.log(`[Letta Plugin] Agent setup successful, connection complete!`);
			this.updateStatusBar('Connected');
			new Notice('Successfully connected to Letta');

			// Sync vault on startup if configured
			if (this.settings.syncOnStartup) {
				console.log(`[Letta Plugin] Starting vault sync...`);
				await this.syncVaultToLetta();
			}

			return true;
		} catch (error: any) {
			console.error('[Letta Plugin] Failed to connect to Letta:', error);
			console.error('[Letta Plugin] Error details:', {
				message: error.message,
				stack: error.stack,
				name: error.name
			});
			this.updateStatusBar('Error');
			new Notice(`Failed to connect to Letta: ${error.message}`);
			return false;
		}
	}

	async setupSource(): Promise<void> {
		try {
			// Try to get existing source
			const sources = await this.makeRequest('/v1/sources');
			const existingSource = sources.find((s: any) => s.name === this.settings.sourceName);
			
			if (existingSource) {
				this.source = { id: existingSource.id, name: existingSource.name };
			} else {
				// Create new source
				const embeddingConfigs = await this.makeRequest('/v1/models/embedding');
				const embeddingConfig = embeddingConfigs[0];

				const newSource = await this.makeRequest('/v1/sources', {
					method: 'POST',
					body: {
						name: this.settings.sourceName,
						embedding_config: embeddingConfig,
						instructions: "A collection of markdown files from an Obsidian vault. Directory structure is preserved in filenames using '__' as path separators."
					}
				});

				this.source = { id: newSource.id, name: newSource.name };
			}
		} catch (error) {
			console.error('Failed to setup source:', error);
			throw error;
		}
	}

	async setupAgent(): Promise<void> {
		if (!this.source) throw new Error('Source not set up');

		try {
			// Try to get existing agent
			const agents = await this.makeRequest('/v1/agents');
			const existingAgent = agents.find((a: any) => a.name === this.settings.agentName);
			
			if (existingAgent) {
				this.agent = { id: existingAgent.id, name: existingAgent.name };
			} else {
				// Create new agent
				const isCloudInstance = this.settings.lettaBaseUrl.includes('api.letta.com');
				const agentBody: any = {
					name: this.settings.agentName
				};

				// Only include project for cloud instances
				if (isCloudInstance) {
					agentBody.project = this.settings.lettaProjectSlug;
				}

				const newAgent = await this.makeRequest('/v1/agents', {
					method: 'POST',
					body: agentBody
				});

				this.agent = { id: newAgent.id, name: newAgent.name };
			}

			// Attach source to agent
			await this.makeRequest(`/v1/agents/${this.agent.id}/sources/${this.source.id}`, {
				method: 'POST'
			});

		} catch (error) {
			console.error('Failed to setup agent:', error);
			throw error;
		}
	}

	encodeFilePath(path: string): string {
		return path.replace(/[\/\\]/g, '__');
	}

	decodeFilePath(encodedPath: string): string {
		return encodedPath.replace(/__/g, '/');
	}

	async syncVaultToLetta(): Promise<void> {
		if (!this.source) {
			new Notice('Please connect to Letta first');
			return;
		}

		try {
			this.updateStatusBar('Syncing...');
			
			// Get existing files from Letta
			const existingFiles = await this.makeRequest(`/v1/sources/${this.source.id}/files`);
			const existingFilesMap = new Map();
			existingFiles.forEach((file: any) => {
				existingFilesMap.set(file.file_name, file);
			});

			// Get all markdown files from vault
			const vaultFiles = this.app.vault.getMarkdownFiles();
			let uploadCount = 0;
			let skipCount = 0;

			for (const file of vaultFiles) {
				const encodedPath = this.encodeFilePath(file.path);
				const existingFile = existingFilesMap.get(encodedPath);
				
				let shouldUpload = true;

				if (existingFile) {
					// Compare file sizes and modification times
					const localFileSize = file.stat.size;

					if (existingFile.file_size === localFileSize) {
						// If sizes match, compare modification times
						const localMtime = file.stat.mtime;
						const existingMtime = existingFile.updated_at ? 
							new Date(existingFile.updated_at).getTime() : 0;

						if (localMtime <= existingMtime) {
							shouldUpload = false;
							skipCount++;
						}
					}

					if (shouldUpload) {
						// Delete existing file to avoid duplicates
						await this.makeRequest(`/v1/sources/${this.source.id}/files/${existingFile.id}`, {
							method: 'DELETE'
						});
					}
				}

				if (shouldUpload) {
					const content = await this.app.vault.read(file);
					
					await this.makeRequest(`/v1/sources/${this.source.id}/files`, {
						method: 'POST',
						headers: {
							'Content-Type': 'multipart/form-data'
						},
						body: {
							file: content,
							file_name: encodedPath
						}
					});
					uploadCount++;
				}
			}

			this.updateStatusBar('Connected');
			new Notice(`Sync complete: ${uploadCount} files uploaded, ${skipCount} files skipped`);

		} catch (error: any) {
			console.error('Failed to sync vault:', error);
			this.updateStatusBar('Error');
			new Notice(`Sync failed: ${error.message}`);
		}
	}

	async onFileChange(file: TFile): Promise<void> {
		if (!file.path.endsWith('.md') || !this.source) {
			return;
		}

		try {
			const encodedPath = this.encodeFilePath(file.path);
			const content = await this.app.vault.read(file);

			// Delete existing file if it exists
			try {
				const existingFiles = await this.makeRequest(`/v1/sources/${this.source.id}/files`);
				const existingFile = existingFiles.find((f: any) => f.file_name === encodedPath);
				if (existingFile) {
					await this.makeRequest(`/v1/sources/${this.source.id}/files/${existingFile.id}`, {
						method: 'DELETE'
					});
				}
			} catch (error) {
				// File might not exist, continue with upload
			}

			await this.makeRequest(`/v1/sources/${this.source.id}/files`, {
				method: 'POST',
				headers: {
					'Content-Type': 'multipart/form-data'
				},
				body: {
					file: content,
					file_name: encodedPath
				}
			});

		} catch (error) {
			console.error('Failed to sync file change:', error);
		}
	}

	async onFileDelete(file: TFile): Promise<void> {
		if (!file.path.endsWith('.md') || !this.source) {
			return;
		}

		try {
			const encodedPath = this.encodeFilePath(file.path);
			const existingFiles = await this.makeRequest(`/v1/sources/${this.source.id}/files`);
			const existingFile = existingFiles.find((f: any) => f.file_name === encodedPath);
			
			if (existingFile) {
				await this.makeRequest(`/v1/sources/${this.source.id}/files/${existingFile.id}`, {
					method: 'DELETE'
				});
			}
		} catch (error) {
			console.error('Failed to delete file from Letta:', error);
		}
	}

	openChatModal(): void {
		if (!this.agent) {
			new Notice('Please connect to Letta first');
			return;
		}

		new LettaChatModal(this.app, this).open();
	}

	async sendMessageToAgent(message: string): Promise<LettaMessage[]> {
		if (!this.agent) throw new Error('Agent not connected');

		const response = await this.makeRequest(`/v1/agents/${this.agent.id}/messages`, {
			method: 'POST',
			body: {
				messages: [{
					role: "user",
					content: [{ text: message }]
				}]
			}
		});

		return response.messages || [];
	}
}

class LettaChatModal extends Modal {
	plugin: LettaPlugin;
	chatContainer: HTMLElement;
	inputContainer: HTMLElement;
	messageInput: HTMLTextAreaElement;
	sendButton: HTMLButtonElement;

	constructor(app: App, plugin: LettaPlugin) {
		super(app);
		this.plugin = plugin;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('letta-chat-modal');

		// Header
		const header = contentEl.createEl('div', { cls: 'letta-chat-header' });
		header.createEl('h2', { text: `Chat with ${this.plugin.settings.agentName}` });
		header.createEl('p', { 
			text: `Connected to: ${this.plugin.settings.sourceName}`,
			cls: 'letta-chat-subtitle' 
		});

		// Chat container
		this.chatContainer = contentEl.createEl('div', { cls: 'letta-chat-container' });
		
		// Input container
		this.inputContainer = contentEl.createEl('div', { cls: 'letta-input-container' });
		
		this.messageInput = this.inputContainer.createEl('textarea', {
			cls: 'letta-message-input',
			attr: { placeholder: 'Ask me anything about your vault...' }
		});

		this.sendButton = this.inputContainer.createEl('button', {
			text: 'Send',
			cls: 'letta-send-button'
		});

		// Event listeners
		this.sendButton.addEventListener('click', () => this.sendMessage());
		
		this.messageInput.addEventListener('keydown', (evt) => {
			if (evt.key === 'Enter' && !evt.shiftKey) {
				evt.preventDefault();
				this.sendMessage();
			}
		});

		// Focus input
		this.messageInput.focus();

		// Add welcome message
		this.addMessage('assistant', 'Hello! I\'m your Letta AI agent. I have access to your vault contents and can help you explore, organize, and work with your notes. What would you like to know?');
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}

	addMessage(type: 'user' | 'assistant' | 'reasoning' | 'tool-call' | 'tool-result', content: string, title?: string) {
		const messageEl = this.chatContainer.createEl('div', { 
			cls: `letta-message letta-message-${type}` 
		});

		if (title) {
			messageEl.createEl('div', { cls: 'letta-message-title', text: title });
		}

		const contentEl = messageEl.createEl('div', { cls: 'letta-message-content' });
		
		// Handle different content types
		if (type === 'tool-call' || type === 'tool-result') {
			contentEl.createEl('pre', { text: content });
		} else {
			// Simple markdown-like formatting
			const formattedContent = content
				.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
				.replace(/\*(.*?)\*/g, '<em>$1</em>')
				.replace(/`([^`]+)`/g, '<code>$1</code>');
			contentEl.innerHTML = formattedContent;
		}

		// Scroll to bottom
		this.chatContainer.scrollTop = this.chatContainer.scrollHeight;
	}

	async sendMessage() {
		const message = this.messageInput.value.trim();
		if (!message) return;

		// Disable input while processing
		this.messageInput.disabled = true;
		this.sendButton.disabled = true;
		this.sendButton.textContent = 'Sending...';

		// Add user message to chat
		this.addMessage('user', message);

		// Clear input
		this.messageInput.value = '';

		try {
			const messages = await this.plugin.sendMessageToAgent(message);

			// Process response messages
			for (const responseMessage of messages) {
				switch (responseMessage.message_type) {
					case 'reasoning_message':
						if (responseMessage.reasoning) {
							this.addMessage('reasoning', responseMessage.reasoning, '🧠 Agent Reasoning');
						}
						break;
					case 'tool_call_message':
						if (responseMessage.tool_call) {
							this.addMessage('tool-call', JSON.stringify(responseMessage.tool_call, null, 2), '🔧 Tool Call');
						}
						break;
					case 'tool_return_message':
						if (responseMessage.tool_return) {
							this.addMessage('tool-result', JSON.stringify(responseMessage.tool_return, null, 2), '📊 Tool Result');
						}
						break;
					case 'assistant_message':
						if (responseMessage.content) {
							this.addMessage('assistant', responseMessage.content);
						}
						break;
				}
			}

		} catch (error: any) {
			console.error('Failed to send message:', error);
			this.addMessage('assistant', `Error: ${error.message}`);
		} finally {
			// Re-enable input
			this.messageInput.disabled = false;
			this.sendButton.disabled = false;
			this.sendButton.textContent = 'Send';
			this.messageInput.focus();
		}
	}
}

class LettaSettingTab extends PluginSettingTab {
	plugin: LettaPlugin;

	constructor(app: App, plugin: LettaPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl('h2', { text: 'Letta AI Agent Settings' });

		// API Configuration
		containerEl.createEl('h3', { text: 'API Configuration' });

		new Setting(containerEl)
			.setName('Letta API Key')
			.setDesc('Your Letta API key for authentication')
			.addText(text => text
				.setPlaceholder('sk-let-...')
				.setValue(this.plugin.settings.lettaApiKey)
				.onChange(async (value) => {
					this.plugin.settings.lettaApiKey = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Letta Base URL')
			.setDesc('Base URL for Letta API')
			.addText(text => text
				.setPlaceholder('https://api.letta.com')
				.setValue(this.plugin.settings.lettaBaseUrl)
				.onChange(async (value) => {
					this.plugin.settings.lettaBaseUrl = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Project Slug')
			.setDesc('Letta project identifier')
			.addText(text => text
				.setPlaceholder('obsidian-vault')
				.setValue(this.plugin.settings.lettaProjectSlug)
				.onChange(async (value) => {
					this.plugin.settings.lettaProjectSlug = value;
					await this.plugin.saveSettings();
				}));

		// Agent Configuration
		containerEl.createEl('h3', { text: 'Agent Configuration' });

		new Setting(containerEl)
			.setName('Agent Name')
			.setDesc('Name for your AI agent')
			.addText(text => text
				.setPlaceholder('Obsidian Assistant')
				.setValue(this.plugin.settings.agentName)
				.onChange(async (value) => {
					this.plugin.settings.agentName = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Source Name')
			.setDesc('Name for the Letta source containing your vault')
			.addText(text => text
				.setPlaceholder('obsidian-vault-files')
				.setValue(this.plugin.settings.sourceName)
				.onChange(async (value) => {
					this.plugin.settings.sourceName = value;
					await this.plugin.saveSettings();
				}));

		// Sync Configuration
		containerEl.createEl('h3', { text: 'Sync Configuration' });

		new Setting(containerEl)
			.setName('Auto Sync')
			.setDesc('Automatically sync file changes to Letta')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.autoSync)
				.onChange(async (value) => {
					this.plugin.settings.autoSync = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Sync on Startup')
			.setDesc('Sync vault to Letta when Obsidian starts')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.syncOnStartup)
				.onChange(async (value) => {
					this.plugin.settings.syncOnStartup = value;
					await this.plugin.saveSettings();
				}));

		// Actions
		containerEl.createEl('h3', { text: 'Actions' });

		new Setting(containerEl)
			.setName('Connect to Letta')
			.setDesc('Test connection and setup agent')
			.addButton(button => button
				.setButtonText('Connect')
				.setCta()
				.onClick(async () => {
					await this.plugin.connectToLetta();
				}));

		new Setting(containerEl)
			.setName('Sync Vault')
			.setDesc('Manually sync all vault files to Letta')
			.addButton(button => button
				.setButtonText('Sync Now')
				.onClick(async () => {
					await this.plugin.syncVaultToLetta();
				}));
	}
}