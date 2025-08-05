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
	TFolder,
	requestUrl,
	ItemView,
	WorkspaceLeaf
} from 'obsidian';

export const LETTA_CHAT_VIEW_TYPE = 'letta-chat-view';
export const LETTA_MEMORY_VIEW_TYPE = 'letta-memory-view';

// Rate limit message constants
export const RATE_LIMIT_MESSAGE = {
	TITLE: 'Rate Limit Exceeded - You\'ve reached the rate limit for your account. Please wait a moment before sending another message.',
	UPGRADE_TEXT: 'Need more? Letta Cloud offers Pro, Scale, and Enterprise plans:',
	BILLING_URL: 'https://app.letta.com/settings/organization/billing',
	CUSTOM_KEYS_TEXT: 'Or bring your own inference provider:',
	CUSTOM_KEYS_URL: 'https://docs.letta.com/guides/cloud/custom-keys',
	
	// Helper function to create full message
	create: (reason: string) => `${RATE_LIMIT_MESSAGE.TITLE}

Reason: ${reason}

${RATE_LIMIT_MESSAGE.UPGRADE_TEXT}
${RATE_LIMIT_MESSAGE.BILLING_URL}

${RATE_LIMIT_MESSAGE.CUSTOM_KEYS_TEXT}
${RATE_LIMIT_MESSAGE.CUSTOM_KEYS_URL}`
};

interface LettaPluginSettings {
	lettaApiKey: string;
	lettaBaseUrl: string;
	lettaProjectSlug: string;
	agentId: string;
	agentName: string; // Keep for display purposes, but use agentId for API calls
	sourceName: string;
	autoSync: boolean;
	syncOnStartup: boolean;
	embeddingModel: string;
	showReasoning: boolean; // Control whether reasoning messages are visible
	enableStreaming: boolean; // Control whether to use streaming API responses
	focusMode: boolean; // Control whether to open only the active file and close others
	allowAgentCreation: boolean; // Control whether agent creation modal can be shown
}

const DEFAULT_SETTINGS: LettaPluginSettings = {
	lettaApiKey: '',
	lettaBaseUrl: 'https://api.letta.com',
	lettaProjectSlug: 'obsidian-vault',
	agentId: '',
	agentName: 'Obsidian Assistant',
	sourceName: 'obsidian-vault-files',
	autoSync: true,
	syncOnStartup: true,
	embeddingModel: 'letta/letta-free',
	showReasoning: true, // Default to showing reasoning messages in tool interactions
	enableStreaming: true, // Default to enabling streaming for real-time responses
	focusMode: false, // Default to having focus mode disabled
	allowAgentCreation: false // Default to disabling agent creation modal
}

interface LettaAgent {
	id: string;
	name: string;
	llm_config?: {
		model: string;
		model_endpoint_type: string;
		provider_name: string;
		provider_category: 'base' | 'byok';
		temperature?: number;
		max_tokens?: number;
		context_window?: number;
	};
}

interface LettaModel {
	model: string;
	model_endpoint_type: string;
	provider_name: string;
	provider_category: 'base' | 'byok';
	context_window: number;
	model_endpoint?: string;
	model_wrapper?: string;
	temperature?: number;
	max_tokens?: number;
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

		// Register the chat view
		this.registerView(
			LETTA_CHAT_VIEW_TYPE,
			(leaf) => new LettaChatView(leaf, this)
		);

		this.registerView(
			LETTA_MEMORY_VIEW_TYPE,
			(leaf) => new LettaMemoryView(leaf, this)
		);

		// Add ribbon icons
		this.addRibbonIcon('bot', 'Open Letta Chat', (evt: MouseEvent) => {
			this.openChatView();
		});

		this.addRibbonIcon('brain-circuit', 'Open Letta Memory Blocks', (evt: MouseEvent) => {
			this.openMemoryView();
		});

		// Add status bar
		this.statusBarItem = this.addStatusBarItem();
		this.updateStatusBar('Disconnected');

		// Add commands
		this.addCommand({
			id: 'open-letta-chat',
			name: 'Open Letta Chat',
			callback: () => {
				this.openChatView();
			}
		});

