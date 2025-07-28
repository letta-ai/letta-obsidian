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
			id: 'open-block-files',
			name: 'Open Memory Block Files',
			callback: async () => {
				await this.createBlockFiles();
			}
		});

		this.addCommand({
			id: 'sync-block-files',
			name: 'Sync Block Files to Letta',
			callback: async () => {
				await this.syncBlockFiles();
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
					this.app.workspace.revealActiveFile();
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
						await this.makeRequest(`/v1/sources/${this.source.id}/${existingFile.id}`, {
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

			await this.makeRequest(`/v1/sources/${this.source.id}/upload`, {
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

	async createBlockFiles() {
		// Check connection first
		if (!this.agent) {
			const connected = await this.connectToLetta();
			if (!connected) {
				new Notice('❌ Connection failed. Please check your settings.');
				return;
			}
		}

		try {
			// Get agent's memory blocks
			const blocks = await this.makeRequest(`/v1/agents/${this.agent.id}/core-memory/blocks`);
			
			if (!blocks || blocks.length === 0) {
				new Notice('No memory blocks found for this agent');
				return;
			}

			// Create a folder for block files (visible to user)
			const blockFolderPath = 'Letta Memory Blocks';
			
			// Ensure the blocks folder exists
			if (!await this.app.vault.adapter.exists(blockFolderPath)) {
				await this.app.vault.createFolder(blockFolderPath);
			}

			// Create files for each block
			for (const block of blocks) {
				const blockFileName = `${blockFolderPath}/${block.label || block.name || 'unnamed'}.md`;
				
				// Create block file content with metadata and instructions
				const blockContent = `---
letta_block: true
block_label: ${block.label || block.name}
character_limit: ${block.limit || 5000}
read_only: ${block.read_only || false}
description: ${block.description || 'No description'}
last_updated: ${new Date().toISOString()}
agent_id: ${this.agent.id}
---

# ${block.label || block.name} Memory Block

> **⚠️ This is a Letta memory block file**
> 
> Edit the content below, then use **"Sync Block Files to Letta"** command to save your changes to the agent's memory.
> 
> - **Character Limit**: ${block.limit || 5000} characters
> - **Current Length**: ${(block.value || '').length} characters
> - **Block Type**: ${block.label || block.name}

---

${block.value || ''}`;

				// Create or update the file
				if (await this.app.vault.adapter.exists(blockFileName)) {
					const existingFile = this.app.vault.getAbstractFileByPath(blockFileName) as TFile;
					if (existingFile) {
						await this.app.vault.modify(existingFile, blockContent);
					}
				} else {
					await this.app.vault.create(blockFileName, blockContent);
				}
			}

			new Notice(`✅ Created ${blocks.length} memory block files in "${blockFolderPath}/" folder. Edit them and use "Sync Block Files to Letta" to save changes.`);

			// Open the first block file
			if (blocks.length > 0) {
				const firstBlockFile = `${blockFolderPath}/${blocks[0].label || blocks[0].name || 'unnamed'}.md`;
				const file = this.app.vault.getAbstractFileByPath(firstBlockFile) as TFile;
				if (file) {
					await this.app.workspace.openLinkText(file.path, '', true);
				}
			}

		} catch (error) {
			console.error('Failed to create block files:', error);
			new Notice('❌ Failed to create block files. Please try again.');
		}
	}

	async onBlockFileChange(file: TFile): Promise<void> {
		// Auto-connect if not connected (silently for auto-sync)
		if (!this.agent) {
			try {
				await this.connectToLetta();
			} catch (error) {
				console.log('[Letta Plugin] Block file sync failed: not connected');
				return;
			}
		}

		try {
			const content = await this.app.vault.read(file);
			
			// Parse frontmatter to extract block metadata
			const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
			if (!frontmatterMatch) {
				console.error('Invalid block file format:', file.path);
				return;
			}

			const frontmatter = frontmatterMatch[1];
			const blockContent = frontmatterMatch[2];
			
			// Check if this is a Letta block file
			const isLettaBlock = frontmatter.includes('letta_block: true');
			if (!isLettaBlock) {
				return; // Not a Letta block file
			}

			// Extract block label from frontmatter
			const labelMatch = frontmatter.match(/^block_label: (.+)$/m);
			if (!labelMatch) {
				console.error('No block label found in file:', file.path);
				return;
			}
			
			const blockLabel = labelMatch[1];
			
			// Update the block via API
			await this.makeRequest(`/v1/agents/${this.agent.id}/core-memory/blocks/${blockLabel}`, {
				method: 'PATCH',
				body: { value: blockContent.trim() }
			});

			console.log(`[Letta Plugin] Block '${blockLabel}' synced from file: ${file.path}`);
		} catch (error) {
			console.error('Failed to sync block file:', error);
		}
	}

	async syncBlockFiles() {
		// Check connection first
		if (!this.agent) {
			const connected = await this.connectToLetta();
			if (!connected) {
				new Notice('❌ Connection failed. Please check your settings.');
				return;
			}
		}

		try {
			const blockFolderPath = 'Letta Memory Blocks';
			
			// Check if folder exists
			if (!await this.app.vault.adapter.exists(blockFolderPath)) {
				new Notice('No block files found. Use "Open Memory Block Files" first.');
				return;
			}

			// Get all .lettablock files
			const folder = this.app.vault.getAbstractFileByPath(blockFolderPath);
			if (!folder || !(folder instanceof TFolder)) {
				new Notice('Block folder not found.');
				return;
			}

			const blockFiles = folder.children.filter(file => 
				file instanceof TFile && file.path.includes('Letta Memory Blocks/') && file.path.endsWith('.md')
			) as TFile[];

			if (blockFiles.length === 0) {
				new Notice('No block files found in the folder.');
				return;
			}

			// Show confirmation modal
			const confirmed = await this.confirmBlockSync(blockFiles.length);
			if (!confirmed) {
				return;
			}

			new Notice(`🔄 Syncing ${blockFiles.length} block files...`);

			let successCount = 0;
			let errorCount = 0;

			// Process each block file
			for (const file of blockFiles) {
				try {
					const content = await this.app.vault.read(file);
					
					// Parse frontmatter to extract block metadata
					const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
					if (!frontmatterMatch) {
						console.error('Invalid block file format:', file.path);
						errorCount++;
						continue;
					}

					const frontmatter = frontmatterMatch[1];
					const fullContent = frontmatterMatch[2];
					
					// Extract actual block content (skip the instruction section)
					const contentMatch = fullContent.match(/^[\s\S]*?---\n\n([\s\S]*)$/);
					const blockContent = contentMatch ? contentMatch[1] : fullContent;
					
					// Check if this is a Letta block file
					const isLettaBlock = frontmatter.includes('letta_block: true');
					if (!isLettaBlock) {
						// Skip non-Letta block files
						continue;
					}

					// Extract block label from frontmatter
					const labelMatch = frontmatter.match(/^block_label: (.+)$/m);
					if (!labelMatch) {
						console.error('No block label found in file:', file.path);
						errorCount++;
						continue;
					}
					
					const blockLabel = labelMatch[1];
					
					// Update the block via API
					await this.makeRequest(`/v1/agents/${this.agent.id}/core-memory/blocks/${blockLabel}`, {
						method: 'PATCH',
						body: { value: blockContent.trim() }
					});

					successCount++;
					console.log(`[Letta Plugin] Block '${blockLabel}' synced from file: ${file.path}`);
				} catch (error) {
					console.error(`Failed to sync block file ${file.path}:`, error);
					errorCount++;
				}
			}

			// Show result
			if (errorCount === 0) {
				new Notice(`✅ Successfully synced ${successCount} block files`);
			} else {
				new Notice(`⚠️ Synced ${successCount} files, ${errorCount} errors. Check console for details.`);
			}

		} catch (error) {
			console.error('Failed to sync block files:', error);
			new Notice('❌ Failed to sync block files. Please try again.');
		}
	}

	private confirmBlockSync(fileCount: number): Promise<boolean> {
		return new Promise((resolve) => {
			const modal = new Modal(this.app);
			modal.setTitle('Confirm Block Sync');
			
			const { contentEl } = modal;
			contentEl.createEl('p', { 
				text: `You are about to sync ${fileCount} memory block file(s) to Letta. This will overwrite the current block contents in your agent's memory.`
			});
			contentEl.createEl('p', { 
				text: 'Are you sure you want to continue?',
				cls: 'mod-warning'
			});
			
			const buttonContainer = contentEl.createEl('div');
			buttonContainer.style.display = 'flex';
			buttonContainer.style.gap = '8px';
			buttonContainer.style.justifyContent = 'flex-end';
			buttonContainer.style.marginTop = '16px';
			
			const syncButton = buttonContainer.createEl('button', {
				text: 'Sync to Letta',
				cls: 'mod-cta'
			});
			
			const cancelButton = buttonContainer.createEl('button', {
				text: 'Cancel'
			});
			
			syncButton.addEventListener('click', () => {
				resolve(true);
				modal.close();
			});
			
			cancelButton.addEventListener('click', () => {
				resolve(false);
				modal.close();
			});
			
			modal.open();
		});
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
			await leaf.setViewState({ type: LETTA_CHAT_VIEW_TYPE, active: true });
		}

		// "Reveal" the leaf in case it is in a collapsed sidebar
		workspace.revealLeaf(leaf);
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
			await leaf.setViewState({ type: LETTA_MEMORY_VIEW_TYPE, active: true });
		}

		// "Reveal" the leaf in case it is in a collapsed sidebar
		workspace.revealLeaf(leaf);
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

class LettaChatView extends ItemView {
	plugin: LettaPlugin;
	chatContainer: HTMLElement;
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
		// Clean up any resources if needed
	}

	addMessage(type: 'user' | 'assistant' | 'reasoning' | 'tool-call' | 'tool-result', content: string, title?: string) {
		const messageEl = this.chatContainer.createEl('div', { 
			cls: `letta-message letta-message-${type}` 
		});

		// Add timestamp
		const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
		
		if (title) {
			const titleEl = messageEl.createEl('div', { cls: 'letta-message-header' });
			titleEl.createEl('span', { cls: 'letta-message-title', text: title });
			titleEl.createEl('span', { cls: 'letta-message-timestamp', text: timestamp });
		}

		const contentEl = messageEl.createEl('div', { cls: 'letta-message-content' });
		
		// Handle different content types
		if (type === 'tool-call' || type === 'tool-result') {
			const pre = contentEl.createEl('pre', { cls: 'letta-code-block' });
			pre.createEl('code', { text: content });
		} else {
			// Enhanced markdown-like formatting
			let formattedContent = content
				.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
				.replace(/\*(.*?)\*/g, '<em>$1</em>')
				.replace(/`([^`]+)`/g, '<code>$1</code>')
				.replace(/^- (.+)$/gm, '<li>$1</li>')
				.replace(/^• (.+)$/gm, '<li>$1</li>')
				.replace(/\n\n/g, '</p><p>')
				.replace(/^\n/g, '')
				.replace(/\n$/g, '');
			
			// Wrap consecutive list items in <ul> tags
			formattedContent = formattedContent.replace(/(<li>.*?<\/li>)(\s*<li>.*?<\/li>)*/g, (match) => {
				return '<ul>' + match + '</ul>';
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

	updateChatStatus() {
		// Determine connection status based on plugin state
		const isConnected = this.plugin.agent && this.plugin.source;
		
		if (isConnected) {
			this.statusDot.className = 'letta-status-dot letta-status-connected';
			
			// Show project info if available
			const projectInfo = this.plugin.settings.lettaProjectSlug 
				? ` • Project: ${this.plugin.settings.lettaProjectSlug}`
				: '';
			
			this.statusText.textContent = `Connected${projectInfo}`;
			
			// Update model button if it exists
			if (this.modelButton) {
				this.updateModelButton();
			}
			
			// Remove disconnected message if it exists
			this.removeDisconnectedMessage();
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
		const adeUrl = `https://app.letta.com/agents/${this.plugin.agent.id}`;
		
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
			const agent = await this.plugin.makeRequest(`/v1/agents/${this.plugin.agent.id}`);
			
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
				await this.plugin.makeRequest(`/v1/agents/${this.plugin.agent.id}`, {
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
			this.plugin.makeRequest(`/v1/agents/${this.plugin.agent.id}`),
			this.plugin.makeRequest(`/v1/agents/${this.plugin.agent.id}/core-memory/blocks`)
		]);
		
		const modal = new AgentPropertyModal(this.app, agentDetails, blocks, async (updatedConfig) => {
			try {
				// Extract block updates from config
				const { blockUpdates, ...agentConfig } = updatedConfig;

				// Update agent properties if any changed
				if (Object.keys(agentConfig).length > 0) {
					await this.plugin.makeRequest(`/v1/agents/${this.plugin.agent.id}`, {
						method: 'PATCH',
						body: agentConfig
					});
				}

				// Update blocks if any changed
				if (blockUpdates && blockUpdates.length > 0) {
					await Promise.all(blockUpdates.map(async (blockUpdate: any) => {
						await this.plugin.makeRequest(`/v1/agents/${this.plugin.agent.id}/core-memory/blocks/${blockUpdate.label}`, {
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
					this.plugin.agent.name = agentConfig.name;
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
			this.addMessage('assistant', '🔌 Connecting to Letta...', '🤖 System');
			const connected = await this.plugin.connectToLetta();
			if (!connected) {
				this.addMessage('assistant', '❌ **Connection failed**. Please check your settings and try again.', '🚨 Error');
				return;
			}
			this.addMessage('assistant', '✅ **Connected!** You can now chat with your agent.', '🤖 System');
		}

		// Disable input while processing
		this.messageInput.disabled = true;
		this.sendButton.disabled = true;
		this.sendButton.innerHTML = '<span>Sending...</span>';
		this.sendButton.addClass('letta-button-loading');

		// Add user message to chat
		this.addMessage('user', message, '👤 You');

		// Clear and reset input
		this.messageInput.value = '';
		this.messageInput.style.height = 'auto';

		try {
			const messages = await this.plugin.sendMessageToAgent(message);

			// Process response messages
			for (const responseMessage of messages) {
				switch (responseMessage.message_type) {
					case 'reasoning_message':
						if (responseMessage.reasoning) {
							this.addMessage('reasoning', responseMessage.reasoning, '🧠 Reasoning');
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
							this.addMessage('assistant', responseMessage.content, `🤖 ${this.plugin.settings.agentName}`);
						}
						break;
				}
			}

		} catch (error: any) {
			console.error('Failed to send message:', error);
			this.addMessage('assistant', `❌ **Error**: ${error.message}\n\nPlease check your connection and try again.`, '🚨 Error');
		} finally {
			// Re-enable input
			this.messageInput.disabled = false;
			this.sendButton.disabled = false;
			this.sendButton.innerHTML = '<span>Send</span>';
			this.sendButton.removeClass('letta-button-loading');
			this.messageInput.focus();
		}
	}

	async openAgentSwitcher() {
		if (!this.plugin.settings.lettaApiKey) {
			new Notice('Please configure your Letta API key first');
			return;
		}

		const isCloudInstance = this.plugin.settings.lettaBaseUrl.includes('api.letta.com');
		
		if (isCloudInstance) {
			// For cloud instances, show agents from current project first
			const currentProject = { 
				id: this.plugin.settings.projectSlug, 
				name: this.plugin.settings.projectSlug || 'Current Project',
				slug: this.plugin.settings.projectSlug 
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
				projects.map(async (project) => {
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
		
		// Add navigation buttons for cloud instances
		if (project && this.plugin.settings.lettaBaseUrl.includes('api.letta.com')) {
			const buttonContainer = contentEl.createEl('div');
			buttonContainer.style.display = 'flex';
			buttonContainer.style.gap = '8px';
			buttonContainer.style.marginBottom = '16px';
			
			if (isCurrentProject) {
				const changeProjectButton = buttonContainer.createEl('button', { 
					text: 'Change Project',
					cls: 'letta-clear-button'
				});
				changeProjectButton.addEventListener('click', () => {
					modal.close();
					this.openProjectSelector();
				});
			} else {
				const backButton = buttonContainer.createEl('button', { 
					text: '← Back to Projects',
					cls: 'letta-clear-button'
				});
				backButton.addEventListener('click', () => {
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
			
			const agentList = contentEl.createEl('div');
			agentList.style.maxHeight = '450px';
			agentList.style.overflowY = 'auto';
			
			for (const agent of agents) {
				const agentEl = agentList.createEl('div');
				agentEl.style.padding = '16px';
				agentEl.style.border = '1px solid var(--background-modifier-border)';
				agentEl.style.borderRadius = '8px';
				agentEl.style.marginBottom = '12px';
				agentEl.style.cursor = 'pointer';
				agentEl.style.transition = 'background 0.2s ease';
				
				// Highlight current agent
				if (agent.id === this.plugin.agent?.id) {
					agentEl.style.border = '2px solid var(--interactive-accent)';
					agentEl.style.backgroundColor = 'var(--background-modifier-hover)';
				}
				
				const nameEl = agentEl.createEl('div', { text: agent.name });
				nameEl.style.fontWeight = '600';
				nameEl.style.marginBottom = '8px';
				nameEl.style.fontSize = '1.1em';
				
				if (agent.id === this.plugin.agent?.id) {
					const currentBadge = agentEl.createEl('span', { text: 'CURRENT' });
					currentBadge.style.fontSize = '0.7em';
					currentBadge.style.color = 'var(--interactive-accent)';
					currentBadge.style.fontWeight = '600';
					currentBadge.style.marginLeft = '8px';
				}
				
				const templateEl = agentEl.createEl('div', { text: `Template: ${agent.template_id || 'Unknown'}` });
				templateEl.style.fontSize = '0.9em';
				templateEl.style.color = 'var(--text-muted)';
				templateEl.style.marginBottom = '4px';
				
				const idEl = agentEl.createEl('div', { text: `ID: ${agent.id}` });
				idEl.style.fontSize = '0.8em';
				idEl.style.color = 'var(--text-faint)';
				idEl.style.fontFamily = 'var(--font-monospace)';
				
				agentEl.addEventListener('mouseenter', () => {
					if (agent.id !== this.plugin.agent?.id) {
						agentEl.style.backgroundColor = 'var(--background-modifier-hover)';
					}
				});
				
				agentEl.addEventListener('mouseleave', () => {
					if (agent.id !== this.plugin.agent?.id) {
						agentEl.style.backgroundColor = '';
					}
				});
				
				agentEl.addEventListener('click', () => {
					if (agent.id !== this.plugin.agent?.id) {
						modal.close();
						this.switchToAgent(agent, project);
					}
				});
			}
			
		} catch (error) {
			loadingEl.textContent = 'Failed to load agents. Please check your connection.';
			console.error('Failed to load agents:', error);
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
				this.plugin.settings.projectSlug = project.slug;
			}
			await this.plugin.saveSettings();
			
			// Update plugin agent reference
			this.plugin.agent = agent;
			
			// Update UI
			this.agentNameElement.textContent = agent.name;
			
			// Show success message
			this.addMessage('assistant', `Switched to agent: **${agent.name}**${project ? ` (Project: ${project.name})` : ''}`, '🤖 System');
			
			new Notice(`Switched to agent: ${agent.name}`);
			
		} catch (error) {
			console.error('Failed to switch agent:', error);
			new Notice('Failed to switch agent. Please try again.');
			this.addMessage('assistant', '❌ **Error**: Failed to switch agent. Please try again.', '🚨 Error');
		}
	}

}

class LettaMemoryView extends ItemView {
	plugin: LettaPlugin;
	blocks: any[] = [];
	blockEditors: Map<string, HTMLTextAreaElement> = new Map();
	blockSaveButtons: Map<string, HTMLButtonElement> = new Map();
	blockDirtyStates: Map<string, boolean> = new Map();
	refreshButton: HTMLButtonElement;
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
			this.blocks = await this.plugin.makeRequest(`/v1/agents/${this.plugin.agent.id}/core-memory/blocks`);
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
			const serverBlock = await this.plugin.makeRequest(`/v1/agents/${this.plugin.agent.id}/core-memory/blocks/${blockLabel}`);
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
			
			await this.plugin.makeRequest(`/v1/agents/${this.plugin.agent.id}/core-memory/blocks/${blockLabel}`, {
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
			console.log(`[Letta Plugin] Attaching block ${createResponse.id} to agent ${this.plugin.agent.id}`);
			
			const attachResponse = await this.plugin.makeRequest(`/v1/agents/${this.plugin.agent.id}/core-memory/blocks/attach/${createResponse.id}`, {
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
				
				const messageResponse = await this.plugin.makeRequest(`/v1/agents/${this.plugin.agent.id}/messages`, {
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
			contentEl.createEl('div', { text: 'Initial Content:', cls: 'config-label' });
			const valueInput = contentEl.createEl('textarea', {
				placeholder: 'Enter the initial content for this memory block...',
				cls: 'config-textarea'
			});
			valueInput.style.height = '120px';
			valueInput.style.marginBottom = '16px';
			
			// Limit input
			contentEl.createEl('div', { text: 'Character Limit:', cls: 'config-label' });
			const limitInput = contentEl.createEl('input', {
				type: 'number',
				value: '2000',
				min: '100',
				max: '8000',
				cls: 'config-input'
			});
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
				const value = valueInput.value.trim();
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
				
				if (!value) {
					new Notice('Please enter some initial content');
					valueInput.focus();
					return;
				}
				
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
			
			await this.plugin.makeRequest(`/v1/agents/${this.plugin.agent.id}/core-memory/blocks/detach/${block.id}`, {
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
			const attachedBlocks = await this.plugin.makeRequest(`/v1/agents/${this.plugin.agent.id}/core-memory/blocks`);
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
			console.log('[Letta Plugin] Attaching block:', block.label || 'Unnamed', 'to agent:', this.plugin.agent.id);
			
			// First, get current agent state to ensure we have the latest block list
			const currentAgent = await this.plugin.makeRequest(`/v1/agents/${this.plugin.agent.id}`);
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
				await this.plugin.makeRequest(`/v1/agents/${this.plugin.agent.id}/core-memory/blocks/attach/${block.id}`, {
					method: 'PATCH'
				});
				
				console.log('[Letta Plugin] Successfully attached block using attach endpoint');
				new Notice(`Memory block "${block.label || 'Unnamed'}" attached successfully`);
				
			} catch (attachError) {
				console.warn('[Letta Plugin] Attach endpoint failed, trying alternative approach:', attachError);
				
				// Alternative approach: Update agent with complete block list
				const updatedBlockIds = [...currentBlocks.map((b: any) => b.id), block.id];
				
				await this.plugin.makeRequest(`/v1/agents/${this.plugin.agent.id}`, {
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
		
		const blockFilesButton = buttonContainer.createEl('button', {
			text: 'Open Block Files',
			cls: 'agent-config-secondary-btn'
		});
		
		const saveButton = buttonContainer.createEl('button', {
			text: 'Save Changes',
			cls: 'agent-config-create-btn'
		});
		
		const cancelButton = buttonContainer.createEl('button', {
			text: 'Cancel',
			cls: 'agent-config-cancel-btn'
		});

		// Event handlers
		blockFilesButton.addEventListener('click', async () => {
			// Get the plugin instance from the app
			const plugin = (this.app as any).plugins.plugins['letta-ai-agent'] as LettaPlugin;
			if (plugin) {
				await plugin.createBlockFiles();
			}
		});

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