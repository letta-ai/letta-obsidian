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

interface AgentConfig {
	name: string;
	system?: string;
	agent_type?: 'memgpt_agent' | 'memgpt_v2_agent' | 'react_agent' | 'workflow_agent' | 'split_thread_agent' | 'sleeptime_agent' | 'voice_convo_agent' | 'voice_sleeptime_agent';
	description?: string;
	model?: string;
	embedding?: string;
	include_base_tools?: boolean;
	include_multi_agent_tools?: boolean;
	include_default_source?: boolean;
	tags?: string[];
	memory_blocks?: Array<{
		value: string;
		label: string;
		limit?: number;
		description?: string;
	}>;
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
			...options.headers
		};

		// Only add Authorization header if API key is provided
		if (this.settings.lettaApiKey) {
			headers['Authorization'] = `Bearer ${this.settings.lettaApiKey}`;
		}

		// Set content type unless it's a file upload
		if (!options.isFileUpload) {
			headers['Content-Type'] = 'application/json';
		}

		// Debug logging
		console.log(`[Letta Plugin] Making ${options.method || 'GET'} request to: ${url}`);
		console.log(`[Letta Plugin] Headers:`, headers);
		if (options.body && !options.isFileUpload) {
			console.log(`[Letta Plugin] Request body:`, options.body);
		} else if (options.isFileUpload) {
			console.log(`[Letta Plugin] File upload request`);
		}

		try {
			let requestBody;
			if (options.body && typeof options.body === 'string' && headers['Content-Type']?.includes('multipart/form-data')) {
				// Manual multipart form data
				requestBody = options.body;
			} else if (options.isFileUpload && options.formData) {
				requestBody = options.formData;
				// Remove Content-Type header to let browser set boundary
				delete headers['Content-Type'];
			} else if (options.body) {
				requestBody = JSON.stringify(options.body);
			}

			const response = await requestUrl({
				url,
				method: options.method || 'GET',
				headers,
				body: requestBody,
				throw: false
			});

			// Debug logging for response
			console.log(`[Letta Plugin] Response status: ${response.status}`);
			console.log(`[Letta Plugin] Response headers:`, response.headers);
			console.log(`[Letta Plugin] Response text:`, response.text);
			
			// Try to parse JSON, but handle cases where response isn't JSON
			let responseJson = null;
			try {
				if (response.text && (response.text.trim().startsWith('{') || response.text.trim().startsWith('['))) {
					responseJson = JSON.parse(response.text);
					console.log(`[Letta Plugin] Response JSON:`, responseJson);
				} else {
					console.log(`[Letta Plugin] Response is not JSON, skipping JSON parse`);
				}
			} catch (jsonError) {
				console.log(`[Letta Plugin] Failed to parse JSON:`, jsonError.message);
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
				} else if (response.status === 405) {
					errorMessage = `Method not allowed for ${path}. This may indicate:\n• Incorrect HTTP method\n• API endpoint has changed\n• Feature not supported in this Letta version`;
				}
				
				console.log(`[Letta Plugin] Enhanced error message: ${errorMessage}`);
				throw new Error(errorMessage);
			}

			return responseJson;
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
				
				// Check if source is already attached to existing agent
				console.log(`[Letta Plugin] Checking if source is attached to existing agent...`);
				const agentSources = existingAgent.sources || [];
				const sourceAttached = agentSources.some((s: any) => s.id === this.source!.id);
				
				if (!sourceAttached) {
					console.log(`[Letta Plugin] Source not attached, updating agent...`);
					// Get current source IDs and add our source
					const currentSourceIds = agentSources.map((s: any) => s.id);
					currentSourceIds.push(this.source!.id);
					
					await this.makeRequest(`/v1/agents/${this.agent.id}`, {
						method: 'PATCH',
						body: {
							source_ids: currentSourceIds
						}
					});
				} else {
					console.log(`[Letta Plugin] Source already attached to agent`);
				}
			} else {
				// Show agent configuration modal
				console.log(`[Letta Plugin] No existing agent found, showing configuration modal...`);
				const configModal = new AgentConfigModal(this.app, this);
				const agentConfig = await configModal.showModal();
				
				if (!agentConfig) {
					throw new Error('Agent configuration cancelled by user');
				}

				console.log(`[Letta Plugin] Creating new agent with config:`, agentConfig);

				// Create new agent with user configuration
				const isCloudInstance = this.settings.lettaBaseUrl.includes('api.letta.com');
				const agentBody: any = {
					name: agentConfig.name,
					agent_type: agentConfig.agent_type,
					description: agentConfig.description,
					model: agentConfig.model,
					embedding: agentConfig.embedding,
					include_base_tools: agentConfig.include_base_tools,
					include_multi_agent_tools: agentConfig.include_multi_agent_tools,
					include_default_source: agentConfig.include_default_source,
					tags: agentConfig.tags,
					memory_blocks: agentConfig.memory_blocks,
					source_ids: [this.source!.id] // Attach source during creation
				};

				// Only include project for cloud instances
				if (isCloudInstance) {
					agentBody.project = this.settings.lettaProjectSlug;
				}

				// Remove undefined values to keep the request clean
				Object.keys(agentBody).forEach(key => {
					if (agentBody[key] === undefined) {
						delete agentBody[key];
					}
				});

				const newAgent = await this.makeRequest('/v1/agents', {
					method: 'POST',
					body: agentBody
				});

				this.agent = { id: newAgent.id, name: newAgent.name };
				
				// Update settings with the configured agent name
				this.settings.agentName = agentConfig.name;
				await this.saveSettings();
			}

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
					
					console.log(`[Letta Plugin] Uploading file as multipart:`, encodedPath);
					console.log(`[Letta Plugin] File content length:`, content.length);
					
					// Create proper multipart form data matching Python client
					const boundary = '----formdata-obsidian-' + Math.random().toString(36).substr(2);
					const multipartBody = [
						`--${boundary}`,
						`Content-Disposition: form-data; name="file"; filename="${encodedPath}"`,
						'Content-Type: text/markdown',
						'',
						content,
						`--${boundary}--`
					].join('\r\n');

					await this.makeRequest(`/v1/sources/${this.source.id}/upload`, {
						method: 'POST',
						headers: {
							'Content-Type': `multipart/form-data; boundary=${boundary}`
						},
						body: multipartBody,
						isFileUpload: true
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

			console.log(`[Letta Plugin] Auto-syncing file change as multipart:`, encodedPath);
			
			// Create proper multipart form data matching Python client
			const boundary = '----formdata-obsidian-' + Math.random().toString(36).substr(2);
			const multipartBody = [
				`--${boundary}`,
				`Content-Disposition: form-data; name="file"; filename="${encodedPath}"`,
				'Content-Type: text/markdown',
				'',
				content,
				`--${boundary}--`
			].join('\r\n');

			await this.makeRequest(`/v1/sources/${this.source.id}/upload`, {
				method: 'POST',
				headers: {
					'Content-Type': `multipart/form-data; boundary=${boundary}`
				},
				body: multipartBody,
				isFileUpload: true
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
					content: [{
						type: "text",
						text: message
					}]
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

class AgentConfigModal extends Modal {
	plugin: LettaPlugin;
	config: AgentConfig;
	resolve: (config: AgentConfig | null) => void;
	reject: (error: Error) => void;

	constructor(app: App, plugin: LettaPlugin) {
		super(app);
		this.plugin = plugin;
		this.config = {
			name: plugin.settings.agentName,
			agent_type: 'memgpt_agent',
			description: 'An AI assistant for your Obsidian vault',
			include_base_tools: true,
			include_multi_agent_tools: false,
			include_default_source: false,
			tags: ['obsidian', 'assistant'],
			memory_blocks: [
				{
					value: 'You are an AI assistant integrated with an Obsidian vault. You have access to the user\'s markdown files and can help them explore, organize, and work with their notes. Be helpful, knowledgeable, and concise.',
					label: 'system',
					limit: 2000,
					description: 'Core system instructions'
				}
			]
		};
	}

	async showModal(): Promise<AgentConfig | null> {
		return new Promise((resolve, reject) => {
			this.resolve = resolve;
			this.reject = reject;
			this.open();
		});
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('agent-config-modal');

		// Header
		const header = contentEl.createEl('div', { cls: 'agent-config-header' });
		header.createEl('h2', { text: 'Configure New Agent' });
		header.createEl('p', { 
			text: 'Set up your Letta AI agent with custom configuration',
			cls: 'agent-config-subtitle' 
		});

		// Form container
		const formEl = contentEl.createEl('div', { cls: 'agent-config-form' });

		// Basic Configuration
		const basicSection = formEl.createEl('div', { cls: 'config-section' });
		basicSection.createEl('h3', { text: 'Basic Configuration' });

		// Agent Name
		const nameGroup = basicSection.createEl('div', { cls: 'config-group' });
		nameGroup.createEl('label', { text: 'Agent Name', cls: 'config-label' });
		const nameInput = nameGroup.createEl('input', { 
			type: 'text', 
			value: this.config.name,
			cls: 'config-input'
		});
		nameInput.addEventListener('input', () => {
			this.config.name = nameInput.value;
		});

		// Agent Type
		const typeGroup = basicSection.createEl('div', { cls: 'config-group' });
		typeGroup.createEl('label', { text: 'Agent Type', cls: 'config-label' });
		const typeSelect = typeGroup.createEl('select', { cls: 'config-select' });
		
		const agentTypes = [
			{ value: 'memgpt_agent', label: 'MemGPT Agent (Recommended)' },
			{ value: 'memgpt_v2_agent', label: 'MemGPT v2 Agent' },
			{ value: 'react_agent', label: 'ReAct Agent' },
			{ value: 'workflow_agent', label: 'Workflow Agent' },
			{ value: 'sleeptime_agent', label: 'Sleeptime Agent' }
		];

		agentTypes.forEach(type => {
			const option = typeSelect.createEl('option', { 
				value: type.value, 
				text: type.label 
			});
			if (type.value === this.config.agent_type) {
				option.selected = true;
			}
		});

		typeSelect.addEventListener('change', () => {
			this.config.agent_type = typeSelect.value as any;
		});

		// Description
		const descGroup = basicSection.createEl('div', { cls: 'config-group' });
		descGroup.createEl('label', { text: 'Description', cls: 'config-label' });
		const descInput = descGroup.createEl('textarea', { 
			value: this.config.description || '',
			cls: 'config-textarea',
			attr: { rows: '3' }
		});
		descInput.addEventListener('input', () => {
			this.config.description = descInput.value;
		});

		// Advanced Configuration
		const advancedSection = formEl.createEl('div', { cls: 'config-section' });
		advancedSection.createEl('h3', { text: 'Advanced Configuration' });

		// Model Configuration
		const modelGroup = advancedSection.createEl('div', { cls: 'config-group' });
		modelGroup.createEl('label', { text: 'Model (Optional)', cls: 'config-label' });
		const modelHelp = modelGroup.createEl('div', { 
			text: 'Format: provider/model-name (e.g., openai/gpt-4)', 
			cls: 'config-help' 
		});
		const modelInput = modelGroup.createEl('input', { 
			type: 'text', 
			value: this.config.model || '',
			cls: 'config-input',
			attr: { placeholder: 'e.g., openai/gpt-4' }
		});
		modelInput.addEventListener('input', () => {
			this.config.model = modelInput.value || undefined;
		});

		// Tool Configuration
		const toolsSection = advancedSection.createEl('div', { cls: 'config-subsection' });
		toolsSection.createEl('h4', { text: 'Tool Configuration' });

		// Include Base Tools
		const baseToolsGroup = toolsSection.createEl('div', { cls: 'config-checkbox-group' });
		const baseToolsCheckbox = baseToolsGroup.createEl('input', { 
			type: 'checkbox', 
			checked: this.config.include_base_tools,
			cls: 'config-checkbox'
		});
		baseToolsGroup.createEl('label', { text: 'Include Base Tools (Core memory functions)', cls: 'config-checkbox-label' });
		baseToolsCheckbox.addEventListener('change', () => {
			this.config.include_base_tools = baseToolsCheckbox.checked;
		});

		// Include Multi-Agent Tools
		const multiAgentToolsGroup = toolsSection.createEl('div', { cls: 'config-checkbox-group' });
		const multiAgentToolsCheckbox = multiAgentToolsGroup.createEl('input', { 
			type: 'checkbox', 
			checked: this.config.include_multi_agent_tools,
			cls: 'config-checkbox'
		});
		multiAgentToolsGroup.createEl('label', { text: 'Include Multi-Agent Tools', cls: 'config-checkbox-label' });
		multiAgentToolsCheckbox.addEventListener('change', () => {
			this.config.include_multi_agent_tools = multiAgentToolsCheckbox.checked;
		});

		// System Prompt Configuration
		const systemSection = formEl.createEl('div', { cls: 'config-section' });
		systemSection.createEl('h3', { text: 'System Prompt' });

		const systemGroup = systemSection.createEl('div', { cls: 'config-group' });
		systemGroup.createEl('label', { text: 'System Instructions', cls: 'config-label' });
		const systemHelp = systemGroup.createEl('div', { 
			text: 'These instructions define how the agent behaves and responds', 
			cls: 'config-help' 
		});
		const systemInput = systemGroup.createEl('textarea', { 
			value: this.config.memory_blocks?.[0]?.value || '',
			cls: 'config-textarea',
			attr: { rows: '6' }
		});
		systemInput.addEventListener('input', () => {
			if (!this.config.memory_blocks) {
				this.config.memory_blocks = [];
			}
			if (this.config.memory_blocks.length === 0) {
				this.config.memory_blocks.push({
					value: '',
					label: 'system',
					limit: 2000,
					description: 'Core system instructions'
				});
			}
			this.config.memory_blocks[0].value = systemInput.value;
		});

		// Tags
		const tagsGroup = systemSection.createEl('div', { cls: 'config-group' });
		tagsGroup.createEl('label', { text: 'Tags (Optional)', cls: 'config-label' });
		const tagsHelp = tagsGroup.createEl('div', { 
			text: 'Comma-separated tags for organizing agents', 
			cls: 'config-help' 
		});
		const tagsInput = tagsGroup.createEl('input', { 
			type: 'text', 
			value: this.config.tags?.join(', ') || '',
			cls: 'config-input',
			attr: { placeholder: 'obsidian, assistant, helpful' }
		});
		tagsInput.addEventListener('input', () => {
			const tags = tagsInput.value.split(',').map(tag => tag.trim()).filter(tag => tag.length > 0);
			this.config.tags = tags.length > 0 ? tags : undefined;
		});

		// Buttons
		const buttonContainer = contentEl.createEl('div', { cls: 'agent-config-buttons' });
		
		const createButton = buttonContainer.createEl('button', { 
			text: 'Create Agent', 
			cls: 'mod-cta agent-config-create-btn' 
		});
		createButton.addEventListener('click', () => {
			this.resolve(this.config);
			this.close();
		});

		const cancelButton = buttonContainer.createEl('button', { 
			text: 'Cancel', 
			cls: 'agent-config-cancel-btn' 
		});
		cancelButton.addEventListener('click', () => {
			this.resolve(null);
			this.close();
		});

		// Focus the name input
		nameInput.focus();
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
		if (this.resolve) {
			this.resolve(null);
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