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

interface LettaPluginSettings {
	lettaApiKey: string;
	lettaBaseUrl: string;
	lettaProjectSlug: string;
	agentName: string;
	sourceName: string;
	autoSync: boolean;
	syncOnStartup: boolean;
	embeddingModel: string;
}

const DEFAULT_SETTINGS: LettaPluginSettings = {
	lettaApiKey: '',
	lettaBaseUrl: 'https://api.letta.com',
	lettaProjectSlug: 'obsidian-vault',
	agentName: 'Obsidian Assistant',
	sourceName: 'obsidian-vault-files',
	autoSync: true,
	syncOnStartup: true,
	embeddingModel: 'letta/letta-free'
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

	updateStatusBar(status: string) {
		if (this.statusBarItem) {
			this.statusBarItem.setText(`Letta: ${status}`);
		}
		
		// Also update chat status if chat view is open
		const chatLeaf = this.app.workspace.getLeavesOfType(LETTA_CHAT_VIEW_TYPE)[0];
		if (chatLeaf && chatLeaf.view instanceof LettaChatView) {
			(chatLeaf.view as LettaChatView).updateChatStatus();
		}
	}

	async makeRequest(path: string, options: any = {}) {
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

	async connectToLetta(attempt: number = 1): Promise<boolean> {
		const maxAttempts = 5;
		const isCloudInstance = this.settings.lettaBaseUrl.includes('api.letta.com');
		
		console.log(`[Letta Plugin] Starting connection to Letta (attempt ${attempt}/${maxAttempts})...`);
		console.log(`[Letta Plugin] Base URL: ${this.settings.lettaBaseUrl}`);
		console.log(`[Letta Plugin] Is cloud instance: ${isCloudInstance}`);
		console.log(`[Letta Plugin] Has API key: ${!!this.settings.lettaApiKey}`);
		
		if (isCloudInstance && !this.settings.lettaApiKey) {
			console.log(`[Letta Plugin] Cloud instance detected but no API key provided`);
			new Notice('API key required for Letta Cloud. Please configure it in settings.');
			return false;
		}

		try {
			this.updateStatusBar(attempt === 1 ? 'Connecting...' : `Retrying... (${attempt}/${maxAttempts})`);
			
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
			
			// Only show success notice on first attempt or after retries
			if (attempt === 1) {
				new Notice('Successfully connected to Letta');
			} else {
				new Notice(`Connected to Letta after ${attempt} attempts`);
			}

			// Sync vault on startup if configured
			if (this.settings.syncOnStartup) {
				console.log(`[Letta Plugin] Starting vault sync...`);
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

			// If we haven't reached max attempts, try again with backoff
			if (attempt < maxAttempts) {
				const backoffMs = Math.min(1000 * Math.pow(2, attempt - 1), 10000); // Cap at 10 seconds
				console.log(`[Letta Plugin] Retrying in ${backoffMs}ms...`);
				
				// Update status to show retry countdown
				this.updateStatusBar(`Retry in ${Math.ceil(backoffMs / 1000)}s...`);
				
				// Wait for backoff period
				await new Promise(resolve => setTimeout(resolve, backoffMs));
				
				// Recursive retry
				return await this.connectToLetta(attempt + 1);
			} else {
				// All attempts failed
				console.error('[Letta Plugin] All connection attempts failed');
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

				const newSource = await this.makeRequest('/v1/sources', {
					method: 'POST',
					body: {
						name: this.settings.sourceName,
						embedding_config: embeddingConfig,
						instructions: "A collection of markdown files from an Obsidian vault. Directory structure is preserved in filenames using '__' as path separators."
					}
				});

				this.source = { id: newSource.id, name: newSource.name };
				console.log(`[Letta Plugin] Created new source with embedding model: ${embeddingConfig.handle}`);
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
					
					await this.makeRequest(`/v1/agents/${this.agent?.id}`, {
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

				// Get embedding config for agent creation
				const embeddingConfigs = await this.makeRequest('/v1/models/embedding');
				const embeddingConfig = embeddingConfigs.find((config: any) => 
					config.handle === 'letta/letta-free' || (config.handle && config.handle.includes('letta'))
				) || embeddingConfigs[0];

				// Create new agent with user configuration
				const isCloudInstance = this.settings.lettaBaseUrl.includes('api.letta.com');
				const agentBody: any = {
					name: agentConfig.name,
					agent_type: agentConfig.agent_type,
					description: agentConfig.description,
					model: agentConfig.model,
					embedding_config: embeddingConfig,
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
		// Auto-connect if not connected
		if (!this.source || !this.agent) {
			new Notice('Connecting to Letta...');
			const connected = await this.connectToLetta();
			if (!connected) {
				return;
			}
		}

		try {
			this.updateStatusBar('Syncing...');
			
			// Get existing files from Letta
			const existingFiles = await this.makeRequest(`/v1/sources/${this.source?.id}/files`);
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
						await this.makeRequest(`/v1/sources/${this.source?.id}/${existingFile.id}`, {
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

					await this.makeRequest(`/v1/sources/${this.source?.id}/upload`, {
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

	async syncCurrentFile(file: TFile | null): Promise<void> {
		if (!file) {
			new Notice('No active file to sync');
			return;
		}

		if (!file.path.endsWith('.md')) {
			new Notice('Only markdown files can be synced to Letta');
			return;
		}

		// Auto-connect if not connected
		if (!this.source || !this.agent) {
			new Notice('Connecting to Letta...');
			const connected = await this.connectToLetta();
			if (!connected) {
				return;
			}
		}

		try {
			this.updateStatusBar('Syncing file...');
			
			const encodedPath = this.encodeFilePath(file.path);
			const content = await this.app.vault.read(file);

			// Check if file exists in Letta and get metadata
			const existingFiles = await this.makeRequest(`/v1/sources/${this.source?.id}/files`);
			const existingFile = existingFiles.find((f: any) => f.file_name === encodedPath);
			
			let action = 'uploaded';
			
			if (existingFile) {
				// Delete existing file first
				await this.makeRequest(`/v1/sources/${this.source?.id}/${existingFile.id}`, {
					method: 'DELETE'
				});
				action = 'updated';
			}

			// Upload the file
			console.log(`[Letta Plugin] Syncing current file:`, encodedPath);
			
			const boundary = '----formdata-obsidian-' + Math.random().toString(36).substr(2);
			const multipartBody = [
				`--${boundary}`,
				`Content-Disposition: form-data; name="file"; filename="${encodedPath}"`,
				'Content-Type: text/markdown',
				'',
				content,
				`--${boundary}--`
			].join('\r\n');

			await this.makeRequest(`/v1/sources/${this.source?.id}/upload`, {
				method: 'POST',
				headers: {
					'Content-Type': `multipart/form-data; boundary=${boundary}`
				},
				body: multipartBody,
				isFileUpload: true
			});

			this.updateStatusBar('Connected');
			new Notice(`File "${file.name}" ${action} to Letta successfully`);

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

		// Auto-connect if not connected (silently for auto-sync)
		if (!this.source || !this.agent) {
			try {
				await this.connectToLetta();
			} catch (error) {
				// Silent fail for auto-sync - don't spam user with notices
				console.log('[Letta Plugin] Auto-sync failed: not connected');
				return;
			}
		}

		try {
			const encodedPath = this.encodeFilePath(file.path);
			const content = await this.app.vault.read(file);

			// Delete existing file if it exists
			try {
				const existingFiles = await this.makeRequest(`/v1/sources/${this.source?.id}/files`);
				const existingFile = existingFiles.find((f: any) => f.file_name === encodedPath);
				if (existingFile) {
					await this.makeRequest(`/v1/sources/${this.source?.id}/${existingFile.id}`, {
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

			await this.makeRequest(`/v1/sources/${this.source?.id}/upload`, {
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
		if (!file.path.endsWith('.md')) {
			return;
		}

		// Auto-connect if not connected (silently for auto-sync)
		if (!this.source || !this.agent) {
			try {
				await this.connectToLetta();
			} catch (error) {
				// Silent fail for auto-sync - don't spam user with notices
				console.log('[Letta Plugin] Auto-delete failed: not connected');
				return;
			}
		}

		try {
			const encodedPath = this.encodeFilePath(file.path);
			const existingFiles = await this.makeRequest(`/v1/sources/${this.source?.id}/files`);
			const existingFile = existingFiles.find((f: any) => f.file_name === encodedPath);
			
			if (existingFile) {
				await this.makeRequest(`/v1/sources/${this.source?.id}/${existingFile.id}`, {
					method: 'DELETE'
				});
			}
		} catch (error) {
			console.error('Failed to delete file from Letta:', error);
		}
	}

	async openChatView(): Promise<void> {
		// Auto-connect if not connected
		if (!this.agent || !this.source) {
			new Notice('Connecting to Letta...');
			const connected = await this.connectToLetta();
			if (!connected) {
				return;
			}
		}

		const { workspace } = this.app;

		let leaf: WorkspaceLeaf | null = null;
		const leaves = workspace.getLeavesOfType(LETTA_CHAT_VIEW_TYPE);

		if (leaves.length > 0) {
			// A leaf with our view already exists, use that
			leaf = leaves[0];
		} else {
			// Our view could not be found in the workspace, create a new leaf
			// in the right sidebar for it
			leaf = workspace.getRightLeaf(false);
			if (leaf) {
				await leaf.setViewState({ type: LETTA_CHAT_VIEW_TYPE, active: true });
			}
		}

		// "Reveal" the leaf in case it is in a collapsed sidebar
		if (leaf) {
			workspace.revealLeaf(leaf);
		}
	}

	async openMemoryView(): Promise<void> {
		// Auto-connect if not connected
		if (!this.agent) {
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

	async sendMessageToAgentStreaming(message: string, onChunk: (chunk: any) => void): Promise<void> {
		if (!this.agent) throw new Error('Agent not connected');

		const url = `${this.settings.lettaBaseUrl}/v1/agents/${this.agent?.id}/messages/stream`;
		const headers: Record<string, string> = {
			'Content-Type': 'application/json'
		};

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
			stream_steps: true,
			stream_tokens: true
		};

		try {
			const response = await fetch(url, {
				method: 'POST',
				headers: headers,
				body: JSON.stringify(body)
			});

			if (!response.ok) {
				const errorText = await response.text();
				throw new Error(`HTTP ${response.status}: ${errorText}`);
			}

			if (!response.body) {
				throw new Error('Response body is null');
			}

			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = '';

			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;

					buffer += decoder.decode(value, { stream: true });
					const lines = buffer.split('\n');
					buffer = lines.pop() || '';

					for (const line of lines) {
						if (line.trim() === '') continue;
						if (line.trim() === 'data: [DONE]') return;
						
						if (line.startsWith('data: ')) {
							const jsonStr = line.slice(6);
							try {
								const chunk = JSON.parse(jsonStr);
								onChunk(chunk);
							} catch (parseError) {
								console.warn('[Letta Plugin] Failed to parse SSE chunk:', jsonStr);
							}
						}
					}
				}
			} finally {
				reader.releaseLock();
			}
		} catch (error) {
			console.error('[Letta Plugin] Streaming request failed:', error);
			throw error;
		}
	}
}

class LettaChatView extends ItemView {
	plugin: LettaPlugin;
	chatContainer: HTMLElement;
	systemMessagesContainer: HTMLElement;
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
		this.agentNameElement = titleContainer.createEl('h3', { text: this.plugin.settings.agentName, cls: 'letta-chat-title' });
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
		
		// Hidden system messages container
		this.systemMessagesContainer = container.createEl('div', { 
			cls: 'letta-system-messages-container'
		});
		this.systemMessagesContainer.style.display = 'none';
		
		// System messages toggle button (unobtrusive)
		const systemToggle = container.createEl('div', { 
			cls: 'letta-system-toggle',
			text: '⚙️',
			attr: { title: 'Toggle system messages' }
		});
		systemToggle.style.cssText = 'position: absolute; top: 10px; right: 10px; cursor: pointer; opacity: 0.3; font-size: 12px; z-index: 100;';
		systemToggle.addEventListener('click', () => {
			const isVisible = this.systemMessagesContainer.style.display !== 'none';
			this.systemMessagesContainer.style.display = isVisible ? 'none' : 'block';
			systemToggle.style.opacity = isVisible ? '0.3' : '0.8';
		});
		
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
			cls: 'letta-send-button mod-cta',
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

	addMessage(type: 'user' | 'assistant' | 'reasoning' | 'tool-call' | 'tool-result', content: string, title?: string, reasoningContent?: string) {
		// Hide typing indicator when real content arrives
		this.hideTypingIndicator();
		// Debug: Check for system_alert content being added as regular message
		if (content && content.includes('"type": "system_alert"')) {
			console.error('[Letta Plugin] ALERT: system_alert content being added as regular message!');
			console.error('[Letta Plugin] Content:', content);
			console.error('[Letta Plugin] Stack trace:', new Error().stack);
			// Don't add this message - it should have been filtered
			return null;
		}
		
		// Debug: Check for heartbeat content being added as regular message
		if (content && (content.includes('"type": "heartbeat"') || 
						content.includes('automated system message') ||
						content.includes('Function call failed, returning control') ||
						content.includes('request_heartbeat=true'))) {
			console.log('[Letta Plugin] Blocked heartbeat content from being displayed as message');
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
						text: '···'
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
					// Handle bold and italic
					.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
					.replace(/\*(.*?)\*/g, '<em>$1</em>')
					.replace(/`([^`]+)`/g, '<code>$1</code>')
					// Handle numbered lists (1. 2. 3. etc.)
					.replace(/^(\d+)\.\s+(.+)$/gm, '<li class="numbered-list">$2</li>')
					// Handle bullet lists
					.replace(/^[-•]\s+(.+)$/gm, '<li>$1</li>')
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

			const contentEl = bubbleEl.createEl('div', { cls: 'letta-message-content' });
			
			// Enhanced markdown-like formatting
			let formattedContent = content
				// Trim leading and trailing whitespace first
				.trim()
				// Normalize multiple consecutive newlines to double newlines
				.replace(/\n{3,}/g, '\n\n')
				// Handle bold and italic
				.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
				.replace(/\*(.*?)\*/g, '<em>$1</em>')
				.replace(/`([^`]+)`/g, '<code>$1</code>')
				// Handle numbered lists (1. 2. 3. etc.)
				.replace(/^(\d+)\.\s+(.+)$/gm, '<li class="numbered-list">$2</li>')
				// Handle bullet lists
				.replace(/^[-•]\s+(.+)$/gm, '<li>$1</li>')
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
			
			contentEl.innerHTML = formattedContent;
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

	clearChat() {
		this.chatContainer.empty();
		// Update status to show disconnected message if not connected
		this.updateChatStatus();
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
			// Clear any pending reasoning from previous sessions
			this.pendingReasoning = '';
			
			// Load last 50 messages by default
			const messages = await this.plugin.makeRequest(`/v1/agents/${this.plugin.agent?.id}/messages?limit=50`);
			
			if (!messages || messages.length === 0) {
				return;
			}

			// Sort messages by timestamp (oldest first)
			const sortedMessages = messages.sort((a: any, b: any) => 
				new Date(a.date).getTime() - new Date(b.date).getTime()
			);

			// Display messages in order
			for (const message of sortedMessages) {
				this.displayHistoricalMessage(message);
			}

			// Add a separator to distinguish historical messages from new ones
			this.addMessageSeparator('Previous conversation history');

		} catch (error) {
			console.error('[Letta Plugin] Failed to load historical messages:', error);
			// Don't show error to user - historical messages are optional
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
			/real-time.*conscious awareness/i
		];
		
		// Check if content contains system prompt patterns
		const hasSystemContent = systemPromptPatterns.some(pattern => pattern.test(content));
		
		if (hasSystemContent) {
			console.log('[Letta Plugin] Filtering out system prompt content');
			// Try to extract only the actual user-facing response
			const lines = content.split('\n');
			const filteredLines = lines.filter(line => {
				// Keep lines that don't look like system instructions
				return !systemPromptPatterns.some(pattern => pattern.test(line)) &&
				       !line.includes('<') && // Filter out XML-like tags
				       line.trim().length > 0;
			});
			
			const filtered = filteredLines.join('\n').trim();
			
			// If we filtered out everything, return a placeholder
			if (!filtered) {
				return 'I processed your request and am ready to help.';
			}
			
			return filtered;
		}
		
		return content;
	}

	// Format tool results with JSON pretty-printing when possible
	formatToolResult(toolResult: string): string {
		if (!toolResult) return toolResult;

		try {
			// Try to parse as JSON
			const parsed = JSON.parse(toolResult);
			// If successful, return pretty-printed JSON
			return JSON.stringify(parsed, null, 2);
		} catch (e) {
			// If not valid JSON, return original string
			return toolResult;
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
		
		// Process the content to extract the main message and billing link
		const lines = content.split('\n');
		let mainMessage = '';
		let billingLink = '';
		
		for (const line of lines) {
			if (line.includes('https://app.letta.com/settings/organization/billing')) {
				billingLink = line.trim();
			} else if (line.trim() && !line.includes('Need more?')) {
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

		// Scroll to bottom
		this.chatContainer.scrollTop = this.chatContainer.scrollHeight;
	}

	displayHistoricalMessage(message: any) {
		console.log('[Letta Plugin] Processing historical message:', message);
		
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
			console.log('[Letta Plugin] Capturing system_alert message:', message);
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
			console.log('[Letta Plugin] Skipping historical heartbeat message:', messageType, message.message_type, messageRole, messageReason);
			return;
		}
		
		// Parse different message types based on Letta's message structure
		switch (message.message_type) {
			case 'user_message':
				if (message.text || message.content) {
					this.addMessage('user', message.text || message.content || '');
				}
				break;
			
			case 'reasoning_message':
				if (message.reasoning) {
					// Store reasoning to be used for next tool call or assistant message
					this.pendingReasoning += message.reasoning;
				}
				break;
			
			case 'tool_call_message':
				if (message.tool_call) {
					// Create tool interaction with reasoning and wait for tool result
					this.currentToolCallMessage = this.addToolInteractionMessage(
						this.pendingReasoning, 
						JSON.stringify(message.tool_call, null, 2)
					);
					// Clear reasoning after using it
					this.pendingReasoning = '';
				}
				break;
			
			case 'tool_return_message':
				if (message.tool_return && this.currentToolCallMessage) {
					// Add tool result to the existing tool interaction message
					this.addToolResultToMessage(this.currentToolCallMessage, 
						JSON.stringify(message.tool_return, null, 2));
					// Clear the current tool call message reference
					this.currentToolCallMessage = null;
				}
				break;
			
			case 'assistant_message':
				if (message.content || message.text) {
					// Filter out system prompt content and use accumulated reasoning
					const rawContent = message.content || message.text || '';
					const filteredContent = this.filterSystemPromptContent(rawContent);
					this.addMessage('assistant', filteredContent, 
						this.plugin.settings.agentName, this.pendingReasoning || undefined);
					// Clear pending reasoning after using it
					this.pendingReasoning = '';
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
				console.log('[Letta Plugin] Unrecognized historical message type:', message.message_type, 'with type property:', messageType);
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
		const messageEl = this.systemMessagesContainer.createEl('div', { 
			cls: 'letta-system-message' 
		});
		
		// Add timestamp
		const timestamp = new Date().toLocaleTimeString();
		const timeEl = messageEl.createEl('div', { 
			text: `[${timestamp}] ${message.type || message.message_type || 'system'}`,
			cls: 'letta-system-message-header'
		});
		
		// Add message content as JSON for debugging
		const contentEl = messageEl.createEl('pre', { 
			cls: 'letta-system-message-content' 
		});
		contentEl.createEl('code', { 
			text: JSON.stringify(message, null, 2)
		});
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
		console.log('[Letta Plugin] Heartbeat received - showing typing indicator');
		this.showTypingIndicator();
		
		// Clear existing timeout
		if (this.heartbeatTimeout) {
			clearTimeout(this.heartbeatTimeout);
		}
		
		// Hide typing indicator after 3 seconds of no heartbeats
		this.heartbeatTimeout = setTimeout(() => {
			console.log('[Letta Plugin] No heartbeat for 3s - hiding typing indicator');
			this.hideTypingIndicator();
			this.heartbeatTimeout = null;
		}, 3000);
	}

	updateChatStatus() {
		// Determine connection status based on plugin state
		const isConnected = this.plugin.agent && this.plugin.source;
		
		if (isConnected) {
			this.statusDot.className = 'letta-status-dot letta-status-connected';
			
			// Show project info only for cloud instances
			const isCloudInstance = this.plugin.settings.lettaBaseUrl.includes('api.letta.com');
			const projectInfo = (isCloudInstance && this.plugin.settings.lettaProjectSlug)
				? ` • Project: ${this.plugin.settings.lettaProjectSlug}`
				: '';
			
			this.statusText.textContent = `Connected${projectInfo}`;
			
			// Update model button if it exists
			if (this.modelButton) {
				this.updateModelButton();
			}
			
			// Remove disconnected message if it exists
			this.removeDisconnectedMessage();
			
			// Load historical messages on first connection
			this.loadHistoricalMessages();
		} else {
			this.statusDot.className = 'letta-status-dot';
			this.statusDot.style.backgroundColor = 'var(--text-muted)';
			this.statusText.textContent = 'Disconnected';
			if (this.modelButton) {
				this.modelButton.textContent = 'N/A';
			}
			
			// Show disconnected message in chat area
			this.showDisconnectedMessage();
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
			text: 'Connect to start chatting with your AI agent about your vault contents.', 
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
				this.agentNameElement.textContent = newName;
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
					this.agentNameElement.textContent = agentConfig.name;
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
		if (!this.plugin.agent || !this.plugin.source) {
			this.addMessage('assistant', 'Connecting to Letta...', 'System');
			const connected = await this.plugin.connectToLetta();
			if (!connected) {
				this.addMessage('assistant', '**Connection failed**. Please check your settings and try again.', 'Error');
				return;
			}
			this.addMessage('assistant', '**Connected!** You can now chat with your agent.', 'System');
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
			// Try streaming first, fallback to non-streaming on CORS/network errors
			const isLocalInstance = !this.plugin.settings.lettaBaseUrl.includes('api.letta.com');
			console.log('[Letta Plugin] Sending message, isLocalInstance:', isLocalInstance);
			let useStreaming = true;
			
			if (isLocalInstance) {
				// For local instances, try streaming but be ready to fallback
				try {
					console.log('[Letta Plugin] Attempting streaming for local instance...');
					await this.plugin.sendMessageToAgentStreaming(message, (chunk) => {
						this.handleStreamingChunk(chunk);
					});
					console.log('[Letta Plugin] Streaming completed successfully');
				} catch (streamError: any) {
					console.log('[Letta Plugin] Streaming failed (likely CORS), falling back to non-streaming:', streamError.message);
					useStreaming = false;
					
					// Show appropriate warning to user
					if (streamError.message.includes('429') || streamError.message.includes('Rate limited')) {
						this.addRateLimitMessage(`Rate Limited - You've reached the rate limit for your account. Please wait a moment before sending another message.\n\nNeed more? Letta Cloud offers Pro, Scale, and Enterprise plans:\nhttps://app.letta.com/settings/organization/billing`);
					} else {
						// Likely CORS issue for local instances
						this.addMessage('assistant', `ℹ️ **Streaming Unavailable** - Using standard mode due to connection limitations.`, 'System');
					}
					
					// Clear any partial messages from failed streaming attempt
					this.currentReasoningMessage = null;
					this.currentAssistantMessage = null;
					this.currentToolCallMessage = null;
					
					// Fall back to non-streaming API
					const messages = await this.plugin.sendMessageToAgent(message);
					this.processNonStreamingMessages(messages);
				}
			} else {
				// For cloud instances, use streaming
				try {
					console.log('[Letta Plugin] Attempting streaming for cloud instance...');
					await this.plugin.sendMessageToAgentStreaming(message, (chunk) => {
						this.handleStreamingChunk(chunk);
					});
					console.log('[Letta Plugin] Streaming completed successfully');
				} catch (streamError: any) {
					console.log('[Letta Plugin] Cloud streaming failed, falling back to non-streaming:', streamError.message);
					
					// Show rate limiting warning to user if applicable
					if (streamError.message.includes('429') || streamError.message.includes('Rate limited')) {
						this.addRateLimitMessage(`Rate Limited - You've reached the rate limit for your account. Please wait a moment before sending another message.\n\nNeed more? Letta Cloud offers Pro, Scale, and Enterprise plans:\nhttps://app.letta.com/settings/organization/billing`);
					}
					
					// Clear any partial messages from failed streaming attempt
					this.currentReasoningMessage = null;
					this.currentAssistantMessage = null;
					this.currentToolCallMessage = null;
					
					// Fall back to non-streaming API
					const messages = await this.plugin.sendMessageToAgent(message);
					this.processNonStreamingMessages(messages);
				}
			}

		} catch (error: any) {
			console.error('Failed to send message:', error);
			
			// Provide specific error messages for common issues
			let errorMessage = `**Error**: ${error.message}`;
			
			if (error.message.includes('429') || error.message.includes('Rate limited')) {
				// Use the special rate limit message display instead of regular error message
				this.addRateLimitMessage(`Rate Limit Exceeded - You've reached the rate limit for your account. Please wait a moment before sending another message.\n\nReason: ${error.message.includes('model-unknown') ? 'Unknown model configuration' : 'Too many requests'}\n\nNeed more? Letta Cloud offers Pro, Scale, and Enterprise plans:\nhttps://app.letta.com/settings/organization/billing`);
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

	private currentReasoningMessage: HTMLElement | null = null;
	private currentAssistantMessage: HTMLElement | null = null;
	private currentToolCallMessage: HTMLElement | null = null;
	private pendingReasoning: string = '';

	handleStreamingChunk(chunk: any) {
		console.log('[Letta Plugin] Streaming chunk received:', chunk);
		
		// Handle system messages - capture system_alert for hidden viewing, skip heartbeats
		if (chunk.type === 'system_alert' || 
			(chunk.message && typeof chunk.message === 'string' && chunk.message.includes('prior messages have been hidden'))) {
			console.log('[Letta Plugin] Capturing streaming system_alert message:', chunk);
			this.addSystemMessage(chunk);
			return;
		}
		
		// Handle heartbeat messages - show typing indicator
		if (chunk.type === 'heartbeat' || 
			chunk.message_type === 'heartbeat' ||
			chunk.role === 'heartbeat' ||
			(chunk.reason && (chunk.reason.includes('automated system message') ||
							  chunk.reason.includes('Function call failed, returning control') ||
							  chunk.reason.includes('request_heartbeat=true')))) {
			this.handleHeartbeat();
			return;
		}
		
		switch (chunk.message_type) {
			case 'reasoning_message':
				console.log('[Letta Plugin] Processing reasoning_message, reasoning:', chunk.reasoning);
				if (chunk.reasoning) {
					// For tool-related reasoning, check if we're expecting a tool call
					this.pendingReasoning += chunk.reasoning;
					console.log('[Letta Plugin] Added to pendingReasoning, total length:', this.pendingReasoning.length);
				}
				break;

			case 'assistant_message_token':
				// Handle individual token streaming for real-time display
				console.log('[Letta Plugin] Processing token:', chunk.token || chunk.content || chunk.text);
				const token = chunk.token || chunk.content || chunk.text;
				if (token) {
					if (!this.currentAssistantMessage) {
						console.log('[Letta Plugin] Creating new assistant message for token streaming with reasoning length:', this.pendingReasoning.length);
						// Create new assistant message with accumulated reasoning
						this.currentAssistantMessage = this.addStreamingMessage('assistant', '', 
							this.plugin.settings.agentName, this.pendingReasoning || undefined);
						// Clear pending reasoning after using it
						this.pendingReasoning = '';
					}
					// Append token to current assistant message for real-time display
					this.appendToStreamingMessage(this.currentAssistantMessage, token);
				}
				break;

			case 'tool_call_message':
				console.log('[Letta Plugin] Processing tool_call_message, tool_call:', chunk.tool_call);
				if (chunk.tool_call) {
					if (!this.currentToolCallMessage) {
						console.log('[Letta Plugin] Creating new tool call message with reasoning length:', this.pendingReasoning.length);
						// Create tool interaction message with reasoning and expandable sections
						this.currentToolCallMessage = this.addToolInteractionMessage(
							this.pendingReasoning, 
							JSON.stringify(chunk.tool_call, null, 2)
						);
						// Clear reasoning after using it
						this.pendingReasoning = '';
					} else {
						console.log('[Letta Plugin] Appending to existing tool call message');
						// This might be a streaming tool call - we could append additional data
						// For now, we'll just log it to avoid duplicate messages
					}
				}
				break;

			case 'tool_return_message':
				if (chunk.tool_return && this.currentToolCallMessage) {
					// Add tool result to the existing tool interaction message
					this.addToolResultToMessage(this.currentToolCallMessage, 
						JSON.stringify(chunk.tool_return, null, 2));
				}
				break;

			case 'assistant_message':
				console.log('[Letta Plugin] Processing assistant_message, full chunk:', chunk);
				console.log('[Letta Plugin] chunk.assistant_message:', chunk.assistant_message);
				console.log('[Letta Plugin] chunk.content:', chunk.content);
				console.log('[Letta Plugin] chunk.text:', chunk.text);
				console.log('[Letta Plugin] chunk.message:', chunk.message);
				
				// Try different possible property names for the message content
				const rawContent = chunk.assistant_message || chunk.content || chunk.text || chunk.message;
				console.log('[Letta Plugin] Raw messageContent:', rawContent);
				
				// Filter out system prompt content
				const messageContent = rawContent ? this.filterSystemPromptContent(rawContent) : rawContent;
				console.log('[Letta Plugin] Filtered messageContent:', messageContent);
				
				if (messageContent) {
					if (!this.currentAssistantMessage) {
						console.log('[Letta Plugin] Creating new assistant message with reasoning length:', this.pendingReasoning.length);
						// Create new assistant message with accumulated reasoning
						this.currentAssistantMessage = this.addStreamingMessage('assistant', '', 
							this.plugin.settings.agentName, this.pendingReasoning || undefined);
						// Clear pending reasoning after using it
						this.pendingReasoning = '';
					}
					// Append to current assistant message
					console.log('[Letta Plugin] Appending to assistant message:', messageContent);
					this.appendToStreamingMessage(this.currentAssistantMessage, messageContent);
				}
				break;

			case 'usage_statistics':
				// Stream finished, reset current messages
				this.currentReasoningMessage = null;
				this.currentAssistantMessage = null;
				this.currentToolCallMessage = null;
				this.pendingReasoning = '';
				break;
				
			case 'heartbeat':
				// Handle heartbeat messages - show typing indicator
				this.handleHeartbeat();
				break;

			default:
				// Log unknown message types for debugging
				console.log('[Letta Plugin] Unknown message type:', chunk.message_type, 'chunk:', chunk);
				
				// Check if this might be a token in a different format
				if (chunk.token || (chunk.content && typeof chunk.content === 'string')) {
					const possibleToken = chunk.token || chunk.content;
					console.log('[Letta Plugin] Possible token in unknown format:', possibleToken);
					
					if (!this.currentAssistantMessage && this.pendingReasoning) {
						console.log('[Letta Plugin] Creating new assistant message for unknown token format');
						this.currentAssistantMessage = this.addStreamingMessage('assistant', '', 
							this.plugin.settings.agentName, this.pendingReasoning || undefined);
						this.pendingReasoning = '';
					}
					
					if (this.currentAssistantMessage && possibleToken) {
						this.appendToStreamingMessage(this.currentAssistantMessage, possibleToken);
					}
				}
				break;
		}
	}

	addStreamingMessage(type: 'user' | 'assistant' | 'reasoning' | 'tool-call' | 'tool-result', content: string, title?: string, reasoningContent?: string): HTMLElement {
		const messageEl = this.chatContainer.createEl('div', { 
			cls: `letta-message letta-message-${type}` 
		});

		// Create bubble wrapper
		const bubbleEl = messageEl.createEl('div', { cls: 'letta-message-bubble' });

		// Add timestamp
		const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
		
		// Skip tool messages - they're now handled by addToolInteractionMessage
		if (type === 'tool-call' || type === 'tool-result') {
			return messageEl; // Return empty element
			
		} else if (type === 'reasoning') {
			// Skip standalone reasoning messages - they should be part of assistant messages
			return messageEl; // Return empty element that won't be displayed
			
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
						text: '···'
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
				reasoningEl.textContent = reasoningContent; // Start with plain text for streaming
			}

			const contentEl = bubbleEl.createEl('div', { 
				cls: 'letta-message-content',
				text: content
			});
		}

		// Auto-scroll to bottom
		setTimeout(() => {
			this.chatContainer.scrollTo({
				top: this.chatContainer.scrollHeight,
				behavior: 'smooth'
			});
		}, 10);

		return messageEl;
	}

	addToolInteractionMessage(reasoning: string, toolCall: string): HTMLElement {
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

		// Reasoning content (always visible)
		if (reasoning) {
			const reasoningEl = bubbleEl.createEl('div', { cls: 'letta-tool-reasoning' });
			
			// Enhanced markdown-like formatting for reasoning
			let formattedReasoning = reasoning
				// Trim leading and trailing whitespace first
				.trim()
				// Normalize multiple consecutive newlines to double newlines
				.replace(/\n{3,}/g, '\n\n')
				// Handle bold and italic
				.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
				.replace(/\*(.*?)\*/g, '<em>$1</em>')
				.replace(/`([^`]+)`/g, '<code>$1</code>')
				// Handle numbered lists (1. 2. 3. etc.)
				.replace(/^(\d+)\.\s+(.+)$/gm, '<li class="numbered-list">$2</li>')
				// Handle bullet lists
				.replace(/^[-•]\s+(.+)$/gm, '<li>$1</li>')
				// Handle double newlines as paragraph breaks first
				.replace(/\n\n/g, '</p><p>')
				// Convert remaining single newlines to <br> tags
				.replace(/\n/g, '<br>');
			
			// Wrap consecutive numbered list items in <ol> tags
			formattedReasoning = formattedReasoning.replace(/(<li class="numbered-list">.*?<\/li>)(\s*<li class="numbered-list">.*?<\/li>)*/g, (match) => {
				return '<ol>' + match + '</ol>';
			});
			
			// Wrap consecutive bullet list items in <ul> tags
			formattedReasoning = formattedReasoning.replace(/(<li>(?!.*class="numbered-list").*?<\/li>)(\s*<li>(?!.*class="numbered-list").*?<\/li>)*/g, (match) => {
				return '<ul>' + match + '</ul>';
			});
			
			// Wrap in paragraphs if needed
			if (formattedReasoning.includes('</p><p>') && !formattedReasoning.startsWith('<')) {
				formattedReasoning = '<p>' + formattedReasoning + '</p>';
			}
			
			reasoningEl.innerHTML = formattedReasoning;
		}

		// Tool call expandable section with enhanced design
		const toolCallHeader = bubbleEl.createEl('div', { cls: 'letta-expandable-header letta-tool-section letta-tool-prominent' });
		
		// Left side with tool name and loading
		const toolLeftSide = toolCallHeader.createEl('div', { cls: 'letta-tool-left' });
		const toolTitle = toolLeftSide.createEl('span', { cls: 'letta-expandable-title letta-tool-name', text: toolName });
		
		// Add loading indicator that will be replaced when result comes in
		const loadingIndicator = toolLeftSide.createEl('span', { 
			cls: 'letta-tool-loading',
			text: ' •••'
		});
		
		// Curvy connecting line (SVG) - continuous flowing wave
		const connectionLine = toolCallHeader.createEl('div', { cls: 'letta-tool-connection' });
		connectionLine.innerHTML = `
			<svg viewBox="0 0 400 12" class="letta-tool-curve" preserveAspectRatio="none">
				<path d="M -50,6 Q -25,2 0,6 T 50,6 T 100,6 T 150,6 T 200,6 T 250,6 T 300,6 T 350,6 T 400,6 T 450,6" 
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
		toolCallPre.createEl('code', { text: toolCall });
		
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
		toolResultHeader.createEl('span', { cls: 'letta-expandable-title', text: 'Tool Result' });
		const toolResultChevron = toolResultHeader.createEl('span', { cls: 'letta-expandable-chevron', text: '○' });
		
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

	addToolResultToMessage(messageEl: HTMLElement, toolResult: string) {
		const bubbleEl = messageEl.querySelector('.letta-message-bubble');
		if (!bubbleEl) return;

		// Remove loading indicator from tool call header
		const loadingIndicator = bubbleEl.querySelector('.letta-tool-loading');
		if (loadingIndicator) {
			loadingIndicator.remove();
		}

		// Show the tool result section
		const toolResultHeader = bubbleEl.querySelector('.letta-tool-result-pending') as HTMLElement;
		const toolResultContent = bubbleEl.querySelector('.letta-expandable-content:last-child') as HTMLElement;
		
		if (toolResultHeader && toolResultContent) {
			// Make visible
			toolResultHeader.style.display = 'flex';
			toolResultContent.style.display = 'block';
			toolResultHeader.removeClass('letta-tool-result-pending');

			// Add content with JSON pretty-printing
			const toolResultPre = toolResultContent.createEl('pre', { cls: 'letta-code-block' });
			const formattedResult = this.formatToolResult(toolResult);
			toolResultPre.createEl('code', { text: formattedResult });

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

	appendToStreamingMessage(messageEl: HTMLElement, newContent: string) {
		// Look for content in both regular and expandable structures
		const contentEl = messageEl.querySelector('.letta-message-content') || 
						  messageEl.querySelector('.letta-expandable-content');
		if (contentEl) {
			contentEl.textContent = (contentEl.textContent || '') + newContent;
			
			// Auto-scroll to bottom
			setTimeout(() => {
				this.chatContainer.scrollTo({
					top: this.chatContainer.scrollHeight,
					behavior: 'smooth'
				});
			}, 10);
		}
	}

	processNonStreamingMessages(messages: any[]) {
		console.log('[Letta Plugin] Processing non-streaming messages:', messages);
		
		// Process response messages (fallback for when streaming fails)
		let tempReasoning = '';
		let tempToolMessage: HTMLElement | null = null;
		
		for (const responseMessage of messages) {
			// Handle system messages - capture system_alert for hidden viewing, skip heartbeats
			if (responseMessage.type === 'system_alert' || 
				(responseMessage.message && typeof responseMessage.message === 'string' && responseMessage.message.includes('prior messages have been hidden'))) {
				console.log('[Letta Plugin] Capturing non-streaming system_alert message:', responseMessage);
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
					if (responseMessage.content) {
						// Filter out system prompt content and use accumulated reasoning
						const filteredContent = this.filterSystemPromptContent(responseMessage.content);
						this.addMessage('assistant', filteredContent, this.plugin.settings.agentName, 
							tempReasoning || undefined);
						// Clear temp reasoning after using it
						tempReasoning = '';
					}
					break;
					
				case 'heartbeat':
					// Skip heartbeat messages - should already be filtered above
					console.log('[Letta Plugin] Heartbeat message reached switch statement - should have been filtered earlier');
					break;
			}
		}
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
			// Clear current chat
			this.clearChat();
			
			// Update plugin settings
			this.plugin.settings.agentName = agent.name;
			if (project) {
				this.plugin.settings.lettaProjectSlug = project.slug;
			}
			await this.plugin.saveSettings();
			
			// Update plugin agent reference
			this.plugin.agent = agent;
			
			// Update UI
			this.agentNameElement.textContent = agent.name;
			
			// Show success message
			this.addMessage('assistant', `Switched to agent: **${agent.name}**${project ? ` (Project: ${project.name})` : ''}`, 'System');
			
			new Notice(`Switched to agent: ${agent.name}`);
			
		} catch (error) {
			console.error('Failed to switch agent:', error);
			new Notice('Failed to switch agent. Please try again.');
			this.addMessage('assistant', '**Error**: Failed to switch agent. Please try again.', 'Error');
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
			// Auto-connect if not connected
			if (!this.plugin.agent) {
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
			agent_type: 'memgpt_agent',
			description: 'An AI assistant for your Obsidian vault',
			include_base_tools: true,
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
		filtersSection.createEl('h3', { text: 'Filter Models' });

		// Provider category filter
		const categoryGroup = filtersSection.createEl('div', { cls: 'config-group' });
		categoryGroup.createEl('label', { text: 'Provider Category:', cls: 'config-label' });
		this.providerCategorySelect = categoryGroup.createEl('select', { cls: 'config-select' });
		this.providerCategorySelect.createEl('option', { text: 'All Categories', value: '' });
		this.providerCategorySelect.createEl('option', { text: 'Base (Letta-hosted)', value: 'base' });
		this.providerCategorySelect.createEl('option', { text: 'BYOK (Bring Your Own Key)', value: 'byok' });

		// Provider name filter
		const providerGroup = filtersSection.createEl('div', { cls: 'config-group' });
		providerGroup.createEl('label', { text: 'Provider:', cls: 'config-label' });
		this.providerNameSelect = providerGroup.createEl('select', { cls: 'config-select' });
		this.providerNameSelect.createEl('option', { text: 'All Providers', value: '' });

		// Search filter
		const searchGroup = filtersSection.createEl('div', { cls: 'config-group' });
		searchGroup.createEl('label', { text: 'Search Models:', cls: 'config-label' });
		this.searchInput = searchGroup.createEl('input', { 
			cls: 'config-input',
			attr: { type: 'text', placeholder: 'Search by model name...' }
		});

		// Models section
		const modelsSection = content.createEl('div', { cls: 'config-section' });
		modelsSection.createEl('h3', { text: 'Available Models' });
		
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
			
			// Model name
			const modelCell = row.createEl('td', { cls: 'model-cell-name' });
			modelCell.createEl('span', { text: model.model, cls: 'model-name' });
			
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

			// Click handler
			row.addEventListener('click', () => this.selectModel(model));
			row.style.cursor = 'pointer';
			
			// Hover effect
			row.addEventListener('mouseenter', () => {
				row.style.backgroundColor = 'var(--background-modifier-hover)';
			});
			row.addEventListener('mouseleave', () => {
				row.style.backgroundColor = '';
			});
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
			
			const newSource = await this.plugin.makeRequest('/v1/sources', {
				method: 'POST',
				body: {
					name: this.plugin.settings.sourceName,
					embedding_config: embeddingConfig,
					instructions: "A collection of markdown files from an Obsidian vault. Directory structure is preserved in filenames using '__' as path separators."
				}
			});

			this.plugin.source = { id: newSource.id, name: newSource.name };
			
			new Notice('Source recreated successfully. You can now sync your vault files.');
			
		} catch (error) {
			console.error('Failed to delete and recreate source:', error);
			new Notice('Failed to delete and recreate source. Please check your connection and try again.');
		}
	}
}