		this.addCommand({
			id: 'open-letta-memory',
			name: 'Open Letta Memory Blocks',
			callback: () => {
				this.openMemoryView();
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
			id: 'sync-current-file-to-letta',
			name: 'Sync Current File to Letta',
			editorCallback: async (editor: Editor, view: MarkdownView) => {
				await this.syncCurrentFile(view.file);
			}
		});



		this.addCommand({
			id: 'open-block-folder',
			name: 'Open Letta Memory Blocks Folder',
			callback: async () => {
				const folder = this.app.vault.getAbstractFileByPath('Letta Memory Blocks');
				if (folder && folder instanceof TFolder) {
					// Focus the file explorer and reveal the folder
					this.app.workspace.leftSplit.expand();
					new Notice('📁 Letta Memory Blocks folder is now visible in the file explorer');
				} else {
					new Notice('Letta Memory Blocks folder not found. Use "Open Memory Block Files" to create it.');
				}
			}
		});

		this.addCommand({
			id: 'connect-to-letta',
			name: 'Connect to Letta',
			callback: async () => {
				if (this.agent && this.source) {
					new Notice('Already connected to Letta');
					return;
				}
				await this.connectToLetta();
			}
		});

		this.addCommand({
			id: 'disconnect-from-letta',
			name: 'Disconnect from Letta',
			callback: () => {
				this.agent = null;
				this.source = null;
				this.updateStatusBar('Disconnected');
				new Notice('Disconnected from Letta');
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

		// Track active file changes for focus mode
		this.registerEvent(
			this.app.workspace.on('active-leaf-change', (leaf) => {
				const activeFile = this.app.workspace.getActiveFile();
				console.log('[LETTA DEBUG] active-leaf-change event triggered');
				console.log('[LETTA DEBUG] - focusMode:', this.settings.focusMode);
				console.log('[LETTA DEBUG] - leaf type:', leaf?.getViewState()?.type);
				console.log('[LETTA DEBUG] - active file:', activeFile?.path || 'null');
				if (this.settings.focusMode) {
					this.onActiveFileChange();
				}
			})
		);

		// Additional debugging events to track file switching
		this.registerEvent(
			this.app.workspace.on('file-open', (file) => {
				console.log('[LETTA DEBUG] file-open event:', file?.path || 'null');
				if (this.settings.focusMode && file && file.path.endsWith('.md')) {
					console.log('[LETTA DEBUG] file-open triggering focus mode update');
					this.onActiveFileChange();
				}
			})
		);

		this.registerEvent(
			this.app.workspace.on('layout-change', () => {
				const activeFile = this.app.workspace.getActiveFile();
				console.log('[LETTA DEBUG] layout-change event, active file:', activeFile?.path || 'null');
			})
		);

		// Add context menu for syncing files
		this.registerEvent(
			this.app.workspace.on('file-menu', (menu, file) => {
				if (file instanceof TFile && file.path.endsWith('.md')) {
					menu.addItem((item) => {
						item
							.setTitle('Sync to Letta')
							.setIcon('bot')
							.onClick(async () => {
								await this.syncCurrentFile(file);
							});
					});
				}
			})
		);
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

	// Get detailed connection status text
	getConnectionStatusText(): string {
		const isCloudInstance = this.settings.lettaBaseUrl.includes('api.letta.com');
		
		if (isCloudInstance) {
			const projectInfo = this.settings.lettaProjectSlug
				? ` • ${this.settings.lettaProjectSlug}`
				: '';
			return `Connected to Letta Cloud${projectInfo}`;
		} else {
			// Show base URL for local/custom instances
			return `Connected to ${this.settings.lettaBaseUrl}`;
		}
	}

	updateStatusBar(status: string) {
		if (this.statusBarItem) {
			// Only show sync-related status, hide connection details
			if (status === 'Connected') {
				this.statusBarItem.setText('');
			} else {
				this.statusBarItem.setText(status);
			}
		}
		
		// Also update chat status if chat view is open
		const chatLeaf = this.app.workspace.getLeavesOfType(LETTA_CHAT_VIEW_TYPE)[0];
		if (chatLeaf && chatLeaf.view instanceof LettaChatView) {
			// Don't await since updateStatusBar should be non-blocking
			(chatLeaf.view as LettaChatView).updateChatStatus();
		}
	}

	async makeRequest(path: string, options: any = {}): Promise<any> {
		return this.makeRequestWithRetry(path, options, 3);
	}

	async makeRequestWithRetry(path: string, options: any = {}, maxRetries: number = 3): Promise<any> {
		let lastError: any;
		
		for (let attempt = 0; attempt <= maxRetries; attempt++) {
			try {
				return await this.executeSingleRequest(path, options);
			} catch (error: any) {
				lastError = error;
				
				// Only retry on rate limiting errors
				if (error.isRateLimit && attempt < maxRetries) {
					const waitTime = error.retryAfter ? error.retryAfter * 1000 : Math.pow(2, attempt) * 1000; // Exponential backoff
					console.log(`[Letta Plugin] Rate limited, waiting ${waitTime}ms before retry ${attempt + 1}/${maxRetries}`);
					await new Promise(resolve => setTimeout(resolve, waitTime));
					continue;
				}
				
				// For non-rate-limit errors or final attempt, throw immediately
				throw error;
			}
		}
		
		throw lastError;
	}

	async executeSingleRequest(path: string, options: any = {}): Promise<any> {
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

		// Debug logging removed for cleaner console output

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
			// Response details available for debugging if needed
			
			// Try to parse JSON, but handle cases where response isn't JSON
			let responseJson = null;
			try {
				if (response.text && (response.text.trim().startsWith('{') || response.text.trim().startsWith('['))) {
					responseJson = JSON.parse(response.text);
					// Response JSON parsed successfully
				} else {
					// Response is not JSON, skipping parse
				}
			} catch (jsonError) {
				// Failed to parse JSON - continuing with text response
			}

			if (response.status >= 400) {
				let errorMessage = `HTTP ${response.status}: ${response.text}`;
				
				// Error details available for debugging if needed
				
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
				} else if (response.status === 429) {
					// Handle rate limiting with retry logic
					const retryAfter = response.headers?.['retry-after'] || response.headers?.['Retry-After'];
					const rateLimitReset = response.headers?.['x-ratelimit-reset'] || response.headers?.['X-RateLimit-Reset'];
					
					// Create detailed error message
					errorMessage = `Rate limit exceeded. ${responseJson?.detail || response.text || 'Please wait before making more requests.'}`;
					
					if (retryAfter) {
						errorMessage += `\nRetry after: ${retryAfter} seconds`;
					}
					if (rateLimitReset) {
						try {
							const resetTime = new Date(parseInt(rateLimitReset) * 1000);
							errorMessage += `\nRate limit resets at: ${resetTime.toLocaleTimeString()}`;
						} catch {
							errorMessage += `\nRate limit reset: ${rateLimitReset}`;
						}
					}
					
					// Create a special error type for rate limiting
					const rateLimitError = new Error(errorMessage);
					(rateLimitError as any).isRateLimit = true;
					(rateLimitError as any).retryAfter = retryAfter ? parseInt(retryAfter) : null;
					throw rateLimitError;
				}
				
				// Enhanced error message created
				throw new Error(errorMessage);
			}

			return responseJson;
		} catch (error: any) {
			// Exception details available for debugging if needed
			
			// Check if this is a network/connection error that might indicate the same issues as a 404
			if (error.message && (error.message.includes('fetch') || error.message.includes('network') || error.message.includes('ECONNREFUSED'))) {
				if (path === '/v1/models/embedding') {
					const enhancedError = new Error('Cannot connect to Letta API. Please verify:\n• Base URL is correct\n• Letta service is running\n• Network connectivity is available');
					throw enhancedError;
				}
			}
			
			console.error('[Letta Plugin] Letta API request failed:', error);
			throw error;
		}
	}

	async getAgentCount(): Promise<number> {
		try {
			// Get all agents across all projects (not filtered by current project)
			const agents = await this.makeRequest('/v1/agents');
			return agents ? agents.length : 0;
		} catch (error) {
			console.error('[Letta Plugin] Failed to get agent count:', error);
			return 0;
		}
	}

	async connectToLetta(attempt: number = 1): Promise<boolean> {
		const maxAttempts = 5;
		const isCloudInstance = this.settings.lettaBaseUrl.includes('api.letta.com');
		
		// Connection attempt ${attempt}/${maxAttempts} to ${this.settings.lettaBaseUrl}
		
		// Validate URL format on first attempt
		if (attempt === 1) {
			try {
				new URL(this.settings.lettaBaseUrl);
			} catch (e) {
				new Notice(`Invalid Base URL format: ${this.settings.lettaBaseUrl}. Please check your settings.`);
				this.updateStatusBar('Invalid URL');
				return false;
			}
			
			// Check for common typos
			if (this.settings.lettaBaseUrl.includes('locahost')) {
				new Notice(`Potential typo in Base URL: Did you mean "localhost"? Current: ${this.settings.lettaBaseUrl}`);
				this.updateStatusBar('URL typo detected');
				return false;
			}
		}
		
		if (isCloudInstance && !this.settings.lettaApiKey) {
			new Notice('API key required for Letta Cloud. Please configure it in settings.');
			return false;
		}

		try {
			this.updateStatusBar(attempt === 1 ? 'Connecting...' : `Retrying... (${attempt}/${maxAttempts})`);
			
			// Testing connection with embedding endpoint
			// Test connection by trying to list embedding models (this endpoint should exist)
			await this.makeRequest('/v1/models/embedding');

			// Setup source and agent
			await this.setupSource();
			
			// Try to setup agent if one is configured
			if (this.settings.agentId) {
				try {
					await this.setupAgent();
				} catch (agentError) {
					console.error('[Letta Plugin] Agent setup failed:', agentError);
					// Clear invalid agent ID
					this.settings.agentId = '';
					this.settings.agentName = '';
					await this.saveSettings();
				}
			}

			this.updateStatusBar('Connected');
			
			// Only show success notice on first attempt or after retries
			if (attempt === 1) {
				new Notice('Successfully connected to Letta');
			} else {
				new Notice(`Connected to Letta after ${attempt} attempts`);
			}

			// Sync vault on startup if configured
			if (this.settings.syncOnStartup) {
				await this.syncVaultToLetta();
			}

			return true;
		} catch (error: any) {
			console.error(`[Letta Plugin] Connection attempt ${attempt} failed:`, error);
			console.error('[Letta Plugin] Error details:', {
				message: error.message,
				stack: error.stack,
				name: error.name
			});

			// Provide specific error messages based on error type
			if (error.message.includes('ERR_NAME_NOT_RESOLVED')) {
				if (attempt === 1) {
					new Notice(`Cannot resolve hostname. Please check your Base URL: ${this.settings.lettaBaseUrl}`);
				}
			} else if (error.message.includes('ECONNREFUSED') || error.message.includes('ERR_CONNECTION_REFUSED')) {
				if (attempt === 1) {
					new Notice(`Connection refused. Is your Letta server running on ${this.settings.lettaBaseUrl}?`);
				}
			} else if (error.message.includes('ENOTFOUND')) {
				if (attempt === 1) {
					new Notice(`Host not found. Please verify the URL spelling: ${this.settings.lettaBaseUrl}`);
				}
			}

			// If we haven't reached max attempts, try again with backoff
			if (attempt < maxAttempts) {
				const backoffMs = Math.min(1000 * Math.pow(2, attempt - 1), 10000); // Cap at 10 seconds
				
				// Update status to show retry countdown
				this.updateStatusBar(`Retry in ${Math.ceil(backoffMs / 1000)}s...`);
				
				// Wait for backoff period
				await new Promise(resolve => setTimeout(resolve, backoffMs));
				
				// Recursive retry
				return await this.connectToLetta(attempt + 1);
			} else {
				// All attempts failed
				this.updateStatusBar('Connection failed');
				new Notice(`Failed to connect to Letta after ${maxAttempts} attempts: ${error.message}`);
				return false;
			}
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
				// Create new source with selected embedding model
				const embeddingConfigs = await this.makeRequest('/v1/models/embedding');
				
				// Find the selected embedding model, fall back to first available or letta-free
				let embeddingConfig = embeddingConfigs.find((config: any) => 
					config.handle === this.settings.embeddingModel
				);
				
				if (!embeddingConfig) {
					// Fallback to letta-free or first available
					embeddingConfig = embeddingConfigs.find((config: any) => 
						config.handle === 'letta/letta-free' || (config.handle && config.handle.includes('letta'))
					) || embeddingConfigs[0];
					
					console.warn(`[Letta Plugin] Selected embedding model "${this.settings.embeddingModel}" not found, using fallback: ${embeddingConfig?.handle}`);
				}

				// Prepare source creation body
				const isCloudInstance = this.settings.lettaBaseUrl.includes('api.letta.com');
				const sourceBody: any = {
					name: this.settings.sourceName,
					instructions: "A collection of markdown files from an Obsidian vault. Directory structure is preserved in filenames using '__' as path separators."
				};
				
				// Only include embedding_config for non-cloud instances
				if (!isCloudInstance) {
					sourceBody.embedding_config = embeddingConfig;
				}

				const newSource = await this.makeRequest('/v1/sources', {
					method: 'POST',
					body: sourceBody
				});

				this.source = { id: newSource.id, name: newSource.name };
				// Created new source with embedding model
			}
		} catch (error) {
			console.error('Failed to setup source:', error);
			throw error;
		}
	}

	async setupAgent(): Promise<void> {
		if (!this.source) throw new Error('Source not set up');
		
		// If no agent ID is configured, skip agent setup silently
		if (!this.settings.agentId) {
			console.log('[Letta Plugin] No agent ID configured, skipping agent setup');
			return;
		}

		try {
			// Try to get the specific agent by ID
			const existingAgent = await this.makeRequest(`/v1/agents/${this.settings.agentId}`);
			
			if (existingAgent) {
				this.agent = { id: existingAgent.id, name: existingAgent.name };
				// Update agent name in settings in case it changed
				this.settings.agentName = existingAgent.name;
				await this.saveSettings();
				
				// Check if source is already attached to existing agent
				// Checking if source is attached to existing agent
				const agentSources = existingAgent.sources || [];
				const sourceAttached = agentSources.some((s: any) => s.id === this.source!.id);
				
				if (!sourceAttached) {
					// Source not attached, updating agent
					// Get current source IDs and add our source
					const currentSourceIds = agentSources.map((s: any) => s.id);
					currentSourceIds.push(this.source!.id);
					
					await this.makeRequest(`/v1/agents/${this.agent?.id}`, {
						method: 'PATCH',
						body: {
							source_ids: currentSourceIds
						}
					});
				} else {
					// Source already attached to agent
				}
			} else {
				// Agent with configured ID not found, clear the invalid ID
				console.log(`[Letta Plugin] Agent with ID ${this.settings.agentId} not found, clearing invalid ID`);
				this.settings.agentId = '';
				this.settings.agentName = '';
				await this.saveSettings();
			}

		} catch (error) {
			console.error('Failed to setup agent:', error);
			// Clear invalid agent ID on error
			this.settings.agentId = '';
			this.settings.agentName = '';
			await this.saveSettings();
			// Don't throw error to prevent blocking startup
		}
	}

	encodeFilePath(path: string): string {
		return path.replace(/[\/\\]/g, '__');
	}

	decodeFilePath(encodedPath: string): string {
		return encodedPath.replace(/__/g, '/');
	}

	// Rate limiter for file uploads (10 files per minute)
	private uploadQueue: Array<() => Promise<void>> = [];
	private uploadsInLastMinute: number[] = [];
	private isProcessingQueue: boolean = false;

	private async addToUploadQueue(uploadFn: () => Promise<void>): Promise<void> {
		return new Promise((resolve, reject) => {
			this.uploadQueue.push(async () => {
				try {
					await uploadFn();
					resolve();
				} catch (error) {
					reject(error);
				}
			});
			
			if (!this.isProcessingQueue) {
				this.processUploadQueue();
			}
		});
	}

	private async processUploadQueue(): Promise<void> {
		if (this.isProcessingQueue || this.uploadQueue.length === 0) {
			return;
		}

		this.isProcessingQueue = true;
		
		while (this.uploadQueue.length > 0) {
			// Clean up old timestamps (older than 1 minute)
			const oneMinuteAgo = Date.now() - 60000;
			this.uploadsInLastMinute = this.uploadsInLastMinute.filter(timestamp => timestamp > oneMinuteAgo);
			
			// Check if we can upload (less than 10 uploads in the last minute)
			if (this.uploadsInLastMinute.length >= 10) {
				const oldestUpload = Math.min(...this.uploadsInLastMinute);
				const waitTime = (oldestUpload + 60000) - Date.now();
				// Rate limit reached, waiting
				await new Promise(resolve => setTimeout(resolve, waitTime));
				continue;
			}

			// Process next upload
			const uploadFn = this.uploadQueue.shift();
			if (uploadFn) {
				try {
					await uploadFn();
					this.uploadsInLastMinute.push(Date.now());
				} catch (error) {
					// Check if it's a rate limit error
					if (error.message && error.message.includes('HTTP 429')) {
						// Hit rate limit, will retry after waiting
						// Put the upload back at the front of the queue to retry
						this.uploadQueue.unshift(uploadFn);
						// Add a small delay before checking rate limits again
						await new Promise(resolve => setTimeout(resolve, 1000));
						continue;
					} else {
						console.error('[Letta Plugin] Upload failed with non-rate-limit error:', error);
						// For other errors, don't retry and continue with next upload
					}
				}
			}
		}
		
		this.isProcessingQueue = false;
	}

	async syncVaultToLetta(): Promise<void> {
		// Auto-connect if not connected to server
		if (!this.source || !this.source.id) {
			new Notice('Connecting to Letta...');
			const connected = await this.connectToLetta();
			if (!connected) {
				return;
			}
		}

		try {
			// Validate source ID before proceeding
			if (!this.source || !this.source.id) {
				throw new Error('Source not properly initialized for vault sync');
			}

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
			const filesToUpload: TFile[] = [];

			// First pass: determine which files need uploading
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
				}

				if (shouldUpload) {
					filesToUpload.push(file);
				}
			}

			// Second pass: upload files with rate limiting
			if (filesToUpload.length > 0) {
				new Notice(`Uploading ${filesToUpload.length} files with rate limiting...`);
				let processedCount = 0;
				
				const uploadPromises = filesToUpload.map(async (file, index) => {
					const encodedPath = this.encodeFilePath(file.path);
					const existingFile = existingFilesMap.get(encodedPath);
					
					return this.addToUploadQueue(async () => {
						// Validate source ID before starting upload
						if (!this.source || !this.source.id) {
							throw new Error('Source not properly initialized for upload');
						}

						// Delete existing file if it exists
						if (existingFile) {
							await this.makeRequest(`/v1/sources/${this.source.id}/${existingFile.id}`, {
								method: 'DELETE'
							});
						}

						// Upload new file
						const content = await this.app.vault.read(file);
						
						// Skip files with no content
						if (!content || content.trim().length === 0) {
							// Skipping empty file
							skipCount++;
							processedCount++;
							this.updateStatusBar(`Syncing (${processedCount}/${filesToUpload.length})`);
							return;
						}
						
						// Uploading file ${processedCount + 1}/${filesToUpload.length}
						
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
						processedCount++;
						
						// Update status bar with progress
						this.updateStatusBar(`Syncing (${processedCount}/${filesToUpload.length})`);
					});
				});

				await Promise.all(uploadPromises);
			}

			this.updateStatusBar('Connected');
			new Notice(`Sync complete: ${uploadCount} files uploaded, ${skipCount} files skipped`);

		} catch (error: any) {
			console.error('Failed to sync vault:', error);
			this.updateStatusBar('Error');
			new Notice(`Sync failed: ${error.message}`);
		}
	}

	async syncCurrentFile(file: TFile | null): Promise<void> {
		if (!file) {
			new Notice('No active file to sync');
			return;
		}

		if (!file.path.endsWith('.md')) {
			new Notice('Only markdown files can be synced to Letta');
			return;
		}

		// Auto-connect if not connected to server
		if (!this.source || !this.source.id) {
			new Notice('Connecting to Letta...');
			const connected = await this.connectToLetta();
			if (!connected) {
				return;
			}
		}

		try {
			this.updateStatusBar(`Syncing ${file.name}...`);
			
			const encodedPath = this.encodeFilePath(file.path);
			
			// Use rate-limited upload for single files too
			await this.addToUploadQueue(async () => {
				// Validate source ID before starting upload
				if (!this.source || !this.source.id) {
					throw new Error('Source not properly initialized for upload');
				}

				const content = await this.app.vault.read(file);


				// Check if file exists in Letta and get metadata
				const existingFiles = await this.makeRequest(`/v1/sources/${this.source.id}/files`);
				const existingFile = existingFiles.find((f: any) => f.file_name === encodedPath);
				
				let action = 'uploaded';
				
				if (existingFile) {
					// Delete existing file first
					await this.makeRequest(`/v1/sources/${this.source.id}/${existingFile.id}`, {
						method: 'DELETE'
					});
					action = 'updated';
				}

				// Upload the file
				// Syncing current file
				
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

				// Show success indication for longer duration, then return to connected
				this.updateStatusBar(`Synced ${file.name}`);
				setTimeout(() => this.updateStatusBar('Connected'), 5000);
			});

		} catch (error: any) {
			console.error('Failed to sync current file:', error);
			this.updateStatusBar('Error');
			new Notice(`Failed to sync file: ${error.message}`);
		}
	}





	async onFileChange(file: TFile): Promise<void> {
		// Skip block files - they should not auto-sync
		if (file.path.includes('Letta Memory Blocks/')) {
			return;
		}
		
		if (!file.path.endsWith('.md')) {
			return;
		}

		// Auto-connect if not connected to server (silently for auto-sync)
		if (!this.source || !this.source.id) {
			try {
				await this.connectToLetta();
			} catch (error) {
				// Silent fail for auto-sync - don't spam user with notices
				// Auto-sync failed: not connected
				return;
			}
		}

		try {
			const encodedPath = this.encodeFilePath(file.path);
			
			// Use rate-limited upload for auto-sync too
			await this.addToUploadQueue(async () => {
				// Validate source ID before starting upload
				if (!this.source || !this.source.id) {
					throw new Error('Source not properly initialized for upload');
				}

				const content = await this.app.vault.read(file);

				// Skip files with no content (silently for auto-sync)
				if (!content || content.trim().length === 0) {
					// Skipping empty file in auto-sync
					return;
				}

				// Delete existing file if it exists
				try {
					const existingFiles = await this.makeRequest(`/v1/sources/${this.source.id}/files`);
					const existingFile = existingFiles.find((f: any) => f.file_name === encodedPath);
					if (existingFile) {
						await this.makeRequest(`/v1/sources/${this.source.id}/${existingFile.id}`, {
							method: 'DELETE'
						});
					}
				} catch (error) {
					// File might not exist, continue with upload
				}

				// Auto-syncing file change as multipart
				
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
			});

		} catch (error) {
			console.error('Failed to sync file change:', error);
		}
	}

	async onFileDelete(file: TFile): Promise<void> {
		if (!file.path.endsWith('.md')) {
			return;
		}

		// Auto-connect if not connected to server (silently for auto-sync)
		if (!this.source || !this.source.id) {
			try {
				await this.connectToLetta();
			} catch (error) {
				// Silent fail for auto-sync - don't spam user with notices
				// Auto-delete failed: not connected
				return;
			}
		}

		try {
			// Validate source ID before proceeding
			if (!this.source || !this.source.id) {
				throw new Error('Source not properly initialized for file deletion');
			}

			const encodedPath = this.encodeFilePath(file.path);
			const existingFiles = await this.makeRequest(`/v1/sources/${this.source.id}/files`);
			const existingFile = existingFiles.find((f: any) => f.file_name === encodedPath);
			
			if (existingFile) {
				await this.makeRequest(`/v1/sources/${this.source.id}/${existingFile.id}`, {
					method: 'DELETE'
				});
			}
		} catch (error) {
			console.error('Failed to delete file from Letta:', error);
		}
	}

	async openFileInAgent(file: TFile): Promise<void> {
		console.log('[LETTA DEBUG] openFileInAgent called with file:', file.path);
		
		if (!this.agent || !this.source) {
			console.log('[LETTA DEBUG] openFileInAgent - early return: agent =', !!this.agent, 'source =', !!this.source);
			return;
		}

		try {
			const encodedPath = this.encodeFilePath(file.path);
			console.log('[LETTA DEBUG] openFileInAgent - encoded path:', encodedPath);
			
			const existingFiles = await this.makeRequest(`/v1/sources/${this.source.id}/files`);
			const existingFile = existingFiles.find((f: any) => f.file_name === encodedPath);
			
			if (existingFile) {
				console.log('[LETTA DEBUG] openFileInAgent - opening file with ID:', existingFile.id);
				await this.makeRequest(`/v1/agents/${this.agent.id}/files/${existingFile.id}/open`, {
					method: 'PATCH'
				});
				console.log('[LETTA DEBUG] openFileInAgent - successfully opened file:', file.path);
			} else {
				console.log('[LETTA DEBUG] openFileInAgent - file not found in source, syncing:', encodedPath);
				
				// Show sync status
				this.updateStatusBar(`Syncing ${file.name} for focus...`);
				
				try {
					// Auto-sync the missing file
					await this.syncCurrentFile(file);
					console.log('[LETTA DEBUG] openFileInAgent - file synced successfully');
					
					// Now try to open it again with retry logic for timing issues
					let newFile = null;
					let retryCount = 0;
					const maxRetries = 5;
					const baseDelay = 1000; // Start with 1 second
					
					while (!newFile && retryCount < maxRetries) {
						if (retryCount > 0) {
							const delay = baseDelay * Math.pow(1.5, retryCount - 1); // Exponential backoff
							console.log(`[LETTA DEBUG] openFileInAgent - retrying file lookup in ${delay}ms, attempt:`, retryCount + 1);
							await new Promise(resolve => setTimeout(resolve, delay));
						}
						
						const updatedFiles = await this.makeRequest(`/v1/sources/${this.source.id}/files`);
						newFile = updatedFiles.find((f: any) => f.file_name === encodedPath);
						retryCount++;
					}
					
					if (newFile) {
						await this.makeRequest(`/v1/agents/${this.agent.id}/files/${newFile.id}/open`, {
							method: 'PATCH'
						});
						console.log('[LETTA DEBUG] openFileInAgent - successfully opened synced file:', file.path);
						this.updateStatusBar('Connected');
					} else {
						console.error('[LETTA DEBUG] openFileInAgent - file still not found after sync and retries');
						this.updateStatusBar('Sync failed');
						setTimeout(() => this.updateStatusBar('Connected'), 3000);
					}
				} catch (syncError) {
					console.error('Failed to sync file:', syncError);
					this.updateStatusBar('Sync failed');
					setTimeout(() => this.updateStatusBar('Connected'), 3000);
				}
			}
		} catch (error) {
			console.error('Failed to open file in agent:', error);
			this.updateStatusBar('Error');
			setTimeout(() => this.updateStatusBar('Connected'), 3000);
		}
	}

	async closeFileInAgent(file: TFile): Promise<void> {
		if (!this.agent || !this.source) return;

		try {
			const encodedPath = this.encodeFilePath(file.path);
			const existingFiles = await this.makeRequest(`/v1/sources/${this.source.id}/files`);
			const existingFile = existingFiles.find((f: any) => f.file_name === encodedPath);
			
			if (existingFile) {
				await this.makeRequest(`/v1/agents/${this.agent.id}/files/${existingFile.id}/close`, {
					method: 'PATCH'
				});
			}
		} catch (error) {
			console.error('Failed to close file in agent:', error);
		}
	}

	async closeAllFilesInAgent(): Promise<void> {
		console.log('[LETTA DEBUG] closeAllFilesInAgent called');
		
		if (!this.agent) {
			console.log('[LETTA DEBUG] closeAllFilesInAgent - early return: no agent');
			return;
		}

		try {
			console.log('[LETTA DEBUG] closeAllFilesInAgent - making API request to close all files');
			await this.makeRequest(`/v1/agents/${this.agent.id}/files/close-all`, {
				method: 'PATCH'
			});
			console.log('[LETTA DEBUG] closeAllFilesInAgent - successfully closed all files');
		} catch (error) {
			console.error('Failed to close all files in agent:', error);
		}
	}

	async onActiveFileChange(): Promise<void> {
		console.log('[LETTA DEBUG] onActiveFileChange called');
		console.log('[LETTA DEBUG] onActiveFileChange - focusMode:', this.settings.focusMode, 'agent:', !!this.agent);
		
		if (!this.settings.focusMode || !this.agent) {
			console.log('[LETTA DEBUG] onActiveFileChange - early return');
			return;
		}

		const activeFile = this.app.workspace.getActiveFile();
		console.log('[LETTA DEBUG] onActiveFileChange - activeFile:', activeFile?.path || 'null');
		
		if (!activeFile || !activeFile.path.endsWith('.md')) {
			console.log('[LETTA DEBUG] onActiveFileChange - early return: no file or not markdown');
			return;
		}

		try {
			console.log('[LETTA DEBUG] onActiveFileChange - applying focus mode for file:', activeFile.path);
			// Close all files first
			await this.closeAllFilesInAgent();
			
			// Open the currently active file
			await this.openFileInAgent(activeFile);
			console.log('[LETTA DEBUG] onActiveFileChange - focus mode applied successfully');
		} catch (error) {
			console.error('Failed to apply focus mode on active file change:', error);
		}
	}

	async applyFocusMode(): Promise<void> {
		if (!this.agent) return;

		try {
			// Close all files first
			await this.closeAllFilesInAgent();
			
			// Open the currently active file if there is one
			const activeFile = this.app.workspace.getActiveFile();
			if (activeFile && activeFile.path.endsWith('.md')) {
				await this.openFileInAgent(activeFile);
			}
		} catch (error) {
			console.error('Failed to apply focus mode:', error);
		}
	}

	async openChatView(): Promise<void> {
		console.log('[LETTA DEBUG] openChatView called');
		
		// Auto-connect if not connected to server
		if (!this.source) {
			console.log('[LETTA DEBUG] openChatView - connecting to Letta');
			new Notice('Connecting to Letta...');
			const connected = await this.connectToLetta();
			if (!connected) {
				console.log('[LETTA DEBUG] openChatView - failed to connect');
				return;
			}
		}

		const { workspace } = this.app;

		// Store the currently active file before opening chat
		const activeFileBeforeChat = workspace.getActiveFile();
		console.log('[LETTA DEBUG] openChatView - activeFileBeforeChat:', activeFileBeforeChat?.path || 'null');

		let leaf: WorkspaceLeaf | null = null;
		const leaves = workspace.getLeavesOfType(LETTA_CHAT_VIEW_TYPE);

		if (leaves.length > 0) {
			// A leaf with our view already exists, use that
			console.log('[LETTA DEBUG] openChatView - using existing leaf');
			leaf = leaves[0];
		} else {
			// Our view could not be found in the workspace, create a new leaf
			// in the right sidebar for it
			console.log('[LETTA DEBUG] openChatView - creating new leaf');
			leaf = workspace.getRightLeaf(false);
			if (leaf) {
				await leaf.setViewState({ type: LETTA_CHAT_VIEW_TYPE, active: true });
			}
		}

		// "Reveal" the leaf in case it is in a collapsed sidebar
		if (leaf) {
			console.log('[LETTA DEBUG] openChatView - revealing leaf');
			workspace.revealLeaf(leaf);
		}

		// If focus mode is enabled and we had an active file, ensure it's opened in the agent
		if (this.settings.focusMode && activeFileBeforeChat && activeFileBeforeChat.path.endsWith('.md')) {
			console.log('[LETTA DEBUG] openChatView - applying focus mode for file:', activeFileBeforeChat.path);
			try {
				await this.closeAllFilesInAgent();
				await this.openFileInAgent(activeFileBeforeChat);
				console.log('[LETTA DEBUG] openChatView - focus mode applied successfully');
			} catch (error) {
				console.error('Failed to apply focus mode after opening chat:', error);
			}
		} else {
			console.log('[LETTA DEBUG] openChatView - not applying focus mode: focusMode =', this.settings.focusMode, 'activeFile =', !!activeFileBeforeChat);
		}
	}

	async openMemoryView(): Promise<void> {
		// Auto-connect if not connected to server
		if (!this.source) {
			new Notice('Connecting to Letta...');
			const connected = await this.connectToLetta();
			if (!connected) {
				return;
			}
		}

		const { workspace } = this.app;

		let leaf: WorkspaceLeaf | null = null;
		const leaves = workspace.getLeavesOfType(LETTA_MEMORY_VIEW_TYPE);

		if (leaves.length > 0) {
			// A leaf with our view already exists, use that
			leaf = leaves[0];
		} else {
			// Our view could not be found in the workspace, create a new leaf
			// in the right sidebar for it
			leaf = workspace.getRightLeaf(false);
			if (leaf) {
				await leaf.setViewState({ type: LETTA_MEMORY_VIEW_TYPE, active: true });
			}
		}

		// "Reveal" the leaf in case it is in a collapsed sidebar
		if (leaf) {
			workspace.revealLeaf(leaf);
		}
	}

	async sendMessageToAgent(message: string): Promise<LettaMessage[]> {
		if (!this.agent) throw new Error('Agent not connected');

		const response = await this.makeRequest(`/v1/agents/${this.agent?.id}/messages`, {
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

	async sendMessageToAgentStream(message: string, onMessage: (message: any) => void, onError: (error: Error) => void, onComplete: () => void): Promise<void> {
		if (!this.agent) throw new Error('Agent not connected');

		const url = `${this.settings.lettaBaseUrl}/v1/agents/${this.agent?.id}/messages/stream`;
		const headers: any = {
			'Content-Type': 'application/json'
		};

		// Only add Authorization header if API key is provided
		if (this.settings.lettaApiKey) {
			headers['Authorization'] = `Bearer ${this.settings.lettaApiKey}`;
		}

		const body = {
			messages: [{
				role: "user",
				content: [{
					type: "text",
					text: message
				}]
			}],
			stream_steps: this.settings.enableStreaming,
			stream_tokens: this.settings.enableStreaming
		};

		try {
			const response = await fetch(url, {
				method: 'POST',
				headers,
				body: JSON.stringify(body)
			});

			if (!response.ok) {
				// For rate limiting, try to extract more detailed error information
				if (response.status === 429) {
					let detailedError = `HTTP 429: Rate limit exceeded`;
					try {
						const errorBody = await response.text();
						if (errorBody) {
							// Try to parse as JSON first
							try {
								const errorJson = JSON.parse(errorBody);
								if (errorJson.detail) {
									detailedError = `HTTP 429: ${errorJson.detail}`;
								} else if (errorJson.message) {
									detailedError = `HTTP 429: ${errorJson.message}`;
								}
							} catch {
								// If not JSON, use the raw text
								detailedError = `HTTP 429: ${errorBody}`;
							}
						}
						// Check for rate limit headers
						const retryAfter = response.headers.get('Retry-After');
						const rateLimitReset = response.headers.get('X-RateLimit-Reset');
						const rateLimitRemaining = response.headers.get('X-RateLimit-Remaining');
						
						if (retryAfter) {
							detailedError += ` | Retry after: ${retryAfter} seconds`;
						}
						if (rateLimitReset) {
							const resetTime = new Date(parseInt(rateLimitReset) * 1000);
							detailedError += ` | Rate limit resets at: ${resetTime.toLocaleTimeString()}`;
						}
						if (rateLimitRemaining) {
							detailedError += ` | Remaining requests: ${rateLimitRemaining}`;
						}
					} catch (bodyError) {
						console.error('[Letta Plugin] Error reading rate limit response body:', bodyError);
					}
					throw new Error(detailedError);
				}
				throw new Error(`HTTP ${response.status}: ${response.statusText}`);
			}

			if (!response.body) {
				throw new Error('No response body available for streaming');
			}

			const reader = response.body.getReader();
			const decoder = new TextDecoder();

			try {
				while (true) {
					const { done, value } = await reader.read();
					
					if (done) {
						break;
					}

					const chunk = decoder.decode(value, { stream: true });
					const lines = chunk.split('\n');

					for (const line of lines) {
						if (line.trim() === '') continue;
						if (line.startsWith('data: ')) {
							const data = line.slice(6); // Remove 'data: ' prefix
							
							if (data === '[DONE]') {
								onComplete();
								return;
							}

							try {
								const message = JSON.parse(data);
								onMessage(message);
							} catch (parseError) {
								console.warn('[Letta Plugin] Failed to parse streaming message:', data);
							}
						}
					}
				}
			} finally {
				reader.releaseLock();
			}
		} catch (error: any) {
			onError(error);
		}
	}


}

class LettaChatView extends ItemView {
	plugin: LettaPlugin;
	chatContainer: HTMLElement;
	typingIndicator: HTMLElement;
	heartbeatTimeout: NodeJS.Timeout | null = null;
	inputContainer: HTMLElement;
	messageInput: HTMLTextAreaElement;
	sendButton: HTMLButtonElement;
	agentNameElement: HTMLElement;
	statusDot: HTMLElement;
	statusText: HTMLElement;
	modelButton: HTMLElement;

	constructor(leaf: WorkspaceLeaf, plugin: LettaPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType() {
		return LETTA_CHAT_VIEW_TYPE;
	}

	getDisplayText() {
		return 'Letta Chat';
	}

	getIcon() {
		return 'bot';
	}

	async onOpen() {
		const container = this.containerEl.children[1];
		container.empty();
		container.addClass('letta-chat-view');

		// Header with connection status
		const header = container.createEl('div', { cls: 'letta-chat-header' });
		
		const titleSection = header.createEl('div', { cls: 'letta-chat-title-section' });
		const titleContainer = titleSection.createEl('div', { cls: 'letta-title-container' });
		this.agentNameElement = titleContainer.createEl('h3', { 
			text: this.plugin.agent ? this.plugin.settings.agentName : 'No Agent', 
			cls: this.plugin.agent ? 'letta-chat-title' : 'letta-chat-title no-agent'
		});
		this.agentNameElement.style.cursor = 'pointer';
		this.agentNameElement.title = 'Click to edit agent name';
		this.agentNameElement.addEventListener('click', () => this.editAgentName());
		
		const configButton = titleContainer.createEl('span', { text: 'Config' });
		configButton.title = 'Configure agent properties';
		configButton.style.cssText = 'cursor: pointer; opacity: 0.7; padding: 2px 6px; margin: 0 4px; font-size: 0.8em;';
		configButton.addEventListener('mouseenter', () => { configButton.style.opacity = '1'; });
		configButton.addEventListener('mouseleave', () => { configButton.style.opacity = '0.7'; });
		configButton.addEventListener('click', () => this.openAgentConfig());

		const memoryButton = titleContainer.createEl('span', { text: 'Memory' });
		memoryButton.title = 'Open memory blocks panel';
		memoryButton.style.cssText = 'cursor: pointer; opacity: 0.7; padding: 2px 6px; margin: 0 4px; font-size: 0.8em;';
		memoryButton.addEventListener('mouseenter', () => { memoryButton.style.opacity = '1'; });
		memoryButton.addEventListener('mouseleave', () => { memoryButton.style.opacity = '0.7'; });
		memoryButton.addEventListener('click', () => this.plugin.openMemoryView());

		const switchAgentButton = titleContainer.createEl('span', { text: 'Agent' });
		switchAgentButton.title = 'Switch to different agent';
		switchAgentButton.style.cssText = 'cursor: pointer; opacity: 0.7; padding: 2px 6px; margin: 0 4px; font-size: 0.8em;';
		switchAgentButton.addEventListener('mouseenter', () => { switchAgentButton.style.opacity = '1'; });
		switchAgentButton.addEventListener('mouseleave', () => { switchAgentButton.style.opacity = '0.7'; });
		switchAgentButton.addEventListener('click', () => this.openAgentSwitcher());

		const adeButton = titleContainer.createEl('span', { text: 'ADE' });
		adeButton.title = 'Open in Letta Agent Development Environment';
		adeButton.style.cssText = 'cursor: pointer; opacity: 0.7; padding: 2px 6px; margin: 0 4px; font-size: 0.8em;';
		adeButton.addEventListener('mouseenter', () => { adeButton.style.opacity = '1'; });
		adeButton.addEventListener('mouseleave', () => { adeButton.style.opacity = '0.7'; });
		adeButton.addEventListener('click', () => this.openInADE());

		
		const statusIndicator = header.createEl('div', { cls: 'letta-status-indicator' });
		this.statusDot = statusIndicator.createEl('span', { cls: 'letta-status-dot' });
		this.statusText = statusIndicator.createEl('span', { cls: 'letta-status-text' });
		
		// Set initial status based on current connection state
		this.updateChatStatus();

		// Chat container
		this.chatContainer = container.createEl('div', { cls: 'letta-chat-container' });
		
		// Typing indicator
		this.typingIndicator = this.chatContainer.createEl('div', { 
			cls: 'letta-typing-indicator' 
		});
		this.typingIndicator.style.display = 'none';
		
		const typingText = this.typingIndicator.createEl('span', { 
			cls: 'letta-typing-text',
			text: `${this.plugin.settings.agentName} is thinking`
		});
		
		const typingDots = this.typingIndicator.createEl('span', { 
			cls: 'letta-typing-dots' 
		});
		typingDots.createEl('span', { text: '.' });
		typingDots.createEl('span', { text: '.' });
		typingDots.createEl('span', { text: '.' });
		
		
		// Now that chat container exists, update status to show disconnected message if needed
		this.updateChatStatus();
		
		// Input container
		this.inputContainer = container.createEl('div', { cls: 'letta-input-container' });
		
		this.messageInput = this.inputContainer.createEl('textarea', {
			cls: 'letta-message-input',
			attr: { 
				placeholder: 'Ask about your vault...',
				rows: '2'
			}
		});

		const buttonContainer = this.inputContainer.createEl('div', { cls: 'letta-button-container' });
		
		// Model switcher button on the left
		this.modelButton = buttonContainer.createEl('button', {
			text: 'Loading...',
			cls: 'letta-model-button',
			attr: { 'aria-label': 'Switch model' }
		});
		this.modelButton.addEventListener('click', () => this.openModelSwitcher());
		
		// Button group on the right
		const rightButtons = buttonContainer.createEl('div', { cls: 'letta-button-group-right' });
		
		this.sendButton = rightButtons.createEl('button', {
			cls: 'letta-send-button',
			attr: { 'aria-label': 'Send message' }
		});
		this.sendButton.createEl('span', { text: 'Send' });

		// Event listeners
		this.sendButton.addEventListener('click', () => this.sendMessage());
		
		// Update status now that all UI elements are created
		this.updateChatStatus();
		
		this.messageInput.addEventListener('keydown', (evt) => {
			if (evt.key === 'Enter' && !evt.shiftKey) {
				evt.preventDefault();
				this.sendMessage();
			}
		});

		// Auto-resize textarea
		this.messageInput.addEventListener('input', () => {
			this.messageInput.style.height = 'auto';
			this.messageInput.style.height = Math.min(this.messageInput.scrollHeight, 80) + 'px';
		});

		// Start with empty chat
	}

	async onClose() {
		// Clean up heartbeat timeout
		if (this.heartbeatTimeout) {
			clearTimeout(this.heartbeatTimeout);
			this.heartbeatTimeout = null;
		}
	}

	addMessage(type: 'user' | 'assistant' | 'reasoning' | 'tool-call' | 'tool-result', content: any, title?: string, reasoningContent?: string) {
		// Adding message to chat interface
		
		// Extract text content from various possible formats
		let textContent: string = '';
		
		if (typeof content === 'string') {
			textContent = content;
		} else if (Array.isArray(content)) {
			// Handle array content - extract text from array elements
			textContent = content.map(item => {
				if (typeof item === 'string') {
					return item;
				} else if (item && typeof item === 'object') {
					return item.text || item.content || item.message || item.value || JSON.stringify(item);
				}
				return String(item);
			}).join('');
		} else if (content && typeof content === 'object') {
			// Try to extract text from object structure
			textContent = content.text || content.content || content.message || content.value || '';
			
			// If still no text found, try JSON stringification as fallback
			if (!textContent && content) {
				console.warn('[Letta Plugin] Content object has no recognizable text field, using JSON fallback:', Object.keys(content));
				textContent = JSON.stringify(content, null, 2);
			}
		} else {
			// Last resort: convert to string
			textContent = String(content || '');
		}
		
		// Text content extracted for display
		
		// Ensure we have some content to display
		if (!textContent) {
			console.warn('[Letta Plugin] No content to display');
			return;
		}
		
		// Hide typing indicator when real content arrives
		this.hideTypingIndicator();
		
		// Clean up previous tool calls when starting a new assistant message
		if (type === 'assistant') {
			this.cleanupPreviousToolCalls();
		}
		// Check if this is actually a system_alert that wasn't properly filtered
		if (textContent && textContent.includes('"type": "system_alert"')) {
			// Try to parse and handle as system message instead
			try {
				const parsed = JSON.parse(textContent);
				if (parsed.type === 'system_alert') {
					this.addSystemMessage(parsed);
					return null;
				}
			} catch (e) {
				// If parsing fails, continue with regular message handling
				// but log this case for debugging
				console.debug('[Letta Plugin] Failed to parse potential system_alert content:', e);
			}
		}
		
		// Debug: Check for heartbeat content being added as regular message
		if (textContent && (textContent.includes('"type": "heartbeat"') || 
						textContent.includes('automated system message') ||
						textContent.includes('Function call failed, returning control') ||
						textContent.includes('request_heartbeat=true'))) {
			// Blocked heartbeat content from being displayed
			// Don't add this message - it should have been filtered and handled by typing indicator
			return null;
		}
		const messageEl = this.chatContainer.createEl('div', { 
			cls: `letta-message letta-message-${type}` 
		});

		// Create bubble wrapper
		const bubbleEl = messageEl.createEl('div', { cls: 'letta-message-bubble' });

		// Add timestamp
		const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
		
		// Skip tool messages - they're now handled by addToolInteractionMessage
		if (type === 'tool-call' || type === 'tool-result') {
			return;
			
		} else if (type === 'reasoning') {
			// Skip standalone reasoning messages - they should be part of assistant messages
			return;
			
		} else {
			// Regular messages (user/assistant)
			if (title && type !== 'user') {
				const headerEl = bubbleEl.createEl('div', { cls: 'letta-message-header' });
				
				// Left side: title and timestamp
				const leftSide = headerEl.createEl('div', { cls: 'letta-message-header-left' });
				
				// Remove emojis from titles
				let cleanTitle = title.replace(/🤖|👤|🚨|✅|❌|🔌/g, '').trim();
				leftSide.createEl('span', { cls: 'letta-message-title', text: cleanTitle });
				leftSide.createEl('span', { cls: 'letta-message-timestamp', text: timestamp });
				
				// Right side: reasoning button if reasoning content exists
				if (type === 'assistant' && reasoningContent) {
					const reasoningBtn = headerEl.createEl('button', { 
						cls: 'letta-reasoning-btn letta-reasoning-collapsed',
						text: '⋯'
					});
					
					// Add click handler for reasoning toggle
					reasoningBtn.addEventListener('click', (e) => {
						e.stopPropagation();
						const isCollapsed = reasoningBtn.classList.contains('letta-reasoning-collapsed');
						if (isCollapsed) {
							reasoningBtn.removeClass('letta-reasoning-collapsed');
							reasoningBtn.addClass('letta-reasoning-expanded');
						} else {
							reasoningBtn.addClass('letta-reasoning-collapsed');
							reasoningBtn.removeClass('letta-reasoning-expanded');
						}
						
						// Toggle reasoning content visibility
						const reasoningEl = bubbleEl.querySelector('.letta-reasoning-content');
						if (reasoningEl) {
							reasoningEl.classList.toggle('letta-reasoning-visible');
						}
					});
				}
			}

			// Add reasoning content if provided (for assistant messages)
			if (type === 'assistant' && reasoningContent) {
				const reasoningEl = bubbleEl.createEl('div', { cls: 'letta-reasoning-content' });
				
				// Enhanced markdown-like formatting for reasoning
				let formattedReasoning = reasoningContent
					// Trim leading and trailing whitespace first
					.trim()
					// Normalize multiple consecutive newlines to double newlines
					.replace(/\n{3,}/g, '\n\n')
					// Handle headers (must be done before other formatting)
					.replace(/^### (.+)$/gm, '<h3>$1</h3>')
					.replace(/^## (.+)$/gm, '<h2>$1</h2>')
					.replace(/^# (.+)$/gm, '<h1>$1</h1>')
					// Handle bold and italic
					.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
					.replace(/\*(.*?)\*/g, '<em>$1</em>')
					.replace(/`([^`]+)`/g, '<code>$1</code>')
					// Handle numbered lists (1. 2. 3. etc.)
					.replace(/^(\d+)\.\s+(.+)$/gm, '<li class="numbered-list">$2</li>')
					// Handle bullet lists (•, -, *)
					.replace(/^[•*-]\s+(.+)$/gm, '<li>$1</li>')
					// Handle double newlines as paragraph breaks first
					.replace(/\n\n/g, '</p><p>')
					// Convert remaining single newlines to <br> tags
					.replace(/\n/g, '<br>');
				
				// Wrap consecutive numbered list items in <ol> tags
				formattedReasoning = formattedReasoning.replace(/(<li class="numbered-list">.*?<\/li>)(\s*<br>\s*<li class="numbered-list">.*?<\/li>)*/g, (match) => {
					// Remove the <br> tags between numbered list items and wrap in <ol>
					const cleanMatch = match.replace(/<br>\s*/g, '');
					return '<ol>' + cleanMatch + '</ol>';
				});
				
				// Wrap consecutive regular list items in <ul> tags
				formattedReasoning = formattedReasoning.replace(/(<li>(?!.*class="numbered-list").*?<\/li>)(\s*<br>\s*<li>(?!.*class="numbered-list").*?<\/li>)*/g, (match) => {
					// Remove the <br> tags between list items and wrap in <ul>
					const cleanMatch = match.replace(/<br>\s*/g, '');
					return '<ul>' + cleanMatch + '</ul>';
				});
				
				// Wrap in paragraphs if needed
				if (formattedReasoning.includes('</p><p>') && !formattedReasoning.startsWith('<')) {
					formattedReasoning = '<p>' + formattedReasoning + '</p>';
				}
				
				reasoningEl.innerHTML = formattedReasoning;
			}

			// Enhanced markdown-like formatting
			let formattedContent = textContent
				// Trim leading and trailing whitespace first
				.trim()
				// Normalize multiple consecutive newlines to double newlines
				.replace(/\n{3,}/g, '\n\n')
				// Handle headers (must be done before other formatting)
				.replace(/^### (.+)$/gm, '<h3>$1</h3>')
				.replace(/^## (.+)$/gm, '<h2>$1</h2>')
				.replace(/^# (.+)$/gm, '<h1>$1</h1>')
				// Handle bold and italic
				.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
				.replace(/\*(.*?)\*/g, '<em>$1</em>')
				.replace(/`([^`]+)`/g, '<code>$1</code>')
				// Handle numbered lists (1. 2. 3. etc.)
				.replace(/^(\d+)\.\s+(.+)$/gm, '<li class="numbered-list">$2</li>')
				// Handle bullet lists (•, -, *)
				.replace(/^[•*-]\s+(.+)$/gm, '<li>$1</li>')
				// Handle double newlines as paragraph breaks first
				.replace(/\n\n/g, '</p><p>')
				// Convert remaining single newlines to <br> tags
				.replace(/\n/g, '<br>');
			
			// Wrap consecutive numbered list items in <ol> tags
			formattedContent = formattedContent.replace(/(<li class="numbered-list">.*?<\/li>)(\s*<br>\s*<li class="numbered-list">.*?<\/li>)*/g, (match) => {
				// Remove the <br> tags between numbered list items and wrap in <ol>
				const cleanMatch = match.replace(/<br>\s*/g, '');
				return '<ol>' + cleanMatch + '</ol>';
			});
			
			// Wrap consecutive regular list items in <ul> tags
			formattedContent = formattedContent.replace(/(<li>(?!.*class="numbered-list").*?<\/li>)(\s*<br>\s*<li>(?!.*class="numbered-list").*?<\/li>)*/g, (match) => {
				// Remove the <br> tags between list items and wrap in <ul>
				const cleanMatch = match.replace(/<br>\s*/g, '');
				return '<ul>' + cleanMatch + '</ul>';
			});
			
			// Wrap in paragraphs if needed
			if (formattedContent.includes('</p><p>') && !formattedContent.startsWith('<')) {
				formattedContent = '<p>' + formattedContent + '</p>';
			}

			// Handle collapsible user messages
			if (type === 'user' && textContent.length > 200) {
				// Create container for collapsible content
				const contentContainer = bubbleEl.createEl('div', { cls: 'letta-user-message-container' });
				
				// Create preview content (first 200 characters)
				const previewContent = textContent.substring(0, 200).trim() + '...';
				const previewEl = contentContainer.createEl('div', { 
					cls: 'letta-message-content letta-user-message-preview' 
				});
				previewEl.textContent = previewContent;
				
				// Create full content (initially hidden)
				const fullContentEl = contentContainer.createEl('div', { 
					cls: 'letta-message-content letta-user-message-full letta-user-message-collapsed' 
				});
				fullContentEl.innerHTML = formattedContent;
				
				// Create expand/collapse button
				const expandBtn = contentContainer.createEl('button', { 
					cls: 'letta-user-message-toggle',
					text: 'See more'
				});
				
				// Add click handler for expand/collapse
				expandBtn.addEventListener('click', (e) => {
					e.stopPropagation();
					const isCollapsed = fullContentEl.classList.contains('letta-user-message-collapsed');
					
					if (isCollapsed) {
						// Expand: hide preview, show full content
						previewEl.style.display = 'none';
						fullContentEl.removeClass('letta-user-message-collapsed');
						expandBtn.textContent = 'See less';
					} else {
						// Collapse: show preview, hide full content
						previewEl.style.display = 'block';
						fullContentEl.addClass('letta-user-message-collapsed');
						expandBtn.textContent = 'See more';
					}
				});
			} else {
				// Regular content for short messages or non-user messages
				const contentEl = bubbleEl.createEl('div', { cls: 'letta-message-content' });
				contentEl.innerHTML = formattedContent;
			}
		}

		// Animate message appearance
		messageEl.style.opacity = '0';
		messageEl.style.transform = 'translateY(10px)';
		setTimeout(() => {
			messageEl.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
			messageEl.style.opacity = '1';
			messageEl.style.transform = 'translateY(0)';
		}, 50);

		// Scroll to bottom with smooth animation
		setTimeout(() => {
			this.chatContainer.scrollTo({
				top: this.chatContainer.scrollHeight,
				behavior: 'smooth'
			});
		}, 100);
	}

	async clearChat() {
		this.chatContainer.empty();
		// Update status to show disconnected message if not connected
		await this.updateChatStatus();
	}


	async loadHistoricalMessages() {
		// Only load if we're connected and chat container is empty (excluding disconnected message)
		if (!this.plugin.agent || !this.chatContainer) {
			return;
		}

		// Check if we already have messages (don't reload on every status update)
		const existingMessages = this.chatContainer.querySelectorAll('.letta-message');
		if (existingMessages.length > 0) {
			return;
		}

		try {
			// Load last 50 messages by default
			const messages = await this.plugin.makeRequest(`/v1/agents/${this.plugin.agent?.id}/messages?limit=50`);
			
			if (!messages || messages.length === 0) {
				return;
			}

			// Filter out any obviously malformed messages before processing
			const validMessages = messages.filter((msg: any) => {
				if (!msg) return false;
				const messageType = msg.message_type || msg.type;
				if (!messageType) {
					console.warn('[Letta Plugin] Message missing type field:', msg);
					return false;
				}
				return true;
			});

			if (validMessages.length === 0) {
				// No valid messages found in response
				return;
			}

			// Sort messages by timestamp (oldest first)
			const sortedMessages = validMessages.sort((a: any, b: any) => 
				new Date(a.date).getTime() - new Date(b.date).getTime()
			);

			// Process messages in groups (reasoning -> tool_call -> tool_return -> assistant)
			this.processMessagesInGroups(sortedMessages);


		} catch (error) {
			console.error('[Letta Plugin] Failed to load historical messages:', error);
			// Show a minimal error message for malformed data issues
			if (error.message && error.message.includes('missing message argument')) {
				this.addMessage('assistant', 'Some messages in your conversation history could not be loaded due to data issues. New messages will work normally.', 'System');
			}
		}
	}

	// Filter out system prompt content that shouldn't be shown to users
	filterSystemPromptContent(content: string): string {
		if (!content) return content;
		
		// Patterns that indicate system prompt leakage
		const systemPromptPatterns = [
			/<control_flow>/i,
			/<basic_functions>/i,
			/<context_instructions>/i,
			/<memory_editing>/i,
			/<memory_tools>/i,
			/program again after the function completes/i,
			/inner monologue.*private to you only/i,
			/Older AI models had no concept of persistent memory/i,
			/conversation with a user.*their.*acti/i,
			/active memory/i,
			/persistent memory/i,
			/context window/i,
			/overflow.*old messages.*permanently lost/i,
			/sentient being/i,
			/real-time.*conscious awareness/i,
			// File system information patterns
			/\*\*Currently Open Files.*Based on my current system access/i,
			/\*\*Available Directories:\*\*/i,
			/obsidian-vault-files.*directory structure preserved/i,
			/using '__' as path separa/i,
			/\*\*File System Notes:\*\*/i,
			/I can open up to \d+ files/i,
			// Repeated content patterns  
			/(.*)\1{2,}/s  // Catches content repeated 3+ times
		];
		
		// Check for repeated content blocks (specific to file system info spam)
		if (content.includes('**Currently Open Files') && content.includes('Based on my current system access')) {
			const matches = content.match(/\*\*Currently Open Files.*?(?=\*\*Currently Open Files|\*\*Available Directories|$)/gs);
			if (matches && matches.length > 1) {
				// Detected repeated file system information, filtering out
				return 'I can see your vault files and am ready to help with your question.';
			}
		}
		
		// Check if content contains system prompt patterns
		const hasSystemContent = systemPromptPatterns.some(pattern => pattern.test(content));
		
		if (hasSystemContent) {
			// Content contains system patterns, attempting selective filtering
			
			// Try more selective filtering - only remove lines that are clearly system instructions
			const lines = content.split('\n');
			const filteredLines = lines.filter(line => {
				const trimmed = line.trim();
				if (!trimmed) return false; // Remove empty lines
				
				// Only remove lines that match very specific system patterns
				const isSystemLine = systemPromptPatterns.some(pattern => {
					const match = pattern.test(trimmed);
					if (match) {
						// console.log('[Letta Plugin] Filtering system line:', trimmed);
					}
					return match;
				});
				
				// Keep lines that don't match system patterns and don't look like XML tags
				return !isSystemLine && !trimmed.includes('<') && !trimmed.includes('>');
			});
			
			const filtered = filteredLines.join('\n').trim();
			
			// Only use fallback if we have very little content left (less than 10 characters)
			if (!filtered || filtered.length < 10) {
				// Minimal content after filtering, using original response
				// Return original content instead of placeholder
				return content;
			}
			
			return filtered;
		}
		
		return content;
	}

	// Format tool results with JSON pretty-printing when possible
	formatToolResult(toolResult: string): string {
		if (!toolResult) return toolResult;

		try {
			// Try to parse as JSON first
			const parsed = JSON.parse(toolResult);
			// If successful, return pretty-printed JSON
			return JSON.stringify(parsed, null, 2);
		} catch (e) {
			// If not valid JSON, check if it's a repr-style string (quoted with escapes)
			let formatted = toolResult;
			
			// Check if it's wrapped in quotes like a Python repr string
			if (formatted.startsWith('"') && formatted.endsWith('"')) {
				try {
					// Try to parse it as a JSON string to handle escapes properly
					formatted = JSON.parse(formatted);
				} catch (parseError) {
					// If JSON parsing fails, manually remove outer quotes and process escapes
					formatted = formatted.slice(1, -1);
					
					// Handle escaped newlines
					formatted = formatted.replace(/\\n/g, '\n');
					
					// Handle escaped quotes
					formatted = formatted.replace(/\\"/g, '"');
					
					// Handle escaped backslashes
					formatted = formatted.replace(/\\\\/g, '\\');
				}
			} else {
				// Handle escaped sequences even without quotes
				formatted = formatted.replace(/\\n/g, '\n');
				formatted = formatted.replace(/\\"/g, '"');
				formatted = formatted.replace(/\\\\/g, '\\');
			}
			
			// Clean up extensive === separators - replace long chains with simple dividers
			formatted = formatted.replace(/={10,}/g, '---\n');
			
			// Clean up any remaining === separators at start/end
			formatted = formatted.replace(/^===+\s*/, '').replace(/\s*===+$/, '');
			
			// Clean up multiple consecutive newlines
			formatted = formatted.replace(/\n{3,}/g, '\n\n');
			
			return formatted.trim();
		}
	}

	// Add a clean, centered rate limiting notification
	addRateLimitMessage(content: string) {
		const messageEl = this.chatContainer.createEl('div', { 
			cls: 'letta-rate-limit-message' 
		});

		// Add timestamp
		const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
		const timeEl = messageEl.createEl('div', { 
			cls: 'letta-rate-limit-timestamp',
			text: timestamp
		});

		// Add content without markdown processing for clean display
		const contentEl = messageEl.createEl('div', { 
			cls: 'letta-rate-limit-content'
		});
		
		// Process the content to extract the main message and links
		const lines = content.split('\n');
		let mainMessage = '';
		let billingLink = '';
		let customKeysLink = '';
		
		for (const line of lines) {
			if (line.includes('https://app.letta.com/settings/organization/billing')) {
				billingLink = line.trim();
			} else if (line.includes('https://docs.letta.com/guides/cloud/custom-keys')) {
				customKeysLink = line.trim();
			} else if (line.trim() && !line.includes('Need more?') && !line.includes('Or bring your own')) {
				if (mainMessage) mainMessage += ' ';
				mainMessage += line.replace(/[⚠️*]/g, '').trim();
			}
		}
		
		// Add main message
		if (mainMessage) {
			const msgEl = contentEl.createEl('div', { 
				cls: 'letta-rate-limit-main',
				text: mainMessage
			});
		}
		
		// Add billing link if present
		if (billingLink) {
			const linkEl = contentEl.createEl('div', { cls: 'letta-rate-limit-link' });
			const link = linkEl.createEl('a', { 
				href: billingLink,
				text: 'Upgrade to Pro, Scale, or Enterprise',
				cls: 'letta-rate-limit-upgrade-link'
			});
			link.setAttribute('target', '_blank');
		}
		
		// Add "or" separator if both links are present
		if (billingLink && customKeysLink) {
			const orEl = contentEl.createEl('div', { 
				cls: 'letta-rate-limit-separator',
				text: 'or'
			});
			orEl.style.cssText = 'text-align: center; margin: 8px 0; color: var(--text-muted); font-size: 0.9em;';
		}
		
		// Add custom keys link if present
		if (customKeysLink) {
			const linkEl = contentEl.createEl('div', { cls: 'letta-rate-limit-link' });
			const link = linkEl.createEl('a', { 
				href: customKeysLink,
				text: 'Learn about bringing your own inference provider',
				cls: 'letta-rate-limit-upgrade-link'
			});
			link.setAttribute('target', '_blank');
		}

		// Scroll to bottom
		this.chatContainer.scrollTop = this.chatContainer.scrollHeight;
	}

	processMessagesInGroups(messages: any[]) {
		let currentReasoning = '';
		let currentToolCallMessage: HTMLElement | null = null;
		let currentToolName = '';
		let currentToolCallData: any = null;
		
		for (const message of messages) {
			try {
				// Skip system messages as they're internal
				if (message.message_type === 'system_message' || message.type === 'system_message') {
					continue;
				}
				
				// Handle system messages - capture system_alert for hidden viewing, skip heartbeats
				if (message.type === 'system_alert' || 
					(message.message && typeof message.message === 'string' && message.message.includes('prior messages have been hidden'))) {
					// Capturing historical system_alert message
					this.addSystemMessage(message);
					continue;
				}
				
				if (message.type === 'heartbeat' || message.message_type === 'heartbeat') {
					continue;
				}
				
				// Filter out login messages - check both direct type and content containing login JSON
				if (message.type === 'login' || message.message_type === 'login') {
					continue;
				}
				
				// Check if this is a user_message containing login JSON
				if (message.message_type === 'user_message' && message.content && typeof message.content === 'string') {
					try {
						const parsedContent = JSON.parse(message.content.trim());
						if (parsedContent.type === 'login') {
							continue;
						}
					} catch (e) {
						// Not JSON, continue processing normally
					}
				}
				
				const messageType = message.message_type || message.type;
				// Processing historical message
			
				// Validate message has required fields based on type
				if (!this.validateMessageStructure(message, messageType)) {
					console.warn('[Letta Plugin] Skipping malformed message:', message);
					this.addErrorMessage(`Malformed ${messageType || 'unknown'} message`, message);
					continue;
				}
			
			switch (messageType) {
			case 'user_message':
				if (message.content || message.text) {
					this.addMessage('user', message.text || message.content || '');
				}
				break;
			
			case 'reasoning_message':
				if (message.reasoning) {
					// Don't display reasoning as standalone message - only accumulate for next assistant message
					currentReasoning += message.reasoning;
				}
				break;
			
			case 'tool_call_message':
				if (message.tool_call) {
					// Extract and store the tool name and data for later use with tool result
					currentToolName = message.tool_call.name || (message.tool_call.function && message.tool_call.function.name) || '';
					currentToolCallData = message.tool_call;
					
					// Create tool interaction with reasoning and wait for tool result
					currentToolCallMessage = this.addToolInteractionMessage(
						currentReasoning, 
						JSON.stringify(message.tool_call, null, 2)
					);
					// Clear reasoning after using it
					currentReasoning = '';
				}
				break;
			
			case 'tool_return_message':
				if (message.tool_return && currentToolCallMessage) {
					// Add tool result to the existing tool interaction message with tool name and data
					this.addToolResultToMessage(currentToolCallMessage, 
						JSON.stringify(message.tool_return, null, 2), currentToolName, currentToolCallData);
					// Clear the current tool call message reference, tool name, and data
					currentToolCallMessage = null;
					currentToolName = '';
					currentToolCallData = null;
				}
				break;
			
			case 'assistant_message':
				if (message.content || message.text) {
					// Filter out system prompt content and use accumulated reasoning
					const rawContent = message.content || message.text || '';
					const filteredContent = this.filterSystemPromptContent(rawContent);
					this.addMessage('assistant', filteredContent, 
						this.plugin.settings.agentName, currentReasoning || undefined);
					// Clear reasoning after using it
					currentReasoning = '';
				}
				break;
			
			default:
				// Unknown historical message type
			}
			} catch (error) {
				console.error('[Letta Plugin] Error processing message:', error, message);
				this.addErrorMessage(`Error processing ${message?.message_type || message?.type || 'unknown'} message`, { error: error.message, message });
			}
		}
	}

	// Validate message structure based on type
	validateMessageStructure(message: any, messageType: string): boolean {
		if (!message) return false;
		
		switch (messageType) {
			case 'user_message':
				return !!(message.content || message.text);
			case 'assistant_message':
				return !!(message.content || message.text);
			case 'reasoning_message':
				return !!(message.reasoning);
			case 'tool_call_message':
				return !!(message.tool_call);
			case 'tool_return_message':
				return !!(message.tool_return);
			default:
				// For unknown types, just check if it's not null/undefined
				return true;
		}
	}

	// Add error message for malformed messages
	addErrorMessage(title: string, data: any) {
		const errorContent = `${title} - This message had invalid data and was skipped.`;
		this.addMessage('assistant', errorContent, 'System');
	}

	displayHistoricalMessage(message: any) {
		// Processing historical message
		
		// Handle system messages - capture system_alert for hidden viewing, skip heartbeats entirely
		// Check multiple possible properties where the type might be stored
		const messageType = message.type || message.message_type;
		const messageRole = message.role;
		const messageReason = message.reason || '';
		const hasHeartbeatContent = messageReason.includes('automated system message') || 
									messageReason.includes('Function call failed, returning control') ||
									messageReason.includes('request_heartbeat=true');
		
		// Store system_alert messages in hidden container for debugging
		if (messageType === 'system_alert' || 
			(message.message && typeof message.message === 'string' && message.message.includes('prior messages have been hidden'))) {
			// Capturing system_alert message
			this.addSystemMessage(message);
			return;
		}
		
		// Skip heartbeat messages entirely  
		if (messageType === 'heartbeat' || 
			message.message_type === 'heartbeat' ||
			messageRole === 'heartbeat' ||
			hasHeartbeatContent ||
			(message.content && typeof message.content === 'string' && 
			 (message.content.includes('automated system message') ||
			  message.content.includes('Function call failed, returning control') ||
			  message.content.includes('request_heartbeat=true'))) ||
			(message.text && typeof message.text === 'string' && 
			 (message.text.includes('automated system message') ||
			  message.text.includes('Function call failed, returning control') ||
			  message.text.includes('request_heartbeat=true')))) {
			// Skipping historical heartbeat message
			return;
		}
		
		// Filter out login messages - check both direct type and content containing login JSON
		if (messageType === 'login' || 
			message.message_type === 'login' ||
			messageRole === 'login') {
			return;
		}
		
		// Check if this is a user_message containing login JSON
		if (message.message_type === 'user_message' && message.content && typeof message.content === 'string') {
			try {
				const parsedContent = JSON.parse(message.content.trim());
				if (parsedContent.type === 'login') {
					return;
				}
			} catch (e) {
				// Not JSON, continue processing normally
			}
		}
		
		// Parse different message types based on Letta's message structure
		switch (message.message_type) {
			case 'user_message':
				if (message.text || message.content) {
					this.addMessage('user', message.text || message.content || '');
				}
				break;
			
			case 'reasoning_message':
				// Reasoning messages are now handled by processMessagesInGroups
				break;
			
			case 'tool_call_message':
				// Tool call messages are now handled by processMessagesInGroups
				break;
			
			case 'tool_return_message':
				// Tool return messages are now handled by processMessagesInGroups
				break;
			
			case 'assistant_message':
				if (message.content || message.text) {
					// Filter out system prompt content
					const rawContent = message.content || message.text || '';
					const filteredContent = this.filterSystemPromptContent(rawContent);
					this.addMessage('assistant', filteredContent, this.plugin.settings.agentName);
				}
				break;
			
			case 'system_message':
				// Skip system messages as they're internal
				break;
				
			case 'heartbeat':
				// Handle heartbeat messages - show typing indicator
				this.handleHeartbeat();
				break;
				
			default:
				// Handle unrecognized message types - log and skip to prevent display
				// Unrecognized historical message type
				break;
		}
	}

	addMessageSeparator(text: string) {
		const separatorEl = this.chatContainer.createEl('div', { 
			cls: 'letta-message-separator' 
		});
		separatorEl.createEl('span', { text, cls: 'letta-separator-text' });
	}

	addSystemMessage(message: any) {
		// Create system message using the same separator style as "Previous conversation history"
		const separatorEl = this.chatContainer.createEl('div', { 
			cls: 'letta-message-separator letta-system-message-separator' 
		});
		// Hidden by default - can be toggled via settings or UI control
		
		// Create clickable separator text
		const separatorText = separatorEl.createEl('span', { 
			text: 'memory update',
			cls: 'letta-separator-text letta-system-separator-text'
		});
		separatorText.style.cursor = 'pointer';
		separatorText.style.userSelect = 'none';
		
		// Create expandable content container (hidden initially)
		const expandedContent = this.chatContainer.createEl('div', { 
			cls: 'letta-system-expanded-content'
		});
		expandedContent.style.cssText = 'display: none; background: var(--background-secondary); border: 1px solid var(--background-modifier-border); border-radius: 4px; padding: 12px; margin: 8px 0; font-size: 12px; line-height: 1.4;';
		
		
		// For system_alert messages, show the readable content
		if (message.type === 'system_alert' && message.message) {
			const messageEl = expandedContent.createEl('div', { 
				text: message.message,
				cls: 'letta-system-content'
			});
			messageEl.style.cssText = 'color: var(--text-normal); white-space: pre-wrap; margin-bottom: 8px;';
		}
		
		// Add a subtle "click to collapse" hint when expanded
		const collapseHint = expandedContent.createEl('div', { 
			text: 'Click "System Message" above to collapse',
			cls: 'letta-system-collapse-hint'
		});
		collapseHint.style.cssText = 'font-size: 10px; color: var(--text-muted); margin-top: 8px; font-style: italic;';
		
		// Toggle functionality
		let isExpanded = false;
		separatorText.addEventListener('click', () => {
			isExpanded = !isExpanded;
			expandedContent.style.display = isExpanded ? 'block' : 'none';
			
			if (isExpanded) {
				// Scroll to keep the expanded content visible
				expandedContent.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
			}
		});
		
		// Auto-scroll to show the new system message separator
		this.chatContainer.scrollTop = this.chatContainer.scrollHeight;
	}

	showTypingIndicator() {
		if (this.typingIndicator) {
			this.typingIndicator.style.display = 'block';
			// Scroll to bottom to show the typing indicator
			this.chatContainer.scrollTop = this.chatContainer.scrollHeight;
		}
	}

	hideTypingIndicator() {
		if (this.typingIndicator) {
			this.typingIndicator.style.display = 'none';
		}
	}

	handleHeartbeat() {
		// Heartbeat received - showing typing indicator
		this.showTypingIndicator();
		
		// Clear existing timeout
		if (this.heartbeatTimeout) {
			clearTimeout(this.heartbeatTimeout);
		}
		
		// Hide typing indicator after 3 seconds of no heartbeats
		this.heartbeatTimeout = setTimeout(() => {
			// No heartbeat for 3s - hiding typing indicator
			this.hideTypingIndicator();
			this.heartbeatTimeout = null;
		}, 3000);
	}

	async updateChatStatus(loadHistoricalMessages = true) {
		// Determine connection status based on plugin state
		const isServerConnected = this.plugin.source;
		const isAgentAttached = this.plugin.agent && this.plugin.source;
		
		if (isAgentAttached) {
			this.statusDot.className = 'letta-status-dot letta-status-connected';
			
			// Use the plugin's helper method for consistent status text
			this.statusText.textContent = this.plugin.getConnectionStatusText();
			
			// Update agent name display
			this.updateAgentNameDisplay();
			
			// Update model button if it exists
			if (this.modelButton) {
				this.updateModelButton();
			}
			
			// Remove disconnected/no agent messages if they exist
			this.removeDisconnectedMessage();
			this.removeNoAgentMessage();
			
			// Conditionally load historical messages
			if (loadHistoricalMessages) {
				this.loadHistoricalMessages();
			}
		} else if (isServerConnected) {
			// Connected to server but no agent attached
			this.statusDot.className = 'letta-status-dot letta-status-connected';
			this.statusText.textContent = this.plugin.getConnectionStatusText();
			
			// Update agent name display to show "No Agent"
			this.updateAgentNameDisplay();
			
			if (this.modelButton) {
				this.modelButton.textContent = 'No Agent';
			}
			
			// Remove disconnected message but show no agent message
			this.removeDisconnectedMessage();
			await this.showNoAgentMessage();
		} else {
			// Not connected to server
			this.statusDot.className = 'letta-status-dot';
			this.statusDot.style.backgroundColor = 'var(--text-muted)';
			this.statusText.textContent = 'Disconnected';
			
			// Update agent name display to show "No Agent"
			this.updateAgentNameDisplay();
			
			if (this.modelButton) {
				this.modelButton.textContent = 'N/A';
			}
			
			// Show disconnected message in chat area
			this.removeNoAgentMessage();
			this.showDisconnectedMessage();
		}
	}

	updateAgentNameDisplay() {
		if (this.plugin.agent) {
			this.agentNameElement.textContent = this.plugin.settings.agentName;
			this.agentNameElement.className = 'letta-chat-title';
		} else {
			this.agentNameElement.textContent = 'No Agent';
			this.agentNameElement.className = 'letta-chat-title no-agent';
		}
	}
	
	showDisconnectedMessage() {
		// Only show if chat container exists
		if (!this.chatContainer) {
			return;
		}
		
		// Remove any existing disconnected message
		this.removeDisconnectedMessage();
		
		// Create disconnected message container
		const disconnectedContainer = this.chatContainer.createEl('div', { 
			cls: 'letta-disconnected-container' 
		});
		
		// Large disconnected message
		const disconnectedMessage = disconnectedContainer.createEl('div', { 
			cls: 'letta-disconnected-message' 
		});
		
		disconnectedMessage.createEl('h2', { 
			text: 'You are not connected to Letta', 
			cls: 'letta-disconnected-title' 
		});
		
		disconnectedMessage.createEl('p', { 
			text: 'A server connection is required to use your stateful agent', 
			cls: 'letta-disconnected-subtitle' 
		});
		
		// Connect button
		const connectButton = disconnectedMessage.createEl('button', {
			text: 'Connect to Letta',
			cls: 'letta-connect-button'
		});
		
		connectButton.addEventListener('click', async () => {
			connectButton.disabled = true;
			connectButton.textContent = 'Connecting...';
			
			try {
				const connected = await this.plugin.connectToLetta();
				if (connected) {
					// Connection successful - message will be removed by updateChatStatus
				} else {
					// Connection failed - reset button
					connectButton.disabled = false;
					connectButton.textContent = 'Connect to Letta';
				}
			} catch (error) {
				// Connection failed - reset button
				connectButton.disabled = false;
				connectButton.textContent = 'Connect to Letta';
			}
		});
	}
	
	removeDisconnectedMessage() {
		if (!this.chatContainer) {
			return;
		}
		
		const existingMessage = this.chatContainer.querySelector('.letta-disconnected-container');
		if (existingMessage) {
			existingMessage.remove();
		}
	}

	async showNoAgentMessage() {
		if (!this.chatContainer) {
			return;
		}
		
		// Remove existing no agent message first
		this.removeNoAgentMessage();
		
		const messageContainer = this.chatContainer.createEl('div', { 
			cls: 'letta-no-agent-container'
		});
		
		const content = messageContainer.createEl('div', { cls: 'letta-no-agent-content' });
		
		content.createEl('h3', { text: 'No Agent Selected', cls: 'letta-no-agent-title' });
		
		content.createEl('p', { 
			text: 'You are connected to Letta, but no agent is selected. Choose an agent to start chatting.',
			cls: 'letta-no-agent-description' 
		});
		
		const buttonContainer = content.createEl('div', { cls: 'letta-no-agent-buttons' });
		
		// Check agent count to determine if Select Agent should be enabled
		const agentCount = await this.plugin.getAgentCount();
		
		const selectAgentButton = buttonContainer.createEl('button', { 
			text: agentCount > 0 ? 'Select Agent' : 'No Agents Available',
			cls: 'mod-cta letta-select-agent-button'
		});
		
		if (agentCount > 0) {
			selectAgentButton.addEventListener('click', async () => {
				// Open agent selector from settings
				const settingTab = new LettaSettingTab(this.app, this.plugin);
				await settingTab.showAgentSelector();
			});
		} else {
			selectAgentButton.disabled = true;
			selectAgentButton.style.opacity = '0.5';
			selectAgentButton.style.cursor = 'not-allowed';
		}
		
		// Only show the create agent button if enabled in settings
		if (this.plugin.settings.allowAgentCreation) {
			const createAgentButton = buttonContainer.createEl('button', { 
				text: 'Create New Agent (Advanced)',
				cls: 'letta-create-agent-button'
			});
			
			// Make the button less prominent to prevent accidental clicks
			createAgentButton.style.cssText = 'opacity: 0.7; font-size: 0.9em;';
			createAgentButton.addEventListener('mouseenter', () => { createAgentButton.style.opacity = '1'; });
			createAgentButton.addEventListener('mouseleave', () => { createAgentButton.style.opacity = '0.7'; });
			
			createAgentButton.addEventListener('click', async () => {
			// Show confirmation before opening agent creation modal
			const confirmModal = new Modal(this.app);
			confirmModal.titleEl.setText('Create New Agent');
			
			const content = confirmModal.contentEl;
			content.createEl('p', { text: 'Are you sure you want to create a new agent? This will open the agent configuration modal.' });
			
			const buttonContainer = content.createEl('div', { cls: 'modal-button-container' });
			buttonContainer.style.cssText = 'display: flex; justify-content: flex-end; gap: 10px; margin-top: 20px;';
			
			const cancelButton = buttonContainer.createEl('button', { text: 'Cancel' });
			cancelButton.addEventListener('click', () => confirmModal.close());
			
			const createButton = buttonContainer.createEl('button', { text: 'Create Agent', cls: 'mod-cta' });
			createButton.addEventListener('click', async () => {
				confirmModal.close();
				
				// Open agent creation modal after confirmation
				const configModal = new AgentConfigModal(this.app, this.plugin);
				const agentConfig = await configModal.showModal();
				
				if (agentConfig) {
					try {
						// Create the agent using the configuration
						await this.createAgentFromConfig(agentConfig);
						new Notice('Agent created successfully!');
						// Refresh the no-agent message to update button state
						await this.showNoAgentMessage();
					} catch (error) {
						console.error('[Letta Plugin] Failed to create agent:', error);
						new Notice(`Failed to create agent: ${error.message}`);
					}
				}
			});
			
			confirmModal.open();
			});
		}
	}

	async createAgentFromConfig(agentConfig: AgentConfig): Promise<void> {
		if (!this.plugin.source) {
			throw new Error('Source not set up');
		}

		// Creating new agent

		// Get embedding config for agent creation
		const embeddingConfigs = await this.plugin.makeRequest('/v1/models/embedding');
		const embeddingConfig = embeddingConfigs.find((config: any) => 
			config.handle === 'letta/letta-free' || (config.handle && config.handle.includes('letta'))
		) || embeddingConfigs[0];

		// Create new agent with user configuration and corrected defaults
		const isCloudInstance = this.plugin.settings.lettaBaseUrl.includes('api.letta.com');
		const agentBody: any = {
			name: agentConfig.name,
			agent_type: 'memgpt_v2_agent', // Use MemGPT v2 architecture
			description: agentConfig.description,
			model: agentConfig.model,
			include_base_tools: false, // Don't include base tools, use custom memory tools
			include_multi_agent_tools: agentConfig.include_multi_agent_tools,
			include_default_source: agentConfig.include_default_source,
			tags: agentConfig.tags,
			memory_blocks: agentConfig.memory_blocks,
			source_ids: [this.plugin.source!.id], // Attach source during creation
			// Specify the correct memory tools
			tools: ['memory_replace', 'memory_insert', 'memory_rethink']
		};
		
		// Only include embedding_config for non-cloud instances
		if (!isCloudInstance) {
			agentBody.embedding_config = embeddingConfig;
		}

		// Only include project for cloud instances
		if (isCloudInstance) {
			agentBody.project = this.plugin.settings.lettaProjectSlug;
		}

		// Remove undefined values to keep the request clean
		Object.keys(agentBody).forEach(key => {
			if (agentBody[key] === undefined) {
				delete agentBody[key];
			}
		});

		const newAgent = await this.plugin.makeRequest('/v1/agents', {
			method: 'POST',
			body: agentBody
		});

		// Update plugin state with the new agent
		this.plugin.agent = { id: newAgent.id, name: newAgent.name };
		
		// Update settings with the new agent
		this.plugin.settings.agentId = newAgent.id;
		this.plugin.settings.agentName = agentConfig.name;
		await this.plugin.saveSettings();
	}

	removeNoAgentMessage() {
		if (!this.chatContainer) {
			return;
		}
		
		const existingMessage = this.chatContainer.querySelector('.letta-no-agent-container');
		if (existingMessage) {
			existingMessage.remove();
		}
	}

	openInADE() {
		if (!this.plugin.agent) {
			new Notice('Please connect to Letta first');
			return;
		}

		// Construct the ADE URL for the current agent
		const adeUrl = `https://app.letta.com/agents/${this.plugin.agent?.id}`;
		
		// Open in external browser
		window.open(adeUrl, '_blank');
		
		new Notice('Opening agent in Letta ADE...');
	}

	async updateModelButton() {
		if (!this.plugin.agent) {
			this.modelButton.textContent = 'N/A';
			return;
		}

		try {
			// Fetch the current agent details to get model info
			const agent = await this.plugin.makeRequest(`/v1/agents/${this.plugin.agent?.id}`);
			
			if (agent && agent.llm_config && agent.llm_config.model) {
				// Display just the model name for brevity
				const modelName = agent.llm_config.model;
				this.modelButton.textContent = modelName;
				this.modelButton.title = `Current model: ${modelName}\nProvider: ${agent.llm_config.provider_name || 'Unknown'}\nClick to change model`;
			} else {
				this.modelButton.textContent = 'Unknown';
			}
		} catch (error) {
			console.error('Error fetching agent model info:', error);
			this.modelButton.textContent = 'Error';
		}
	}

	openModelSwitcher() {
		if (!this.plugin.agent) {
			new Notice('Please connect to Letta first');
			return;
		}

		const modal = new ModelSwitcherModal(this.app, this.plugin, this.plugin.agent);
		modal.open();
	}

	async editAgentName() {
		if (!this.plugin.agent) {
			new Notice('Please connect to Letta first');
			return;
		}

		const currentName = this.plugin.settings.agentName;
		const newName = await this.promptForAgentName(currentName);
		
		if (newName && newName !== currentName) {
			try {
				// Update agent name via API
				await this.plugin.makeRequest(`/v1/agents/${this.plugin.agent?.id}`, {
					method: 'PATCH',
					body: { name: newName }
				});

				// Update settings
				this.plugin.settings.agentName = newName;
				await this.plugin.saveSettings();

				// Update UI
				this.updateAgentNameDisplay();
				this.plugin.agent.name = newName;

				new Notice(`Agent name updated to: ${newName}`);
			} catch (error) {
				console.error('Failed to update agent name:', error);
				new Notice('Failed to update agent name. Please try again.');
			}
		}
	}

	private promptForAgentName(currentName: string): Promise<string | null> {
		return new Promise((resolve) => {
			const modal = new Modal(this.app);
			modal.setTitle('Edit Agent Name');
			
			const { contentEl } = modal;
			contentEl.createEl('p', { text: 'Enter a new name for your agent:' });
			
			const input = contentEl.createEl('input', {
				type: 'text',
				value: currentName,
				cls: 'config-input'
			});
			input.style.width = '100%';
			input.style.marginBottom = '16px';
			
			const buttonContainer = contentEl.createEl('div');
			buttonContainer.style.display = 'flex';
			buttonContainer.style.gap = '8px';
			buttonContainer.style.justifyContent = 'flex-end';
			
			const saveButton = buttonContainer.createEl('button', {
				text: 'Save',
				cls: 'mod-cta'
			});
			
			const cancelButton = buttonContainer.createEl('button', {
				text: 'Cancel'
			});
			
			saveButton.addEventListener('click', () => {
				const newName = input.value.trim();
				if (newName) {
					resolve(newName);
					modal.close();
				}
			});
			
			cancelButton.addEventListener('click', () => {
				resolve(null);
				modal.close();
			});
			
			input.addEventListener('keydown', (e) => {
				if (e.key === 'Enter') {
					const newName = input.value.trim();
					if (newName) {
						resolve(newName);
						modal.close();
					}
				}
				if (e.key === 'Escape') {
					resolve(null);
					modal.close();
				}
			});
			
			modal.open();
			input.focus();
			input.select();
		});
	}

	async openAgentConfig() {
		if (!this.plugin.agent) {
			// Try to connect first
			try {
				await this.plugin.connectToLetta();
				if (!this.plugin.agent) {
					new Notice('Please configure your Letta connection first');
					return;
				}
			} catch (error) {
				new Notice('Failed to connect to Letta. Please check your settings.');
				return;
			}
		}

		// Get current agent details and blocks
		const [agentDetails, blocks] = await Promise.all([
			this.plugin.makeRequest(`/v1/agents/${this.plugin.agent?.id}`),
			this.plugin.makeRequest(`/v1/agents/${this.plugin.agent?.id}/core-memory/blocks`)
		]);
		
		const modal = new AgentPropertyModal(this.app, agentDetails, blocks, async (updatedConfig) => {
			try {
				// Extract block updates from config
				const { blockUpdates, ...agentConfig } = updatedConfig;

				// Update agent properties if any changed
				if (Object.keys(agentConfig).length > 0) {
					await this.plugin.makeRequest(`/v1/agents/${this.plugin.agent?.id}`, {
						method: 'PATCH',
						body: agentConfig
					});
				}

				// Update blocks if any changed
				if (blockUpdates && blockUpdates.length > 0) {
					await Promise.all(blockUpdates.map(async (blockUpdate: any) => {
						await this.plugin.makeRequest(`/v1/agents/${this.plugin.agent?.id}/core-memory/blocks/${blockUpdate.label}`, {
							method: 'PATCH',
							body: { value: blockUpdate.value }
						});
					}));
				}

				// Update local agent reference and settings
				if (agentConfig.name && agentConfig.name !== this.plugin.settings.agentName) {
					this.plugin.settings.agentName = agentConfig.name;
					await this.plugin.saveSettings();
					this.updateAgentNameDisplay();
					if (this.plugin.agent) {
						this.plugin.agent.name = agentConfig.name;
					}
				}

				const hasAgentChanges = Object.keys(agentConfig).length > 0;
				const hasBlockChanges = blockUpdates && blockUpdates.length > 0;
				
				if (hasAgentChanges && hasBlockChanges) {
					new Notice('Agent configuration and memory blocks updated successfully');
				} else if (hasAgentChanges) {
					new Notice('Agent configuration updated successfully');
				} else if (hasBlockChanges) {
					new Notice('Memory blocks updated successfully');
				}
			} catch (error) {
				console.error('Failed to update agent configuration:', error);
				new Notice('Failed to update agent configuration. Please try again.');
			}
		});
		
		modal.open();
	}

	async sendMessage() {
		const message = this.messageInput.value.trim();
		if (!message) return;

		// Check connection and auto-connect if needed
		if (!this.plugin.source) {
			this.addMessage('assistant', 'Connecting to Letta...', 'System');
			const connected = await this.plugin.connectToLetta();
			if (!connected) {
				this.addMessage('assistant', '**Connection failed**. Please check your settings and try again.', 'Error');
				return;
			}
		}
		
		// Check if agent is attached after connection
		if (!this.plugin.agent) {
			this.addMessage('assistant', '**No agent selected**. Please select an agent to start chatting.', 'System');
			return;
		}

		// Disable input while processing
		this.messageInput.disabled = true;
		this.sendButton.disabled = true;
		this.sendButton.innerHTML = '<span>Sending...</span>';
		this.sendButton.addClass('letta-button-loading');

		// Add user message to chat
		this.addMessage('user', message);

		// Clear and reset input
		this.messageInput.value = '';
		this.messageInput.style.height = 'auto';

		try {
			if (this.plugin.settings.enableStreaming) {
				// Use streaming API for real-time responses
				// Sending message via streaming API
				
				// Complete any existing streaming message before starting new one
				if (this.currentAssistantMessageEl) {
					// Completing existing streaming message before new message
					this.markStreamingComplete();
					// Clear state but preserve DOM elements
					this.currentReasoningContent = '';
					this.currentAssistantContent = '';
					this.currentAssistantMessageEl = null;
					this.currentReasoningMessageEl = null;
					this.currentToolMessageEl = null;
					this.currentToolCallId = null;
					this.currentToolCallArgs = '';
					this.currentToolCallName = '';
				}
				
				// Reset streaming state (now safe since we completed above)
				this.resetStreamingState();
				
				await this.plugin.sendMessageToAgentStream(
					message,
					(message) => {
						// Handle each streaming message
						this.processStreamingMessage(message);
					},
					(error) => {
						// Handle streaming error
						console.error('Streaming error:', error);
						
						// Check if it's a rate limiting error and handle it specially
						if (error.message && error.message.includes('HTTP 429')) {
							console.log('[Letta Plugin] Rate limit error detected, showing specialized message');
							// Create the proper rate limit message format that includes billing link
							this.addRateLimitMessage(RATE_LIMIT_MESSAGE.create(error.message));
						} else {
							this.addMessage('assistant', `**Streaming Error**: ${error.message}`, 'Error');
						}
					},
					() => {
						// Handle streaming completion
						// Streaming completed
						this.markStreamingComplete();
					}
				);
			} else {
				// Use non-streaming API for more stable responses
				// Sending message via non-streaming API
				const messages = await this.plugin.sendMessageToAgent(message);
				this.processNonStreamingMessages(messages);
			}

		} catch (error: any) {
			console.error('Failed to send message:', error);
			
			// Try fallback to non-streaming API only if streaming was enabled and fails
			if (this.plugin.settings.enableStreaming && 
				(error.message.includes('stream') || error.message.includes('fetch') || error.message.includes('network'))) {
				// Streaming failed, trying non-streaming fallback
				try {
					const messages = await this.plugin.sendMessageToAgent(message);
					this.processNonStreamingMessages(messages);
					return; // Success with fallback
				} catch (fallbackError: any) {
					console.error('Fallback also failed:', fallbackError);
					error = fallbackError; // Use the fallback error for error handling
				}
			}
			
			// Provide specific error messages for common issues
			let errorMessage = `**Error**: ${error.message}`;
			
			if (error.message.includes('429') || error.message.includes('Rate limited')) {
				// Use the special rate limit message display instead of regular error message
				const reason = error.message.includes('model-unknown') ? 'Unknown model configuration' : 'Too many requests';
				this.addRateLimitMessage(RATE_LIMIT_MESSAGE.create(reason));
				return; // Return early to avoid showing regular error message
			} else if (error.message.includes('401') || error.message.includes('Unauthorized')) {
				errorMessage = `**Authentication Error**\n\nYour API key may be invalid or expired. Please check your settings.\n\n*${error.message}*`;
			} else if (error.message.includes('403') || error.message.includes('Forbidden')) {
				errorMessage = `**Access Denied**\n\nYou don't have permission to access this resource. Please check your account permissions.\n\n*${error.message}*`;
			} else if (error.message.includes('500') || error.message.includes('Internal Server Error')) {
				errorMessage = `**Server Error**\n\nLetta's servers are experiencing issues. Please try again in a few moments.\n\n*${error.message}*`;
			} else {
				errorMessage += '\n\nPlease check your connection and try again.';
			}
			
			this.addMessage('assistant', errorMessage, 'Error');
		} finally {
			// Re-enable input
			this.messageInput.disabled = false;
			this.sendButton.disabled = false;
			this.sendButton.innerHTML = '<span>Send</span>';
			this.sendButton.removeClass('letta-button-loading');
			this.messageInput.focus();
		}
	}




	// Clean up wavy lines and prominent styling from previous tool calls
	cleanupPreviousToolCalls() {
		// Remove wavy lines and prominent styling from all previous tool calls
		const allWavyLines = this.chatContainer.querySelectorAll('.letta-tool-curve');
		allWavyLines.forEach(line => line.remove());
		
		const allProminentHeaders = this.chatContainer.querySelectorAll('.letta-tool-prominent');
		allProminentHeaders.forEach(header => header.removeClass('letta-tool-prominent'));
	}

	addToolInteractionMessage(reasoning: string, toolCall: string): HTMLElement {
		// Clean up previous tool calls when a new one starts
		this.cleanupPreviousToolCalls();
		
		// Parse tool call to extract tool name
		let toolName = 'Tool Call';
		try {
			const toolCallObj = JSON.parse(toolCall);
			if (toolCallObj.name) {
				toolName = toolCallObj.name;
			} else if (toolCallObj.function && toolCallObj.function.name) {
				toolName = toolCallObj.function.name;
			}
		} catch (e) {
			// Keep default if parsing fails
		}
		const messageEl = this.chatContainer.createEl('div', { 
			cls: 'letta-message letta-message-tool-interaction' 
		});

		// Create bubble wrapper
		const bubbleEl = messageEl.createEl('div', { cls: 'letta-message-bubble' });

		// Add timestamp
		const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

		// Header with timestamp
		const headerEl = bubbleEl.createEl('div', { cls: 'letta-message-header' });
		const leftSide = headerEl.createEl('div', { cls: 'letta-message-header-left' });
		leftSide.createEl('span', { cls: 'letta-message-title', text: 'Tool Usage' });
		leftSide.createEl('span', { cls: 'letta-message-timestamp', text: timestamp });

		// Reasoning content (only visible if setting is enabled)
		if (reasoning && this.plugin.settings.showReasoning) {
			const reasoningEl = bubbleEl.createEl('div', { cls: 'letta-tool-reasoning' });
			
			// Enhanced markdown-like formatting for reasoning
			let formattedReasoning = reasoning
				// Trim leading and trailing whitespace first
				.trim()
				// Normalize multiple consecutive newlines to double newlines
				.replace(/\n{3,}/g, '\n\n')
				// Handle headers (must be done before other formatting)
				.replace(/^### (.+)$/gm, '<h3>$1</h3>')
				.replace(/^## (.+)$/gm, '<h2>$1</h2>')
				.replace(/^# (.+)$/gm, '<h1>$1</h1>')
				// Handle bold and italic
				.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
				.replace(/\*(.*?)\*/g, '<em>$1</em>')
				.replace(/`([^`]+)`/g, '<code>$1</code>')
				// Handle numbered lists (1. 2. 3. etc.)
				.replace(/^(\d+)\.\s+(.+)$/gm, '<li class="numbered-list">$2</li>')
				// Handle bullet lists (•, -, *)
				.replace(/^[•*-]\s+(.+)$/gm, '<li>$1</li>')
				// Handle double newlines as paragraph breaks first
				.replace(/\n\n/g, '</p><p>')
				// Convert remaining single newlines to <br> tags
				.replace(/\n/g, '<br>');
			
			// Wrap consecutive numbered list items in <ol> tags
			formattedReasoning = formattedReasoning.replace(/(<li class="numbered-list">.*?<\/li>)(\s*<br>\s*<li class="numbered-list">.*?<\/li>)*/g, (match) => {
				// Remove the <br> tags between numbered list items and wrap in <ol>
				const cleanMatch = match.replace(/<br>\s*/g, '');
				return '<ol>' + cleanMatch + '</ol>';
			});
			
			// Wrap consecutive regular list items in <ul> tags
			formattedReasoning = formattedReasoning.replace(/(<li>(?!.*class="numbered-list").*?<\/li>)(\s*<br>\s*<li>(?!.*class="numbered-list").*?<\/li>)*/g, (match) => {
				// Remove the <br> tags between list items and wrap in <ul>
				const cleanMatch = match.replace(/<br>\s*/g, '');
				return '<ul>' + cleanMatch + '</ul>';
			});
			
			// Wrap in paragraphs if needed
			if (formattedReasoning.includes('</p><p>') && !formattedReasoning.startsWith('<')) {
				formattedReasoning = '<p>' + formattedReasoning + '</p>';
			}
			
			reasoningEl.innerHTML = formattedReasoning;
		}

		// Normal expandable display for all tools
		const toolCallHeader = bubbleEl.createEl('div', { cls: 'letta-expandable-header letta-tool-section letta-tool-prominent' });
		
		// Left side with tool name and loading
		const toolLeftSide = toolCallHeader.createEl('div', { cls: 'letta-tool-left' });
		const toolTitle = toolLeftSide.createEl('span', { cls: 'letta-expandable-title letta-tool-name', text: toolName });
		
		// No loading indicator - just the wavy line animation shows loading state
		
		// Curvy connecting line (SVG) - continuous flowing wave
		const connectionLine = toolCallHeader.createEl('div', { cls: 'letta-tool-connection' });
		connectionLine.innerHTML = `
			<svg viewBox="0 0 400 12" class="letta-tool-curve" preserveAspectRatio="none">
				<path d="M 0,6 Q 12.5,2 25,6 Q 37.5,10 50,6 Q 62.5,2 75,6 Q 87.5,10 100,6 Q 112.5,2 125,6 Q 137.5,10 150,6 Q 162.5,2 175,6 Q 187.5,10 200,6 Q 212.5,2 225,6 Q 237.5,10 250,6 Q 262.5,2 275,6 Q 287.5,10 300,6 Q 312.5,2 325,6 Q 337.5,10 350,6 Q 362.5,2 375,6 Q 387.5,10 400,6 Q 412.5,2 425,6 Q 437.5,10 450,6" 
					  stroke="var(--interactive-accent)" 
					  stroke-width="1.5" 
					  fill="none" 
					  opacity="0.7"/>
			</svg>
		`;
		
		// Right side with circle indicator
		const toolRightSide = toolCallHeader.createEl('div', { cls: 'letta-tool-right' });
		const toolCallChevron = toolRightSide.createEl('span', { cls: 'letta-expandable-chevron letta-tool-circle', text: '○' });
		
		const toolCallContent = bubbleEl.createEl('div', { 
			cls: 'letta-expandable-content letta-expandable-collapsed'
		});
		const toolCallPre = toolCallContent.createEl('pre', { cls: 'letta-code-block' });
		
		// Extract and pretty-print just the arguments from the tool call
		let displayContent = toolCall;
		try {
			const toolCallObj = JSON.parse(toolCall);
			if (toolCallObj.arguments) {
				// Parse the arguments if they're a string, otherwise use directly
				let args = toolCallObj.arguments;
				if (typeof args === 'string') {
					args = JSON.parse(args);
				}
				displayContent = JSON.stringify(args, null, 2);
			}
		} catch (e) {
			// If parsing fails, fall back to the original content
		}
		
		toolCallPre.createEl('code', { text: displayContent });
		
		// Add click handler for tool call expand/collapse
		toolCallHeader.addEventListener('click', () => {
			const isCollapsed = toolCallContent.classList.contains('letta-expandable-collapsed');
			if (isCollapsed) {
				toolCallContent.removeClass('letta-expandable-collapsed');
				toolCallChevron.textContent = '●';
			} else {
				toolCallContent.addClass('letta-expandable-collapsed');
				toolCallChevron.textContent = '○';
			}
		});

		// Tool result placeholder (will be filled later)
		const toolResultHeader = bubbleEl.createEl('div', { 
			cls: 'letta-expandable-header letta-tool-section letta-tool-result-pending'
		});
		toolResultHeader.style.display = 'none';
		const toolResultTitle = toolResultHeader.createEl('span', { cls: 'letta-expandable-title', text: 'Tool Result' });
		const toolResultChevron = toolResultHeader.createEl('span', { cls: 'letta-expandable-chevron letta-tool-circle', text: '○' });
		
		const toolResultContent = bubbleEl.createEl('div', { 
			cls: 'letta-expandable-content letta-expandable-collapsed'
		});
		toolResultContent.style.display = 'none';

		// Auto-scroll to bottom
		setTimeout(() => {
			this.chatContainer.scrollTo({
				top: this.chatContainer.scrollHeight,
				behavior: 'smooth'
			});
		}, 10);

		return messageEl;
	}

	addToolResultToMessage(messageEl: HTMLElement, toolResult: string, toolName?: string, toolCallData?: any) {
		const bubbleEl = messageEl.querySelector('.letta-message-bubble');
		if (!bubbleEl) return;

		// Loading state was shown by wavy line animation only (no text indicator)

		// Remove wavy line animation now that tool call is complete
		const wavyLine = bubbleEl.querySelector('.letta-tool-curve');
		if (wavyLine) {
			wavyLine.remove();
		}

		// Remove prominent styling from tool call header now that it's complete
		const toolCallHeader = bubbleEl.querySelector('.letta-tool-prominent');
		if (toolCallHeader) {
			toolCallHeader.removeClass('letta-tool-prominent');
		}

		// Detect tool type - use provided toolName and toolCallData if available, otherwise parse from DOM
		let isArchivalMemorySearch = false;
		let isArchivalMemoryInsert = false;
		let effectiveToolCallData = toolCallData;
		
		if (toolName) {
			// Use provided tool name (for historical messages)
			isArchivalMemorySearch = toolName === 'archival_memory_search';
			isArchivalMemoryInsert = toolName === 'archival_memory_insert';
		} else {
			// Parse from DOM (for streaming messages)
			try {
				const toolCallPre = bubbleEl.querySelector('.letta-code-block code');
				if (toolCallPre) {
					effectiveToolCallData = JSON.parse(toolCallPre.textContent || '{}');
					const detectedToolName = effectiveToolCallData.name || (effectiveToolCallData.function && effectiveToolCallData.function.name);
					isArchivalMemorySearch = detectedToolName === 'archival_memory_search';
					isArchivalMemoryInsert = detectedToolName === 'archival_memory_insert';
				}
			} catch (e) {
				// Ignore parsing errors
			}
		}

		// Show the tool result section
		const toolResultHeader = bubbleEl.querySelector('.letta-tool-result-pending') as HTMLElement;
		const toolResultContent = bubbleEl.querySelector('.letta-expandable-content:last-child') as HTMLElement;
		
		if (toolResultHeader && toolResultContent) {
			// Format the result and get a preview
			const formattedResult = this.formatToolResult(toolResult);
			
			// Always use "Tool Result" as the label (don't show content preview)
			const toolResultTitle = toolResultHeader.querySelector('.letta-expandable-title');
			if (toolResultTitle) {
				toolResultTitle.textContent = 'Tool Result';
			}
			
			// Make visible
			toolResultHeader.style.display = 'flex';
			toolResultContent.style.display = 'block';
			toolResultHeader.removeClass('letta-tool-result-pending');

			// Handle special tool types
			if (isArchivalMemorySearch) {
				this.createArchivalMemoryDisplay(toolResultContent, toolResult);
			} else if (isArchivalMemoryInsert) {
				this.createArchivalMemoryInsertDisplay(toolResultContent, effectiveToolCallData, toolResult);
			} else {
				// Add full content to expandable section for other tools
				const toolResultDiv = toolResultContent.createEl('div', { 
					cls: 'letta-tool-result-text',
					text: formattedResult 
				});
			}

			// Add click handler for tool result expand/collapse
			const toolResultChevron = toolResultHeader.querySelector('.letta-expandable-chevron');
			toolResultHeader.addEventListener('click', () => {
				const isCollapsed = toolResultContent.classList.contains('letta-expandable-collapsed');
				if (isCollapsed) {
					toolResultContent.removeClass('letta-expandable-collapsed');
					if (toolResultChevron) toolResultChevron.textContent = '●';
				} else {
					toolResultContent.addClass('letta-expandable-collapsed');
					if (toolResultChevron) toolResultChevron.textContent = '○';
				}
			});
		}

		// Auto-scroll to bottom
		setTimeout(() => {
			this.chatContainer.scrollTo({
				top: this.chatContainer.scrollHeight,
				behavior: 'smooth'
			});
		}, 10);
	}

	createArchivalMemoryDisplay(container: HTMLElement, toolResult: string) {
		try {
			let result;
			let rawContent = toolResult.trim();
			
			// Handle JSON-encoded string containing Python tuple format
			if (rawContent.startsWith('"') && rawContent.endsWith('"')) {
				const parsedString = JSON.parse(rawContent);
				
				if (parsedString.startsWith('(') && parsedString.endsWith(')')) {
					// Extract array from Python tuple: ([...], count) -> [...]
					const innerContent = parsedString.slice(1, -1);
					const match = innerContent.match(/^(.+),\s*(\d+)$/);
					
					if (match) {
						const arrayString = match[1];
						// Extract memory items manually from Python dict format
						const dictPattern = /\{'timestamp':\s*'([^']+)',\s*'content':\s*'((?:[^'\\]|\\.)*)'\}/g;
						const memoryItems = [];
						let dictMatch;
						
						while ((dictMatch = dictPattern.exec(arrayString)) !== null) {
							const timestamp = dictMatch[1];
							const content = dictMatch[2]
								.replace(/\\'/g, "'")
								.replace(/\\n/g, '\n')
								.replace(/\\t/g, '\t')
								.replace(/\\"/g, '"');
							memoryItems.push({ timestamp, content });
						}
						
						result = memoryItems;
					} else {
						result = JSON.parse(parsedString);
					}
				} else {
					result = JSON.parse(parsedString);
				}
			} else if (rawContent.startsWith('(') && rawContent.endsWith(')')) {
				// Handle direct Python tuple format
				const innerContent = rawContent.slice(1, -1);
				const match = innerContent.match(/^(.+),\s*(\d+)$/);
				if (match) {
					let arrayString = match[1];
					arrayString = arrayString
						.replace(/None/g, 'null')
						.replace(/True/g, 'true')
						.replace(/False/g, 'false')
						.replace(/'/g, '"');
					result = JSON.parse(arrayString);
				} else {
					result = JSON.parse(rawContent);
				}
			} else {
				result = JSON.parse(rawContent);
			}
			
			// Check if it's an array (archival memory search results)
			if (Array.isArray(result) && result.length > 0) {
				const memoryList = container.createEl('div', { cls: 'letta-memory-list' });
				
				// Filter out non-memory items (like count at the end)
				const memoryItems = result.filter(item => 
					typeof item === 'object' && 
					item !== null && 
					(item.content || item.text || item.message)
				);
				
				memoryItems.forEach((item, index) => {
					// Create expandable memory item
					const memoryItem = memoryList.createEl('div', { cls: 'letta-memory-item' });
					
					// Extract content and timestamp
					const content = item.content || item.text || item.message || '';
					const timestamp = item.timestamp || '';
					
					// Create expandable header
					const itemHeader = memoryItem.createEl('div', { 
						cls: 'letta-memory-item-header letta-expandable-header' 
					});
					
					// Add expand/collapse indicator
					const chevron = itemHeader.createEl('span', { 
						cls: 'letta-expandable-chevron',
						text: '○'
					});
					
					// Add memory item title with timestamp
					const titleText = "";
					
					itemHeader.createEl('span', { 
						cls: 'letta-memory-title',
						text: titleText
					});
					
					// Add preview of content (first 80 characters)
					const preview = content.length > 80 ? 
						content.substring(0, 80).trim() + '...' : 
						content;
					
					itemHeader.createEl('span', { 
						cls: 'letta-memory-preview',
						text: preview
					});
					
					// Create collapsible content area
					const itemContent = memoryItem.createEl('div', { 
						cls: 'letta-memory-content letta-expandable-content letta-expandable-collapsed'
					});
					
					// Apply markdown formatting to the full content
					let formattedContent = content
						.trim()
						.replace(/\n{3,}/g, '\n\n')
						// Handle headers
						.replace(/^### (.+)$/gm, '<h3>$1</h3>')
						.replace(/^## (.+)$/gm, '<h2>$1</h2>')
						.replace(/^# (.+)$/gm, '<h1>$1</h1>')
						// Handle bold and italic
						.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
						.replace(/\*(.*?)\*/g, '<em>$1</em>')
						.replace(/`([^`]+)`/g, '<code>$1</code>')
						// Handle bullet lists
						.replace(/^[•*-]\s+(.+)$/gm, '<li>$1</li>')
						// Convert line breaks to HTML
						.replace(/\n/g, '<br>');
					
					// Wrap consecutive list items in ul tags
					formattedContent = formattedContent.replace(/(<li>.*?<\/li>)(?:\s*<li>.*?<\/li>)*/g, (match: string) => {
						return '<ul>' + match + '</ul>';
					});
					
					itemContent.innerHTML = formattedContent;
					
					// Add click handler for expand/collapse
					itemHeader.addEventListener('click', () => {
						const isCollapsed = itemContent.classList.contains('letta-expandable-collapsed');
						if (isCollapsed) {
							itemContent.removeClass('letta-expandable-collapsed');
							chevron.textContent = '●';
						} else {
							itemContent.addClass('letta-expandable-collapsed');
							chevron.textContent = '○';
						}
					});
				});
				
				// Add summary at the bottom
				if (memoryItems.length > 0) {
					const summary = container.createEl('div', { cls: 'letta-memory-summary' });
					summary.createEl('span', { 
						text: `Found ${memoryItems.length} memory item${memoryItems.length === 1 ? '' : 's'}`
					});
				}
				
			} else if (result && typeof result === 'object') {
				// Single item or different structure
				const singleItem = container.createEl('div', { cls: 'letta-memory-single' });
				
				let content = result.content || result.text || result.message || JSON.stringify(result, null, 2);
				let formattedContent = content
					.trim()
					.replace(/\n{3,}/g, '\n\n')
					.replace(/^### (.+)$/gm, '<h3>$1</h3>')
					.replace(/^## (.+)$/gm, '<h2>$1</h2>')
					.replace(/^# (.+)$/gm, '<h1>$1</h1>')
					.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
					.replace(/\*(.*?)\*/g, '<em>$1</em>')
					.replace(/`([^`]+)`/g, '<code>$1</code>')
					.replace(/\n/g, '<br>');
				
				singleItem.innerHTML = formattedContent;
			} else {
				// Fallback to raw display
				const fallback = container.createEl('div', { cls: 'letta-tool-result-text' });
				fallback.textContent = toolResult;
			}
		} catch (e) {
			// If parsing fails, fall back to raw display
			const fallback = container.createEl('div', { cls: 'letta-tool-result-text' });
			fallback.textContent = toolResult;
		}
	}

	createArchivalMemoryInsertDisplay(container: HTMLElement, toolCallData: any, toolResult: string) {
		try {
			// Extract the content from the tool call arguments
			let memoryContent = '';
			
			if (toolCallData) {
				let args = null;
				
				// Try different argument formats
				if (toolCallData.arguments) {
					// Standard format: { arguments: "..." } or { arguments: {...} }
					if (typeof toolCallData.arguments === 'string') {
						try {
							args = JSON.parse(toolCallData.arguments);
						} catch (e) {
							console.warn('[Letta Plugin] Failed to parse arguments string:', toolCallData.arguments);
						}
					} else {
						args = toolCallData.arguments;
					}
				} else if (toolCallData.function && toolCallData.function.arguments) {
					// OpenAI format: { function: { arguments: "..." } }
					if (typeof toolCallData.function.arguments === 'string') {
						try {
							args = JSON.parse(toolCallData.function.arguments);
						} catch (e) {
							console.warn('[Letta Plugin] Failed to parse function arguments string:', toolCallData.function.arguments);
						}
					} else {
						args = toolCallData.function.arguments;
					}
				}
				
				// Extract content from parsed arguments
				if (args && args.content) {
					memoryContent = args.content;
				}
			}
			
			if (memoryContent) {
				// Add a simple header to indicate this is the content being stored
				const header = container.createEl('div', { cls: 'letta-memory-insert-header' });
				header.createEl('span', { cls: 'letta-memory-insert-label', text: 'Content stored in archival memory:' });
				
				// Create simple content area with markdown formatting
				const contentArea = container.createEl('div', { cls: 'letta-memory-insert-content' });
				
				// Apply basic markdown formatting to the content
				let formattedContent = memoryContent
					.trim()
					.replace(/\n{3,}/g, '\n\n')
					// Handle headers
					.replace(/^### (.+)$/gm, '<h3>$1</h3>')
					.replace(/^## (.+)$/gm, '<h2>$1</h2>')
					.replace(/^# (.+)$/gm, '<h1>$1</h1>')
					// Handle bold and italic
					.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
					.replace(/\*(.*?)\*/g, '<em>$1</em>')
					.replace(/`([^`]+)`/g, '<code>$1</code>')
					// Convert line breaks to HTML
					.replace(/\n/g, '<br>');
				
				contentArea.innerHTML = formattedContent;
			} else {
				// Fallback if we can't extract the content
				const fallback = container.createEl('div', { cls: 'letta-tool-result-text' });
				fallback.textContent = `Memory insert completed. Result: ${toolResult}`;
			}
		} catch (e) {
			console.error('[Letta Plugin] Error creating archival memory insert display:', e);
			// If parsing fails, fall back to raw display
			const fallback = container.createEl('div', { cls: 'letta-tool-result-text' });
			fallback.textContent = `Memory insert completed. Result: ${toolResult}`;
		}
	}


	processNonStreamingMessages(messages: any[]) {
		// Processing non-streaming messages
		
		// Process response messages (fallback for when streaming fails)
		let tempReasoning = '';
		let tempToolMessage: HTMLElement | null = null;
		
		for (const responseMessage of messages) {
			// Handle system messages - capture system_alert for hidden viewing, skip heartbeats
			if (responseMessage.type === 'system_alert' || 
				(responseMessage.message && typeof responseMessage.message === 'string' && responseMessage.message.includes('prior messages have been hidden'))) {
				// Capturing non-streaming system_alert message
				this.addSystemMessage(responseMessage);
				continue;
			}
			
			// Handle heartbeat messages - show typing indicator
			if (responseMessage.type === 'heartbeat' || 
				responseMessage.message_type === 'heartbeat' ||
				responseMessage.role === 'heartbeat' ||
				(responseMessage.reason && (responseMessage.reason.includes('automated system message') ||
											responseMessage.reason.includes('Function call failed, returning control') ||
											responseMessage.reason.includes('request_heartbeat=true')))) {
				this.handleHeartbeat();
				continue;
			}
			
			switch (responseMessage.message_type) {
				case 'reasoning_message':
					if (responseMessage.reasoning) {
						// Accumulate reasoning for the next tool call or assistant message
						tempReasoning += responseMessage.reasoning;
					}
					break;
				case 'usage_statistics':
					// Received non-streaming usage statistics
					this.addUsageStatisticsToLastMessage(responseMessage);
					break;
				case 'tool_call_message':
					if (responseMessage.tool_call) {
						// Create tool interaction with reasoning
						tempToolMessage = this.addToolInteractionMessage(
							tempReasoning, 
							JSON.stringify(responseMessage.tool_call, null, 2)
						);
						// Clear reasoning after using it
						tempReasoning = '';
					}
					break;
				case 'tool_return_message':
					if (responseMessage.tool_return && tempToolMessage) {
						// Add tool result to the existing tool interaction message
						this.addToolResultToMessage(tempToolMessage, 
							JSON.stringify(responseMessage.tool_return, null, 2));
						// Clear the temp tool message reference
						tempToolMessage = null;
					}
					break;
				case 'assistant_message':
					// Processing assistant message
					
					// Try multiple possible content fields
					let content = responseMessage.content || responseMessage.text || responseMessage.message;
					
					// Handle array content by extracting text from array elements
					if (Array.isArray(content)) {
						content = content.map(item => {
							if (typeof item === 'string') {
								return item;
							} else if (item && typeof item === 'object') {
								return item.text || item.content || item.message || item.value || JSON.stringify(item);
							}
							return String(item);
						}).join('');
						// Non-streaming: Converted array content to string
					}
					
					if (content) {
						// Filter out system prompt content and use accumulated reasoning
						const filteredContent = this.filterSystemPromptContent(content);
						this.addMessage('assistant', filteredContent, this.plugin.settings.agentName, 
							tempReasoning || undefined);
						// Clear temp reasoning after using it
						tempReasoning = '';
					} else {
						console.warn('[Letta Plugin] Assistant message has no recognizable content field:', Object.keys(responseMessage));
						// Fallback: display the whole message structure for debugging
						this.addMessage('assistant', `**Debug**: ${JSON.stringify(responseMessage, null, 2)}`, 'Debug');
					}
					break;
					
				case 'heartbeat':
					// Skip heartbeat messages - should already be filtered above
					// Heartbeat message reached switch statement
					break;
					
				default:
					// Unrecognized message type
					
					// Fallback handling for messages without proper message_type
					if (responseMessage.content || responseMessage.text || responseMessage.message) {
						let content = responseMessage.content || responseMessage.text || responseMessage.message;
						
						// Handle array content by extracting text from array elements
						if (Array.isArray(content)) {
							content = content.map(item => {
								if (typeof item === 'string') {
									return item;
								} else if (item && typeof item === 'object') {
									return item.text || item.content || item.message || item.value || JSON.stringify(item);
								}
								return String(item);
							}).join('');
							// Fallback: Converted array content to string
						}
						
						const filteredContent = this.filterSystemPromptContent(content);
						this.addMessage('assistant', filteredContent, this.plugin.settings.agentName);
					} else {
						// Last resort: show the JSON structure for debugging
						console.warn('[Letta Plugin] Message has no recognizable content, displaying as debug info');
						this.addMessage('assistant', `**Debug**: Unknown message structure\n\`\`\`json\n${JSON.stringify(responseMessage, null, 2)}\n\`\`\``, 'Debug');
					}
					break;
			}
		}
	}

	processStreamingMessage(message: any) {
		
		// Handle system messages - capture system_alert for hidden viewing, skip heartbeats
		if (message.type === 'system_alert' || 
			(message.message && typeof message.message === 'string' && message.message.includes('prior messages have been hidden'))) {
			// Capturing streaming system_alert message
			this.addSystemMessage(message);
			return;
		}
		
		// Handle heartbeat messages - show typing indicator
		if (message.type === 'heartbeat' || 
			message.message_type === 'heartbeat' ||
			message.role === 'heartbeat' ||
			(message.reason && (message.reason.includes('automated system message') ||
								message.reason.includes('Function call failed, returning control') ||
								message.reason.includes('request_heartbeat=true')))) {
			this.handleHeartbeat();
			return;
		}
		
		// Filter out login messages - check both direct type and content containing login JSON
		if (message.type === 'login' || message.message_type === 'login') {
			return;
		}
		
		// Check if this is a user_message containing login JSON
		if (message.message_type === 'user_message' && message.content && typeof message.content === 'string') {
			try {
				const parsedContent = JSON.parse(message.content.trim());
				if (parsedContent.type === 'login') {
					return;
				}
			} catch (e) {
				// Not JSON, continue processing normally
			}
		}
		
		// Handle usage statistics
		if (message.message_type === 'usage_statistics') {
			// Received usage statistics
			this.addUsageStatistics(message);
			return;
		}
		
		switch (message.message_type) {
			case 'reasoning_message':
				if (message.reasoning) {
					// For streaming, we accumulate reasoning and show it in real-time
					this.updateOrCreateReasoningMessage(message.reasoning);
				}
				break;
			case 'tool_call_message':
				if (message.tool_call) {
					// Handle streaming tool call chunks
					// Received tool call message
					this.handleStreamingToolCall(message.tool_call);
				} else {
					// Received tool_call_message but no tool_call field
				}
				break;
			case 'tool_return_message':
				if (message.tool_return) {
					// Tool return received
					// Update the current tool interaction with the result
					this.updateStreamingToolResult(message.tool_return);
					// Clear the current tool call state since it's complete
					this.currentToolCallId = null;
					this.currentToolCallArgs = '';
					this.currentToolCallName = '';
				}
				break;
			case 'assistant_message':
				// Processing streaming assistant message
				
				// Try multiple possible content fields
				let content = message.content || message.text || message.message || message.assistant_message;
				
				// Handle array content by extracting text from array elements
				if (Array.isArray(content)) {
					content = content.map(item => {
						if (typeof item === 'string') {
							return item;
						} else if (item && typeof item === 'object') {
							return item.text || item.content || item.message || item.value || JSON.stringify(item);
						}
						return String(item);
					}).join('');
					// Streaming: Converted array content to string
				}
				
				if (content) {
					// Filter out system prompt content
					const filteredContent = this.filterSystemPromptContent(content);
					this.updateOrCreateAssistantMessage(filteredContent);
				} else {
					console.warn('[Letta Plugin] Streaming assistant message has no recognizable content field:', Object.keys(message));
				}
				break;
				
			case 'heartbeat':
				// Skip heartbeat messages - should already be filtered above
				// Heartbeat message reached switch statement
				break;
				
			default:
				// Unrecognized streaming message type
				break;
		}
	}

	// State for streaming messages
	private currentReasoningContent: string = '';
	private currentAssistantContent: string = '';
	private currentAssistantMessageEl: HTMLElement | null = null;
	private currentReasoningMessageEl: HTMLElement | null = null;
	private currentToolMessageEl: HTMLElement | null = null;
	private currentToolCallId: string | null = null;
	private currentToolCallArgs: string = '';
	private currentToolCallName: string = '';

	updateOrCreateReasoningMessage(reasoning: string) {
		// Only accumulate reasoning content, don't create standalone messages
		// Reasoning will be displayed as part of tool interactions instead
		this.currentReasoningContent += reasoning;
	}

	updateOrCreateAssistantMessage(content: string) {
		this.currentAssistantContent += content;
		
		// Create or update assistant message
		if (!this.currentAssistantMessageEl) {
			this.currentAssistantMessageEl = this.chatContainer.createEl('div', { 
				cls: 'letta-message letta-message-assistant' 
			});
			const bubbleEl = this.currentAssistantMessageEl.createEl('div', { cls: 'letta-message-bubble' });
			
			// Add header
			const headerEl = bubbleEl.createEl('div', { cls: 'letta-message-header' });
			const leftSide = headerEl.createEl('div', { cls: 'letta-message-header-left' });
			leftSide.createEl('span', { cls: 'letta-message-title', text: this.plugin.settings.agentName });
			leftSide.createEl('span', { cls: 'letta-message-timestamp', text: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) });
			
			// Add reasoning content if available and setting is enabled
			if (this.currentReasoningContent && this.plugin.settings.showReasoning) {
				const reasoningEl = bubbleEl.createEl('div', { cls: 'letta-tool-reasoning' });
				
				// Apply markdown formatting to reasoning
				let formattedReasoning = this.currentReasoningContent
					.trim()
					.replace(/\n{3,}/g, '\n\n')
					.replace(/^### (.+)$/gm, '<h3>$1</h3>')
					.replace(/^## (.+)$/gm, '<h2>$1</h2>')
					.replace(/^# (.+)$/gm, '<h1>$1</h1>')
					.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
					.replace(/\*(.*?)\*/g, '<em>$1</em>')
					.replace(/`([^`]+)`/g, '<code>$1</code>')
					.replace(/^(\d+)\.\s+(.+)$/gm, '<li class="numbered-list">$2</li>')
					.replace(/^[•*-]\s+(.+)$/gm, '<li>$1</li>')
					.replace(/\n\n/g, '</p><p>')
					.replace(/\n/g, '<br>');
				
				// Wrap consecutive numbered list items in <ol> tags
				formattedReasoning = formattedReasoning.replace(/(<li class="numbered-list">.*?<\/li>)(\s*<br>\s*<li class="numbered-list">.*?<\/li>)*/g, (match) => {
					const cleanMatch = match.replace(/<br>\s*/g, '');
					return '<ol>' + cleanMatch + '</ol>';
				});
				
				// Wrap consecutive regular list items in <ul> tags
				formattedReasoning = formattedReasoning.replace(/(<li>(?!.*class="numbered-list").*?<\/li>)(\s*<br>\s*<li>(?!.*class="numbered-list").*?<\/li>)*/g, (match) => {
					const cleanMatch = match.replace(/<br>\s*/g, '');
					return '<ul>' + cleanMatch + '</ul>';
				});
				
				// Wrap in paragraphs if needed
				if (formattedReasoning.includes('</p><p>') && !formattedReasoning.startsWith('<')) {
					formattedReasoning = '<p>' + formattedReasoning + '</p>';
				}
				
				reasoningEl.innerHTML = formattedReasoning;
				// Displayed reasoning content in assistant message
			}
			
			// Add content container
			bubbleEl.createEl('div', { cls: 'letta-message-content' });
		}
		
		// Update the assistant content with markdown formatting
		const contentEl = this.currentAssistantMessageEl.querySelector('.letta-message-content');
		if (contentEl) {
			// Apply the same markdown formatting as in addMessage
			let formattedContent = this.currentAssistantContent
				.trim()
				.replace(/\n{3,}/g, '\n\n')
				.replace(/^### (.+)$/gm, '<h3>$1</h3>')
				.replace(/^## (.+)$/gm, '<h2>$1</h2>')
				.replace(/^# (.+)$/gm, '<h1>$1</h1>')
				.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
				.replace(/\*(.*?)\*/g, '<em>$1</em>')
				.replace(/`([^`]+)`/g, '<code>$1</code>')
				.replace(/^(\d+)\.\s+(.+)$/gm, '<li class="numbered-list">$2</li>')
				.replace(/^[•*-]\s+(.+)$/gm, '<li>$1</li>')
				.replace(/\n\n/g, '</p><p>')
				.replace(/\n/g, '<br>');
			
			// Wrap consecutive numbered list items in <ol> tags
			formattedContent = formattedContent.replace(/(<li class="numbered-list">.*?<\/li>)(\s*<br>\s*<li class="numbered-list">.*?<\/li>)*/g, (match) => {
				const cleanMatch = match.replace(/<br>\s*/g, '');
				return '<ol>' + cleanMatch + '</ol>';
			});
			
			// Wrap consecutive regular list items in <ul> tags
			formattedContent = formattedContent.replace(/(<li>(?!.*class="numbered-list").*?<\/li>)(\s*<br>\s*<li>(?!.*class="numbered-list").*?<\/li>)*/g, (match) => {
				const cleanMatch = match.replace(/<br>\s*/g, '');
				return '<ul>' + cleanMatch + '</ul>';
			});
			
			// Wrap in paragraphs if needed
			if (formattedContent.includes('</p><p>') && !formattedContent.startsWith('<')) {
				formattedContent = '<p>' + formattedContent + '</p>';
			}
			
			contentEl.innerHTML = formattedContent;
		}
		
		// Scroll to bottom
		setTimeout(() => {
			this.chatContainer.scrollTo({
				top: this.chatContainer.scrollHeight,
				behavior: 'smooth'
			});
		}, 10);
	}

	createStreamingToolInteraction(toolCall: any) {
		// Clean up previous tool calls
		this.cleanupPreviousToolCalls();
		
		// Parse tool call to extract tool name
		let toolName = 'Tool Call';
		try {
			if (toolCall.name) {
				toolName = toolCall.name;
			} else if (toolCall.function && toolCall.function.name) {
				toolName = toolCall.function.name;
			}
		} catch (e) {
			// Keep default if parsing fails
		}
		
		// Create tool interaction message
		this.currentToolMessageEl = this.chatContainer.createEl('div', { 
			cls: 'letta-message letta-message-tool-interaction' 
		});

		const bubbleEl = this.currentToolMessageEl.createEl('div', { cls: 'letta-message-bubble' });

		// Add timestamp
		const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

		// Header with timestamp
		const headerEl = bubbleEl.createEl('div', { cls: 'letta-message-header' });
		const leftSide = headerEl.createEl('div', { cls: 'letta-message-header-left' });
		leftSide.createEl('span', { cls: 'letta-message-title', text: 'Tool Usage' });
		leftSide.createEl('span', { cls: 'letta-message-timestamp', text: timestamp });

		// Add reasoning content if available and setting is enabled
		console.log('[Letta Plugin] Creating tool interaction with reasoning content:', this.currentReasoningContent);
		console.log('[Letta Plugin] showReasoning setting:', this.plugin.settings.showReasoning);
		if (this.currentReasoningContent && this.plugin.settings.showReasoning) {
			const reasoningEl = bubbleEl.createEl('div', { cls: 'letta-tool-reasoning' });
			
			// Apply markdown formatting to reasoning
			let formattedReasoning = this.currentReasoningContent
				.trim()
				.replace(/\n{3,}/g, '\n\n')
				.replace(/^### (.+)$/gm, '<h3>$1</h3>')
				.replace(/^## (.+)$/gm, '<h2>$1</h2>')
				.replace(/^# (.+)$/gm, '<h1>$1</h1>')
				.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
				.replace(/\*(.*?)\*/g, '<em>$1</em>')
				.replace(/`([^`]+)`/g, '<code>$1</code>')
				.replace(/^(\d+)\.\s+(.+)$/gm, '<li class="numbered-list">$2</li>')
				.replace(/^[•*-]\s+(.+)$/gm, '<li>$1</li>')
				.replace(/\n\n/g, '</p><p>')
				.replace(/\n/g, '<br>');
			
			// Wrap consecutive numbered list items in <ol> tags
			formattedReasoning = formattedReasoning.replace(/(<li class="numbered-list">.*?<\/li>)(\s*<br>\s*<li class="numbered-list">.*?<\/li>)*/g, (match) => {
				const cleanMatch = match.replace(/<br>\s*/g, '');
				return '<ol>' + cleanMatch + '</ol>';
			});
			
			// Wrap consecutive regular list items in <ul> tags
			formattedReasoning = formattedReasoning.replace(/(<li>(?!.*class="numbered-list").*?<\/li>)(\s*<br>\s*<li>(?!.*class="numbered-list").*?<\/li>)*/g, (match) => {
				const cleanMatch = match.replace(/<br>\s*/g, '');
				return '<ul>' + cleanMatch + '</ul>';
			});
			
			// Wrap in paragraphs if needed
			if (formattedReasoning.includes('</p><p>') && !formattedReasoning.startsWith('<')) {
				formattedReasoning = '<p>' + formattedReasoning + '</p>';
			}
			
			reasoningEl.innerHTML = formattedReasoning;
			console.log('[Letta Plugin] Successfully created reasoning element with content');
		} else {
			console.log('[Letta Plugin] Not displaying reasoning content - either empty or setting disabled');
			console.log('[Letta Plugin] Reasoning content length:', this.currentReasoningContent.length);
			console.log('[Letta Plugin] showReasoning setting:', this.plugin.settings.showReasoning);
		}

		// Tool call expandable section
		const toolCallHeader = bubbleEl.createEl('div', { cls: 'letta-expandable-header letta-tool-section letta-tool-prominent' });
		
		const toolLeftSide = toolCallHeader.createEl('div', { cls: 'letta-tool-left' });
		toolLeftSide.createEl('span', { cls: 'letta-expandable-title letta-tool-name', text: toolName });
		
		// Curvy connecting line (SVG)
		const connectionLine = toolCallHeader.createEl('div', { cls: 'letta-tool-connection' });
		connectionLine.innerHTML = `
			<svg viewBox="0 0 400 12" class="letta-tool-curve" preserveAspectRatio="none">
				<path d="M 0,6 Q 12.5,2 25,6 Q 37.5,10 50,6 Q 62.5,2 75,6 Q 87.5,10 100,6 Q 112.5,2 125,6 Q 137.5,10 150,6 Q 162.5,2 175,6 Q 187.5,10 200,6 Q 212.5,2 225,6 Q 237.5,10 250,6 Q 262.5,2 275,6 Q 287.5,10 300,6 Q 312.5,2 325,6 Q 337.5,10 350,6 Q 362.5,2 375,6 Q 387.5,10 400,6 Q 412.5,2 425,6 Q 437.5,10 450,6" 
					  stroke="var(--interactive-accent)" 
					  stroke-width="1.5" 
					  fill="none" 
					  opacity="0.7"/>
			</svg>
		`;
		
		const toolRightSide = toolCallHeader.createEl('div', { cls: 'letta-tool-right' });
		toolRightSide.createEl('span', { cls: 'letta-expandable-chevron letta-tool-circle', text: '○' });
		
		const toolCallContent = bubbleEl.createEl('div', { 
			cls: 'letta-expandable-content letta-expandable-collapsed'
		});
		const toolCallPre = toolCallContent.createEl('pre', { cls: 'letta-code-block' });
		toolCallPre.createEl('code', { text: JSON.stringify(toolCall, null, 2) });
		
		// Add click handler for tool call expand/collapse
		toolCallHeader.addEventListener('click', () => {
			const isCollapsed = toolCallContent.classList.contains('letta-expandable-collapsed');
			if (isCollapsed) {
				toolCallContent.removeClass('letta-expandable-collapsed');
				toolCallHeader.querySelector('.letta-expandable-chevron')!.textContent = '●';
			} else {
				toolCallContent.addClass('letta-expandable-collapsed');
				toolCallHeader.querySelector('.letta-expandable-chevron')!.textContent = '○';
			}
		});

		// Tool result placeholder (will be filled later)
		const toolResultHeader = bubbleEl.createEl('div', { 
			cls: 'letta-expandable-header letta-tool-section letta-tool-result-pending'
		});
		toolResultHeader.style.display = 'none';
		toolResultHeader.createEl('span', { cls: 'letta-expandable-title', text: 'Tool Result' });
		toolResultHeader.createEl('span', { cls: 'letta-expandable-chevron letta-tool-circle', text: '○' });
		
		const toolResultContent = bubbleEl.createEl('div', { 
			cls: 'letta-expandable-content letta-expandable-collapsed'
		});
		toolResultContent.style.display = 'none';

		// Auto-scroll to bottom
		setTimeout(() => {
			this.chatContainer.scrollTo({
				top: this.chatContainer.scrollHeight,
				behavior: 'smooth'
			});
		}, 10);

		// Clear reasoning content after using it
		this.currentReasoningContent = '';
		console.log('[Letta Plugin] Cleared reasoning content after creating tool interaction');
	}

	updateStreamingToolResult(toolReturn: any) {
		if (!this.currentToolMessageEl) return;
		
		// Use the unified addToolResultToMessage method for consistency
		this.addToolResultToMessage(this.currentToolMessageEl, JSON.stringify(toolReturn, null, 2));
		
		// Auto-scroll to bottom
		setTimeout(() => {
			this.chatContainer.scrollTo({
				top: this.chatContainer.scrollHeight,
				behavior: 'smooth'
			});
		}, 10);
	}


	resetStreamingState() {
		// Remove any existing streaming assistant message from DOM
		if (this.currentAssistantMessageEl) {
			this.currentAssistantMessageEl.remove();
		}
		
		// Remove any existing streaming tool message from DOM
		if (this.currentToolMessageEl) {
			this.currentToolMessageEl.remove();
		}
		
		this.currentReasoningContent = '';
		this.currentAssistantContent = '';
		this.currentAssistantMessageEl = null;
		this.currentReasoningMessageEl = null;
		this.currentToolMessageEl = null;
		this.currentToolCallId = null;
		this.currentToolCallArgs = '';
		this.currentToolCallName = '';
	}

	markStreamingComplete() {
		// Remove streaming cursor from assistant message
		if (this.currentAssistantMessageEl) {
			this.currentAssistantMessageEl.classList.add('streaming-complete');
		}
		
		// Hide typing indicator
		this.hideTypingIndicator();
	}

	addUsageStatistics(usageMessage: any) {
		// Add usage statistics to the current streaming assistant message
		if (!this.currentAssistantMessageEl) return;

		this.addUsageStatsToElement(this.currentAssistantMessageEl, usageMessage);
	}

	addUsageStatisticsToLastMessage(usageMessage: any) {
		// Add usage statistics to the most recent assistant message in the chat
		const assistantMessages = this.chatContainer.querySelectorAll('.letta-message-assistant');
		if (assistantMessages.length === 0) return;

		const lastAssistantMessage = assistantMessages[assistantMessages.length - 1] as HTMLElement;
		this.addUsageStatsToElement(lastAssistantMessage, usageMessage);
	}

	addUsageStatsToElement(messageEl: HTMLElement, usageMessage: any) {
		const bubbleEl = messageEl.querySelector('.letta-message-bubble');
		if (!bubbleEl) return;

		// Check if usage info already exists to avoid duplicates
		const existingUsage = bubbleEl.querySelector('.letta-usage-stats');
		if (existingUsage) return;

		// Create usage statistics display
		const usageEl = bubbleEl.createEl('div', { cls: 'letta-usage-stats' });
		
		const parts = [];
		
		if (usageMessage.total_tokens) {
			parts.push(`${usageMessage.total_tokens.toLocaleString()} tokens`);
		} else {
			// Fallback to individual token counts
			if (usageMessage.prompt_tokens || usageMessage.completion_tokens) {
				const prompt = usageMessage.prompt_tokens || 0;
				const completion = usageMessage.completion_tokens || 0;
				const total = prompt + completion;
				parts.push(`${total.toLocaleString()} tokens`);
			}
		}
		
		if (usageMessage.step_count) {
			parts.push(`${usageMessage.step_count} step${usageMessage.step_count === 1 ? '' : 's'}`);
		}
		
		if (parts.length > 0) {
			usageEl.textContent = parts.join(' • ');
		}
	}

	handleStreamingToolCall(toolCall: any) {
		const toolCallId = toolCall.tool_call_id || toolCall.id;
		const toolName = toolCall.name || (toolCall.function && toolCall.function.name) || 'Tool Call';
		const toolArgs = toolCall.arguments || toolCall.args || '';
		
		// Check if this is a new tool call or a continuation of the current one
		if (this.currentToolCallId !== toolCallId) {
			// New tool call - create the interaction
			console.log('[Letta Plugin] Creating new tool interaction with reasoning content:', this.currentReasoningContent);
			this.currentToolCallId = toolCallId;
			this.currentToolCallName = toolName;
			this.currentToolCallArgs = toolArgs;
			this.createStreamingToolInteraction(toolCall);
		} else {
			// Continuation of current tool call - accumulate arguments
			this.currentToolCallArgs += toolArgs;
			
			// Update the tool call display with accumulated arguments
			if (this.currentToolMessageEl) {
				const toolCallPre = this.currentToolMessageEl.querySelector('.letta-code-block code');
				if (toolCallPre) {
					const updatedToolCall = {
						...toolCall,
						arguments: this.currentToolCallArgs
					};
					toolCallPre.textContent = JSON.stringify(updatedToolCall, null, 2);
				}
			}
		}
		
		console.log(`[Letta Plugin] Tool call chunk received: ${toolCallId}, args: "${toolArgs}" (accumulated: "${this.currentToolCallArgs}")`);
	}



	async openAgentSwitcher() {
		if (!this.plugin.settings.lettaApiKey) {
			new Notice('Please configure your Letta API key first');
			return;
		}

		const isCloudInstance = this.plugin.settings.lettaBaseUrl.includes('api.letta.com');
		
		if (isCloudInstance) {
			// For cloud instances, check if we have a valid project ID
			const projectSlug = this.plugin.settings.lettaProjectSlug;
			
			// Check if project slug looks like a proper UUID or known invalid values
			const isValidProjectId = projectSlug && 
				projectSlug !== 'obsidian-vault' && 
				projectSlug !== 'default-project' && 
				projectSlug !== 'filesystem' &&
				(projectSlug.includes('-') && projectSlug.length > 10); // Basic UUID-like check
				
			if (!isValidProjectId) {
				// Invalid project slug for cloud instances, show project selector
				new Notice('Please select a valid project first');
				this.openProjectSelector();
				return;
			}
			
			// Show agents from current project first  
			const currentProject = { 
				id: projectSlug, 
				name: projectSlug || 'Current Project',
				slug: projectSlug 
			};
			this.openAgentSelector(currentProject, true); // true indicates it's the current project
		} else {
			// For local instances, show all agents directly
			this.openAgentSelector();
		}
	}

	async openProjectSelector() {
		const modal = new Modal(this.app);
		modal.setTitle('Select Project');
		
		const { contentEl } = modal;
		contentEl.style.width = '700px';
		contentEl.style.height = '500px';
		
		// Loading state
		const loadingEl = contentEl.createEl('div', { 
			text: 'Loading projects and counting agents...', 
			cls: 'letta-memory-empty' 
		});
		
		try {
			console.log('[Letta Plugin] Making request to /v1/projects');
			const projectsResponse = await this.plugin.makeRequest('/v1/projects');
			console.log('[Letta Plugin] Projects response:', projectsResponse);
			loadingEl.remove();
			
			// Handle different response formats
			let projects;
			if (Array.isArray(projectsResponse)) {
				projects = projectsResponse;
			} else if (projectsResponse.projects) {
				projects = projectsResponse.projects;
			} else {
				projects = [];
			}
			
			if (!projects || projects.length === 0) {
				contentEl.createEl('div', { 
					text: 'No projects found', 
					cls: 'letta-memory-empty' 
				});
				return;
			}
			
			const projectList = contentEl.createEl('div');
			projectList.style.maxHeight = '400px';
			projectList.style.overflowY = 'auto';
			
			// Pre-fetch agent counts for each project
			console.log('[Letta Plugin] Fetching agent counts for projects:', projects);
			const projectsWithCounts = await Promise.all(
				projects.map(async (project: any) => {
					try {
						const agents = await this.plugin.makeRequest(`/v1/agents?project_id=${project.id}`);
						console.log(`[Letta Plugin] Project ${project.name} has ${agents?.length || 0} agents:`, agents);
						return { ...project, agentCount: agents?.length || 0 };
					} catch (error) {
						console.warn(`Failed to get agent count for project ${project.name}:`, error);
						return { ...project, agentCount: 0 };
					}
				})
			);
			console.log('[Letta Plugin] Projects with counts:', projectsWithCounts);
			
			for (const project of projectsWithCounts) {
				const projectEl = projectList.createEl('div');
				projectEl.style.padding = '12px';
				projectEl.style.border = '1px solid var(--background-modifier-border)';
				projectEl.style.borderRadius = '8px';
				projectEl.style.marginBottom = '8px';
				projectEl.style.cursor = 'pointer';
				projectEl.style.transition = 'background 0.2s ease';
				
				// Grey out projects with no agents
				if (project.agentCount === 0) {
					projectEl.style.opacity = '0.6';
					projectEl.style.cursor = 'not-allowed';
				}
				
				const headerEl = projectEl.createEl('div');
				headerEl.style.display = 'flex';
				headerEl.style.justifyContent = 'space-between';
				headerEl.style.alignItems = 'center';
				headerEl.style.marginBottom = '4px';
				headerEl.style.gap = '12px';
				
				const nameEl = headerEl.createEl('div', { text: project.name });
				nameEl.style.fontWeight = '600';
				nameEl.style.flex = '1';
				nameEl.style.minWidth = '0';
				nameEl.style.overflow = 'hidden';
				nameEl.style.textOverflow = 'ellipsis';
				nameEl.style.whiteSpace = 'nowrap';
				
				const countEl = headerEl.createEl('div', { 
					text: `${project.agentCount || 0} agent${(project.agentCount || 0) !== 1 ? 's' : ''}` 
				});
				countEl.style.fontSize = '0.8em';
				countEl.style.color = (project.agentCount || 0) > 0 ? 'var(--color-green)' : 'var(--text-muted)';
				countEl.style.fontWeight = '500';
				countEl.style.flexShrink = '0';
				countEl.style.whiteSpace = 'nowrap';
				countEl.style.backgroundColor = 'var(--background-modifier-border)';
				countEl.style.padding = '2px 6px';
				countEl.style.borderRadius = '4px';
				
				const slugEl = projectEl.createEl('div', { text: project.slug });
				slugEl.style.fontSize = '0.9em';
				slugEl.style.color = 'var(--text-muted)';
				
				if (project.agentCount === 0) {
					const noAgentsEl = projectEl.createEl('div', { text: 'No agents available' });
					noAgentsEl.style.fontSize = '0.8em';
					noAgentsEl.style.color = 'var(--text-faint)';
					noAgentsEl.style.fontStyle = 'italic';
					noAgentsEl.style.marginTop = '4px';
				}
				
				projectEl.addEventListener('mouseenter', () => {
					if (project.agentCount > 0) {
						projectEl.style.backgroundColor = 'var(--background-modifier-hover)';
					}
				});
				
				projectEl.addEventListener('mouseleave', () => {
					projectEl.style.backgroundColor = '';
				});
				
				projectEl.addEventListener('click', () => {
					if (project.agentCount > 0) {
						console.log('[Letta Plugin] Project selected:', project);
						modal.close();
						this.openAgentSelector(project);
					} else {
						new Notice(`Project "${project.name}" has no agents available`);
					}
				});
			}
			
		} catch (error) {
			console.error('[Letta Plugin] Failed to load projects:', error);
			loadingEl.textContent = `Failed to load projects: ${error.message || 'Please check your connection.'}`;
		}
		
		modal.open();
	}

	async openAgentSelector(project?: any, isCurrentProject?: boolean) {
		const modal = new Modal(this.app);
		modal.setTitle(project ? `Select Agent - ${project.name}` : 'Select Agent');
		
		const { contentEl } = modal;
		contentEl.style.width = '700px';
		contentEl.style.height = '600px';
		
		// Add navigation buttons
		const isCloudInstance = this.plugin.settings.lettaBaseUrl.includes('api.letta.com');
		
		// Always show change project button for cloud instances, and when there's an API key
		if (isCloudInstance && this.plugin.settings.lettaApiKey) {
			const buttonContainer = contentEl.createEl('div');
			buttonContainer.style.display = 'flex';
			buttonContainer.style.gap = '8px';
			buttonContainer.style.marginBottom = '16px';
			
			if (project && isCurrentProject) {
				const changeProjectButton = buttonContainer.createEl('button', { 
					text: 'Change Project',
					cls: 'letta-clear-button'
				});
				changeProjectButton.addEventListener('click', () => {
					modal.close();
					this.openProjectSelector();
				});
			} else if (project && !isCurrentProject) {
				const backButton = buttonContainer.createEl('button', { 
					text: '← Back to Projects',
					cls: 'letta-clear-button'
				});
				backButton.addEventListener('click', () => {
					modal.close();
					this.openProjectSelector();
				});
			} else {
				// No specific project - show generic change project button
				const changeProjectButton = buttonContainer.createEl('button', { 
					text: 'Select Project',
					cls: 'letta-clear-button'
				});
				changeProjectButton.addEventListener('click', () => {
					modal.close();
					this.openProjectSelector();
				});
			}
		}
		
		// Loading state
		const loadingEl = contentEl.createEl('div', { 
			text: 'Loading agents...', 
			cls: 'letta-memory-empty' 
		});
		
		try {
			// Build query params for agents request
			const params = new URLSearchParams();
			if (project) {
				params.append('project_id', project.id);
			}
			
			const queryString = params.toString();
			const endpoint = `/v1/agents${queryString ? '?' + queryString : ''}`;
			
			const agents = await this.plugin.makeRequest(endpoint);
			loadingEl.remove();
			
			if (!agents || agents.length === 0) {
				const emptyDiv = contentEl.createEl('div', { cls: 'letta-memory-empty' });
				emptyDiv.style.textAlign = 'center';
				emptyDiv.style.padding = '40px';
				
				emptyDiv.createEl('div', { 
					text: project ? `No agents found in "${project.name}"` : 'No agents found',
					cls: 'letta-memory-empty'
				});
				
				if (project) {
					if (isCurrentProject) {
						emptyDiv.createEl('p', { 
							text: 'Your current project doesn\'t have any agents yet. Try selecting a different project or create a new agent.',
							cls: 'letta-memory-empty'
						});
						
						const changeProjectButton = emptyDiv.createEl('button', { 
							text: 'Change Project',
							cls: 'letta-clear-button'
						});
						changeProjectButton.style.marginTop = '16px';
						changeProjectButton.addEventListener('click', () => {
							modal.close();
							this.openProjectSelector();
						});
					} else {
						emptyDiv.createEl('p', { 
							text: 'This project doesn\'t have any agents yet. Try selecting a different project or create a new agent.',
							cls: 'letta-memory-empty'
						});
						
						const backButton = emptyDiv.createEl('button', { 
							text: '← Back to Projects',
							cls: 'letta-clear-button'
						});
						backButton.style.marginTop = '16px';
						backButton.addEventListener('click', () => {
							modal.close();
							this.openProjectSelector();
						});
					}
				}
				return;
			}
			
			// Create table structure
			const agentList = contentEl.createEl('div', { cls: 'agent-selector-list' });
			agentList.style.maxHeight = '450px';
			agentList.style.overflowY = 'auto';
			agentList.style.border = '1px solid var(--background-modifier-border)';
			agentList.style.borderRadius = '6px';
			
			const table = agentList.createEl('table', { cls: 'model-table' });
			
			// Table header
			const thead = table.createEl('thead');
			const headerRow = thead.createEl('tr');
			headerRow.createEl('th', { text: 'Agent Name' });
			headerRow.createEl('th', { text: 'Template' });
			headerRow.createEl('th', { text: 'Agent ID' });
			headerRow.createEl('th', { text: 'Status' });

			// Table body
			const tbody = table.createEl('tbody');
			
			for (const agent of agents) {
				const row = tbody.createEl('tr', { cls: 'model-table-row' });
				
				// Agent name
				const nameCell = row.createEl('td', { cls: 'model-cell-name' });
				nameCell.createEl('span', { text: agent.name, cls: 'model-name' });
				
				// Template
				row.createEl('td', { 
					text: agent.template_id || 'Unknown',
					cls: 'model-cell-provider'
				});
				
				// Agent ID (shortened)
				const idCell = row.createEl('td', { cls: 'model-cell-context' });
				const shortId = agent.id.substring(0, 8) + '...';
				idCell.createEl('span', { 
					text: shortId,
					title: agent.id // Show full ID on hover
				});
				
				// Status (current indicator)
				const statusCell = row.createEl('td', { cls: 'model-cell-status' });
				const isCurrentAgent = agent.id === this.plugin.agent?.id;
				if (isCurrentAgent) {
					statusCell.createEl('span', { 
						text: 'Current',
						cls: 'model-current-badge'
					});
				} else {
					statusCell.createEl('span', { 
						text: 'Available',
						cls: 'model-available-badge'
					});
				}

				// Click handler - allow clicking on current agent too
				row.addEventListener('click', () => {
					modal.close();
					this.switchToAgent(agent, project);
				});
				row.style.cursor = 'pointer';
				
				// Hover effect
				row.addEventListener('mouseenter', () => {
					row.style.backgroundColor = 'var(--background-modifier-hover)';
				});
				row.addEventListener('mouseleave', () => {
					row.style.backgroundColor = '';
				});
			}
			
		} catch (error: any) {
			console.error('Failed to load agents:', error);
			loadingEl.remove();
			
			// Create error container
			const errorDiv = contentEl.createEl('div', { cls: 'letta-memory-error' });
			errorDiv.style.textAlign = 'center';
			errorDiv.style.padding = '40px';
			
			// Check if this is a project not found error
			if (error.message && (error.message.includes('Project not found') || (error.message.includes('Agent not found') && project))) {
				const errorTitle = errorDiv.createEl('h3', { 
					text: 'Project Not Found'
				});
				errorTitle.style.cssText = 'margin-bottom: 16px; color: var(--text-error);';
				
				const errorText = errorDiv.createEl('p', { 
					text: `The project "${project?.id || 'default-project'}" does not exist or you don't have access to it.`
				});
				errorText.style.cssText = 'margin-bottom: 16px;';
				
				// For cloud instances, offer to change project
				if (this.plugin.settings.lettaBaseUrl.includes('api.letta.com')) {
					const changeProjectButton = errorDiv.createEl('button', { 
						text: 'Select Different Project',
						cls: 'letta-connect-button'
					});
					changeProjectButton.style.marginRight = '12px';
					changeProjectButton.addEventListener('click', () => {
						modal.close();
						this.openProjectSelector();
					});
				}
				
				// Settings button
				const settingsButton = errorDiv.createEl('button', { 
					text: 'Check Settings',
					cls: 'letta-model-button'
				});
				settingsButton.addEventListener('click', () => {
					modal.close();
					// Open Obsidian settings to the plugin page
					// @ts-ignore
					this.app.setting.open();
					// @ts-ignore 
					this.app.setting.openTabById('letta-ai-agent');
				});
			} else {
				// Generic error handling
				const errorTitle = errorDiv.createEl('h3', { 
					text: 'Failed to Load Agents'
				});
				errorTitle.style.cssText = 'margin-bottom: 16px; color: var(--text-error);';
				
				const errorText = errorDiv.createEl('p', { 
					text: 'Please check your connection and try again.'
				});
				errorText.style.cssText = 'margin-bottom: 16px;';
				
				const retryButton = errorDiv.createEl('button', { 
					text: 'Retry',
					cls: 'letta-connect-button'
				});
				retryButton.addEventListener('click', () => {
					modal.close();
					this.openAgentSelector(project, isCurrentProject);
				});
			}
		}
		
		modal.open();
	}

	async switchToAgent(agent: any, project?: any) {
		try {
			console.log(`[Letta Plugin] Switching to agent: ${agent.name} (ID: ${agent.id})`);
			
			// Clear current chat without triggering updateChatStatus
			this.chatContainer.empty();
			
			// CRITICAL: Update both agent name AND agent ID in settings
			this.plugin.settings.agentName = agent.name;
			this.plugin.settings.agentId = agent.id; // This was missing!
			
			if (project) {
				this.plugin.settings.lettaProjectSlug = project.slug;
			}
			await this.plugin.saveSettings();
			
			// Update plugin agent reference with consistent format (like setupAgent does)
			this.plugin.agent = { 
				id: agent.id, 
				name: agent.name,
				// Preserve other properties if they exist
				...agent
			};
			
			// Verify the agent switch by checking if we can access it
			const verifyAgent = await this.plugin.makeRequest(`/v1/agents/${agent.id}`);
			if (!verifyAgent) {
				throw new Error(`Cannot access agent ${agent.id} - may not exist or lack permissions`);
			}
			
			console.log(`[Letta Plugin] Successfully verified agent access: ${verifyAgent.name}`);
			
			// Update UI - agent name
			this.updateAgentNameDisplay();
			
			// Update chat status without loading historical messages for fresh start
			await this.updateChatStatus(false);
			
			// Show success message for fresh conversation
			this.addMessage('assistant', `Started fresh conversation with **${agent.name}**${project ? ` (Project: ${project.name})` : ''}`, 'System');
			
			new Notice(`Switched to agent: ${agent.name}`);
			
		} catch (error) {
			console.error('Failed to switch agent:', error);
			new Notice(`Failed to switch agent: ${error.message}`);
			this.addMessage('assistant', `**Error**: Failed to switch agent: ${error.message}`, 'Error');
		}
	}

}

class LettaMemoryView extends ItemView {
	plugin: LettaPlugin;
	blocks: any[] = [];
	blockEditors: Map<string, HTMLTextAreaElement> = new Map();
	blockSaveButtons: Map<string, HTMLButtonElement> = new Map();
	blockDirtyStates: Map<string, boolean> = new Map();
	refreshButton: HTMLSpanElement;
	lastRefreshTime: Date = new Date();

	constructor(leaf: WorkspaceLeaf, plugin: LettaPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType() {
		return LETTA_MEMORY_VIEW_TYPE;
	}

	getDisplayText() {
		return 'Memory Blocks';
	}

	getIcon() {
		return 'brain-circuit';
	}

	async onOpen() {
		const container = this.containerEl.children[1];
		container.empty();
		container.addClass('letta-memory-view');

		// Header
		const header = container.createEl('div', { cls: 'letta-memory-header' });
		header.createEl('h3', { text: 'Memory', cls: 'letta-memory-title' });
		
		const buttonContainer = header.createEl('div');
		buttonContainer.style.display = 'flex';
		buttonContainer.style.gap = '8px';
		
		const createButton = buttonContainer.createEl('span', { text: 'New' });
		createButton.style.cssText = 'cursor: pointer; opacity: 0.7; padding: 2px 6px; margin: 0 4px;';
		createButton.addEventListener('mouseenter', () => { createButton.style.opacity = '1'; });
		createButton.addEventListener('mouseleave', () => { createButton.style.opacity = '0.7'; });
		createButton.addEventListener('click', () => this.createNewBlock());
		
		const attachButton = buttonContainer.createEl('span', { text: 'Manage' });
		attachButton.style.cssText = 'cursor: pointer; opacity: 0.7; padding: 2px 6px; margin: 0 4px;';
		attachButton.addEventListener('mouseenter', () => { attachButton.style.opacity = '1'; });
		attachButton.addEventListener('mouseleave', () => { attachButton.style.opacity = '0.7'; });
		attachButton.addEventListener('click', () => this.searchAndAttachBlocks());
		
		this.refreshButton = buttonContainer.createEl('span', { text: 'Refresh' });
		this.refreshButton.style.cssText = 'cursor: pointer; opacity: 0.7; padding: 2px 6px; margin: 0 4px;';
		this.refreshButton.addEventListener('mouseenter', () => { this.refreshButton.style.opacity = '1'; });
		this.refreshButton.addEventListener('mouseleave', () => { this.refreshButton.style.opacity = '0.7'; });
		this.refreshButton.addEventListener('click', () => this.loadBlocks());

		// Content container
		const contentContainer = container.createEl('div', { cls: 'letta-memory-content' });
		
		// Load initial blocks
		await this.loadBlocks();
	}

	async loadBlocks() {
		try {
			// Auto-connect if not connected to server
			if (!this.plugin.source) {
				new Notice('Connecting to Letta...');
				const connected = await this.plugin.connectToLetta();
				if (!connected) {
					this.showError('Failed to connect to Letta');
					return;
				}
			}

			this.refreshButton.style.opacity = '0.5';
			this.refreshButton.style.pointerEvents = 'none';
			this.refreshButton.textContent = 'Loading...';

			// Fetch blocks from API
			this.blocks = await this.plugin.makeRequest(`/v1/agents/${this.plugin.agent?.id}/core-memory/blocks`);
			this.lastRefreshTime = new Date();
			
			this.renderBlocks();
			
		} catch (error) {
			console.error('Failed to load memory blocks:', error);
			this.showError('Failed to load memory blocks');
		} finally {
			this.refreshButton.style.opacity = '0.7';
			this.refreshButton.style.pointerEvents = 'auto';
			this.refreshButton.textContent = '↻ Refresh';
		}
	}

	renderBlocks() {
		const contentContainer = this.containerEl.querySelector('.letta-memory-content') as HTMLElement;
		contentContainer.empty();

		if (!this.blocks || this.blocks.length === 0) {
			contentContainer.createEl('div', { 
				text: 'No memory blocks found',
				cls: 'letta-memory-empty'
			});
			return;
		}

		// Create block editors
		this.blocks.forEach(block => {
			const blockContainer = contentContainer.createEl('div', { cls: 'letta-memory-block' });
			
			// Block header
			const blockHeader = blockContainer.createEl('div', { cls: 'letta-memory-block-header' });
			
			const titleSection = blockHeader.createEl('div', { cls: 'letta-memory-title-section' });
			titleSection.createEl('h4', { 
				text: block.label || block.name || 'Unnamed Block',
				cls: 'letta-memory-block-title'
			});
			
			const headerActions = blockHeader.createEl('div', { cls: 'letta-memory-header-actions' });
			
			// Character counter
			const charCounter = headerActions.createEl('span', { 
				text: `${(block.value || '').length}/${block.limit || 5000}`,
				cls: 'letta-memory-char-counter'
			});
			
			// Detach button
			const detachButton = headerActions.createEl('button', {
				text: 'Detach',
				cls: 'letta-memory-action-btn letta-memory-detach-btn',
				attr: { title: 'Detach block from agent (keeps block in system)' }
			});
			
			// Delete button
			const deleteButton = headerActions.createEl('button', {
				text: 'Delete',
				cls: 'letta-memory-action-btn letta-memory-delete-btn',
				attr: { title: 'Permanently delete this block' }
			});
			
			// Event listeners for buttons
			detachButton.addEventListener('click', () => this.detachBlock(block));
			deleteButton.addEventListener('click', () => this.deleteBlock(block));

			// Block description
			if (block.description) {
				blockContainer.createEl('div', { 
					text: block.description,
					cls: 'letta-memory-block-description'
				});
			}

			// Editor textarea
			const editor = blockContainer.createEl('textarea', {
				cls: 'letta-memory-block-editor',
				attr: { 
					placeholder: 'Enter block content...',
					'data-block-label': block.label || block.name
				}
			});
			editor.value = block.value || '';
			
			if (block.read_only) {
				editor.disabled = true;
				editor.style.opacity = '0.6';
			}

			// Update character counter on input
			editor.addEventListener('input', () => {
				const currentLength = editor.value.length;
				const limit = block.limit || 5000;
				charCounter.textContent = `${currentLength}/${limit}`;
				
				if (currentLength > limit) {
					charCounter.style.color = 'var(--text-error)';
				} else {
					charCounter.style.color = 'var(--text-muted)';
				}

				// Track dirty state
				const isDirty = editor.value !== (block.value || '');
				this.blockDirtyStates.set(block.label || block.name, isDirty);
				this.updateSaveButton(block.label || block.name, isDirty);
			});

			// Save button
			const saveButton = blockContainer.createEl('button', {
				text: 'Save Changes',
				cls: 'letta-memory-save-btn'
			});
			saveButton.disabled = true;
			
			saveButton.addEventListener('click', () => this.saveBlock(block.label || block.name));

			// Store references
			this.blockEditors.set(block.label || block.name, editor);
			this.blockSaveButtons.set(block.label || block.name, saveButton);
			this.blockDirtyStates.set(block.label || block.name, false);
		});
	}

	updateSaveButton(blockLabel: string, isDirty: boolean) {
		const saveButton = this.blockSaveButtons.get(blockLabel);
		if (saveButton) {
			saveButton.disabled = !isDirty;
			saveButton.textContent = isDirty ? 'Save Changes' : 'No Changes';
		}
	}

	async saveBlock(blockLabel: string) {
		const editor = this.blockEditors.get(blockLabel);
		const saveButton = this.blockSaveButtons.get(blockLabel);
		
		if (!editor || !saveButton) return;

		try {
			saveButton.disabled = true;
			saveButton.textContent = 'Checking...';

			// Step 1: Fetch current server state to check for conflicts
			const serverBlock = await this.plugin.makeRequest(`/v1/agents/${this.plugin.agent?.id}/core-memory/blocks/${blockLabel}`);
			const localBlock = this.blocks.find(b => (b.label || b.name) === blockLabel);
			
			if (!localBlock) {
				throw new Error('Local block not found');
			}

			// Step 2: Check for conflicts (server value differs from our original local value)
			const serverValue = (serverBlock.value || '').trim();
			const originalLocalValue = (localBlock.value || '').trim();
			const newValue = editor.value.trim();

			if (serverValue !== originalLocalValue) {
				// Conflict detected - show resolution dialog
				saveButton.textContent = 'Conflict Detected';
				
				const resolution = await this.showConflictDialog(blockLabel, originalLocalValue, serverValue, newValue);
				
				if (resolution === 'cancel') {
					saveButton.textContent = 'Save Changes';
					return;
				} else if (resolution === 'keep-server') {
					// Update editor and local state with server version
					editor.value = serverValue;
					localBlock.value = serverValue;
					this.blockDirtyStates.set(blockLabel, false);
					saveButton.textContent = 'No Changes';
					
					// Update character counter
					const charCounter = this.containerEl.querySelector(`[data-block-label="${blockLabel}"]`)?.parentElement?.querySelector('.letta-memory-char-counter') as HTMLElement;
					if (charCounter) {
						const limit = localBlock.limit || 5000;
						charCounter.textContent = `${serverValue.length}/${limit}`;
						if (serverValue.length > limit) {
							charCounter.style.color = 'var(--text-error)';
						} else {
							charCounter.style.color = 'var(--text-muted)';
						}
					}
					
					new Notice(`Memory block "${blockLabel}" updated with server version`);
					return;
				}
				// If resolution === 'overwrite', continue with save
			}

			// Step 3: Save our changes (no conflict or user chose to overwrite)
			saveButton.textContent = 'Saving...';
			
			await this.plugin.makeRequest(`/v1/agents/${this.plugin.agent?.id}/core-memory/blocks/${blockLabel}`, {
				method: 'PATCH',
				body: { value: newValue }
			});

			// Update local state
			localBlock.value = newValue;
			this.blockDirtyStates.set(blockLabel, false);
			saveButton.textContent = 'Saved ✓';
			
			setTimeout(() => {
				saveButton.textContent = 'No Changes';
			}, 2000);

			new Notice(`Memory block "${blockLabel}" updated successfully`);

		} catch (error) {
			console.error(`Failed to save block ${blockLabel}:`, error);
			new Notice(`Failed to save block "${blockLabel}". Please try again.`);
			saveButton.textContent = 'Save Changes';
		} finally {
			saveButton.disabled = this.blockDirtyStates.get(blockLabel) !== true;
		}
	}

	private showConflictDialog(blockLabel: string, originalValue: string, serverValue: string, localValue: string): Promise<'keep-server' | 'overwrite' | 'cancel'> {
		return new Promise((resolve) => {
			const modal = new Modal(this.app);
			modal.setTitle('Memory Block Conflict');
			
			const { contentEl } = modal;
			
			// Warning message
			const warningEl = contentEl.createEl('div', { cls: 'conflict-warning' });
			warningEl.createEl('p', { 
				text: `The memory block "${blockLabel}" has been changed on the server since you started editing.`,
				cls: 'conflict-message'
			});
			
			// Create tabs/sections for different versions
			const versionsContainer = contentEl.createEl('div', { cls: 'conflict-versions' });
			
			// Server version section
			const serverSection = versionsContainer.createEl('div', { cls: 'conflict-section' });
			serverSection.createEl('h4', { text: '🌐 Server Version (Current)', cls: 'conflict-section-title' });
			const serverTextarea = serverSection.createEl('textarea', { 
				cls: 'conflict-textarea',
				attr: { readonly: 'true', rows: '6' }
			});
			serverTextarea.value = serverValue;
			
			// Your version section  
			const localSection = versionsContainer.createEl('div', { cls: 'conflict-section' });
			localSection.createEl('h4', { text: '✏️ Your Changes', cls: 'conflict-section-title' });
			const localTextarea = localSection.createEl('textarea', { 
				cls: 'conflict-textarea',
				attr: { readonly: 'true', rows: '6' }
			});
			localTextarea.value = localValue;
			
			// Character counts
			const serverCount = contentEl.createEl('p', { 
				text: `Server version: ${serverValue.length} characters`,
				cls: 'conflict-char-count'
			});
			const localCount = contentEl.createEl('p', { 
				text: `Your version: ${localValue.length} characters`,
				cls: 'conflict-char-count'
			});
			
			// Action buttons
			const buttonContainer = contentEl.createEl('div', { cls: 'conflict-buttons' });
			
			const keepServerButton = buttonContainer.createEl('button', {
				text: 'Keep Server Version',
				cls: 'conflict-btn conflict-btn-server'
			});
			
			const overwriteButton = buttonContainer.createEl('button', {
				text: 'Overwrite with My Changes',
				cls: 'conflict-btn conflict-btn-overwrite'
			});
			
			const cancelButton = buttonContainer.createEl('button', {
				text: 'Cancel',
				cls: 'conflict-btn conflict-btn-cancel'
			});
			
			// Event handlers
			keepServerButton.addEventListener('click', () => {
				resolve('keep-server');
				modal.close();
			});
			
			overwriteButton.addEventListener('click', () => {
				resolve('overwrite');
				modal.close();
			});
			
			cancelButton.addEventListener('click', () => {
				resolve('cancel');
				modal.close();
			});
			
			modal.open();
		});
	}

	showError(message: string) {
		const contentContainer = this.containerEl.querySelector('.letta-memory-content') as HTMLElement;
		contentContainer.empty();
		contentContainer.createEl('div', { 
			text: message,
			cls: 'letta-memory-error'
		});
	}

	async createNewBlock() {
		if (!this.plugin.agent) {
			new Notice('Please connect to Letta first');
			return;
		}

		const blockData = await this.promptForNewBlock();
		if (!blockData) return;

		try {
			// Step 1: Create the block using the blocks endpoint
			console.log('[Letta Plugin] Creating block with data:', blockData);
			
			const createResponse = await this.plugin.makeRequest('/v1/blocks', {
				method: 'POST',
				body: {
					label: blockData.label,
					description: blockData.description,
					value: blockData.value,
					limit: blockData.limit
				}
			});

			console.log('[Letta Plugin] Block created successfully:', createResponse);
			
			// Step 2: Attach the block to the agent
			console.log(`[Letta Plugin] Attaching block ${createResponse.id} to agent ${this.plugin.agent?.id}`);
			
			const attachResponse = await this.plugin.makeRequest(`/v1/agents/${this.plugin.agent?.id}/core-memory/blocks/attach/${createResponse.id}`, {
				method: 'PATCH'
			});

			console.log('[Letta Plugin] Block attached successfully:', attachResponse);
			
			new Notice(`Created and attached memory block: ${blockData.label}`);
			
			// Refresh the blocks list
			await this.loadBlocks();
			
		} catch (error) {
			console.error('Failed to create and attach memory block:', error);
			
			// Fallback: Try the message approach as last resort
			try {
				console.log('[Letta Plugin] Trying message approach as fallback');
				
				const messageResponse = await this.plugin.makeRequest(`/v1/agents/${this.plugin.agent?.id}/messages`, {
					method: 'POST',
					body: {
						messages: [{
							role: 'user',
							content: [{
								type: 'text',
								text: `Please create a new memory block with label "${blockData.label}", description "${blockData.description}", and initial content: "${blockData.value}". Use core_memory_append or appropriate memory tools to add this information to your memory.`
							}]
						}]
					}
				});
				
				console.log('[Letta Plugin] Message approach result:', messageResponse);
				new Notice(`Requested agent to create memory block: ${blockData.label}`);
				
				// Refresh the blocks list after a short delay to allow agent processing
				setTimeout(() => this.loadBlocks(), 2000);
				
			} catch (messageError) {
				console.error('Both creation approaches failed:', error, messageError);
				new Notice('Failed to create memory block. This feature may not be available in the current API version.');
			}
		}
	}

	private promptForNewBlock(): Promise<{label: string, value: string, limit: number, description: string} | null> {
		return new Promise((resolve) => {
			const modal = new Modal(this.app);
			modal.setTitle('Create New Memory Block');
			
			const { contentEl } = modal;
			contentEl.style.width = '500px';
			
			// Label input
			contentEl.createEl('div', { text: 'Block Label:', cls: 'config-label' });
			const labelInput = contentEl.createEl('input', {
				type: 'text',
				placeholder: 'e.g., user_preferences, project_context',
				cls: 'config-input'
			});
			labelInput.style.marginBottom = '16px';
			
			// Description input
			contentEl.createEl('div', { text: 'Description:', cls: 'config-label' });
			const descriptionInput = contentEl.createEl('input', {
				type: 'text',
				placeholder: 'Brief description of what this block is for...',
				cls: 'config-input'
			});
			descriptionInput.style.marginBottom = '16px';
			
			// Value textarea
			contentEl.createEl('div', { text: 'Initial Content (optional):', cls: 'config-label' });
			const valueInput = contentEl.createEl('textarea', {
				placeholder: 'Enter initial content for this memory block (can be left empty)...',
				cls: 'config-textarea'
			});
			valueInput.style.height = '120px';
			valueInput.style.marginBottom = '16px';
			
			// Limit input
			contentEl.createEl('div', { text: 'Character Limit:', cls: 'config-label' });
			const limitInput = contentEl.createEl('input', {
				cls: 'config-input'
			}) as HTMLInputElement;
			limitInput.type = 'number';
			limitInput.value = '2000';
			limitInput.min = '100';
			limitInput.max = '8000';
			limitInput.style.marginBottom = '16px';
			
			const buttonContainer = contentEl.createEl('div');
			buttonContainer.style.display = 'flex';
			buttonContainer.style.gap = '8px';
			buttonContainer.style.justifyContent = 'flex-end';
			
			const createButton = buttonContainer.createEl('button', {
				text: 'Create Block',
				cls: 'mod-cta'
			});
			
			const cancelButton = buttonContainer.createEl('button', {
				text: 'Cancel'
			});
			
			createButton.addEventListener('click', () => {
				const label = labelInput.value.trim();
				const description = descriptionInput.value.trim();
				const value = valueInput.value; // Don't trim - allow empty content
				const limit = parseInt(limitInput.value) || 2000;
				
				if (!label) {
					new Notice('Please enter a block label');
					labelInput.focus();
					return;
				}
				
				if (!description) {
					new Notice('Please enter a description');
					descriptionInput.focus();
					return;
				}
				
				// Allow empty blocks - content can be added later
				
				resolve({ label, description, value, limit });
				modal.close();
			});
			
			cancelButton.addEventListener('click', () => {
				resolve(null);
				modal.close();
			});
			
			modal.open();
			labelInput.focus();
		});
	}

	async detachBlock(block: any) {
		if (!this.plugin.agent) {
			new Notice('Please connect to Letta first');
			return;
		}

		try {
			// Show confirmation dialog
			const confirmed = await this.showConfirmDialog(
				'Detach Memory Block',
				`Are you sure you want to detach "${block.label || block.name}" from this agent? The block will remain in the system but won't be accessible to this agent.`,
				'Detach',
				'var(--color-orange)'
			);

			if (!confirmed) return;

			console.log('[Letta Plugin] Detaching block:', block.label || block.name);
			
			await this.plugin.makeRequest(`/v1/agents/${this.plugin.agent?.id}/core-memory/blocks/detach/${block.id}`, {
				method: 'PATCH'
			});

			new Notice(`Memory block "${block.label || block.name}" detached successfully`);
			
			// Refresh the blocks list
			await this.loadBlocks();

		} catch (error) {
			console.error('Failed to detach block:', error);
			new Notice(`Failed to detach block "${block.label || block.name}". Please try again.`);
		}
	}

	async deleteBlock(block: any) {
		if (!this.plugin.agent) {
			new Notice('Please connect to Letta first');
			return;
		}

		try {
			// Show confirmation dialog with stronger warning
			const confirmed = await this.showConfirmDialog(
				'Delete Memory Block',
				`⚠️ Are you sure you want to PERMANENTLY DELETE "${block.label || block.name}"? This action cannot be undone and will remove the block from the entire system.`,
				'Delete Forever',
				'var(--text-error)'
			);

			if (!confirmed) return;

			console.log('[Letta Plugin] Deleting block:', block.label || block.name);
			
			await this.plugin.makeRequest(`/v1/blocks/${block.id}`, {
				method: 'DELETE'
			});

			new Notice(`Memory block "${block.label || block.name}" deleted permanently`);
			
			// Refresh the blocks list
			await this.loadBlocks();

		} catch (error) {
			console.error('Failed to delete block:', error);
			new Notice(`Failed to delete block "${block.label || block.name}". Please try again.`);
		}
	}

	private showConfirmDialog(title: string, message: string, confirmText: string, confirmColor: string): Promise<boolean> {
		return new Promise((resolve) => {
			const modal = new Modal(this.app);
			modal.setTitle(title);
			
			const { contentEl } = modal;
			
			// Warning message
			const messageEl = contentEl.createEl('p', { text: message });
			messageEl.style.marginBottom = '20px';
			messageEl.style.lineHeight = '1.4';
			
			// Button container
			const buttonContainer = contentEl.createEl('div');
			buttonContainer.style.display = 'flex';
			buttonContainer.style.gap = '12px';
			buttonContainer.style.justifyContent = 'flex-end';
			
			// Cancel button
			const cancelButton = buttonContainer.createEl('button', {
				text: 'Cancel',
				cls: 'conflict-btn conflict-btn-cancel'
			});
			
			// Confirm button
			const confirmButton = buttonContainer.createEl('button', {
				text: confirmText,
				cls: 'conflict-btn'
			});
			confirmButton.style.background = confirmColor;
			confirmButton.style.color = 'var(--text-on-accent)';
			
			// Event handlers
			cancelButton.addEventListener('click', () => {
				resolve(false);
				modal.close();
			});
			
			confirmButton.addEventListener('click', () => {
				resolve(true);
				modal.close();
			});
			
			modal.open();
		});
	}

	async searchAndAttachBlocks() {
		if (!this.plugin.agent) {
			new Notice('Please connect to Letta first');
			return;
		}

		try {
			// Get current agent's attached blocks to filter them out
			const attachedBlocks = await this.plugin.makeRequest(`/v1/agents/${this.plugin.agent?.id}/core-memory/blocks`);
			const attachedBlockIds = new Set(attachedBlocks.map((block: any) => block.id));

			// Build query parameters for block search
			let queryParams = '?limit=100'; // Get more blocks for searching
			
			// If we have a project, filter by project_id
			if (this.plugin.settings.lettaProjectSlug) {
				// Try to get project ID from slug - we'll need to look this up
				try {
					const projects = await this.plugin.makeRequest('/v1/projects');
					const currentProject = projects.find((p: any) => p.slug === this.plugin.settings.lettaProjectSlug);
					if (currentProject) {
						queryParams += `&project_id=${currentProject.id}`;
					}
				} catch (error) {
					console.warn('Could not get project ID for filtering blocks:', error);
					// Continue without project filter
				}
			}

			// Fetch all available blocks
			const allBlocks = await this.plugin.makeRequest(`/v1/blocks${queryParams}`);
			
			// Filter out already attached blocks and templates
			const availableBlocks = allBlocks.filter((block: any) => 
				!attachedBlockIds.has(block.id) && !block.is_template
			);

			if (availableBlocks.length === 0) {
				new Notice('No unattached blocks found in the current scope');
				return;
			}

			// Show search/selection modal
			this.showBlockSearchModal(availableBlocks);

		} catch (error) {
			console.error('Failed to search blocks:', error);
			new Notice('Failed to search for blocks. Please try again.');
		}
	}

	private showBlockSearchModal(blocks: any[]) {
		const modal = new Modal(this.app);
		modal.setTitle('Manage Memory Blocks');
		
		const { contentEl } = modal;
		contentEl.addClass('block-search-modal');
		
		// Content section
		const content = contentEl.createEl('div', { cls: 'block-search-content' });
		
		// Search input
		const searchInput = content.createEl('input', {
			type: 'text',
			placeholder: 'Search blocks by label, description, or content...',
			cls: 'block-search-input'
		});
		
		// Results info
		const resultsInfo = content.createEl('div', {
			text: `Found ${blocks.length} available blocks`,
			cls: 'block-search-results-info'
		});
		
		// Scrollable blocks container
		const blocksContainer = content.createEl('div', { cls: 'block-search-list' });
		
		// Render all blocks initially
		const renderBlocks = (filteredBlocks: any[]) => {
			blocksContainer.empty();
			resultsInfo.textContent = `Found ${filteredBlocks.length} available blocks`;
			
			if (filteredBlocks.length === 0) {
				blocksContainer.createEl('div', {
					text: 'No blocks match your search',
					cls: 'block-search-empty'
				});
				return;
			}
			
			filteredBlocks.forEach(block => {
				const blockEl = blocksContainer.createEl('div', { cls: 'block-search-item' });
				
				// Block header
				const headerEl = blockEl.createEl('div', { cls: 'block-search-item-header' });
				
				const titleEl = headerEl.createEl('div', { cls: 'block-search-item-title' });
				
				titleEl.createEl('h4', {
					text: block.label || 'Unnamed Block'
				});
				
				if (block.description) {
					titleEl.createEl('div', {
						text: block.description,
						cls: 'block-search-item-description'
					});
				}
				
				// Character count
				headerEl.createEl('span', {
					text: `${(block.value || '').length} chars`,
					cls: 'block-search-item-chars'
				});
				
				// Preview of content
				const preview = (block.value || '').slice(0, 200);
				const contentPreview = blockEl.createEl('div', { cls: 'block-search-item-preview' });
				contentPreview.textContent = preview + (block.value && block.value.length > 200 ? '...' : '');
				
				// Click to attach
				blockEl.addEventListener('click', () => {
					modal.close();
					this.attachBlock(block);
				});
			});
		};
		
		// Initial render
		renderBlocks(blocks);
		
		// Search functionality
		searchInput.addEventListener('input', () => {
			const searchTerm = searchInput.value.toLowerCase();
			const filteredBlocks = blocks.filter(block => {
				const label = (block.label || '').toLowerCase();
				const description = (block.description || '').toLowerCase();
				const content = (block.value || '').toLowerCase();
				return label.includes(searchTerm) || 
					   description.includes(searchTerm) || 
					   content.includes(searchTerm);
			});
			renderBlocks(filteredBlocks);
		});
		
		// Button container
		const buttonContainer = content.createEl('div', { cls: 'block-search-buttons' });
		
		const cancelButton = buttonContainer.createEl('button', {
			text: 'Cancel',
			cls: 'conflict-btn conflict-btn-cancel'
		});
		
		cancelButton.addEventListener('click', () => modal.close());
		
		modal.open();
		searchInput.focus();
	}

	async attachBlock(block: any) {
		if (!this.plugin.agent) {
			new Notice('Please connect to Letta first');
			return;
		}

		try {
			console.log('[Letta Plugin] Attaching block:', block.label || 'Unnamed', 'to agent:', this.plugin.agent?.id);
			
			// First, get current agent state to ensure we have the latest block list
			const currentAgent = await this.plugin.makeRequest(`/v1/agents/${this.plugin.agent?.id}`);
			const currentBlocks = currentAgent.memory?.blocks || [];
			
			console.log('[Letta Plugin] Current blocks before attach:', currentBlocks.map((b: any) => b.label || b.id));
			
			// Check if block is already attached
			const isAlreadyAttached = currentBlocks.some((b: any) => b.id === block.id);
			if (isAlreadyAttached) {
				new Notice(`Memory block "${block.label || 'Unnamed'}" is already attached to this agent`);
				return;
			}
			
			// Try the standard attach endpoint first
			try {
				await this.plugin.makeRequest(`/v1/agents/${this.plugin.agent?.id}/core-memory/blocks/attach/${block.id}`, {
					method: 'PATCH'
				});
				
				console.log('[Letta Plugin] Successfully attached block using attach endpoint');
				new Notice(`Memory block "${block.label || 'Unnamed'}" attached successfully`);
				
			} catch (attachError) {
				console.warn('[Letta Plugin] Attach endpoint failed, trying alternative approach:', attachError);
				
				// Alternative approach: Update agent with complete block list
				const updatedBlockIds = [...currentBlocks.map((b: any) => b.id), block.id];
				
				await this.plugin.makeRequest(`/v1/agents/${this.plugin.agent?.id}`, {
					method: 'PATCH',
					body: {
						memory: {
							...currentAgent.memory,
							blocks: updatedBlockIds
						}
					}
				});
				
				console.log('[Letta Plugin] Successfully attached block using agent update approach');
				new Notice(`Memory block "${block.label || 'Unnamed'}" attached successfully`);
			}
			
			// Refresh the blocks list to show the newly attached block
			await this.loadBlocks();

		} catch (error) {
			console.error('Failed to attach block:', error);
			new Notice(`Failed to attach block "${block.label || 'Unnamed'}". Please try again.`);
		}
	}

	async onClose() {
		// Clean up any resources if needed
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
			agent_type: 'memgpt_v2_agent', // Default to MemGPT v2 architecture
			description: 'An AI assistant for your Obsidian vault',
			include_base_tools: false, // Don't include core_memory* tools
			include_multi_agent_tools: false,
			include_default_source: false,
			tags: ['obsidian', 'assistant'],
			model: 'letta/letta-free',
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
			{ value: 'memgpt_v2_agent', label: 'MemGPT v2 Agent (Recommended)' },
			{ value: 'memgpt_agent', label: 'MemGPT v1 Agent' },
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
			text: 'Format: provider/model-name (default: letta/letta-free)', 
			cls: 'config-help' 
		});
		const modelInput = modelGroup.createEl('input', { 
			type: 'text', 
			value: this.config.model || 'letta/letta-free',
			cls: 'config-input',
			attr: { placeholder: 'letta/letta-free' }
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
			cls: 'config-checkbox'
		}) as HTMLInputElement;
		baseToolsCheckbox.type = 'checkbox';
		baseToolsCheckbox.checked = this.config.include_base_tools ?? true;
		baseToolsGroup.createEl('label', { text: 'Include Base Tools (Core memory functions)', cls: 'config-checkbox-label' });
		baseToolsCheckbox.addEventListener('change', () => {
			this.config.include_base_tools = baseToolsCheckbox.checked;
		});

		// Include Multi-Agent Tools
		const multiAgentToolsGroup = toolsSection.createEl('div', { cls: 'config-checkbox-group' });
		const multiAgentToolsCheckbox = multiAgentToolsGroup.createEl('input', { 
			cls: 'config-checkbox'
		}) as HTMLInputElement;
		multiAgentToolsCheckbox.type = 'checkbox';
		multiAgentToolsCheckbox.checked = this.config.include_multi_agent_tools ?? false;
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

class ModelSwitcherModal extends Modal {
	plugin: LettaPlugin;
	currentAgent: LettaAgent;
	models: LettaModel[] = [];
	filteredModels: LettaModel[] = [];
	
	// Filter controls
	providerCategorySelect: HTMLSelectElement;
	providerNameSelect: HTMLSelectElement;
	searchInput: HTMLInputElement;
	
	// Model list
	modelList: HTMLElement;
	resultsCounter: HTMLElement;
	
	constructor(app: App, plugin: LettaPlugin, currentAgent: LettaAgent) {
		super(app);
		this.plugin = plugin;
		this.currentAgent = currentAgent;
	}

	async onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('model-switcher-modal');

		// Header
		const header = contentEl.createEl('div', { cls: 'agent-config-header' });
		header.createEl('h2', { text: 'Select Model' });
		header.createEl('p', { 
			text: `Choose a model for agent: ${this.currentAgent.name}`,
			cls: 'agent-config-subtitle'
		});

		// Content area
		const content = contentEl.createEl('div', { cls: 'agent-config-form' });

		// Current model info
		const currentSection = content.createEl('div', { cls: 'config-section' });
		currentSection.createEl('h3', { text: 'Current Model' });
		
		const currentModel = this.currentAgent.llm_config?.model || 'Unknown';
		const currentProvider = this.currentAgent.llm_config?.provider_name || 'Unknown';
		const currentCategory = this.currentAgent.llm_config?.provider_category || 'Unknown';
		
		currentSection.createEl('p', { 
			text: `Model: ${currentModel}`,
			cls: 'config-help'
		});
		currentSection.createEl('p', { 
			text: `Provider: ${currentProvider} (${currentCategory})`,
			cls: 'config-help'
		});

		// Filters section
		const filtersSection = content.createEl('div', { cls: 'config-section' });
		const filtersHeader = filtersSection.createEl('div', { cls: 'filters-header' });
		filtersHeader.createEl('h3', { text: 'Filter Models' });
		
		// Add clear filters button
		const clearFiltersBtn = filtersHeader.createEl('button', { 
			text: 'Clear Filters',
			cls: 'clear-filters-btn'
		});
		clearFiltersBtn.addEventListener('click', () => this.clearFilters());

		// Filters grid container
		const filtersGrid = filtersSection.createEl('div', { cls: 'filters-grid' });

		// Provider category filter
		const categoryGroup = filtersGrid.createEl('div', { cls: 'config-group' });
		categoryGroup.createEl('label', { text: 'Provider Category:', cls: 'config-label' });
		this.providerCategorySelect = categoryGroup.createEl('select', { cls: 'config-select' });
		this.providerCategorySelect.createEl('option', { text: 'All Categories', value: '' });
		this.providerCategorySelect.createEl('option', { text: 'Base (Letta-hosted)', value: 'base' });
		this.providerCategorySelect.createEl('option', { text: 'BYOK (Bring Your Own Key)', value: 'byok' });

		// Provider name filter
		const providerGroup = filtersGrid.createEl('div', { cls: 'config-group' });
		providerGroup.createEl('label', { text: 'Provider:', cls: 'config-label' });
		this.providerNameSelect = providerGroup.createEl('select', { cls: 'config-select' });
		this.providerNameSelect.createEl('option', { text: 'All Providers', value: '' });

		// Search filter
		const searchGroup = filtersGrid.createEl('div', { cls: 'config-group' });
		const searchLabel = searchGroup.createEl('label', { text: 'Search Models:', cls: 'config-label' });
		const searchContainer = searchGroup.createEl('div', { cls: 'search-input-container' });
		this.searchInput = searchContainer.createEl('input', { 
			cls: 'config-input search-input',
			attr: { type: 'text', placeholder: 'Search models...' }
		});
		
		// Add search clear button
		const searchClearBtn = searchContainer.createEl('button', { 
			cls: 'search-clear-btn',
			attr: { type: 'button', title: 'Clear search' }
		});
		searchClearBtn.innerHTML = '×';
		searchClearBtn.addEventListener('click', () => {
			this.searchInput.value = '';
			this.filterModels();
		});

		// Models section
		const modelsSection = content.createEl('div', { cls: 'config-section' });
		const modelsHeader = modelsSection.createEl('div', { cls: 'models-header' });
		modelsHeader.createEl('h3', { text: 'Available Models' });
		
		// Add results counter
		const resultsCounter = modelsHeader.createEl('span', { 
			cls: 'results-counter',
			text: 'Loading...'
		});
		this.resultsCounter = resultsCounter;
		
		this.modelList = modelsSection.createEl('div', { cls: 'block-search-list' });
		this.modelList.createEl('div', { 
			text: 'Loading models...',
			cls: 'block-search-empty'
		});

		// Buttons
		const buttons = contentEl.createEl('div', { cls: 'agent-config-buttons' });
		
		const cancelBtn = buttons.createEl('button', { 
			text: 'Cancel',
			cls: 'agent-config-cancel-btn'
		});
		cancelBtn.addEventListener('click', () => this.close());

		// Load models and setup event listeners
		await this.loadModels();
		this.setupEventListeners();
	}

	async loadModels() {
		try {
			const response = await this.plugin.makeRequest('/v1/models/');
			this.models = response || [];
			this.updateProviderOptions();
			this.filterModels();
		} catch (error) {
			console.error('Error loading models:', error);
			this.modelList.empty();
			this.modelList.createEl('div', { 
				text: 'Error loading models. Please try again.',
				cls: 'block-search-empty'
			});
		}
	}

	updateProviderOptions() {
		// Get unique provider names
		const providers = [...new Set(this.models.map(m => m.provider_name).filter(Boolean))];
		
		// Clear existing options (keep the "All Providers" option)
		while (this.providerNameSelect.children.length > 1) {
			this.providerNameSelect.removeChild(this.providerNameSelect.lastChild!);
		}
		
		// Add provider options
		providers.sort().forEach(provider => {
			this.providerNameSelect.createEl('option', { 
				text: provider,
				value: provider
			});
		});
	}

	setupEventListeners() {
		this.providerCategorySelect.addEventListener('change', () => this.filterModels());
		this.providerNameSelect.addEventListener('change', () => this.filterModels());
		this.searchInput.addEventListener('input', () => this.filterModels());
		
		// Add keyboard shortcuts
		this.searchInput.addEventListener('keydown', (e) => {
			if (e.key === 'Escape') {
				this.searchInput.value = '';
				this.filterModels();
			} else if (e.key === 'Enter' && this.filteredModels.length === 1) {
				// Select the only filtered model on Enter
				this.selectModel(this.filteredModels[0]);
			}
		});
		
		// Auto-focus search input
		setTimeout(() => this.searchInput.focus(), 100);
	}

	clearFilters() {
		this.providerCategorySelect.value = '';
		this.providerNameSelect.value = '';
		this.searchInput.value = '';
		this.filterModels();
	}

	highlightSearchTerm(text: string, searchTerm: string): string {
		if (!searchTerm) return text;
		
		const regex = new RegExp(`(${searchTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
		return text.replace(regex, '<mark class="search-highlight">$1</mark>');
	}

	filterModels() {
		const categoryFilter = this.providerCategorySelect.value;
		const providerFilter = this.providerNameSelect.value;
		const searchFilter = this.searchInput.value.toLowerCase();

		this.filteredModels = this.models.filter(model => {
			const matchesCategory = !categoryFilter || model.provider_category === categoryFilter;
			const matchesProvider = !providerFilter || model.provider_name === providerFilter;
			const matchesSearch = !searchFilter || model.model.toLowerCase().includes(searchFilter);
			
			return matchesCategory && matchesProvider && matchesSearch;
		});

		this.renderModels();
	}

	renderModels() {
		this.modelList.empty();
		
		// Update results counter
		const totalModels = this.models.length;
		const filteredCount = this.filteredModels.length;
		this.resultsCounter.textContent = `${filteredCount} of ${totalModels} models`;

		if (this.filteredModels.length === 0) {
			this.modelList.createEl('div', { 
				text: 'No models found matching the current filters.',
				cls: 'block-search-empty'
			});
			return;
		}

		// Create table structure
		const table = this.modelList.createEl('table', { cls: 'model-table' });
		
		// Table header
		const thead = table.createEl('thead');
		const headerRow = thead.createEl('tr');
		headerRow.createEl('th', { text: 'Model' });
		headerRow.createEl('th', { text: 'Provider' });
		headerRow.createEl('th', { text: 'Category' });
		headerRow.createEl('th', { text: 'Context Window' });
		headerRow.createEl('th', { text: 'Status' });

		// Table body
		const tbody = table.createEl('tbody');
		
		this.filteredModels.forEach(model => {
			const row = tbody.createEl('tr', { cls: 'model-table-row' });
			
			// Model name with search highlighting
			const modelCell = row.createEl('td', { cls: 'model-cell-name' });
			const modelNameSpan = modelCell.createEl('span', { cls: 'model-name' });
			const searchTerm = this.searchInput.value.toLowerCase();
			modelNameSpan.innerHTML = this.highlightSearchTerm(model.model, searchTerm);
			
			// Add model details as tooltip
			const modelDetails = [
				`Provider: ${model.provider_name || 'Unknown'}`,
				`Category: ${model.provider_category || 'Unknown'}`,
				`Context: ${model.context_window?.toLocaleString() || 'Unknown'} tokens`,
				model.model_endpoint ? `Endpoint: ${model.model_endpoint}` : null
			].filter(Boolean).join('\n');
			
			modelCell.setAttribute('title', modelDetails);
			
			// Provider
			row.createEl('td', { 
				text: model.provider_name || 'Unknown',
				cls: 'model-cell-provider'
			});
			
			// Category
			const categoryCell = row.createEl('td', { cls: 'model-cell-category' });
			const categoryBadge = categoryCell.createEl('span', { 
				text: model.provider_category || 'Unknown',
				cls: `model-category-badge model-category-${model.provider_category || 'unknown'}`
			});
			
			// Context window
			row.createEl('td', { 
				text: model.context_window?.toLocaleString() || 'Unknown',
				cls: 'model-cell-context'
			});
			
			// Status (current indicator)
			const statusCell = row.createEl('td', { cls: 'model-cell-status' });
			const currentModel = this.currentAgent.llm_config?.model;
			if (currentModel === model.model) {
				const currentBadge = statusCell.createEl('span', { 
					text: '✓ Current',
					cls: 'model-current-badge'
				});
				currentBadge.setAttribute('title', 'This model is currently selected for your agent');
				// Disable clicking on current model
				row.classList.add('model-current-row');
			} else {
				const availableBadge = statusCell.createEl('span', { 
					text: 'Select',
					cls: 'model-available-badge'
				});
				availableBadge.setAttribute('title', 'Click to select this model');
			}

			// Click handler - only for non-current models
			if (currentModel !== model.model) {
				row.addEventListener('click', () => this.selectModel(model));
				row.style.cursor = 'pointer';
				
				// Hover effect
				row.addEventListener('mouseenter', () => {
					row.style.backgroundColor = 'var(--background-modifier-hover)';
				});
				row.addEventListener('mouseleave', () => {
					row.style.backgroundColor = '';
				});
			} else {
				row.style.cursor = 'default';
				row.style.opacity = '0.7';
			}
		});
	}

	async selectModel(model: LettaModel) {
		try {
			// Update the agent's LLM config
			const updateData = {
				llm_config: {
					...this.currentAgent.llm_config,
					model: model.model,
					model_endpoint_type: model.model_endpoint_type,
					provider_name: model.provider_name,
					provider_category: model.provider_category,
					context_window: model.context_window,
					model_endpoint: model.model_endpoint,
					model_wrapper: model.model_wrapper
				}
			};

			await this.plugin.makeRequest(`/v1/agents/${this.currentAgent.id}`, {
				method: 'PATCH',
				body: updateData
			});

			new Notice(`Model updated to ${model.model}`);
			
			// Update the current agent data
			this.currentAgent.llm_config = updateData.llm_config;
			
			// Refresh the model button in the chat view
			const chatLeaf = this.app.workspace.getLeavesOfType(LETTA_CHAT_VIEW_TYPE)[0];
			if (chatLeaf && chatLeaf.view instanceof LettaChatView) {
				(chatLeaf.view as LettaChatView).updateModelButton();
			}

			this.close();
		} catch (error) {
			console.error('Error updating model:', error);
			new Notice('Failed to update model. Please try again.');
		}
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

class AgentPropertyModal extends Modal {
	agent: any;
	blocks: any[];
	onSave: (config: any) => Promise<void>;

	constructor(app: App, agent: any, blocks: any[], onSave: (config: any) => Promise<void>) {
		super(app);
		this.agent = agent;
		this.blocks = blocks;
		this.onSave = onSave;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.addClass('agent-property-modal');
		
		// Header
		const header = contentEl.createEl('div', { cls: 'agent-config-header' });
		header.createEl('h2', { text: 'Agent Configuration' });
		header.createEl('p', { 
			text: 'Customize your agent\'s properties and behavior',
			cls: 'agent-config-subtitle'
		});

		// Form container
		const form = contentEl.createEl('div', { cls: 'agent-config-form' });
		
		// Name section
		const nameSection = form.createEl('div', { cls: 'config-section' });
		nameSection.createEl('h3', { text: 'Basic Information' });
		
		const nameGroup = nameSection.createEl('div', { cls: 'config-group' });
		nameGroup.createEl('label', { text: 'Agent Name', cls: 'config-label' });
		const nameInput = nameGroup.createEl('input', {
			type: 'text',
			cls: 'config-input',
			value: this.agent.name || ''
		});

		const descGroup = nameSection.createEl('div', { cls: 'config-group' });
		descGroup.createEl('label', { text: 'Description', cls: 'config-label' });
		descGroup.createEl('div', { 
			text: 'Optional description for your agent',
			cls: 'config-help'
		});
		const descInput = descGroup.createEl('textarea', {
			cls: 'config-textarea',
			attr: { rows: '3' }
		});
		descInput.value = this.agent.description || '';

		// System prompt section
		const systemSection = form.createEl('div', { cls: 'config-section' });
		systemSection.createEl('h3', { text: 'System Prompt' });
		
		const systemGroup = systemSection.createEl('div', { cls: 'config-group' });
		systemGroup.createEl('label', { text: 'System Instructions', cls: 'config-label' });
		systemGroup.createEl('div', { 
			text: 'Instructions that define how your agent behaves and responds',
			cls: 'config-help'
		});
		const systemInput = systemGroup.createEl('textarea', {
			cls: 'config-textarea',
			attr: { rows: '6' }
		});
		systemInput.value = this.agent.system || '';

		// Tags section
		const tagsSection = form.createEl('div', { cls: 'config-section' });
		tagsSection.createEl('h3', { text: 'Tags' });
		
		const tagsGroup = tagsSection.createEl('div', { cls: 'config-group' });
		tagsGroup.createEl('label', { text: 'Tags (comma-separated)', cls: 'config-label' });
		tagsGroup.createEl('div', { 
			text: 'Organize your agent with tags for easy discovery',
			cls: 'config-help'
		});
		const tagsInput = tagsGroup.createEl('input', {
			type: 'text',
			cls: 'config-input',
			value: this.agent.tags ? this.agent.tags.join(', ') : ''
		});

		// Memory blocks section
		const blocksSection = form.createEl('div', { cls: 'config-section' });
		blocksSection.createEl('h3', { text: 'Core Memory Blocks' });
		
		// Create block editors
		this.blocks.forEach(block => {
			const blockGroup = blocksSection.createEl('div', { cls: 'config-group' });
			const blockHeader = blockGroup.createEl('div', { cls: 'block-header' });
			
			blockHeader.createEl('label', { 
				text: `${block.label || block.name || 'Unnamed Block'}`,
				cls: 'config-label'
			});
			
			const blockInfo = blockHeader.createEl('span', { 
				text: `${block.value?.length || 0}/${block.limit || 5000} chars`,
				cls: 'block-char-count'
			});
			
			if (block.description) {
				blockGroup.createEl('div', { 
					text: block.description,
					cls: 'config-help'
				});
			}
			
			const blockTextarea = blockGroup.createEl('textarea', {
				cls: 'config-textarea block-editor',
				attr: { 
					rows: '8',
					'data-block-label': block.label || block.name
				}
			});
			blockTextarea.value = block.value || '';
			
			if (block.read_only) {
				blockTextarea.disabled = true;
				blockTextarea.style.opacity = '0.6';
			}
			
			// Add character counter update
			blockTextarea.addEventListener('input', () => {
				const currentLength = blockTextarea.value.length;
				const limit = block.limit || 5000;
				blockInfo.textContent = `${currentLength}/${limit} chars`;
				
				if (currentLength > limit) {
					blockInfo.style.color = 'var(--text-error)';
				} else {
					blockInfo.style.color = 'var(--text-muted)';
				}
			});
		});

		// Memory management section
		const memorySection = form.createEl('div', { cls: 'config-section' });
		memorySection.createEl('h3', { text: 'Memory Management' });
		
		const clearGroup = memorySection.createEl('div', { cls: 'config-checkbox-group' });
		const clearCheckbox = clearGroup.createEl('input', {
			type: 'checkbox',
			cls: 'config-checkbox'
		});
		clearCheckbox.checked = this.agent.message_buffer_autoclear || false;
		clearGroup.createEl('label', { 
			text: 'Auto-clear message buffer (agent won\'t remember previous messages)',
			cls: 'config-checkbox-label'
		});

		// Buttons
		const buttonContainer = contentEl.createEl('div', { cls: 'agent-config-buttons' });
		
		
		const saveButton = buttonContainer.createEl('button', {
			text: 'Save Changes',
			cls: 'agent-config-create-btn'
		});
		
		const cancelButton = buttonContainer.createEl('button', {
			text: 'Cancel',
			cls: 'agent-config-cancel-btn'
		});

		// Event handlers

		saveButton.addEventListener('click', async () => {
			const config: any = {};
			const blockUpdates: any[] = [];
			
			// Only include fields that have changed
			if (nameInput.value.trim() !== this.agent.name) {
				config.name = nameInput.value.trim();
			}
			
			if (descInput.value.trim() !== (this.agent.description || '')) {
				config.description = descInput.value.trim() || null;
			}
			
			if (systemInput.value.trim() !== (this.agent.system || '')) {
				config.system = systemInput.value.trim() || null;
			}
			
			const newTags = tagsInput.value.trim() ? 
				tagsInput.value.split(',').map(tag => tag.trim()).filter(tag => tag) : [];
			const currentTags = this.agent.tags || [];
			if (JSON.stringify(newTags) !== JSON.stringify(currentTags)) {
				config.tags = newTags;
			}
			
			if (clearCheckbox.checked !== (this.agent.message_buffer_autoclear || false)) {
				config.message_buffer_autoclear = clearCheckbox.checked;
			}

			// Check for block changes
			const blockTextareas = form.querySelectorAll('.block-editor') as NodeListOf<HTMLTextAreaElement>;
			blockTextareas.forEach(textarea => {
				const blockLabel = textarea.getAttribute('data-block-label');
				const originalBlock = this.blocks.find(b => (b.label || b.name) === blockLabel);
				
				if (originalBlock && textarea.value !== (originalBlock.value || '')) {
					blockUpdates.push({
						label: blockLabel,
						value: textarea.value
					});
				}
			});

			// Save changes
			if (Object.keys(config).length > 0 || blockUpdates.length > 0) {
				await this.onSave({ ...config, blockUpdates });
			}
			
			this.close();
		});

		cancelButton.addEventListener('click', () => {
			this.close();
		});

		// Focus the name input
		nameInput.focus();
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
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

		// Agent ID Setting
		new Setting(containerEl)
			.setName('Agent ID')
			.setDesc('ID of the agent to use with this vault. Leave empty to select an agent when starting chat.')
			.addText(text => text
				.setPlaceholder('Enter agent ID...')
				.setValue(this.plugin.settings.agentId)
				.onChange(async (value) => {
					this.plugin.settings.agentId = value.trim();
					// Clear agent name when ID changes
					if (value.trim() !== this.plugin.settings.agentId) {
						this.plugin.settings.agentName = '';
					}
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

		// Embedding Model Setting
		const embeddingModelSetting = new Setting(containerEl)
			.setName('Embedding Model')
			.setDesc('Model used for embedding vault files. Changing this requires re-embedding all files.');

		// Add dropdown for embedding models
		this.addEmbeddingModelDropdown(embeddingModelSetting);

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

		// Chat Configuration
		containerEl.createEl('h3', { text: 'Chat Configuration' });

		new Setting(containerEl)
			.setName('Show Reasoning Messages')
			.setDesc('Display AI reasoning messages in the chat (useful for debugging)')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.showReasoning)
				.onChange(async (value) => {
					this.plugin.settings.showReasoning = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Enable Streaming')
			.setDesc('Use streaming API for real-time responses (disable for slower but more stable responses)')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.enableStreaming)
				.onChange(async (value) => {
					this.plugin.settings.enableStreaming = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Focus Mode')
			.setDesc('When enabled, only the currently active file is opened in the agent context, all other files are closed')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.focusMode)
				.onChange(async (value) => {
					this.plugin.settings.focusMode = value;
					await this.plugin.saveSettings();
					// Apply focus mode immediately if enabled
					if (value) {
						await this.plugin.applyFocusMode();
					}
				}));

		new Setting(containerEl)
			.setName('Allow Agent Creation')
			.setDesc('When enabled, shows the "Create New Agent" button in the chat interface when no agent is selected')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.allowAgentCreation)
				.onChange(async (value) => {
					this.plugin.settings.allowAgentCreation = value;
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

	async addEmbeddingModelDropdown(setting: Setting) {
		try {
			// Fetch available embedding models
			const embeddingModels = await this.plugin.makeRequest('/v1/models/embedding');
			
			setting.addDropdown(dropdown => {
				// Add options for each embedding model
				embeddingModels.forEach((model: any) => {
					if (model.handle) {
						dropdown.addOption(model.handle, model.handle);
					}
				});
				
				// Set current value
				dropdown.setValue(this.plugin.settings.embeddingModel);
				
				// Handle changes
				dropdown.onChange(async (value) => {
					// Check if the embedding model has actually changed
					if (value !== this.plugin.settings.embeddingModel) {
						// Show confirmation dialog about re-embedding
						const shouldProceed = await this.showEmbeddingChangeConfirmation(value);
						
						if (shouldProceed) {
							// Update the setting
							this.plugin.settings.embeddingModel = value;
							await this.plugin.saveSettings();
							
							// Delete existing source and folder to force re-embedding
							await this.deleteSourceForReembedding();
						} else {
							// Revert the dropdown to the original value
							dropdown.setValue(this.plugin.settings.embeddingModel);
						}
					}
				});
			});
		} catch (error) {
			console.error('Failed to fetch embedding models:', error);
			
			// Fallback to text input if API call fails
			setting.addText(text => text
				.setPlaceholder('letta/letta-free')
				.setValue(this.plugin.settings.embeddingModel)
				.onChange(async (value) => {
					this.plugin.settings.embeddingModel = value;
					await this.plugin.saveSettings();
				}));
		}

		// Advanced Actions
		this.containerEl.createEl('h3', { text: 'Advanced Actions' });

		new Setting(this.containerEl)
			.setName('Delete and Recreate Source')
			.setDesc('Delete the current source and recreate it. This will remove all synced files and require a fresh sync.')
			.addButton(button => button
				.setButtonText('Delete & Recreate Source')
				.setClass('mod-warning')
				.onClick(async () => {
					const confirmed = await this.showDeleteSourceConfirmation();
					if (confirmed) {
						await this.deleteAndRecreateSource();
					}
				}));
	}

	async showEmbeddingChangeConfirmation(newModel: string): Promise<boolean> {
		return new Promise((resolve) => {
			const modal = new Modal(this.app);
			modal.setTitle('Change Embedding Model');
			
			const { contentEl } = modal;
			
			contentEl.createEl('p', { 
				text: `Changing the embedding model from "${this.plugin.settings.embeddingModel}" to "${newModel}" requires re-embedding all vault files.` 
			});
			
			contentEl.createEl('p', { 
				text: 'This will:',
				cls: 'setting-item-description'
			});
			
			const warningList = contentEl.createEl('ul');
			warningList.createEl('li', { text: 'Delete the existing source and all embedded content' });
			warningList.createEl('li', { text: 'Re-upload and re-embed all vault files' });
			warningList.createEl('li', { text: 'Take some time depending on vault size' });
			
			contentEl.createEl('p', { 
				text: 'Do you want to proceed?',
				cls: 'mod-warning'
			});
			
			const buttonContainer = contentEl.createEl('div', { cls: 'modal-button-container' });
			
			const cancelButton = buttonContainer.createEl('button', { text: 'Cancel' });
			cancelButton.addEventListener('click', () => {
				modal.close();
				resolve(false);
			});
			
			const proceedButton = buttonContainer.createEl('button', { 
				text: 'Proceed with Re-embedding',
				cls: 'mod-cta mod-warning'
			});
			proceedButton.addEventListener('click', () => {
				modal.close();
				resolve(true);
			});
			
			modal.open();
		});
	}

	async deleteSourceForReembedding() {
		try {
			if (this.plugin.source) {
				// Delete the existing source
				await this.plugin.makeRequest(`/v1/sources/${this.plugin.source.id}`, {
					method: 'DELETE'
				});
				
				// Clear the source reference
				this.plugin.source = null;
				
				new Notice('Existing source deleted. Re-syncing vault with new embedding model...');
				
				// Trigger a fresh sync with the new embedding model
				if (this.plugin.settings.autoSync) {
					setTimeout(() => {
						this.plugin.syncVaultToLetta();
					}, 1000);
				}
			}
		} catch (error) {
			console.error('Failed to delete source for re-embedding:', error);
			new Notice('Failed to delete existing source. You may need to manually delete it.');
		}
	}

	async showDeleteSourceConfirmation(): Promise<boolean> {
		return new Promise((resolve) => {
			const modal = new Modal(this.app);
			modal.setTitle('Delete and Recreate Source');
			
			const { contentEl } = modal;
			
			contentEl.createEl('p', { 
				text: 'This will permanently delete the current source and all synced files from Letta.' 
			});
			
			contentEl.createEl('p', { 
				text: 'This action will:',
				cls: 'setting-item-description'
			});
			
			const warningList = contentEl.createEl('ul');
			warningList.createEl('li', { text: 'Delete the existing source and all embedded content' });
			warningList.createEl('li', { text: 'Create a new empty source' });
			warningList.createEl('li', { text: 'Require a fresh sync of all vault files' });
			warningList.createEl('li', { text: 'Remove all existing file associations' });
			
			contentEl.createEl('p', { 
				text: 'This action cannot be undone. Are you sure you want to proceed?',
				cls: 'mod-warning'
			});
			
			const buttonContainer = contentEl.createEl('div', { cls: 'modal-button-container' });
			
			const cancelButton = buttonContainer.createEl('button', { text: 'Cancel' });
			cancelButton.addEventListener('click', () => {
				modal.close();
				resolve(false);
			});
			
			const deleteButton = buttonContainer.createEl('button', { 
				text: 'Delete & Recreate',
				cls: 'mod-cta mod-warning'
			});
			deleteButton.addEventListener('click', () => {
				modal.close();
				resolve(true);
			});
			
			modal.open();
		});
	}

	async deleteAndRecreateSource() {
		try {
			new Notice('Deleting existing source...');
			
			if (this.plugin.source) {
				// Delete the existing source
				await this.plugin.makeRequest(`/v1/sources/${this.plugin.source.id}`, {
					method: 'DELETE'
				});
			}
			
			// Clear the source reference
			this.plugin.source = null;
			
			new Notice('Creating new source...');
			
			// Create a new source using the same logic from setupSource()
			const embeddingModels = await this.plugin.makeRequest('/v1/models/embedding');
			const embeddingConfig = embeddingModels.find((model: any) => 
				model.handle === this.plugin.settings.embeddingModel
			);
			
			if (!embeddingConfig) {
				throw new Error(`Embedding model ${this.plugin.settings.embeddingModel} not found`);
			}
			
			// Prepare source creation body
			const isCloudInstance = this.plugin.settings.lettaBaseUrl.includes('api.letta.com');
			const sourceBody: any = {
				name: this.plugin.settings.sourceName,
				instructions: "A collection of markdown files from an Obsidian vault. Directory structure is preserved in filenames using '__' as path separators."
			};
			
			// Only include embedding_config for non-cloud instances
			if (!isCloudInstance) {
				sourceBody.embedding_config = embeddingConfig;
			}

			const newSource = await this.plugin.makeRequest('/v1/sources', {
				method: 'POST',
				body: sourceBody
			});

			this.plugin.source = { id: newSource.id, name: newSource.name };
			
			new Notice('Source recreated successfully. You can now sync your vault files.');
			
		} catch (error) {
			console.error('Failed to delete and recreate source:', error);
			new Notice('Failed to delete and recreate source. Please check your connection and try again.');
		}
	}

	async showAgentSelector(): Promise<void> {
		try {
			// Fetch agents from server
			const agents = await this.plugin.makeRequest('/v1/agents');
			
			if (!agents || agents.length === 0) {
				new Notice('No agents found. Please create an agent first.');
				return;
			}

			return new Promise((resolve) => {
				const modal = new Modal(this.app);
				modal.setTitle('Select Agent');
				
				const { contentEl } = modal;
				
				contentEl.createEl('p', { 
					text: 'Choose an agent to use with this Obsidian vault:',
					cls: 'setting-item-description'
				});
				
				const agentList = contentEl.createEl('div', { cls: 'letta-agent-list' });
				
				agents.forEach((agent: any) => {
					const agentItem = agentList.createEl('div', { cls: 'letta-agent-item' });
					
					const agentInfo = agentItem.createEl('div', { cls: 'letta-agent-info' });
					agentInfo.createEl('div', { text: agent.name, cls: 'letta-agent-item-name' });
					agentInfo.createEl('div', { text: `ID: ${agent.id}`, cls: 'letta-agent-item-id' });
					if (agent.description) {
						agentInfo.createEl('div', { text: agent.description, cls: 'letta-agent-item-desc' });
					}
					
					const selectButton = agentItem.createEl('button', { 
						text: 'Select',
						cls: 'mod-cta'
					});
					
					selectButton.addEventListener('click', async () => {
						this.plugin.settings.agentId = agent.id;
						this.plugin.settings.agentName = agent.name;
						await this.plugin.saveSettings();
						
						// Attempt to connect to the selected agent
						try {
							await this.plugin.setupAgent();
							new Notice(`Selected and connected to agent: ${agent.name}`);
							
							// Update the chat interface to reflect the agent connection
							const chatLeaf = this.app.workspace.getLeavesOfType(LETTA_CHAT_VIEW_TYPE)[0];
							if (chatLeaf && chatLeaf.view instanceof LettaChatView) {
								await (chatLeaf.view as LettaChatView).updateChatStatus();
							}
						} catch (error) {
							console.error('[Letta Plugin] Failed to connect to selected agent:', error);
							new Notice(`Selected agent ${agent.name}, but failed to connect: ${error.message}`);
						}
						
						modal.close();
						
						// Refresh the settings display
						this.display();
						resolve();
					});
				});
				
				const buttonContainer = contentEl.createEl('div', { cls: 'modal-button-container' });
				const cancelButton = buttonContainer.createEl('button', { text: 'Cancel' });
				cancelButton.addEventListener('click', () => {
					modal.close();
					resolve();
				});
				
				modal.open();
			});

		} catch (error) {
			console.error('Failed to fetch agents:', error);
			new Notice('Failed to fetch agents. Please check your connection and try again.');
		}
	}
}
