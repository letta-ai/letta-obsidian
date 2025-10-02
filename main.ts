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
	WorkspaceLeaf,
	MarkdownRenderer,
	Component,
} from "obsidian";
import { LettaClient, LettaError } from "@letta-ai/letta-client";

export const LETTA_CHAT_VIEW_TYPE = "letta-chat-view";
export const LETTA_MEMORY_VIEW_TYPE = "letta-memory-view";

// Rate limit message constants
export const RATE_LIMIT_MESSAGE = {
	TITLE: "Rate Limit Exceeded - You've reached the rate limit for your account. Please wait a moment before sending another message.",
	UPGRADE_TEXT:
		"Need more? Letta Cloud offers Pro, Scale, and Enterprise plans:",
	BILLING_URL: "https://app.letta.com/settings/organization/billing",
	CUSTOM_KEYS_TEXT: "Or bring your own inference provider:",
	CUSTOM_KEYS_URL: "https://docs.letta.com/guides/cloud/custom-keys",

	// Helper function to create full message
	create: (reason: string) => `${RATE_LIMIT_MESSAGE.TITLE}

Reason: ${reason}

${RATE_LIMIT_MESSAGE.UPGRADE_TEXT}
${RATE_LIMIT_MESSAGE.BILLING_URL}

${RATE_LIMIT_MESSAGE.CUSTOM_KEYS_TEXT}
${RATE_LIMIT_MESSAGE.CUSTOM_KEYS_URL}`,
};

// Error handling interfaces
interface RateLimitError extends Error {
	isRateLimit: boolean;
	retryAfter: number | null;
}

interface EnhancedError extends Error {
	status: number;
	responseText: string;
	responseJson: any;
}

// Agent type definitions
type AgentType =
	| "memgpt_v2_agent"
	| "react_agent"
	| "workflow_agent"
	| "sleeptime_agent";

interface LettaPluginSettings {
	lettaApiKey: string;
	lettaBaseUrl: string;
	lettaProjectSlug: string;
	agentId: string;
	agentName: string; // Keep for display purposes, but use agentId for API calls
	autoConnect: boolean; // Control whether to auto-connect on startup
	showReasoning: boolean; // Control whether reasoning messages are visible
	enableStreaming: boolean; // Control whether to use streaming API responses
	allowAgentCreation: boolean; // Control whether agent creation modal can be shown
	enableCustomTools: boolean; // Control whether to register custom Obsidian tools
	askBeforeToolRegistration: boolean; // Ask for consent before registering custom tools
	defaultNoteFolder: string; // Default folder for new notes created via custom tools
	focusMode: boolean; // Control whether to track and share the currently viewed note
	focusBlockCharLimit: number; // Character limit for the focus mode memory block
	// Deprecated properties (kept for compatibility)
	sourceName?: string;
	autoSync?: boolean;
	syncOnStartup?: boolean;
	askBeforeFolderCreation?: boolean;
	askBeforeFolderAttachment?: boolean;
}

const DEFAULT_SETTINGS: LettaPluginSettings = {
	lettaApiKey: "",
	lettaBaseUrl: "https://api.letta.com",
	lettaProjectSlug: "", // No default project - will be determined by agent selection
	agentId: "",
	agentName: "Obsidian Assistant",
	autoConnect: false, // Default to not auto-connecting to avoid startup blocking
	showReasoning: true, // Default to showing reasoning messages in tool interactions
	enableStreaming: true, // Default to enabling streaming for real-time responses
	allowAgentCreation: true, // Default to enabling agent creation modal
	enableCustomTools: true, // Default to enabling custom tools
	askBeforeToolRegistration: true, // Default to asking before registering tools
	defaultNoteFolder: "lettamade", // Default folder for agent-created notes
	focusMode: true, // Default to enabling focus mode
	focusBlockCharLimit: 4000, // Default character limit for focus block
};

interface LettaAgent {
	id: string;
	name: string;
	llm_config?: {
		model: string;
		model_endpoint_type: string;
		provider_name: string;
		provider_category: "base" | "byok";
		temperature?: number;
		max_tokens?: number;
		context_window?: number;
	};
}

interface LettaModel {
	model: string;
	model_endpoint_type: string;
	provider_name: string;
	provider_category: "base" | "byok";
	context_window: number;
	model_endpoint?: string;
	model_wrapper?: string;
	temperature?: number;
	max_tokens?: number;
	handle?: string;
}

interface LettaSource {
	id: string;
	name: string;
}

interface ObsidianNoteProposal {
	action: "create_note";
	title: string;
	content: string;
	folder?: string;
	tags?: string[];
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
	agent_type?:
		| "memgpt_agent"
		| "memgpt_v2_agent"
		| "react_agent"
		| "workflow_agent"
		| "split_thread_agent"
		| "sleeptime_agent"
		| "voice_convo_agent"
		| "voice_sleeptime_agent";
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
	statusBarItem: HTMLElement | null = null;
	client: LettaClient | null = null;
	lastAuthError: string | null = null;
	focusBlockId: string | null = null;
	focusUpdateTimer: NodeJS.Timeout | null = null;
	lastFocusedFile: TFile | null = null;
	isConnecting: boolean = false;

	async onload() {
		await this.loadSettings();

		// Register the chat view
		this.registerView(
			LETTA_CHAT_VIEW_TYPE,
			(leaf) => new LettaChatView(leaf, this),
		);

		this.registerView(
			LETTA_MEMORY_VIEW_TYPE,
			(leaf) => new LettaMemoryView(leaf, this),
		);

		// Add ribbon icons
		this.addRibbonIcon("bot", "Open Letta Chat", (evt: MouseEvent) => {
			this.openChatView();
		});

		this.addRibbonIcon(
			"brain-circuit",
			"Open Letta Memory Blocks",
			(evt: MouseEvent) => {
				this.openMemoryView();
			},
		);

		// Add status bar
		this.statusBarItem = this.addStatusBarItem();
		this.updateStatusBar("Disconnected");

		// Add commands
		this.addCommand({
			id: "open-letta-chat",
			name: "Open Chat",
			callback: () => {
				this.openChatView();
			},
		});

		this.addCommand({
			id: "open-letta-memory",
			name: "Open Memory Blocks",
			callback: () => {
				this.openMemoryView();
			},
		});



		this.addCommand({
			id: "open-block-folder",
			name: "Open Memory Blocks Folder",
			callback: async () => {
				const folder = this.app.vault.getAbstractFileByPath(
					"Letta Memory Blocks",
				);
				if (folder && folder instanceof TFolder) {
					// Focus the file explorer and reveal the folder
					this.app.workspace.leftSplit.expand();
					new Notice(
						"📁 Memory Blocks folder is now visible in the file explorer",
					);
				} else {
					new Notice(
						'Memory Blocks folder not found. Use "Open Memory Block Files" to create it.',
					);
				}
			},
		});

		this.addCommand({
			id: "connect-to-letta",
			name: "Connect",
			callback: async () => {
				if (this.agent) {
					new Notice("Already connected");
					return;
				}
				await this.connectToLetta();
			},
		});

		this.addCommand({
			id: "disconnect-from-letta",
			name: "Disconnect",
			callback: () => {
				this.agent = null;
				this.updateStatusBar("Disconnected");
				new Notice("Disconnected");
			},
		});

		// Add settings tab
		this.addSettingTab(new LettaSettingTab(this.app, this));

		// Auto-connect on startup if configured (non-blocking)
		if (this.settings.lettaApiKey && this.settings.autoConnect) {
			this.connectToLetta().catch((error) => {
				console.error(
					"[Letta Plugin] Background connection failed:",
					error,
				);
				// Don't show notices for background connection failures during startup
			});
		}

		// Track active file changes for focus mode
		this.registerEvent(
			this.app.workspace.on("layout-change", () => {
				if (this.settings.focusMode && this.agent) {
					const activeFile = this.app.workspace.getActiveFile();
					if (activeFile !== this.lastFocusedFile) {
						this.lastFocusedFile = activeFile;
						this.scheduleFocusUpdate();
					}
				}
			}),
		);

	}

	onunload() {
		if (this.focusUpdateTimer) {
			clearTimeout(this.focusUpdateTimer);
		}
		this.agent = null;
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData(),
		);
		this.initializeClient();
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.initializeClient();
	}

	private initializeClient() {
		try {
			// Only initialize if we have a base URL
			if (!this.settings.lettaBaseUrl) {
				this.client = null;
				return;
			}

			// Initialize with token and base URL from settings
			const config: any = {
				baseURL: this.settings.lettaBaseUrl,
			};

			// Only add token if API key is provided (for self-hosted without auth)
			if (this.settings.lettaApiKey) {
				config.token = this.settings.lettaApiKey;
			}

			this.client = new LettaClient(config);
		} catch (error) {
			console.error("[Letta Plugin] Failed to initialize client:", error);
			this.client = null;
		}
	}

	// Get detailed connection status text
	getConnectionStatusText(): string {
		const isCloudInstance =
			this.settings.lettaBaseUrl.includes("api.letta.com");

		if (isCloudInstance) {
			const projectInfo = this.settings.lettaProjectSlug
				? ` • ${this.settings.lettaProjectSlug}`
				: "";
			return `Connected to Letta Cloud${projectInfo}`;
		} else {
			// Show base URL for local/custom instances
			return `Connected to ${this.settings.lettaBaseUrl}`;
		}
	}

	updateStatusBar(status: string) {
		if (this.statusBarItem) {
			// Only show sync-related status, hide connection details
			if (status === "Connected") {
				this.statusBarItem.setText("");
			} else {
				this.statusBarItem.setText(status);
			}
		}

		// Also update chat status if chat view is open
		const chatLeaf =
			this.app.workspace.getLeavesOfType(LETTA_CHAT_VIEW_TYPE)[0];
		if (chatLeaf && chatLeaf.view instanceof LettaChatView) {
			// Don't await since updateStatusBar should be non-blocking
			(chatLeaf.view as LettaChatView).updateChatStatus();
		}
	}

	async makeRequest(path: string, options: any = {}): Promise<any> {
		return this.makeRequestWithRetry(path, options, 3);
	}

	async makeRequestWithRetry(
		path: string,
		options: any = {},
		maxRetries: number = 3,
	): Promise<any> {
		let lastError: any;

		for (let attempt = 0; attempt <= maxRetries; attempt++) {
			try {
				return await this.executeSingleRequest(path, options);
			} catch (error: any) {
				lastError = error;

				// Only retry on rate limiting errors
				if (error.isRateLimit && attempt < maxRetries) {
					const waitTime = error.retryAfter
						? error.retryAfter * 1000
						: Math.pow(2, attempt) * 1000; // Exponential backoff
					// console.log(`[Letta Plugin] Rate limited, waiting ${waitTime}ms before retry ${attempt + 1}/${maxRetries}`);
					await new Promise((resolve) =>
						setTimeout(resolve, waitTime),
					);
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
			...options.headers,
		};

		// Only add Authorization header if API key is provided
		if (this.settings.lettaApiKey) {
			headers["Authorization"] = `Bearer ${this.settings.lettaApiKey}`;
		}

		// Set content type unless it's a file upload
		if (!options.isFileUpload) {
			headers["Content-Type"] = "application/json";
		}

		// Debug logging
		// console.log(`[Letta Plugin] Making request to ${url}`);
		// console.log(`[Letta Plugin] Request headers:`, headers);
		// console.log(`[Letta Plugin] Request options:`, options);

		try {
			let requestBody;
			if (
				options.body &&
				typeof options.body === "string" &&
				headers["Content-Type"]?.includes("multipart/form-data")
			) {
				// Manual multipart form data
				requestBody = options.body;
			} else if (options.isFileUpload && options.formData) {
				requestBody = options.formData;
				// Remove Content-Type header to let browser set boundary
				delete headers["Content-Type"];
			} else if (options.body) {
				requestBody = JSON.stringify(options.body);
			}

			const response = await requestUrl({
				url,
				method: options.method || "GET",
				headers,
				body: requestBody,
				throw: false,
			});

			// Debug logging for response
			// Response details available for debugging if needed

			// Try to parse JSON, but handle cases where response isn't JSON
			let responseJson = null;
			try {
				if (
					response.text &&
					(response.text.trim().startsWith("{") ||
						response.text.trim().startsWith("[") ||
						response.text.trim().startsWith('"'))
				) {
					responseJson = JSON.parse(response.text);
					// console.log(`[Letta Plugin] Parsed JSON response:`, responseJson);
				} else {
					// console.log(`[Letta Plugin] Response is not JSON, raw text:`, response.text);
				}
			} catch (jsonError) {
				// Failed to parse JSON - continuing with text response
			}

			if (response.status >= 400) {
				let errorMessage = `HTTP ${response.status}: ${response.text}`;

				// Error details available for debugging if needed

				if (response.status === 404) {
					if (path === "/v1/agents") {
						errorMessage =
							"Cannot connect to Letta API. Please verify:\n• Base URL is correct\n• Letta service is running\n• Network connectivity is available";
					} else if (path.includes("/v1/folders")) {
						errorMessage =
							"Source not found. This may indicate:\n• Invalid project configuration\n• Missing permissions\n• Source was deleted externally";
					} else if (
						path === "/v1/agents" &&
						options.method === "POST"
					) {
						errorMessage =
							"Failed to create agent. This may indicate:\n• Invalid project ID\n• Missing permissions\n• API endpoint has changed\n• Server configuration issue";
					} else if (path.includes("/v1/agents")) {
						errorMessage =
							"Agent not found. This may indicate:\n• Invalid project configuration\n• Missing permissions\n• Agent was deleted externally";
					} else {
						errorMessage = `Endpoint not found (${path}). This may indicate:\n• Incorrect base URL configuration\n• Outdated plugin version\n• API endpoint has changed`;
					}
				} else if (response.status === 401) {
					const isCloudInstance =
						this.settings.lettaBaseUrl.includes("api.letta.com");
					if (isCloudInstance && !this.settings.lettaApiKey) {
						errorMessage =
							"Authentication required for Letta Cloud. Please provide an API key in settings.";
					} else if (!this.settings.lettaApiKey) {
						errorMessage =
							"Authentication failed. If using a self-hosted instance with auth enabled, please provide an API key in settings.";
					} else {
						errorMessage =
							"Authentication failed. Please verify your API key is correct and has proper permissions.";
					}
				} else if (response.status === 405) {
					errorMessage = `Method not allowed for ${path}. This may indicate:\n• Incorrect HTTP method\n• API endpoint has changed\n• Feature not supported in this Letta version`;
				} else if (response.status === 429) {
					// Handle rate limiting with retry logic
					const retryAfter =
						response.headers?.["retry-after"] ||
						response.headers?.["Retry-After"];
					const rateLimitReset =
						response.headers?.["x-ratelimit-reset"] ||
						response.headers?.["X-RateLimit-Reset"];

					// Create detailed error message
					errorMessage = `Rate limit exceeded. ${responseJson?.detail || response.text || "Please wait before making more requests."}`;

					if (retryAfter) {
						errorMessage += `\nRetry after: ${retryAfter} seconds`;
					}
					if (rateLimitReset) {
						try {
							const resetTime = new Date(
								parseInt(rateLimitReset) * 1000,
							);
							errorMessage += `\nRate limit resets at: ${resetTime.toLocaleTimeString()}`;
						} catch {
							errorMessage += `\nRate limit reset: ${rateLimitReset}`;
						}
					}

					// Create a special error type for rate limiting
					const rateLimitError = new Error(
						errorMessage,
					) as RateLimitError;
					rateLimitError.isRateLimit = true;
					rateLimitError.retryAfter = retryAfter
						? parseInt(retryAfter)
						: null;
					throw rateLimitError;
				}

				// Enhanced error message created with preserved response details
				const enhancedError = new Error(errorMessage) as EnhancedError;
				enhancedError.status = response.status;
				enhancedError.responseText = response.text;
				enhancedError.responseJson = responseJson;
				throw enhancedError;
			}

			return responseJson;
		} catch (error: any) {
			// Exception details available for debugging if needed
			console.error("[Letta Plugin] Letta API request failed:", {
				error: error.message,
				status: error.status,
				responseText: error.responseText,
				responseJson: error.responseJson,
				path,
				method: options.method || "GET",
				stack: error.stack,
			});

			// Check if this is a network/connection error that might indicate the same issues as a 404
			if (
				error.message &&
				(error.message.includes("fetch") ||
					error.message.includes("network") ||
					error.message.includes("ECONNREFUSED"))
			) {
				if (path === "/v1/agents") {
					const enhancedError = new Error(
						"Cannot connect to Letta API. Please verify:\n• Base URL is correct\n• Letta service is running\n• Network connectivity is available",
					);
					throw enhancedError;
				}
			}

			throw error;
		}
	}

	async getAgentCount(): Promise<number> {
		try {
			if (!this.client) return 0;
			// Get all agents across all projects (not filtered by current project)
			const agents = await this.client.agents.list();
			return agents ? agents.length : 0;
		} catch (error) {
			console.error("[Letta Plugin] Failed to get agent count:", error);
			return 0;
		}
	}

	async connectToLetta(attempt: number = 1, progressCallback?: (message: string) => void): Promise<boolean> {
		const maxAttempts = 5;
		const isCloudInstance =
			this.settings.lettaBaseUrl.includes("api.letta.com");

		// Set connecting flag on first attempt
		if (attempt === 1) {
			this.isConnecting = true;
		}

		console.log(`[Letta Plugin] connectToLetta called - attempt ${attempt}/${maxAttempts}`);
		console.log(`[Letta Plugin] Connection details:`, {
			baseUrl: this.settings.lettaBaseUrl,
			isCloudInstance,
			hasApiKey: !!this.settings.lettaApiKey,
			hasClient: !!this.client,
			currentAgent: this.agent
		});

		// Connection attempt ${attempt}/${maxAttempts} to ${this.settings.lettaBaseUrl}

		// Validate URL format on first attempt
		if (attempt === 1) {
			try {
				new URL(this.settings.lettaBaseUrl);
			} catch (e) {
				new Notice(
					`Invalid Base URL format: ${this.settings.lettaBaseUrl}. Please check your settings.`,
				);
				this.updateStatusBar("Invalid URL");
				this.isConnecting = false;
				return false;
			}

			// Check for common typos
			if (this.settings.lettaBaseUrl.includes("locahost")) {
				new Notice(
					`Potential typo in Base URL: Did you mean "localhost"? Current: ${this.settings.lettaBaseUrl}`,
				);
				this.updateStatusBar("URL typo detected");
				this.isConnecting = false;
				return false;
			}
		}

		if (isCloudInstance && !this.settings.lettaApiKey) {
			new Notice(
				"API key required for Letta Cloud. Please configure it in settings.",
			);
			this.isConnecting = false;
			return false;
		}

		try {
			const progressMessage = attempt === 1
				? "Connecting to server..."
				: `Retrying connection... (${attempt}/${maxAttempts})`;
			
			this.updateStatusBar(progressMessage);
			progressCallback?.(progressMessage);

			// Test connection by trying to list agents (this endpoint should exist)
			if (!this.client) throw new Error("Client not initialized");
			console.log("[Letta Plugin] Testing connection by listing agents...");
			await this.client.agents.list();
			console.log("[Letta Plugin] Connection test successful");

			// Try to setup agent if one is configured
			if (this.settings.agentId) {
				try {
					progressCallback?.("Loading agent configuration...");
					await this.setupAgent();

					// Setup focus block after agent is ready
					if (this.agent) {
						await this.ensureFocusBlock();
					}
				} catch (agentError) {
					console.error(
						"[Letta Plugin] Agent setup failed:",
						agentError,
					);
					// Clear invalid agent ID
					this.settings.agentId = "";
					this.settings.agentName = "";
					await this.saveSettings();
				}
			}

			this.updateStatusBar("Connected");
			progressCallback?.("Connection successful!");

			// Clear any previous auth errors on successful connection
			this.lastAuthError = null;

			// Only show success notice on first attempt or after retries
			if (attempt === 1) {
				new Notice("Successfully connected to Letta");
			} else {
				new Notice(`Connected to Letta after ${attempt} attempts`);
			}

			console.log("[Letta Plugin] connectToLetta completed successfully");
			console.log("[Letta Plugin] Final state:", {
				hasAgent: !!this.agent,
				agentId: this.agent?.id,
				agentName: this.agent?.name
			});

			// Ensure chat view UI is updated after connection, regardless of agent state
			this.updateStatusBar("Connected");
			this.isConnecting = false;
			const chatLeaf = this.app.workspace.getLeavesOfType(LETTA_CHAT_VIEW_TYPE)[0];
			if (chatLeaf && chatLeaf.view instanceof LettaChatView) {
				console.log("[Letta Plugin] Forcing chat status update after connection");
				(chatLeaf.view as LettaChatView).updateChatStatus();
			}

			return true;
		} catch (error: any) {
			console.error(
				`[Letta Plugin] Connection attempt ${attempt} failed:`,
				error,
			);
			console.error("[Letta Plugin] Error details:", {
				message: error.message,
				stack: error.stack,
				name: error.name,
			});

			// Clear client on authentication failures to ensure proper UI state
			if (error.message.includes("401") || error.message.includes("Unauthorized")) {
				console.log("[Letta Plugin] Authentication failed - clearing client");
				this.client = null;
				this.agent = null;
				this.lastAuthError = "Authentication failed. Please check your API key and base URL in the plugin settings.";

				// Show immediate notice for auth failures on first attempt
				if (attempt === 1) {
					new Notice("Authentication failed. Please check your API key in plugin settings.");
				}

				// Don't retry authentication errors - return failure immediately
				const failureMessage = "Authentication failed";
				this.updateStatusBar(failureMessage);
				progressCallback?.(failureMessage);
				this.isConnecting = false;
				return false;
			} else {
				// Clear auth error for other types of errors
				this.lastAuthError = null;
			}

			// Provide specific error messages based on error type
			if (error.message.includes("ERR_NAME_NOT_RESOLVED")) {
				if (attempt === 1) {
					new Notice(
						`Cannot resolve hostname. Please check your Base URL: ${this.settings.lettaBaseUrl}`,
					);
				}
			} else if (
				error.message.includes("ECONNREFUSED") ||
				error.message.includes("ERR_CONNECTION_REFUSED")
			) {
				if (attempt === 1) {
					new Notice(
						`Connection refused. Is your Letta server running on ${this.settings.lettaBaseUrl}?`,
					);
				}
			} else if (error.message.includes("ENOTFOUND")) {
				if (attempt === 1) {
					new Notice(
						`Host not found. Please verify the URL spelling: ${this.settings.lettaBaseUrl}`,
					);
				}
			}

			// If we haven't reached max attempts, try again with backoff
			if (attempt < maxAttempts) {
				const backoffMs = Math.min(
					1000 * Math.pow(2, attempt - 1),
					10000,
				); // Cap at 10 seconds

				// Update status to show retry countdown
				const retryMessage = `Retry in ${Math.ceil(backoffMs / 1000)}s...`;
				this.updateStatusBar(retryMessage);
				progressCallback?.(retryMessage);

				// Wait for backoff period
				await new Promise((resolve) => setTimeout(resolve, backoffMs));

				// Recursive retry
				return await this.connectToLetta(attempt + 1, progressCallback);
			} else {
				// All attempts failed
				const failureMessage = "Connection failed";
				this.updateStatusBar(failureMessage);
				progressCallback?.(failureMessage);
				this.isConnecting = false;
				new Notice(
					`Failed to connect to Letta after ${maxAttempts} attempts: ${error.message}`,
				);
				return false;
			}
		}
	}


	async setupAgent(): Promise<void> {

		// If no agent ID is configured, skip agent setup silently
		if (!this.settings.agentId) {
			// console.log('[Letta Plugin] No agent ID configured, skipping agent setup');
			return;
		}

		try {
			if (!this.client) throw new Error("Client not initialized");

			// Try to get the specific agent by ID
			const existingAgent = await this.client.agents.retrieve(
				this.settings.agentId,
			);

			if (existingAgent) {
				this.agent = { id: existingAgent.id, name: existingAgent.name };
				// Update agent name in settings in case it changed
				this.settings.agentName = existingAgent.name;
				await this.saveSettings();


				// Register Obsidian tools after successful agent setup (if enabled)
				if (this.settings.enableCustomTools) {
					await this.registerObsidianTools();
				}
			} else {
				// Agent with configured ID not found, clear the invalid ID
				console.log(
					`[Letta Plugin] Agent with ID ${this.settings.agentId} not found, clearing invalid ID`,
				);
				this.settings.agentId = "";
				this.settings.agentName = "";
				await this.saveSettings();
			}
		} catch (error) {
			console.error("Failed to setup agent:", error);
			// Clear invalid agent ID on error
			this.settings.agentId = "";
			this.settings.agentName = "";
			await this.saveSettings();
			// Don't throw error to prevent blocking startup
		}
	}

	// Focus Mode Methods
	async ensureFocusBlock(): Promise<void> {
		if (!this.agent || !this.client) return;

		const focusBlockLabel = `obsidian-${this.agent.id}-focused-note`;

		try {
			// Check if block exists
			const blocks = await this.client.blocks.list({ label: focusBlockLabel });

			if (blocks && blocks.length > 0) {
				// Block exists, store its ID
				this.focusBlockId = blocks[0].id || null;

				// Attach if focus mode is enabled
				if (this.settings.focusMode) {
					await this.attachFocusBlock();
				}
			} else {
				// Create the block
				const block = await this.client.blocks.create({
					label: focusBlockLabel,
					description: "The content of the Obsidian file that the user is currently viewing.",
					value: "The user is not currently viewing a note.",
					limit: this.settings.focusBlockCharLimit,
				});
				this.focusBlockId = block.id || null;

				// Attach if focus mode is enabled
				if (this.settings.focusMode) {
					await this.attachFocusBlock();
				}
			}

			// Update with current file if any
			if (this.settings.focusMode) {
				const activeFile = this.app.workspace.getActiveFile();
				if (activeFile) {
					await this.updateFocusBlock(activeFile);
				}
			}
		} catch (error) {
			console.error("[Letta Plugin] Failed to ensure focus block:", error);
		}
	}

	async attachFocusBlock(): Promise<void> {
		if (!this.agent || !this.client || !this.focusBlockId) return;

		try {
			await this.client.agents.blocks.attach(this.agent.id, this.focusBlockId);
			console.log("[Letta Plugin] Focus block attached successfully");
		} catch (error) {
			// Block might already be attached, that's okay
			console.log("[Letta Plugin] Focus block attach result:", error);
		}
	}

	async detachFocusBlock(): Promise<void> {
		if (!this.agent || !this.client || !this.focusBlockId) return;

		try {
			await this.client.agents.blocks.detach(this.agent.id, this.focusBlockId);
			console.log("[Letta Plugin] Focus block detached successfully");
		} catch (error) {
			console.error("[Letta Plugin] Failed to detach focus block:", error);
		}
	}

	async updateFocusBlock(file: TFile | null): Promise<void> {
		if (!this.agent || !this.client || !this.focusBlockId) return;

		try {
			let value: string;

			if (!file) {
				value = "The user is not currently viewing a note.";
			} else {
				const content = await this.app.vault.read(file);
				const title = file.basename;
				const path = file.path;

				// Format the content
				const formattedContent = `NOTE TITLE: ${title}
NOTE PATH: ${path}

${content}`;

				// Check size limit
				if (formattedContent.length > this.settings.focusBlockCharLimit) {
					// Truncate content but keep header
					const header = `NOTE TITLE: ${title}
NOTE PATH: ${path}

`;
					const availableSpace = this.settings.focusBlockCharLimit - header.length - 50; // Leave some space for ellipsis
					const truncatedContent = content.substring(0, availableSpace) + "\n\n[Note truncated - exceeds character limit]";
					value = header + truncatedContent;

					// Show warning in chat view if it's open
					this.showSizeLimitWarning(file, content.length);
				} else {
					value = formattedContent;
				}
			}

			const focusBlockLabel = `obsidian-${this.agent.id}-focused-note`;
			await this.client.agents.blocks.modify(this.agent.id, focusBlockLabel, {
				value: value,
				limit: this.settings.focusBlockCharLimit,
			});

			console.log("[Letta Plugin] Focus block updated");
		} catch (error) {
			console.error("[Letta Plugin] Failed to update focus block:", error);
		}
	}

	scheduleFocusUpdate(): void {
		// Clear existing timer
		if (this.focusUpdateTimer) {
			clearTimeout(this.focusUpdateTimer);
		}

		// Schedule update in 5 seconds
		this.focusUpdateTimer = setTimeout(() => {
			this.updateFocusBlock(this.lastFocusedFile);
		}, 5000);
	}

	showSizeLimitWarning(file: TFile, actualSize: number): void {
		// Find open chat views and show warning
		const leaves = this.app.workspace.getLeavesOfType(LETTA_CHAT_VIEW_TYPE);
		leaves.forEach(leaf => {
			const view = leaf.view as LettaChatView;
			if (view && view.showSizeLimitWarning) {
				view.showSizeLimitWarning(file, actualSize, this.settings.focusBlockCharLimit);
			}
		});
	}

	async openChatView(): Promise<void> {
		// console.log('[LETTA DEBUG] openChatView called');

		// Auto-connect if not connected to server
		if (!this.agent) {
			// console.log('[LETTA DEBUG] openChatView - connecting to Letta');
			new Notice("Connecting to Letta...");
			const connected = await this.connectToLetta();
			if (!connected) {
				// console.log('[LETTA DEBUG] openChatView - failed to connect');
				return;
			}
		}

		const { workspace } = this.app;

		// Store the currently active file before opening chat
		const activeFileBeforeChat = workspace.getActiveFile();
		// console.log('[LETTA DEBUG] openChatView - activeFileBeforeChat:', activeFileBeforeChat?.path || 'null');

		let leaf: WorkspaceLeaf | null = null;
		const leaves = workspace.getLeavesOfType(LETTA_CHAT_VIEW_TYPE);

		if (leaves.length > 0) {
			// A leaf with our view already exists, use that
			// console.log('[LETTA DEBUG] openChatView - using existing leaf');
			leaf = leaves[0];
		} else {
			// Our view could not be found in the workspace, create a new leaf
			// in the right sidebar for it
			// console.log('[LETTA DEBUG] openChatView - creating new leaf');
			leaf = workspace.getRightLeaf(false);
			if (leaf) {
				await leaf.setViewState({
					type: LETTA_CHAT_VIEW_TYPE,
					active: true,
				});
			}
		}

		// "Reveal" the leaf in case it is in a collapsed sidebar
		if (leaf) {
			// console.log('[LETTA DEBUG] openChatView - revealing leaf');
			workspace.revealLeaf(leaf);
		}

	}

	async openMemoryView(): Promise<void> {
		// Auto-connect if not connected to server
		if (!this.agent) {
			new Notice("Connecting to Letta...");
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
				await leaf.setViewState({
					type: LETTA_MEMORY_VIEW_TYPE,
					active: true,
				});
			}
		}

		// "Reveal" the leaf in case it is in a collapsed sidebar
		if (leaf) {
			workspace.revealLeaf(leaf);
		}
	}

	async sendMessageToAgent(message: string): Promise<LettaMessage[]> {
		if (!this.agent) throw new Error("Agent not connected");
		if (!this.client) throw new Error("Client not initialized");

		console.log(
			"[Letta NonStream] Sending message to agent:",
			this.agent.id,
		);
		const response = await this.client.agents.messages.create(
			this.agent.id,
			{
				messages: [
					{
						role: "user",
						content: `[Message from Obsidian chat interface]\n\n${message}`,
					},
				],
			},
		);

		console.log("[Letta NonStream] Response received:", response);
		console.log("[Letta NonStream] Messages:", response.messages);
		return (response.messages || []) as any;
	}

	async sendMessageToAgentStream(
		message: string,
		onMessage: (message: any) => void,
		onError: (error: Error) => void,
		onComplete: () => void,
	): Promise<void> {
		if (!this.agent) throw new Error("Agent not connected");
		if (!this.client) throw new Error("Client not initialized");

		try {
			// Use the SDK's streaming API
			console.log(
				"[Letta Stream] Starting stream for agent:",
				this.agent.id,
			);
			const stream = await this.client.agents.messages.createStream(
				this.agent.id,
				{
					messages: [
						{
							role: "user",
							content: `[Message from Obsidian chat interface]\n\n${message}`,
						},
					],
					streamTokens: true,
				},
			);
			console.log("[Letta Stream] Stream created successfully:", stream);

			// Process the stream
			for await (const chunk of stream) {
				console.log("[Letta Stream] Chunk received:", chunk);
				console.log("[Letta Stream] Chunk type:", typeof chunk);

				// Check if this is the [DONE] signal
				if (
					(chunk as any) === "[DONE]" ||
					(typeof chunk === "string" &&
						(chunk as string).includes("[DONE]"))
				) {
					console.log("[Letta Stream] Received DONE signal");
					onComplete();
					return;
				}

				onMessage(chunk);
			}

			// Stream completed successfully (if we exit loop normally)
			console.log("[Letta Stream] Stream ended normally");
			onComplete();
		} catch (error: any) {
			console.error("[Letta Stream] Stream error:", error);
			console.error("[Letta Stream] Error details:", {
				message: error.message,
				status: error.statusCode || error.status,
				name: error.name,
				stack: error.stack,
			});

			// Check if this is a CORS-related error and create appropriate error message
			if (
				error instanceof TypeError &&
				(error.message.includes("NetworkError") ||
					error.message.includes("fetch") ||
					error.message.includes("Failed to fetch") ||
					error.message.includes("CORS"))
			) {
				const corsError = new Error(
					"CORS_ERROR: Network request failed, likely due to CORS restrictions. Falling back to non-streaming API.",
				);
				onError(corsError);
			} else if (error instanceof LettaError) {
				// Handle Letta SDK errors - check for rate limiting and CORS issues
				if (error.statusCode === 429) {
					// This is a genuine rate limit error
					onError(new Error(`HTTP 429: ${error.message}`));
				} else if (
					error.statusCode === 0 ||
					(error.statusCode === 429 &&
						!error.message.includes("rate"))
				) {
					// Likely a CORS error masquerading as another error
					const corsError = new Error(
						"CORS_ERROR: Cross-origin request blocked. Streaming not available from this origin. Falling back to non-streaming API.",
					);
					onError(corsError);
				} else {
					onError(error);
				}
			} else {
				onError(error);
			}
		}
	}

	async registerObsidianTools(): Promise<boolean> {
		// DISABLED: Approval-based tool registration is currently disabled due to upstream Letta API issues
		// with streaming approval flow. Re-enable once the API properly supports approval_request_message
		// during streaming (currently only sends stop_reason).
		return true;

		/* COMMENTED OUT - DO NOT USE UNTIL UPSTREAM ISSUES RESOLVED
		if (!this.client) {
			console.error("Cannot register tools: Letta client not initialized");
			return false;
		}

		const toolName = "write_obsidian_note";

		// First check if the tool already exists
		console.log(`[Letta Plugin] Checking if tool '${toolName}' already exists...`);
		let existingTool: any = null;
		try {
			const tools = await this.client.tools.list({ name: toolName });
			existingTool = tools.find((tool: any) => tool.name === toolName);
			if (existingTool) {
				console.log(`[Letta Plugin] Tool '${toolName}' already exists with ID: ${existingTool.id}`);
			}
		} catch (error) {
			console.error("Failed to check existing tools:", error);
		}

		// If tool exists and we have an agent, check if it's already attached
		if (existingTool && this.agent) {
			console.log(`[Letta Plugin] Checking if tool is already attached to agent ${this.agent.id}...`);
			try {
				const agentDetails = await this.client.agents.retrieve(this.agent.id);
				const currentTools = agentDetails.tools || [];

				const isToolAttached = currentTools.some((t: any) =>
					t.name === toolName || t === toolName ||
					(typeof t === 'object' && t.id === existingTool.id)
				);

				if (isToolAttached) {
					console.log(`[Letta Plugin] Tool '${toolName}' already exists and is attached to agent. Ensuring approval requirement is set...`);

					// Even if tool is attached, ensure approval requirement is set (Method 3)
					try {
						console.log(`[Letta Plugin] Calling modifyApproval with agentId: ${this.agent.id}, toolName: ${toolName}, requiresApproval: true`);
						const approvalResult = await this.client.agents.tools.modifyApproval(
							this.agent.id,
							toolName,
							{ requiresApproval: true }
						);
						console.log(`[Letta Plugin] modifyApproval response:`, approvalResult);

						// Check tool rules in the agent state
						const toolRules = (approvalResult as any).toolRules || (approvalResult as any).tool_rules;
						console.log(`[Letta Plugin] Agent toolRules after modifyApproval:`, toolRules);
						const approvalRule = toolRules?.find((rule: any) =>
							rule.toolName === toolName || rule.tool_name === toolName
						);
						console.log(`[Letta Plugin] Approval rule for '${toolName}':`, approvalRule);

						// Verify the tool's approval status after setting it
						const agentTools = await this.client.agents.tools.list(this.agent.id);
						const toolInfo = agentTools.find((t: any) => t.name === toolName);
						console.log(`[Letta Plugin] Tool '${toolName}' info from tools list:`, toolInfo);
					} catch (approvalError: any) {
						console.error("Failed to set approval requirement:", approvalError);
						console.error("Error details:", approvalError.message, approvalError.stack);
					}

					return true; // Success - tool is already fully configured
				} else {
					console.log(`[Letta Plugin] Tool exists but not attached to agent. Will attach it.`);
				}
			} catch (error) {
				console.error("Failed to check agent tools:", error);
			}
		}

		const writeNoteToolCode = `
def write_obsidian_note(
    block_label: str,
    file_path: str
) -> str:
    """
    Request approval to write a memory block's content to an Obsidian note file.
    This tool requires human approval before execution.

    Args:
        block_label: The label of the memory block containing the content to write
        file_path: The path where the note should be created (e.g., 'journal/2024-10-01.md' or 'projects/my-project.md')
                  If a default note folder is configured, it will be automatically prepended to this path.

    Returns:
        str: Success message if approved and executed

    Note:
        This tool will pause and request approval from the user.
        The user can approve to create the note or deny with guidance.
    """
    return f"Requesting approval to write block '{block_label}' to {file_path}"
`;

		// Now check if user consent is required (only if we need to create or attach the tool)
		if (this.settings.askBeforeToolRegistration) {
			console.log("[Letta Plugin] User consent required - showing modal...");
			const consentModal = new ToolRegistrationConsentModal(this.app, this);
			const userConsent = await consentModal.show();
			if (!userConsent) {
				console.log("[Letta Plugin] User declined tool registration");
				return false;
			}
		}

		let tool = existingTool;
		
		try {
			if (!existingTool) {
				// Tool doesn't exist, create it with approval requirement
				console.log(`[Letta Plugin] Creating new tool '${toolName}' with approval requirement...`);
				tool = await this.client.tools.upsert({
					name: toolName,
					sourceCode: writeNoteToolCode,
					description: "Write a memory block's content to an Obsidian note file (requires approval)",
					tags: ["obsidian", "note-creation", "requires-approval"],
					default_requires_approval: true
				} as any);
				console.log("Successfully created Obsidian note creation tool with approval requirement:", tool);
			} else {
				console.log(`[Letta Plugin] Using existing tool '${toolName}' with ID: ${existingTool.id}`);
			}

			// Attach tool to current agent if available and not already attached
			if (this.agent && tool && tool.id) {
				try {
					// If we had an existing tool that was already attached, we would have returned early
					// So if we reach here, we need to attach the tool
					console.log(`[Letta Plugin] Attaching tool '${toolName}' to agent ${this.agent.id}...`);
					await this.client.agents.tools.attach(this.agent.id, tool.id);
					console.log(`[Letta Plugin] Successfully attached '${toolName}' tool to agent`);

					// Set approval requirement for this agent-tool relationship (Method 3)
					console.log(`[Letta Plugin] Setting approval requirement for '${toolName}' on agent ${this.agent.id}...`);
					try {
						console.log(`[Letta Plugin] Calling modifyApproval with agentId: ${this.agent.id}, toolName: ${toolName}, requiresApproval: true`);
						const approvalResult = await this.client.agents.tools.modifyApproval(
							this.agent.id,
							toolName,
							{ requiresApproval: true }
						);
						console.log(`[Letta Plugin] modifyApproval response:`, approvalResult);

						// Check tool rules in the agent state
						const toolRules = (approvalResult as any).toolRules || (approvalResult as any).tool_rules;
						console.log(`[Letta Plugin] Agent toolRules after modifyApproval:`, toolRules);
						const approvalRule = toolRules?.find((rule: any) =>
							rule.toolName === toolName || rule.tool_name === toolName
						);
						console.log(`[Letta Plugin] Approval rule for '${toolName}':`, approvalRule);

						// Verify the tool's approval status after setting it
						const agentTools = await this.client.agents.tools.list(this.agent.id);
						const toolInfo = agentTools.find((t: any) => t.name === toolName);
						console.log(`[Letta Plugin] Tool '${toolName}' info from tools list:`, toolInfo);
					} catch (approvalError: any) {
						console.error("Failed to set approval requirement:", approvalError);
						console.error("Error details:", approvalError.message, approvalError.stack);
						// Don't fail the whole operation if this fails
					}
				} catch (error) {
					console.error("Failed to attach tool to agent:", error);
					// Log more details for debugging
					console.error("Error details:", {
						agentId: this.agent.id,
						toolId: tool.id,
						errorMessage: error.message
					});
				}
			}

			const actionMessage = existingTool 
				? "Obsidian note creation tool attached successfully"
				: "Obsidian note creation tool registered successfully";
			new Notice(actionMessage);
			return true;
		} catch (error) {
			console.error("Failed to register Obsidian tools:", error);
			new Notice("Failed to register note creation tool");
			return false;
		}
		END COMMENTED OUT SECTION */
	}

	async createNoteFromProposal(proposal: ObsidianNoteProposal): Promise<string> {
		// Sanitize the title to ensure it's a valid filename
		const sanitizedTitle = proposal.title.replace(/[\\/:*?"<>|]/g, "_");
		const fileName = `${sanitizedTitle}.md`;
		
		// Determine the full path
		const folder = proposal.folder?.trim() || this.settings.defaultNoteFolder;
		const fullPath = folder ? `${folder}/${fileName}` : fileName;
		
		try {
			// Create folder if needed and it doesn't exist
			if (folder) {
				const folderExists = this.app.vault.getAbstractFileByPath(folder);
				if (!folderExists) {
					await this.app.vault.createFolder(folder);
					console.log(`Created folder: ${folder}`);
				}
			}
			
			// Check if file already exists
			const existingFile = this.app.vault.getAbstractFileByPath(fullPath);
			if (existingFile) {
				// Handle duplicate filename
				const timestamp = new Date().toISOString().slice(0, 19).replace(/[:-]/g, "");
				const duplicatePath = folder 
					? `${folder}/${sanitizedTitle}_${timestamp}.md`
					: `${sanitizedTitle}_${timestamp}.md`;
				
				const file = await this.app.vault.create(duplicatePath, proposal.content);
				
				// Open the note in a new tab
				const leaf = this.app.workspace.getLeaf('tab');
				await leaf.openFile(file);
				
				new Notice(`Created note with unique name: ${file.basename}`);
				return file.path;
			} else {
				// Create the note
				const file = await this.app.vault.create(fullPath, proposal.content);
				
				// Open the note in a new tab
				const leaf = this.app.workspace.getLeaf('tab');
				await leaf.openFile(file);
				
				new Notice(`Created note: ${file.basename}`);
				return file.path;
			}
		} catch (error) {
			console.error("Failed to create note from proposal:", error);
			new Notice(`Failed to create note: ${error.message}`);
			throw error;
		}
	}
}

class LettaChatView extends ItemView {
	plugin: LettaPlugin;
	chatContainer: HTMLElement;
	typingIndicator: HTMLElement;
	sizeLimitWarning: HTMLElement;
	heartbeatTimeout: NodeJS.Timeout | null = null;
	header: HTMLElement;
	inputContainer: HTMLElement;
	messageInput: HTMLTextAreaElement;
	sendButton: HTMLButtonElement;
	agentNameElement: HTMLElement;
	statusDot: HTMLElement;
	statusText: HTMLElement;

	constructor(leaf: WorkspaceLeaf, plugin: LettaPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType() {
		return LETTA_CHAT_VIEW_TYPE;
	}

	getDisplayText() {
		return "Letta Chat";
	}

	getIcon() {
		return "bot";
	}

	async onOpen() {
		const container = this.containerEl.children[1];
		container.empty();
		container.addClass("letta-chat-view");

		// Header with connection status
		this.header = container.createEl("div", { cls: "letta-chat-header" });

		const titleSection = this.header.createEl("div", {
			cls: "letta-chat-title-section",
		});

		this.agentNameElement = titleSection.createEl("h3", {
			text: this.plugin.agent
				? this.plugin.settings.agentName
				: "No Agent",
			cls: this.plugin.agent
				? "letta-chat-title"
				: "letta-chat-title no-agent",
		});
		this.agentNameElement.addClass("letta-agent-name-clickable");
		this.agentNameElement.title = "Click to edit agent name";
		this.agentNameElement.addEventListener("click", () =>
			this.editAgentName(),
		);

		const headerButtonContainer = titleSection.createEl("div", {
			cls: "letta-button-container",
		});

		const configButton = headerButtonContainer.createEl("span", {
			text: "Config",
		});
		configButton.title = "Configure agent properties";
		configButton.addClass("letta-config-button");
		configButton.addEventListener("click", () => this.openAgentConfig());

		const memoryButton = headerButtonContainer.createEl("span", {
			text: "Memory",
		});
		memoryButton.title = "Open memory blocks panel";
		memoryButton.addClass("letta-config-button");
		memoryButton.addEventListener("click", () =>
			this.plugin.openMemoryView(),
		);

		const switchAgentButton = headerButtonContainer.createEl("span", {
			text: "Agent",
		});
		switchAgentButton.title = "Switch to different agent";
		switchAgentButton.addClass("letta-config-button");
		switchAgentButton.addEventListener("click", () =>
			this.openAgentSwitcher(),
		);

		const adeButton = headerButtonContainer.createEl("span", { text: "ADE" });
		adeButton.title = "Open in Letta Agent Development Environment";
		adeButton.addClass("letta-config-button");
		adeButton.addEventListener("click", () => this.openInADE());

		const statusIndicator = this.header.createEl("div", {
			cls: "letta-status-indicator",
		});
		this.statusDot = statusIndicator.createEl("span", {
			cls: "letta-status-dot",
		});
		this.statusText = statusIndicator.createEl("span", {
			cls: "letta-status-text",
		});

		// Chat container
		this.chatContainer = container.createEl("div", {
			cls: "letta-chat-container",
		});

		// Size limit warning (hidden by default)
		this.sizeLimitWarning = this.chatContainer.createEl("div", {
			cls: "letta-size-limit-warning",
		});
		this.sizeLimitWarning.style.display = "none";

		// Typing indicator
		this.typingIndicator = this.chatContainer.createEl("div", {
			cls: "letta-typing-indicator",
		});
		this.typingIndicator.addClass("letta-typing-hidden");

		const typingText = this.typingIndicator.createEl("span", {
			cls: "letta-typing-text",
			text: `${this.plugin.settings.agentName} is thinking`,
		});

		const typingDots = this.typingIndicator.createEl("span", {
			cls: "letta-typing-dots",
		});
		typingDots.createEl("span", { text: "." });
		typingDots.createEl("span", { text: "." });
		typingDots.createEl("span", { text: "." });

		// Now that chat container exists, update status to show disconnected message if needed
		this.updateChatStatus();

		// Input container
		this.inputContainer = container.createEl("div", {
			cls: "letta-input-container",
		});

		this.messageInput = this.inputContainer.createEl("textarea", {
			cls: "letta-message-input",
			attr: {
				placeholder: "Ask about your vault...",
				rows: "2",
			},
		});

		const buttonContainer = this.inputContainer.createEl("div", {
			cls: "letta-button-container",
		});

		this.sendButton = buttonContainer.createEl("button", {
			cls: "letta-send-button",
			attr: { "aria-label": "Send message" },
		});
		this.sendButton.createEl("span", { text: "Send" });

		// Event listeners
		this.sendButton.addEventListener("click", () => this.sendMessage());

		// Update status now that all UI elements are created
		this.updateChatStatus();

		this.messageInput.addEventListener("keydown", (evt) => {
			if (evt.key === "Enter" && !evt.shiftKey) {
				evt.preventDefault();
				this.sendMessage();
			}
		});

		// Auto-resize textarea
		this.messageInput.addEventListener("input", () => {
			this.messageInput.style.height = "auto";
			this.messageInput.style.height =
				Math.min(this.messageInput.scrollHeight, 80) + "px";
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

	/**
	 * Safely render markdown content using Obsidian's built-in MarkdownRenderer
	 */
	async renderMarkdownContent(
		container: HTMLElement,
		content: string,
	): Promise<void> {
		// Clear existing content
		container.empty();

		try {
			// Use Obsidian's built-in markdown renderer
			await MarkdownRenderer.render(
				this.plugin.app,
				content,
				container,
				"", // sourcePath - empty for dynamic content
				new Component(), // Component for lifecycle management
			);
		} catch (error) {
			console.error("Error rendering markdown:", error);
			// Fallback to plain text if markdown rendering fails
			container.textContent = content;
		}
	}

	async addMessage(
		type: "user" | "assistant" | "reasoning" | "tool-call" | "tool-result",
		content: any,
		title?: string,
		reasoningContent?: string,
	) {
		// Adding message to chat interface

		// Extract text content from various possible formats
		let textContent: string = "";

		if (typeof content === "string") {
			textContent = content;
		} else if (Array.isArray(content)) {
			// Handle array content - extract text from array elements
			textContent = content
				.map((item) => {
					if (typeof item === "string") {
						return item;
					} else if (item && typeof item === "object") {
						return (
							item.text ||
							item.content ||
							item.message ||
							item.value ||
							JSON.stringify(item)
						);
					}
					return String(item);
				})
				.join("");
		} else if (content && typeof content === "object") {
			// Try to extract text from object structure
			textContent =
				content.text ||
				content.content ||
				content.message ||
				content.value ||
				"";

			// If still no text found, try JSON stringification as fallback
			if (!textContent && content) {
				console.warn(
					"[Letta Plugin] Content object has no recognizable text field, using JSON fallback:",
					Object.keys(content),
				);
				textContent = JSON.stringify(content, null, 2);
			}
		} else {
			// Last resort: convert to string
			textContent = String(content || "");
		}

		// Text content extracted for display

		// Ensure we have some content to display
		if (!textContent) {
			console.warn("[Letta Plugin] No content to display");
			return;
		}

		// Hide typing indicator when real content arrives
		this.hideTypingIndicator();

		// Clean up previous tool calls when starting a new assistant message
		if (type === "assistant") {
			this.cleanupPreviousToolCalls();
		}
		// Check if this is actually a system_alert that wasn't properly filtered
		if (textContent && textContent.includes('"type": "system_alert"')) {
			// Try to parse and handle as system message instead
			try {
				const parsed = JSON.parse(textContent);
				if (parsed.type === "system_alert") {
					this.addSystemMessage(parsed);
					return null;
				}
			} catch (e) {
				// If parsing fails, continue with regular message handling
				// but log this case for debugging
				console.debug(
					"[Letta Plugin] Failed to parse potential system_alert content:",
					e,
				);
			}
		}

		// Debug: Check for heartbeat content being added as regular message
		if (
			textContent &&
			(textContent.includes('"type": "heartbeat"') ||
				textContent.includes("automated system message") ||
				textContent.includes(
					"Function call failed, returning control",
				) ||
				textContent.includes("request_heartbeat=true"))
		) {
			// Blocked heartbeat content from being displayed
			// Don't add this message - it should have been filtered and handled by typing indicator
			return null;
		}
		const messageEl = this.chatContainer.createEl("div", {
			cls: `letta-message letta-message-${type}`,
		});

		// Create bubble wrapper
		const bubbleEl = messageEl.createEl("div", {
			cls: "letta-message-bubble",
		});

		// Add timestamp
		const timestamp = new Date().toLocaleTimeString([], {
			hour: "2-digit",
			minute: "2-digit",
		});

		// Skip tool messages - they're now handled by addToolInteractionMessage
		if (type === "tool-call" || type === "tool-result") {
			return;
		} else if (type === "reasoning") {
			// Skip standalone reasoning messages - they should be part of assistant messages
			return;
		} else {
			// Regular messages (user/assistant)
			if (title && type !== "user") {
				const headerEl = bubbleEl.createEl("div", {
					cls: "letta-message-header",
				});

				// Left side: title and timestamp
				const leftSide = headerEl.createEl("div", {
					cls: "letta-message-header-left",
				});

				// Remove emojis from titles
				let cleanTitle = title.replace(/🤖|👤|🚨|✅|❌|🔌/g, "").trim();
				leftSide.createEl("span", {
					cls: "letta-message-title",
					text: cleanTitle,
				});
				leftSide.createEl("span", {
					cls: "letta-message-timestamp",
					text: timestamp,
				});

				// Right side: reasoning button if reasoning content exists
				if (type === "assistant" && reasoningContent) {
					const reasoningBtn = headerEl.createEl("button", {
						cls: "letta-reasoning-btn letta-reasoning-collapsed",
						text: "⋯",
					});

					// Add click handler for reasoning toggle
					reasoningBtn.addEventListener("click", (e) => {
						e.stopPropagation();
						const isCollapsed = reasoningBtn.classList.contains(
							"letta-reasoning-collapsed",
						);
						if (isCollapsed) {
							reasoningBtn.removeClass(
								"letta-reasoning-collapsed",
							);
							reasoningBtn.addClass("letta-reasoning-expanded");
						} else {
							reasoningBtn.addClass("letta-reasoning-collapsed");
							reasoningBtn.removeClass(
								"letta-reasoning-expanded",
							);
						}

						// Toggle reasoning content visibility
						const reasoningEl = bubbleEl.querySelector(
							".letta-reasoning-content",
						);
						if (reasoningEl) {
							reasoningEl.classList.toggle(
								"letta-reasoning-visible",
							);
						}
					});
				}
			}

			// Add reasoning content if provided (for assistant messages)
			if (type === "assistant" && reasoningContent) {
				const reasoningEl = bubbleEl.createEl("div", {
					cls: "letta-reasoning-content",
				});

				// Enhanced markdown-like formatting for reasoning
				let formattedReasoning = reasoningContent
					// Trim leading and trailing whitespace first
					.trim()
					// Normalize multiple consecutive newlines to double newlines
					.replace(/\n{3,}/g, "\n\n")
					// Handle headers (must be done before other formatting)
					.replace(/^### (.+)$/gm, "<h3>$1</h3>")
					.replace(/^## (.+)$/gm, "<h2>$1</h2>")
					.replace(/^# (.+)$/gm, "<h1>$1</h1>")
					// Handle bold and italic
					.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
					.replace(/\*(.*?)\*/g, "<em>$1</em>")
					.replace(/`([^`]+)`/g, "<code>$1</code>")
					// Handle numbered lists (1. 2. 3. etc.)
					.replace(
						/^(\d+)\.\s+(.+)$/gm,
						'<li class="numbered-list">$2</li>',
					)
					// Handle bullet lists (•, -, *)
					.replace(/^[•*-]\s+(.+)$/gm, "<li>$1</li>")
					// Handle double newlines as paragraph breaks first
					.replace(/\n\n/g, "</p><p>")
					// Convert remaining single newlines to <br> tags
					.replace(/\n/g, "<br>");

				// Wrap consecutive numbered list items in <ol> tags
				formattedReasoning = formattedReasoning.replace(
					/(<li class="numbered-list">.*?<\/li>)(\s*<br>\s*<li class="numbered-list">.*?<\/li>)*/g,
					(match) => {
						// Remove the <br> tags between numbered list items and wrap in <ol>
						const cleanMatch = match.replace(/<br>\s*/g, "");
						return "<ol>" + cleanMatch + "</ol>";
					},
				);

				// Wrap consecutive regular list items in <ul> tags
				formattedReasoning = formattedReasoning.replace(
					/(<li>(?!.*class="numbered-list").*?<\/li>)(\s*<br>\s*<li>(?!.*class="numbered-list").*?<\/li>)*/g,
					(match) => {
						// Remove the <br> tags between list items and wrap in <ul>
						const cleanMatch = match.replace(/<br>\s*/g, "");
						return "<ul>" + cleanMatch + "</ul>";
					},
				);

				// Wrap in paragraphs if needed
				if (
					formattedReasoning.includes("</p><p>") &&
					!formattedReasoning.startsWith("<")
				) {
					formattedReasoning = "<p>" + formattedReasoning + "</p>";
				}

				reasoningEl.innerHTML = formattedReasoning;
			}

			// Handle collapsible user messages
			if (type === "user" && textContent.length > 200) {
				// Create container for collapsible content
				const contentContainer = bubbleEl.createEl("div", {
					cls: "letta-user-message-container",
				});

				// Create preview content (first 200 characters)
				const previewContent =
					textContent.substring(0, 200).trim() + "...";
				const previewEl = contentContainer.createEl("div", {
					cls: "letta-message-content letta-user-message-preview",
				});
				previewEl.textContent = previewContent;

				// Create full content (initially hidden)
				const fullContentEl = contentContainer.createEl("div", {
					cls: "letta-message-content letta-user-message-full letta-user-message-collapsed",
				});
				// Use robust markdown rendering instead of innerHTML
				await this.renderMarkdownContent(fullContentEl, textContent);

				// Create expand/collapse button
				const expandBtn = contentContainer.createEl("button", {
					cls: "letta-user-message-toggle",
					text: "See more",
				});

				// Add click handler for expand/collapse
				expandBtn.addEventListener("click", (e) => {
					e.stopPropagation();
					const isCollapsed = fullContentEl.classList.contains(
						"letta-user-message-collapsed",
					);

					if (isCollapsed) {
						// Expand: hide preview, show full content
						previewEl.addClass("letta-user-message-preview-hidden");
						fullContentEl.removeClass(
							"letta-user-message-collapsed",
						);
						expandBtn.textContent = "See less";
					} else {
						// Collapse: show preview, hide full content
						previewEl.removeClass(
							"letta-user-message-preview-hidden",
						);
						fullContentEl.addClass("letta-user-message-collapsed");
						expandBtn.textContent = "See more";
					}
				});
			} else {
				// Regular content for short messages or non-user messages
				const contentEl = bubbleEl.createEl("div", {
					cls: "letta-message-content",
				});
				// Use robust markdown rendering instead of innerHTML
				await this.renderMarkdownContent(contentEl, textContent);
			}
		}

		// Animate message appearance
		messageEl.addClass("letta-message-entering");
		setTimeout(() => {
			messageEl.removeClass("letta-message-entering");
			messageEl.addClass("letta-message-entered");
		}, 50);

		// Scroll to bottom with smooth animation
		setTimeout(() => {
			this.chatContainer.scrollTo({
				top: this.chatContainer.scrollHeight,
				behavior: "smooth",
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
		const existingMessages =
			this.chatContainer.querySelectorAll(".letta-message");
		if (existingMessages.length > 0) {
			return;
		}

		try {
			// Load last 50 messages by default
			const messages = await this.plugin.makeRequest(
				`/v1/agents/${this.plugin.agent?.id}/messages?limit=50`,
			);

			if (!messages || messages.length === 0) {
				return;
			}

			// Filter out any obviously malformed messages before processing
			const validMessages = messages.filter((msg: any) => {
				if (!msg) return false;
				const messageType = msg.message_type || msg.type;
				if (!messageType) {
					console.warn(
						"[Letta Plugin] Message missing type field:",
						msg,
					);
					return false;
				}
				return true;
			});

			if (validMessages.length === 0) {
				// No valid messages found in response
				return;
			}

			// Sort messages by timestamp (oldest first)
			const sortedMessages = validMessages.sort(
				(a: any, b: any) =>
					new Date(a.date).getTime() - new Date(b.date).getTime(),
			);

			// Process messages in groups (reasoning -> tool_call -> tool_return -> assistant)
			await this.processMessagesInGroups(sortedMessages);
		} catch (error) {
			console.error(
				"[Letta Plugin] Failed to load historical messages:",
				error,
			);
			// Show a minimal error message for malformed data issues
			if (
				error.message &&
				error.message.includes("missing message argument")
			) {
				await this.addMessage(
					"assistant",
					"Some messages in your conversation history could not be loaded due to data issues. New messages will work normally.",
					"System",
				);
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
			/using folder paths/i,
			/\*\*File System Notes:\*\*/i,
			/I can open up to \d+ files/i,
			// Repeated content patterns
			/(.*)\1{2,}/s, // Catches content repeated 3+ times
		];

		// Check for repeated content blocks (specific to file system info spam)
		if (
			content.includes("**Currently Open Files") &&
			content.includes("Based on my current system access")
		) {
			const matches = content.match(
				/\*\*Currently Open Files.*?(?=\*\*Currently Open Files|\*\*Available Directories|$)/gs,
			);
			if (matches && matches.length > 1) {
				// Detected repeated file system information, filtering out
				return "I can see your vault files and am ready to help with your question.";
			}
		}

		// Check if content contains system prompt patterns
		const hasSystemContent = systemPromptPatterns.some((pattern) =>
			pattern.test(content),
		);

		if (hasSystemContent) {
			// Content contains system patterns, attempting selective filtering

			// Try more selective filtering - only remove lines that are clearly system instructions
			const lines = content.split("\n");
			const filteredLines = lines.filter((line) => {
				const trimmed = line.trim();
				if (!trimmed) return false; // Remove empty lines

				// Only remove lines that match very specific system patterns
				const isSystemLine = systemPromptPatterns.some((pattern) => {
					const match = pattern.test(trimmed);
					if (match) {
						// console.log('[Letta Plugin] Filtering system line:', trimmed);
					}
					return match;
				});

				// Keep lines that don't match system patterns and don't look like XML tags
				return (
					!isSystemLine &&
					!trimmed.includes("<") &&
					!trimmed.includes(">")
				);
			});

			const filtered = filteredLines.join("\n").trim();

			// Only use fallback if we have very little content left (less than 10 characters)
			if (!filtered || filtered.length < 10) {
				// Minimal content after filtering, using original response
				// Return original content instead of placeholder
				// Comprehensive escape handling
				return this.processEscapeSequences(content);
			}

			// Comprehensive escape handling
			return this.processEscapeSequences(filtered);
		}

		// Comprehensive escape handling
		return this.processEscapeSequences(content);
	}

	// Process common escape sequences in content
	processEscapeSequences(content: string): string {
		if (!content) return content;

		return content
			// Handle escaped newlines
			.replace(/\\n/g, "\n")
			// Handle newline-dash patterns (common in lists)
			.replace(/\\n-/g, "\n- ")
			// Handle escaped tabs
			.replace(/\\t/g, "\t")
			// Handle escaped quotes
			.replace(/\\"/g, '"')
			.replace(/\\'/g, "'")
			// Handle escaped backslashes
			.replace(/\\\\/g, "\\")
			// Handle literal \n- patterns that might appear in text
			.replace(/\\n\s*-/g, "\n- ")
			// Clean up any double newlines created
			.replace(/\n{3,}/g, "\n\n");
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
					formatted = formatted.replace(/\\n/g, "\n");

					// Handle escaped quotes
					formatted = formatted.replace(/\\"/g, '"');

					// Handle escaped backslashes
					formatted = formatted.replace(/\\\\/g, "\\");
				}
			} else {
				// Handle escaped sequences even without quotes
				formatted = formatted.replace(/\\n/g, "\n");
				formatted = formatted.replace(/\\"/g, '"');
				formatted = formatted.replace(/\\\\/g, "\\");
			}

			// Clean up extensive === separators - replace long chains with simple dividers
			formatted = formatted.replace(/={10,}/g, "---\n");

			// Clean up any remaining === separators at start/end
			formatted = formatted
				.replace(/^===+\s*/, "")
				.replace(/\s*===+$/, "");

			// Clean up multiple consecutive newlines
			formatted = formatted.replace(/\n{3,}/g, "\n\n");

			return formatted.trim();
		}
	}

	// Add a clean, centered rate limiting notification
	addRateLimitMessage(content: string) {
		// console.log('[Letta Plugin] Adding rate limit message:', content);
		const messageEl = this.chatContainer.createEl("div", {
			cls: "letta-rate-limit-message",
		});

		// Add timestamp
		const timestamp = new Date().toLocaleTimeString([], {
			hour: "2-digit",
			minute: "2-digit",
		});
		const timeEl = messageEl.createEl("div", {
			cls: "letta-rate-limit-timestamp",
			text: timestamp,
		});

		// Add content without markdown processing for clean display
		const contentEl = messageEl.createEl("div", {
			cls: "letta-rate-limit-content",
		});

		// Process the content to extract the main message and links
		const lines = content.split("\n");
		let mainMessage = "";
		let billingLink = "";
		let customKeysLink = "";

		for (const line of lines) {
			if (
				line.includes(
					"https://app.letta.com/settings/organization/billing",
				)
			) {
				billingLink = line.trim();
			} else if (
				line.includes("https://docs.letta.com/guides/cloud/custom-keys")
			) {
				customKeysLink = line.trim();
			} else if (
				line.trim() &&
				!line.includes("Need more?") &&
				!line.includes("Or bring your own")
			) {
				if (mainMessage) mainMessage += " ";
				mainMessage += line.replace(/[⚠️*]/g, "").trim();
			}
		}

		// Add main message
		if (mainMessage) {
			const msgEl = contentEl.createEl("div", {
				cls: "letta-rate-limit-main",
				text: mainMessage,
			});
		}

		// Add billing link if present
		if (billingLink) {
			const linkEl = contentEl.createEl("div", {
				cls: "letta-rate-limit-link",
			});
			const link = linkEl.createEl("a", {
				href: billingLink,
				text: "Upgrade to Pro, Scale, or Enterprise",
				cls: "letta-rate-limit-upgrade-link",
			});
			link.setAttribute("target", "_blank");
		}

		// Add "or" separator if both links are present
		if (billingLink && customKeysLink) {
			const orEl = contentEl.createEl("div", {
				cls: "letta-rate-limit-separator",
				text: "or",
			});
			orEl.style.cssText =
				"text-align: center; margin: 8px 0; color: var(--text-muted); font-size: 0.9em;";
		}

		// Add custom keys link if present
		if (customKeysLink) {
			const linkEl = contentEl.createEl("div", {
				cls: "letta-rate-limit-link",
			});
			const link = linkEl.createEl("a", {
				href: customKeysLink,
				text: "Learn about bringing your own inference provider",
				cls: "letta-rate-limit-upgrade-link",
			});
			link.setAttribute("target", "_blank");
		}

		// Scroll to bottom
		this.chatContainer.scrollTop = this.chatContainer.scrollHeight;
	}

	async processMessagesInGroups(messages: any[]) {
		let currentReasoning = "";
		let currentToolCallMessage: HTMLElement | null = null;
		let currentToolName = "";
		let currentToolCallData: any = null;

		for (const message of messages) {
			try {
				// Skip system messages as they're internal
				if (
					message.message_type === "system_message" ||
					message.type === "system_message"
				) {
					continue;
				}

				// Handle system messages - capture system_alert for hidden viewing, skip heartbeats
				if (
					message.type === "system_alert" ||
					(message.message &&
						typeof message.message === "string" &&
						message.message.includes(
							"prior messages have been hidden",
						))
				) {
					// Capturing historical system_alert message
					this.addSystemMessage(message);
					continue;
				}

				if (
					message.type === "heartbeat" ||
					message.message_type === "heartbeat"
				) {
					continue;
				}

				// Filter out login messages - check both direct type and content containing login JSON
				if (
					message.type === "login" ||
					message.message_type === "login"
				) {
					continue;
				}

				// Check if this is a user_message containing login JSON
				if (
					(message.message_type === "user_message" ||
						message.messageType === "user_message") &&
					message.content &&
					typeof message.content === "string"
				) {
					try {
						const parsedContent = JSON.parse(
							message.content.trim(),
						);
						if (parsedContent.type === "login") {
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
					console.warn(
						"[Letta Plugin] Skipping malformed message:",
						message,
					);
					await this.addErrorMessage(
						`Malformed ${messageType || "unknown"} message`,
						message,
					);
					continue;
				}

				switch (messageType) {
					case "user_message":
						if (message.content || message.text) {
							await this.addMessage(
								"user",
								message.text || message.content || "",
							);
						}
						break;

					case "reasoning_message":
						if (message.reasoning) {
							// Don't display reasoning as standalone message - only accumulate for next assistant message
							currentReasoning += message.reasoning;
						}
						break;

					case "tool_call_message":
						if (message.tool_call) {
							// Extract and store the tool name and data for later use with tool result
							currentToolName =
								message.tool_call.name ||
								(message.tool_call.function &&
									message.tool_call.function.name) ||
								"";
							currentToolCallData = message.tool_call;

							// Create tool interaction with reasoning and wait for tool result
							currentToolCallMessage =
								this.addToolInteractionMessage(
									currentReasoning,
									JSON.stringify(message.tool_call, null, 2),
								);
							// Clear reasoning after using it
							currentReasoning = "";
						}
						break;

					case "tool_return_message":
						if (message.tool_return && currentToolCallMessage) {
							// Add tool result to the existing tool interaction message with tool name and data
							await this.addToolResultToMessage(
								currentToolCallMessage,
								JSON.stringify(message.tool_return, null, 2),
								currentToolName,
								currentToolCallData,
							);
							// Clear the current tool call message reference, tool name, and data
							currentToolCallMessage = null;
							currentToolName = "";
							currentToolCallData = null;
						}
						break;

					case "assistant_message":
						if (message.content || message.text) {
							// Filter out system prompt content and use accumulated reasoning
							const rawContent =
								message.content || message.text || "";
							const filteredContent =
								this.filterSystemPromptContent(rawContent);
							await this.addMessage(
								"assistant",
								filteredContent,
								this.plugin.settings.agentName,
								currentReasoning || undefined,
							);
							// Clear reasoning after using it
							currentReasoning = "";
						}
						break;

					case "approval_request_message":
						// DISABLED: Approval handling commented out due to upstream API issues
						// console.log("[Letta Plugin] Found historical approval_request_message:", message);
						// await this.handleApprovalRequest(message);
						break;

					default:
					// Unknown historical message type
				}
			} catch (error) {
				console.error(
					"[Letta Plugin] Error processing message:",
					error,
					message,
				);
				await this.addErrorMessage(
					`Error processing ${message?.message_type || message?.type || "unknown"} message`,
					{ error: error.message, message },
				);
			}
		}
	}

	// Validate message structure based on type
	validateMessageStructure(message: any, messageType: string): boolean {
		if (!message) return false;

		switch (messageType) {
			case "user_message":
				return !!(message.content || message.text);
			case "assistant_message":
				return !!(message.content || message.text);
			case "reasoning_message":
				return !!message.reasoning;
			case "tool_call_message":
				return !!message.tool_call;
			case "tool_return_message":
				return !!message.tool_return;
			default:
				// For unknown types, just check if it's not null/undefined
				return true;
		}
	}

	// Add error message for malformed messages
	async addErrorMessage(title: string, data: any) {
		const errorContent = `${title} - This message had invalid data and was skipped.`;
		await this.addMessage("assistant", errorContent, "System");
	}

	async displayHistoricalMessage(message: any) {
		// Processing historical message

		// Handle system messages - capture system_alert for hidden viewing, skip heartbeats entirely
		// Check multiple possible properties where the type might be stored
		const messageType = message.type || message.message_type;
		const messageRole = message.role;
		const messageReason = message.reason || "";
		const hasHeartbeatContent =
			messageReason.includes("automated system message") ||
			messageReason.includes("Function call failed, returning control") ||
			messageReason.includes("request_heartbeat=true");

		// Store system_alert messages in hidden container for debugging
		if (
			messageType === "system_alert" ||
			(message.message &&
				typeof message.message === "string" &&
				message.message.includes("prior messages have been hidden"))
		) {
			// Capturing system_alert message
			this.addSystemMessage(message);
			return;
		}

		// Skip heartbeat messages entirely
		if (
			messageType === "heartbeat" ||
			message.message_type === "heartbeat" ||
			messageRole === "heartbeat" ||
			hasHeartbeatContent ||
			(message.content &&
				typeof message.content === "string" &&
				(message.content.includes("automated system message") ||
					message.content.includes(
						"Function call failed, returning control",
					) ||
					message.content.includes("request_heartbeat=true"))) ||
			(message.text &&
				typeof message.text === "string" &&
				(message.text.includes("automated system message") ||
					message.text.includes(
						"Function call failed, returning control",
					) ||
					message.text.includes("request_heartbeat=true")))
		) {
			// Skipping historical heartbeat message
			return;
		}

		// Filter out login messages - check both direct type and content containing login JSON
		if (
			messageType === "login" ||
			message.message_type === "login" ||
			messageRole === "login"
		) {
			return;
		}

		// Check if this is a user_message containing login JSON
		if (
			(message.message_type === "user_message" ||
				message.messageType === "user_message") &&
			message.content &&
			typeof message.content === "string"
		) {
			try {
				const parsedContent = JSON.parse(message.content.trim());
				if (parsedContent.type === "login") {
					return;
				}
			} catch (e) {
				// Not JSON, continue processing normally
			}
		}

		// Parse different message types based on Letta's message structure
		switch (message.message_type) {
			case "user_message":
				if (message.text || message.content) {
					await this.addMessage(
						"user",
						message.text || message.content || "",
					);
				}
				break;

			case "reasoning_message":
				// Reasoning messages are now handled by processMessagesInGroups
				break;

			case "tool_call_message":
				// Tool call messages are now handled by processMessagesInGroups
				break;

			case "tool_return_message":
				// Tool return messages are now handled by processMessagesInGroups
				break;

			case "assistant_message":
				if (message.content || message.text) {
					// Filter out system prompt content
					const rawContent = message.content || message.text || "";
					const filteredContent =
						this.filterSystemPromptContent(rawContent);
					await this.addMessage(
						"assistant",
						filteredContent,
						this.plugin.settings.agentName,
					);
				}
				break;

			case "system_message":
				// Skip system messages as they're internal
				break;

			case "heartbeat":
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
		const separatorEl = this.chatContainer.createEl("div", {
			cls: "letta-message-separator",
		});
		separatorEl.createEl("span", { text, cls: "letta-separator-text" });
	}

	addSystemMessage(message: any) {
		// Create system message using the same separator style as "Previous conversation history"
		const separatorEl = this.chatContainer.createEl("div", {
			cls: "letta-message-separator letta-system-message-separator",
		});
		// Hidden by default - can be toggled via settings or UI control

		// Create clickable separator text
		const separatorText = separatorEl.createEl("span", {
			text: "memory update",
			cls: "letta-separator-text letta-system-separator-text",
		});
		separatorText.style.cursor = "pointer";
		separatorText.style.userSelect = "none";

		// Create expandable content container (hidden initially)
		const expandedContent = this.chatContainer.createEl("div", {
			cls: "letta-system-expanded-content",
		});
		expandedContent.style.cssText =
			"display: none; background: var(--background-secondary); border: 1px solid var(--background-modifier-border); border-radius: 4px; padding: 12px; margin: 8px 0; font-size: 12px; line-height: 1.4;";

		// For system_alert messages, show the readable content
		if (message.type === "system_alert" && message.message) {
			const messageEl = expandedContent.createEl("div", {
				text: message.message,
				cls: "letta-system-content",
			});
			messageEl.style.cssText =
				"color: var(--text-normal); white-space: pre-wrap; margin-bottom: 8px;";
		}

		// Add a subtle "click to collapse" hint when expanded
		const collapseHint = expandedContent.createEl("div", {
			text: 'Click "System Message" above to collapse',
			cls: "letta-system-collapse-hint",
		});
		collapseHint.style.cssText =
			"font-size: 10px; color: var(--text-muted); margin-top: 8px; font-style: italic;";

		// Toggle functionality
		let isExpanded = false;
		separatorText.addEventListener("click", () => {
			isExpanded = !isExpanded;
			expandedContent.style.display = isExpanded ? "block" : "none";

			if (isExpanded) {
				// Scroll to keep the expanded content visible
				expandedContent.scrollIntoView({
					behavior: "smooth",
					block: "nearest",
				});
			}
		});

		// Auto-scroll to show the new system message separator
		this.chatContainer.scrollTop = this.chatContainer.scrollHeight;
	}

	showTypingIndicator() {
		if (this.typingIndicator) {
			this.typingIndicator.removeClass("letta-typing-hidden");
			this.typingIndicator.addClass("letta-typing-visible");
			// Scroll to bottom to show the typing indicator
			this.chatContainer.scrollTop = this.chatContainer.scrollHeight;
		}
	}

	hideTypingIndicator() {
		if (this.typingIndicator) {
			this.typingIndicator.removeClass("letta-typing-visible");
			this.typingIndicator.addClass("letta-typing-hidden");
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

	async updateChatStatus(loadHistoricalMessages = true, connectingMessage?: string) {
		console.log("[Letta Plugin] updateChatStatus called with loadHistoricalMessages:", loadHistoricalMessages, "connectingMessage:", connectingMessage);

		// If we have a connecting message, show connecting state
		if (connectingMessage) {
			console.log("[Letta Plugin] updateChatStatus: Taking CONNECTING branch -", connectingMessage);
			this.statusDot.className = "letta-status-dot letta-status-warning";
			this.statusText.textContent = connectingMessage;
			// Update agent name display to show "Connecting..."
			this.updateAgentNameDisplay(connectingMessage);
			// Show header but hide input when connecting
			if (this.header) {
				this.header.style.display = "flex";
			}
			if (this.inputContainer) {
				this.inputContainer.style.display = "none";
			}
			// Show connecting message in chat area
			this.removeDisconnectedMessage();
			this.removeNoAgentMessage();
			this.showConnectingMessage(connectingMessage);
			return;
		}

		// Determine connection status based on plugin state
		const isAgentAttached = !!this.plugin.agent;
		const isServerConnected = !!this.plugin.client;
		const isConnecting = this.plugin.isConnecting;

		console.log("[Letta Plugin] updateChatStatus state check:", {
			hasAgent: !!this.plugin.agent,
			agentId: this.plugin.agent?.id,
			agentName: this.plugin.agent?.name,
			isAgentAttached,
			isServerConnected,
			isConnecting
		});

		// If we're in the middle of connecting, show connecting state
		if (isConnecting) {
			console.log("[Letta Plugin] updateChatStatus: Taking CONNECTING branch - plugin is connecting");
			this.statusDot.className = "letta-status-dot letta-status-warning";
			this.statusText.textContent = "Connecting...";
			this.updateAgentNameDisplay("Connecting...");
			if (this.header) {
				this.header.style.display = "flex";
			}
			if (this.inputContainer) {
				this.inputContainer.style.display = "none";
			}
			this.removeDisconnectedMessage();
			this.removeNoAgentMessage();
			this.showConnectingMessage("Connecting to Letta...");
			return;
		}

		if (isAgentAttached) {
			console.log("[Letta Plugin] updateChatStatus: Taking AGENT_ATTACHED branch - full connection");
			this.statusDot.className =
				"letta-status-dot letta-status-connected";

			// Use the plugin's helper method for consistent status text
			this.statusText.textContent = this.plugin.getConnectionStatusText();

			// Update agent name display
			this.updateAgentNameDisplay();

			// Show header and input when connected
			if (this.header) {
				this.header.style.display = "flex";
			}
			if (this.inputContainer) {
				this.inputContainer.style.display = "flex";
			}

			// Remove disconnected/no agent/connecting messages if they exist
			this.removeDisconnectedMessage();
			this.removeNoAgentMessage();
			this.removeConnectingMessage();

			// Conditionally load historical messages
			if (loadHistoricalMessages) {
				this.loadHistoricalMessages();
			}
		} else if (isServerConnected) {
			console.log("[Letta Plugin] updateChatStatus: Taking SERVER_CONNECTED branch - server connected but no agent");
			// Connected to server but no agent selected
			this.statusDot.className = "letta-status-dot letta-status-warning";
			this.statusText.textContent = this.plugin.getConnectionStatusText();

			// Update agent name display to show "No Agent Selected"
			this.updateAgentNameDisplay();

			// Show header but hide input when no agent
			if (this.header) {
				this.header.style.display = "flex";
			}
			if (this.inputContainer) {
				this.inputContainer.style.display = "none";
			}

			// Show no agent message in chat area
			this.removeDisconnectedMessage();
			this.removeConnectingMessage();
			this.showNoAgentMessage();
		} else {
			console.log("[Letta Plugin] updateChatStatus: Taking DISCONNECTED branch - no connection");
			// Not connected to server
			this.statusDot.className = "letta-status-dot";
			this.statusDot.style.backgroundColor = "var(--text-muted)";
			this.statusText.textContent = "Letta Disconnected";

			// Update agent name display to show "No Agent"
			this.updateAgentNameDisplay();

			// Hide header and input when disconnected
			if (this.header) {
				this.header.style.display = "none";
			}
			if (this.inputContainer) {
				this.inputContainer.style.display = "none";
			}

			// Show disconnected message in chat area
			this.removeNoAgentMessage();
			this.removeConnectingMessage();
			this.showDisconnectedMessage();
		}
	}

	updateAgentNameDisplay(connectingMessage?: string) {
		if (connectingMessage) {
			this.agentNameElement.textContent = "Connecting...";
			this.agentNameElement.className = "letta-chat-title connecting";
			return;
		}

		const isServerConnected = !!this.plugin.client;

		if (this.plugin.agent) {
			this.agentNameElement.textContent = this.plugin.settings.agentName;
			this.agentNameElement.className = "letta-chat-title";
		} else if (isServerConnected) {
			this.agentNameElement.textContent = "No Agent Selected";
			this.agentNameElement.className = "letta-chat-title no-agent-selected";
		} else {
			this.agentNameElement.textContent = "No Agent";
			this.agentNameElement.className = "letta-chat-title no-agent";
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
		const disconnectedContainer = this.chatContainer.createEl("div", {
			cls: "letta-disconnected-container",
		});

		// Large disconnected message
		const disconnectedMessage = disconnectedContainer.createEl("div", {
			cls: "letta-disconnected-message",
		});

		disconnectedMessage.createEl("h2", {
			text: "You are not connected to Letta",
			cls: "letta-disconnected-title",
		});

		disconnectedMessage.createEl("p", {
			text: "A server connection is required to use your stateful agent",
			cls: "letta-disconnected-subtitle",
		});

		// Show authentication error message if available
		if (this.plugin.lastAuthError) {
			disconnectedMessage.createEl("p", {
				text: this.plugin.lastAuthError,
				cls: "letta-auth-error-text",
			});
		}

		// Connect button
		const connectButton = disconnectedMessage.createEl("button", {
			text: "Connect to Letta",
			cls: "letta-connect-button",
		});

		// Progress message element
		const progressMessage = disconnectedMessage.createEl("div", {
			cls: "letta-connect-progress hidden",
		});

		connectButton.addEventListener("click", async () => {
			console.log("[Letta Plugin] Connect button clicked - starting connection process");
			connectButton.disabled = true;

			// Clear existing content and add spinner
			connectButton.innerHTML = "";
			const spinner = connectButton.createEl("span", {
				cls: "letta-connect-spinner",
			});
			connectButton.appendChild(document.createTextNode("Connecting..."));

			// Show progress message
			progressMessage.classList.remove("hidden");
			progressMessage.classList.add("visible");

			try {
				console.log("[Letta Plugin] Calling connectToLetta from button click handler");
				const connected = await this.plugin.connectToLetta(1, (message: string) => {
					progressMessage.textContent = message;
				});

				console.log("[Letta Plugin] connectToLetta returned:", connected);

				if (connected) {
					console.log("[Letta Plugin] Connection successful - calling updateChatStatus to refresh UI");
					console.log("[Letta Plugin] Current plugin state before updateChatStatus:", {
						hasAgent: !!this.plugin.agent,
						agentId: this.plugin.agent?.id
					});
					// Connection successful - explicitly update chat status to refresh UI
					await this.updateChatStatus();
					console.log("[Letta Plugin] updateChatStatus completed");
				} else {
					console.log("[Letta Plugin] Connection failed - resetting connect button");
					// Connection failed - reset button
					this.resetConnectButton(connectButton, progressMessage);
				}
			} catch (error) {
				console.log("[Letta Plugin] Exception in connect button handler:", error);
				// Connection failed - reset button
				this.resetConnectButton(connectButton, progressMessage);
			}
		});
	}

	private resetConnectButton(connectButton: HTMLButtonElement, progressMessage: HTMLElement) {
		// Clear button content
		connectButton.innerHTML = "";
		connectButton.textContent = "Connect to Letta";
		connectButton.disabled = false;

		// Hide progress message
		progressMessage.classList.remove("visible");
		progressMessage.classList.add("hidden");
	}

	removeDisconnectedMessage() {
		if (!this.chatContainer) {
			return;
		}

		const existingMessage = this.chatContainer.querySelector(
			".letta-disconnected-container",
		);
		if (existingMessage) {
			existingMessage.remove();
		}
	}

	showConnectingMessage(message: string) {
		// Only show if chat container exists
		if (!this.chatContainer) {
			return;
		}

		// Remove any existing connecting message
		this.removeConnectingMessage();

		// Create connecting message container
		const connectingContainer = this.chatContainer.createEl("div", {
			cls: "letta-connecting-container",
		});

		// Large connecting message
		const connectingMessage = connectingContainer.createEl("div", {
			cls: "letta-connecting-message",
		});

		connectingMessage.createEl("h2", {
			text: message,
			cls: "letta-connecting-title",
		});

		connectingMessage.createEl("p", {
			text: "Establishing connection to Letta service...",
			cls: "letta-connecting-subtitle",
		});

		// Add animated dots
		const dots = connectingMessage.createEl("div", {
			cls: "letta-connecting-dots",
		});
		dots.createEl("span");
		dots.createEl("span");
		dots.createEl("span");
	}

	removeConnectingMessage() {
		if (!this.chatContainer) {
			return;
		}

		const existingMessage = this.chatContainer.querySelector(
			".letta-connecting-container",
		);
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

		const messageContainer = this.chatContainer.createEl("div", {
			cls: "letta-no-agent-container",
		});

		const content = messageContainer.createEl("div", {
			cls: "letta-no-agent-content",
		});

		content.createEl("h3", {
			text: "No Agent Selected",
			cls: "letta-no-agent-title",
		});

		content.createEl("p", {
			text: "You are connected to Letta, but no agent is selected. Choose an agent to start chatting.",
			cls: "letta-no-agent-description",
		});

		const buttonContainer = content.createEl("div", {
			cls: "letta-no-agent-buttons",
		});

		// Check agent count to determine if Select Agent should be enabled
		const agentCount = await this.plugin.getAgentCount();

		const selectAgentButton = buttonContainer.createEl("button", {
			text: agentCount > 0 ? "Select Agent" : "No Agents Available",
			cls: "mod-cta letta-select-agent-button",
		});

		if (agentCount > 0) {
			selectAgentButton.addEventListener("click", async () => {
				// Open agent selector from settings
				const settingTab = new LettaSettingTab(this.app, this.plugin);
				await settingTab.showAgentSelector();
			});
		} else {
			selectAgentButton.disabled = true;
			selectAgentButton.style.opacity = "0.5";
			selectAgentButton.style.cursor = "not-allowed";
		}

		// Show the create agent button
		const createAgentButton = buttonContainer.createEl("button", {
			text: "Create New Agent",
			cls: "letta-create-agent-button",
		});

		// Make the button less prominent to prevent accidental clicks
		createAgentButton.style.cssText = "opacity: 0.7; font-size: 0.9em;";
		createAgentButton.addEventListener("mouseenter", () => {
			createAgentButton.style.opacity = "1";
		});
		createAgentButton.addEventListener("mouseleave", () => {
			createAgentButton.style.opacity = "0.7";
		});

		createAgentButton.addEventListener("click", async () => {
			// Show confirmation before opening agent creation modal
			const confirmModal = new Modal(this.app);
			confirmModal.titleEl.setText("Create New Agent");

			const content = confirmModal.contentEl;
			content.createEl("p", {
				text: "Are you sure you want to create a new agent? This will open the agent configuration modal.",
			});

			const buttonContainer = content.createEl("div", {
				cls: "modal-button-container",
			});
			buttonContainer.style.cssText =
				"display: flex; justify-content: flex-end; gap: 10px; margin-top: 20px;";

			const cancelButton = buttonContainer.createEl("button", {
				text: "Cancel",
			});
			cancelButton.addEventListener("click", () => confirmModal.close());

			const createButton = buttonContainer.createEl("button", {
				text: "Create Agent",
				cls: "mod-cta",
			});
			createButton.addEventListener("click", async () => {
				confirmModal.close();

				// Open agent creation modal after confirmation
				const configModal = new AgentConfigModal(this.app, this.plugin);
				const agentConfig = await configModal.showModal();

				if (agentConfig) {
					try {
						// Create the agent using the configuration
						await this.createAgentFromConfig(agentConfig);
						new Notice("Agent created successfully!");
						// Refresh the no-agent message to update button state
						await this.showNoAgentMessage();
					} catch (error) {
						console.error(
							"[Letta Plugin] Failed to create agent:",
							error,
						);
						new Notice(`Failed to create agent: ${error.message}`);
					}
				}
			});

			confirmModal.open();
		});
	}

	async createAgentFromConfig(agentConfig: AgentConfig): Promise<void> {

		// Creating new agent
		// console.log('[Letta Plugin] Starting agent creation with config:', agentConfig);

		// Check if this is a cloud instance and handle project selection
		const isCloudInstance =
			this.plugin.settings.lettaBaseUrl.includes("api.letta.com");
		let selectedProject: any = null;

		if (isCloudInstance) {
			console.log(
				"[Letta Plugin] Cloud instance detected, checking projects...",
			);
			try {
				const projectsResponse =
					await this.plugin.makeRequest("/v1/projects");
				console.log(
					"[Letta Plugin] Available projects response:",
					projectsResponse,
				);

				// Handle both direct array and nested response formats
				const projects = projectsResponse.projects || projectsResponse;
				console.log("[Letta Plugin] Projects array:", projects);

				// If we have a configured project slug, try to find it
				if (this.plugin.settings.lettaProjectSlug) {
					selectedProject = projects.find(
						(p: any) =>
							p.slug === this.plugin.settings.lettaProjectSlug,
					);
					if (!selectedProject) {
						console.warn(
							`[Letta Plugin] Configured project "${this.plugin.settings.lettaProjectSlug}" not found`,
						);
					}
				}

				// If no valid project is selected, use the first available project
				if (!selectedProject && projects.length > 0) {
					selectedProject = projects[0];
					console.log(
						"[Letta Plugin] Using first available project:",
						selectedProject,
					);
					console.log(
						"[Letta Plugin] Project fields available:",
						Object.keys(selectedProject),
					);
				}

				if (!selectedProject) {
					throw new Error(
						"No projects available. Please create a project first in your Letta instance.",
					);
				}
			} catch (error) {
				console.error("[Letta Plugin] Project setup failed:", error);
				throw new Error(`Failed to setup project: ${error.message}`);
			}
		}

		// Create new agent with user configuration and corrected defaults
		const agentBody: any = {
			name: agentConfig.name,
			agent_type: agentConfig.agent_type || "memgpt_v2_agent", // Use user selection or default to MemGPT v2
			description: agentConfig.description,
			model: agentConfig.model,
			include_base_tools: false, // Don't include base tools, use custom memory tools
			include_multi_agent_tools: agentConfig.include_multi_agent_tools,
			include_default_source: agentConfig.include_default_source,
			tags: agentConfig.tags,
			memory_blocks: agentConfig.memory_blocks,
			// source_ids removed - no longer using deprecated folder approach
			// Specify the correct memory tools
			tools: ["memory_replace", "memory_insert", "memory_rethink"],
		};

		// Only include project for cloud instances
		if (isCloudInstance && selectedProject) {
			// Try using slug instead of id since the API error suggests id is not found
			agentBody.project = selectedProject.slug;
			console.log(
				"[Letta Plugin] Using project for agent creation:",
				selectedProject.slug,
			);
		}

		// Remove undefined values to keep the request clean
		Object.keys(agentBody).forEach((key) => {
			if (agentBody[key] === undefined) {
				delete agentBody[key];
			}
		});

		console.log(
			"[Letta Plugin] Creating agent with config:",
			JSON.stringify(agentBody, null, 2),
		);

		let newAgent: any;
		try {
			if (!this.plugin.client) throw new Error("Client not initialized");
			newAgent = await this.plugin.client.agents.create(agentBody);
			console.log("[Letta Plugin] Agent created successfully:", newAgent);
		} catch (error: any) {
			console.error(
				"[Letta Plugin] Agent creation failed with error:",
				error,
			);
			console.error("[Letta Plugin] Error details:", {
				status: error.status,
				message: error.message,
				responseText: error.responseText,
				responseJson: error.responseJson,
				url: `${this.plugin.settings.lettaBaseUrl}/v1/agents`,
				method: "POST",
				body: agentBody,
			});
			throw error;
		}

		// Update plugin state with the new agent
		this.plugin.agent = { id: newAgent.id, name: newAgent.name };

		// Update settings with the new agent
		this.plugin.settings.agentId = newAgent.id;
		this.plugin.settings.agentName = agentConfig.name;

		// Update project settings if we selected a project
		if (selectedProject) {
			this.plugin.settings.lettaProjectSlug = selectedProject.slug;
			console.log(
				"[Letta Plugin] Updated project settings to:",
				selectedProject.slug,
			);
		}

		await this.plugin.saveSettings();
	}

	removeNoAgentMessage() {
		if (!this.chatContainer) {
			return;
		}

		const existingMessage = this.chatContainer.querySelector(
			".letta-no-agent-container",
		);
		if (existingMessage) {
			existingMessage.remove();
		}
	}

	openInADE() {
		if (!this.plugin.agent) {
			new Notice("Please connect to Letta first");
			return;
		}

		// Construct the ADE URL for the current agent
		const adeUrl = `https://app.letta.com/agents/${this.plugin.agent?.id}`;

		// Open in external browser
		window.open(adeUrl, "_blank");

		new Notice("Opening agent in Letta ADE...");
	}


	async editAgentName() {
		if (!this.plugin.agent) {
			new Notice("Please connect to Letta first");
			return;
		}

		const currentName = this.plugin.settings.agentName;
		const newName = await this.promptForAgentName(currentName);

		if (newName && newName !== currentName) {
			try {
				// Update agent name via API
				await this.plugin.makeRequest(
					`/v1/agents/${this.plugin.agent?.id}`,
					{
						method: "PATCH",
						body: { name: newName },
					},
				);

				// Update settings
				this.plugin.settings.agentName = newName;
				await this.plugin.saveSettings();

				// Update UI
				this.updateAgentNameDisplay();
				this.plugin.agent.name = newName;

				new Notice(`Agent name updated to: ${newName}`);
			} catch (error) {
				console.error("Failed to update agent name:", error);
				new Notice("Failed to update agent name. Please try again.");
			}
		}
	}

	private promptForAgentName(currentName: string): Promise<string | null> {
		return new Promise((resolve) => {
			const modal = new Modal(this.app);
			modal.setTitle("Edit Agent Name");

			const { contentEl } = modal;
			contentEl.createEl("p", {
				text: "Enter a new name for your agent:",
			});

			const input = contentEl.createEl("input", {
				type: "text",
				value: currentName,
				cls: "config-input",
			});
			input.style.width = "100%";
			input.style.marginBottom = "16px";

			const buttonContainer = contentEl.createEl("div");
			buttonContainer.style.display = "flex";
			buttonContainer.style.gap = "8px";
			buttonContainer.style.justifyContent = "flex-end";

			const saveButton = buttonContainer.createEl("button", {
				text: "Save",
				cls: "mod-cta",
			});

			const cancelButton = buttonContainer.createEl("button", {
				text: "Cancel",
			});

			saveButton.addEventListener("click", () => {
				const newName = input.value.trim();
				if (newName) {
					resolve(newName);
					modal.close();
				}
			});

			cancelButton.addEventListener("click", () => {
				resolve(null);
				modal.close();
			});

			input.addEventListener("keydown", (e) => {
				if (e.key === "Enter") {
					const newName = input.value.trim();
					if (newName) {
						resolve(newName);
						modal.close();
					}
				}
				if (e.key === "Escape") {
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
					new Notice("Please configure your Letta connection first");
					return;
				}
			} catch (error) {
				new Notice(
					"Failed to connect to Letta. Please check your settings.",
				);
				return;
			}
		}

		if (!this.plugin.client) throw new Error("Client not initialized");

		// Get current agent details and blocks
		const [agentDetails, blocks] = await Promise.all([
			this.plugin.makeRequest(`/v1/agents/${this.plugin.agent!.id}`),
			this.plugin.makeRequest(
				`/v1/agents/${this.plugin.agent!.id}/core-memory/blocks`,
			),
		]);

		const modal = new AgentPropertyModal(
			this.app,
			agentDetails,
			blocks,
			async (updatedConfig) => {
				try {
					// Extract block updates from config
					const { blockUpdates, ...agentConfig } = updatedConfig;

					// Update agent properties if any changed
					if (Object.keys(agentConfig).length > 0) {
						await this.plugin.makeRequest(
							`/v1/agents/${this.plugin.agent?.id}`,
							{
								method: "PATCH",
								body: agentConfig,
							},
						);
					}

					// Update blocks if any changed
					if (blockUpdates && blockUpdates.length > 0) {
						await Promise.all(
							blockUpdates.map(async (blockUpdate: any) => {
								await this.plugin.makeRequest(
									`/v1/agents/${this.plugin.agent?.id}/core-memory/blocks/${blockUpdate.label}`,
									{
										method: "PATCH",
										body: { value: blockUpdate.value },
									},
								);
							}),
						);
					}

					// Update local agent reference and settings
					if (
						agentConfig.name &&
						agentConfig.name !== this.plugin.settings.agentName
					) {
						this.plugin.settings.agentName = agentConfig.name;
						await this.plugin.saveSettings();
						this.updateAgentNameDisplay();
						if (this.plugin.agent) {
							this.plugin.agent.name = agentConfig.name;
						}
					}

					const hasAgentChanges = Object.keys(agentConfig).length > 0;
					const hasBlockChanges =
						blockUpdates && blockUpdates.length > 0;

					if (hasAgentChanges && hasBlockChanges) {
						new Notice(
							"Agent configuration and memory blocks updated successfully",
						);
					} else if (hasAgentChanges) {
						new Notice("Agent configuration updated successfully");
					} else if (hasBlockChanges) {
						new Notice("Memory blocks updated successfully");
					}
				} catch (error) {
					console.error(
						"Failed to update agent configuration:",
						error,
					);
					new Notice(
						"Failed to update agent configuration. Please try again.",
					);
				}
			},
		);

		modal.open();
	}

	showSizeLimitWarning(file: TFile, actualSize: number, limit: number): void {
		if (!this.sizeLimitWarning) return;

		const warningContent = `
			<div class="letta-size-warning-icon">⚠️</div>
			<div class="letta-size-warning-text">
				<strong>Note too large for agent to view</strong><br>
				File: ${file.basename}<br>
				Size: ${actualSize.toLocaleString()} characters (limit: ${limit.toLocaleString()})<br>
				<small>Increase the character limit in settings to view larger files</small>
			</div>
		`;

		this.sizeLimitWarning.innerHTML = warningContent;
		this.sizeLimitWarning.style.display = "block";

		// Auto-hide after 10 seconds
		setTimeout(() => {
			if (this.sizeLimitWarning) {
				this.sizeLimitWarning.style.display = "none";
			}
		}, 10000);
	}

	async sendMessage() {
		const message = this.messageInput.value.trim();
		if (!message) return;

		// Check connection and auto-connect if needed
		if (!this.plugin.agent) {
			// Show connecting status in the chat view
			await this.updateChatStatus(false, "Connecting to Letta...");

			const connected = await this.plugin.connectToLetta(1, (progressMessage) => {
				// Update the connecting status with progress messages
				this.updateChatStatus(false, progressMessage);
			});

			if (!connected) {
				// Connection failed, show no agent/disconnected state
				await this.updateChatStatus(false);
				await this.addMessage(
					"assistant",
					"**Connection failed**. Please check your settings and try again.",
					"Error",
				);
				return;
			} else {
				// Connection succeeded, update status to reflect current state
				await this.updateChatStatus(false);
			}
		}

		// Check if agent is attached after connection
		if (!this.plugin.agent) {
			await this.addMessage(
				"assistant",
				"**No agent selected**. Please select an agent to start chatting.",
				"System",
			);
			return;
		}

		// Disable input while processing
		this.messageInput.disabled = true;
		this.sendButton.disabled = true;
		this.sendButton.textContent = "Sending...";
		this.sendButton.addClass("letta-button-loading");

		// Add user message to chat
		await this.addMessage("user", message);

		// Clear and reset input
		this.messageInput.value = "";
		this.messageInput.style.height = "auto";

		try {
			if (this.plugin.settings.enableStreaming) {
				// Use streaming API for real-time responses
				// Sending message via streaming API

				// Complete any existing streaming message before starting new one
				if (this.currentAssistantMessageEl) {
					// Completing existing streaming message before new message
					this.markStreamingComplete();
					// Clear state but preserve DOM elements
					this.currentReasoningContent = "";
					this.assistantReasoningContent = "";
					this.currentAssistantContent = "";
					this.currentAssistantMessageEl = null;
					this.currentReasoningMessageEl = null;
					this.currentToolMessageEl = null;
					this.currentToolCallId = null;
					this.currentToolCallArgs = "";
					this.currentToolCallName = "";
					this.currentToolCallData = null;
					this.currentApprovalRequestId = null;
					this.currentApprovalArgs = "";
					this.currentApprovalToolName = "";
					this.hasCreatedApprovalUI = false;
				}

				// Reset streaming state (now safe since we completed above)
				this.resetStreamingState();

				await this.plugin.sendMessageToAgentStream(
					message,
					async (message) => {
						// Handle each streaming message
						await this.processStreamingMessage(message);
					},
					async (error) => {
						// Handle streaming error
						console.error("Streaming error:", error);

						// Check if it's a CORS error and trigger fallback
						if (
							error.message &&
							error.message.includes("CORS_ERROR")
						) {
							console.log(
								"[Letta Plugin] CORS error detected, triggering fallback to non-streaming API",
							);
							// Don't show error message - let the fallback handle it
							throw error; // This will be caught by the outer catch block and trigger fallback
						}
						// Check if it's a rate limiting error and handle it specially
						else if (
							error.message &&
							error.message.includes("HTTP 429")
						) {
							console.log(
								"[Letta Plugin] Rate limit error detected, showing specialized message",
							);
							const rateLimitContent = RATE_LIMIT_MESSAGE.create(
								error.message,
							);
							console.log(
								"[Letta Plugin] Rate limit message content:",
								rateLimitContent,
							);
							// Create the proper rate limit message format that includes billing link
							this.addRateLimitMessage(rateLimitContent);
						} else {
							await this.addMessage(
								"assistant",
								`**Streaming Error**: ${error.message}`,
								"Error",
							);
						}
					},
					() => {
						// Handle streaming completion
						// Streaming completed
						this.markStreamingComplete();
					},
				);
			} else {
				// Use non-streaming API for more stable responses
				// Sending message via non-streaming API
				const messages = await this.plugin.sendMessageToAgent(message);
				await this.processNonStreamingMessages(messages);
			}
		} catch (error: any) {
			console.error("Failed to send message:", error);

			// Try fallback to non-streaming API if streaming was enabled and fails with CORS or network issues
			if (
				this.plugin.settings.enableStreaming &&
				(error.message.includes("CORS_ERROR") ||
					error.message.includes("stream") ||
					error.message.includes("fetch") ||
					error.message.includes("network"))
			) {
				if (error.message.includes("CORS_ERROR")) {
					console.log(
						"[Letta Plugin] Streaming blocked by CORS, falling back to non-streaming API",
					);
				} else {
					console.log(
						"[Letta Plugin] Streaming failed, trying non-streaming fallback",
					);
				}

				try {
					const messages =
						await this.plugin.sendMessageToAgent(message);
					await this.processNonStreamingMessages(messages);
					return; // Success with fallback
				} catch (fallbackError: any) {
					console.error("Fallback also failed:", fallbackError);
					error = fallbackError; // Use the fallback error for error handling
				}
			}

			// Provide specific error messages for common issues
			let errorMessage = `**Error**: ${error.message}`;

			if (
				error.message.includes("429") ||
				error.message.includes("Rate limited")
			) {
				// Use the special rate limit message display instead of regular error message
				const reason = error.message.includes("model-unknown")
					? "Unknown model configuration"
					: "Too many requests";
				const rateLimitContent = RATE_LIMIT_MESSAGE.create(reason);
				console.log(
					"[Letta Plugin] Non-streaming rate limit message content:",
					rateLimitContent,
				);
				this.addRateLimitMessage(rateLimitContent);
				return; // Return early to avoid showing regular error message
			} else if (
				error.message.includes("401") ||
				error.message.includes("Unauthorized")
			) {
				errorMessage = `**Authentication Error**\n\nYour API key may be invalid or expired. Please check your settings.\n\n*${error.message}*`;
			} else if (
				error.message.includes("403") ||
				error.message.includes("Forbidden")
			) {
				errorMessage = `**Access Denied**\n\nYou don't have permission to access this resource. Please check your account permissions.\n\n*${error.message}*`;
			} else if (
				error.message.includes("500") ||
				error.message.includes("Internal Server Error")
			) {
				errorMessage = `**Server Error**\n\nLetta's servers are experiencing issues. Please try again in a few moments.\n\n*${error.message}*`;
			} else {
				errorMessage +=
					"\n\nPlease check your connection and try again.";
			}

			await this.addMessage("assistant", errorMessage, "Error");
		} finally {
			// Re-enable input
			this.messageInput.disabled = false;
			this.sendButton.disabled = false;
			this.sendButton.textContent = "Send";
			this.sendButton.removeClass("letta-button-loading");
			this.messageInput.focus();
		}
	}

	// Clean up wavy lines and prominent styling from previous tool calls
	cleanupPreviousToolCalls() {
		// Remove wavy lines and prominent styling from all previous tool calls
		const allWavyLines =
			this.chatContainer.querySelectorAll(".letta-tool-curve");
		allWavyLines.forEach((line) => line.remove());

		const allProminentHeaders = this.chatContainer.querySelectorAll(
			".letta-tool-prominent",
		);
		allProminentHeaders.forEach((header) =>
			header.removeClass("letta-tool-prominent"),
		);
	}

	addToolInteractionMessage(
		reasoning: string,
		toolCall: string,
	): HTMLElement {
		// Clean up previous tool calls when a new one starts
		this.cleanupPreviousToolCalls();

		// Parse tool call to extract tool name
		let toolName = "Tool Call";
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
		const messageEl = this.chatContainer.createEl("div", {
			cls: "letta-message letta-message-tool-interaction",
		});

		// Create bubble wrapper
		const bubbleEl = messageEl.createEl("div", {
			cls: "letta-message-bubble",
		});

		// Add timestamp
		const timestamp = new Date().toLocaleTimeString([], {
			hour: "2-digit",
			minute: "2-digit",
		});

		// Header with timestamp
		const headerEl = bubbleEl.createEl("div", {
			cls: "letta-message-header",
		});
		const leftSide = headerEl.createEl("div", {
			cls: "letta-message-header-left",
		});
		leftSide.createEl("span", {
			cls: "letta-message-title",
			text: "Tool Usage",
		});
		leftSide.createEl("span", {
			cls: "letta-message-timestamp",
			text: timestamp,
		});

		// Reasoning content (only visible if setting is enabled)
		if (reasoning && this.plugin.settings.showReasoning) {
			const reasoningEl = bubbleEl.createEl("div", {
				cls: "letta-tool-reasoning",
			});

			// Enhanced markdown-like formatting for reasoning
			let formattedReasoning = reasoning
				// Trim leading and trailing whitespace first
				.trim()
				// Normalize multiple consecutive newlines to double newlines
				.replace(/\n{3,}/g, "\n\n")
				// Handle headers (must be done before other formatting)
				.replace(/^### (.+)$/gm, "<h3>$1</h3>")
				.replace(/^## (.+)$/gm, "<h2>$1</h2>")
				.replace(/^# (.+)$/gm, "<h1>$1</h1>")
				// Handle bold and italic
				.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
				.replace(/\*(.*?)\*/g, "<em>$1</em>")
				.replace(/`([^`]+)`/g, "<code>$1</code>")
				// Handle numbered lists (1. 2. 3. etc.)
				.replace(
					/^(\d+)\.\s+(.+)$/gm,
					'<li class="numbered-list">$2</li>',
				)
				// Handle bullet lists (•, -, *)
				.replace(/^[•*-]\s+(.+)$/gm, "<li>$1</li>")
				// Handle double newlines as paragraph breaks first
				.replace(/\n\n/g, "</p><p>")
				// Convert remaining single newlines to <br> tags
				.replace(/\n/g, "<br>");

			// Wrap consecutive numbered list items in <ol> tags
			formattedReasoning = formattedReasoning.replace(
				/(<li class="numbered-list">.*?<\/li>)(\s*<br>\s*<li class="numbered-list">.*?<\/li>)*/g,
				(match) => {
					// Remove the <br> tags between numbered list items and wrap in <ol>
					const cleanMatch = match.replace(/<br>\s*/g, "");
					return "<ol>" + cleanMatch + "</ol>";
				},
			);

			// Wrap consecutive regular list items in <ul> tags
			formattedReasoning = formattedReasoning.replace(
				/(<li>(?!.*class="numbered-list").*?<\/li>)(\s*<br>\s*<li>(?!.*class="numbered-list").*?<\/li>)*/g,
				(match) => {
					// Remove the <br> tags between list items and wrap in <ul>
					const cleanMatch = match.replace(/<br>\s*/g, "");
					return "<ul>" + cleanMatch + "</ul>";
				},
			);

			// Wrap in paragraphs if needed
			if (
				formattedReasoning.includes("</p><p>") &&
				!formattedReasoning.startsWith("<")
			) {
				formattedReasoning = "<p>" + formattedReasoning + "</p>";
			}

			reasoningEl.innerHTML = formattedReasoning;
		}

		// Normal expandable display for all tools
		const toolCallHeader = bubbleEl.createEl("div", {
			cls: "letta-expandable-header letta-tool-section letta-tool-prominent",
		});

		// Left side with tool name and loading
		const toolLeftSide = toolCallHeader.createEl("div", {
			cls: "letta-tool-left",
		});
		const toolTitle = toolLeftSide.createEl("span", {
			cls: "letta-expandable-title letta-tool-name",
			text: toolName,
		});

		// No loading indicator - just the wavy line animation shows loading state

		// Curvy connecting line (SVG) - continuous flowing wave
		const connectionLine = toolCallHeader.createEl("div", {
			cls: "letta-tool-connection",
		});
		const svg = document.createElementNS(
			"http://www.w3.org/2000/svg",
			"svg",
		);
		svg.setAttribute("viewBox", "0 0 400 12");
		svg.setAttribute("preserveAspectRatio", "none");
		svg.setAttribute("class", "letta-tool-curve");

		const path = document.createElementNS(
			"http://www.w3.org/2000/svg",
			"path",
		);
		path.setAttribute(
			"d",
			"M 0,6 Q 12.5,2 25,6 Q 37.5,10 50,6 Q 62.5,2 75,6 Q 87.5,10 100,6 Q 112.5,2 125,6 Q 137.5,10 150,6 Q 162.5,2 175,6 Q 187.5,10 200,6 Q 212.5,2 225,6 Q 237.5,10 250,6 Q 262.5,2 275,6 Q 287.5,10 300,6 Q 312.5,2 325,6 Q 337.5,10 350,6 Q 362.5,2 375,6 Q 387.5,10 400,6 Q 412.5,2 425,6 Q 437.5,10 450,6",
		);
		path.setAttribute("stroke", "var(--interactive-accent)");
		path.setAttribute("stroke-width", "1.5");
		path.setAttribute("fill", "none");
		path.setAttribute("opacity", "0.7");

		svg.appendChild(path);
		connectionLine.appendChild(svg);

		// Right side with circle indicator
		const toolRightSide = toolCallHeader.createEl("div", {
			cls: "letta-tool-right",
		});
		const toolCallChevron = toolRightSide.createEl("span", {
			cls: "letta-expandable-chevron letta-tool-circle",
			text: "○",
		});

		const toolCallContent = bubbleEl.createEl("div", {
			cls: "letta-expandable-content letta-expandable-collapsed",
		});
		const toolCallPre = toolCallContent.createEl("pre", {
			cls: "letta-code-block",
		});

		// Extract and pretty-print just the arguments from the tool call
		let displayContent = toolCall;
		try {
			const toolCallObj = JSON.parse(toolCall);
			if (toolCallObj.arguments) {
				// Parse the arguments if they're a string, otherwise use directly
				let args = toolCallObj.arguments;
				if (typeof args === "string") {
					args = JSON.parse(args);
				}
				displayContent = JSON.stringify(args, null, 2);
			}
		} catch (e) {
			// If parsing fails, fall back to the original content
		}

		const codeEl = toolCallPre.createEl("code", { text: displayContent });
		// Store the tool name in a data attribute for reliable parsing
		codeEl.setAttribute("data-tool-name", toolName);

		// Add click handler for tool call expand/collapse
		toolCallHeader.addEventListener("click", () => {
			const isCollapsed = toolCallContent.classList.contains(
				"letta-expandable-collapsed",
			);
			if (isCollapsed) {
				toolCallContent.removeClass("letta-expandable-collapsed");
				toolCallChevron.textContent = "●";
			} else {
				toolCallContent.addClass("letta-expandable-collapsed");
				toolCallChevron.textContent = "○";
			}
		});

		// Tool result placeholder (will be filled later)
		const toolResultHeader = bubbleEl.createEl("div", {
			cls: "letta-expandable-header letta-tool-section letta-tool-result-pending",
		});
		toolResultHeader.addClass("letta-tool-result-hidden");
		const toolResultTitle = toolResultHeader.createEl("span", {
			cls: "letta-expandable-title",
			text: "Tool Result",
		});
		const toolResultChevron = toolResultHeader.createEl("span", {
			cls: "letta-expandable-chevron letta-tool-circle",
			text: "○",
		});

		const toolResultContent = bubbleEl.createEl("div", {
			cls: "letta-expandable-content letta-expandable-collapsed",
		});
		toolResultContent.addClass("letta-tool-content-hidden");

		// Auto-scroll to bottom
		setTimeout(() => {
			this.chatContainer.scrollTo({
				top: this.chatContainer.scrollHeight,
				behavior: "smooth",
			});
		}, 10);

		return messageEl;
	}

	async addToolResultToMessage(
		messageEl: HTMLElement,
		toolResult: string,
		toolName?: string,
		toolCallData?: any,
	) {
		const bubbleEl = messageEl.querySelector(".letta-message-bubble");
		if (!bubbleEl) return;

		// Loading state was shown by wavy line animation only (no text indicator)

		// Remove wavy line animation now that tool call is complete
		const wavyLine = bubbleEl.querySelector(".letta-tool-curve");
		if (wavyLine) {
			wavyLine.remove();
		}

		// Remove prominent styling from tool call header now that it's complete
		const toolCallHeader = bubbleEl.querySelector(".letta-tool-prominent");
		if (toolCallHeader) {
			toolCallHeader.removeClass("letta-tool-prominent");
		}

		// Detect tool type - use provided toolName and toolCallData if available, otherwise parse from DOM
		let isArchivalMemorySearch = false;
		let isArchivalMemoryInsert = false;
		let isObsidianNoteProposal = false;
		let effectiveToolCallData = toolCallData;

		if (toolName) {
			// Use provided tool name (for historical messages)
			isArchivalMemorySearch = toolName === "archival_memory_search";
			isArchivalMemoryInsert = toolName === "archival_memory_insert";
			isObsidianNoteProposal = toolName === "propose_obsidian_note";
		} else {
			// Parse from DOM (for streaming messages)
			try {
				const toolCallPre = bubbleEl.querySelector(
					".letta-code-block code",
				);
				if (toolCallPre) {
					// First try to get tool name from data attribute (more reliable)
					const detectedToolName = toolCallPre.getAttribute("data-tool-name");
					console.log("[Letta Plugin] DOM parsing - data-tool-name:", detectedToolName);
					if (detectedToolName) {
						isArchivalMemorySearch = detectedToolName === "archival_memory_search";
						isArchivalMemoryInsert = detectedToolName === "archival_memory_insert";
						isObsidianNoteProposal = detectedToolName === "propose_obsidian_note";
					} else {
						// Fallback to parsing from content (legacy)
						effectiveToolCallData = JSON.parse(
							toolCallPre.textContent || "{}",
						);
						const fallbackToolName =
							effectiveToolCallData.name ||
							(effectiveToolCallData.function &&
								effectiveToolCallData.function.name);
						isArchivalMemorySearch =
							fallbackToolName === "archival_memory_search";
						isArchivalMemoryInsert =
							fallbackToolName === "archival_memory_insert";
						isObsidianNoteProposal =
							fallbackToolName === "propose_obsidian_note";
					}
				}
			} catch (e) {
				// Ignore parsing errors
			}
		}

		// Fallback detection: check tool result content for note proposals
		if (!isObsidianNoteProposal) {
			try {
				const parsedResult = JSON.parse(toolResult);
				if (parsedResult.action === "create_note" && parsedResult.title && parsedResult.content) {
					console.log("[Letta Plugin] 🔍 Fallback detection: Found note proposal in tool result!");
					isObsidianNoteProposal = true;
				}
			} catch (e) {
				// Not JSON or not a note proposal, continue normally
			}
		}

		// Debug logging for tool detection
		console.log("[Letta Plugin] Tool detection results:", {
			toolName,
			detectedFromDOM: !toolName,
			isArchivalMemorySearch,
			isArchivalMemoryInsert,
			isObsidianNoteProposal,
			toolResultPreview: toolResult.substring(0, 100) + "..."
		});


		// Show the tool result section
		const toolResultHeader = bubbleEl.querySelector(
			".letta-tool-result-pending",
		) as HTMLElement;
		const toolResultContent = bubbleEl.querySelector(
			".letta-expandable-content:last-child",
		) as HTMLElement;

		if (toolResultHeader && toolResultContent) {
			// Format the result and get a preview
			const formattedResult = this.formatToolResult(toolResult);

			// Always use "Tool Result" as the label (don't show content preview)
			const toolResultTitle = toolResultHeader.querySelector(
				".letta-expandable-title",
			);
			if (toolResultTitle) {
				toolResultTitle.textContent = "Tool Result";
			}

			// Make visible
			toolResultHeader.removeClass("letta-tool-result-hidden");
			toolResultHeader.addClass("letta-tool-result-visible");
			toolResultContent.removeClass("letta-tool-content-hidden");
			toolResultContent.addClass("letta-tool-content-visible");
			toolResultHeader.removeClass("letta-tool-result-pending");

			// Handle special tool types
			if (isArchivalMemorySearch) {
				this.createArchivalMemoryDisplay(toolResultContent, toolResult);
			} else if (isArchivalMemoryInsert) {
				this.createArchivalMemoryInsertDisplay(
					toolResultContent,
					effectiveToolCallData,
					toolResult,
				);
			} else if (isObsidianNoteProposal) {
				// Show pretty note preview instead of raw JSON for note proposals
				this.createNotePreviewDisplay(toolResultContent, toolResult);
			} else {
				// Add full content to expandable section for other tools
				const toolResultDiv = toolResultContent.createEl("div", {
					cls: "letta-tool-result-text",
					text: formattedResult,
				});
			}

			// Add click handler for tool result expand/collapse
			const toolResultChevron = toolResultHeader.querySelector(
				".letta-expandable-chevron",
			);
			toolResultHeader.addEventListener("click", () => {
				const isCollapsed = toolResultContent.classList.contains(
					"letta-expandable-collapsed",
				);
				if (isCollapsed) {
					toolResultContent.removeClass("letta-expandable-collapsed");
					if (toolResultChevron) toolResultChevron.textContent = "●";
				} else {
					toolResultContent.addClass("letta-expandable-collapsed");
					if (toolResultChevron) toolResultChevron.textContent = "○";
				}
			});

			// Post-processing enhancement for note proposals
			if (isObsidianNoteProposal) {
				console.log("[Letta Plugin] 🎯 Note proposal detected! Starting enhancement...");
				setTimeout(async () => {
					try {
						await this.enhanceNoteProposalDisplay(toolResultContent, toolResult);
					} catch (error) {
						console.error("[Letta Plugin] ❌ Error during note proposal enhancement:", error);
					}
				}, 10); // Reduced delay for faster appearance
			}
		}

		// Auto-scroll to bottom
		setTimeout(() => {
			this.chatContainer.scrollTo({
				top: this.chatContainer.scrollHeight,
				behavior: "smooth",
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

				if (
					parsedString.startsWith("(") &&
					parsedString.endsWith(")")
				) {
					// Extract array from Python tuple: ([...], count) -> [...]
					const innerContent = parsedString.slice(1, -1);
					const match = innerContent.match(/^(.+),\s*(\d+)$/);

					if (match) {
						const arrayString = match[1];
						// Extract memory items manually from Python dict format
						const dictPattern =
							/\{'timestamp':\s*'([^']+)',\s*'content':\s*'((?:[^'\\]|\\.)*)'\}/g;
						const memoryItems = [];
						let dictMatch;

						while (
							(dictMatch = dictPattern.exec(arrayString)) !== null
						) {
							const timestamp = dictMatch[1];
							const content = dictMatch[2]
								.replace(/\\'/g, "'")
								.replace(/\\n/g, "\n")
								.replace(/\\t/g, "\t")
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
			} else if (rawContent.startsWith("(") && rawContent.endsWith(")")) {
				// Handle direct Python tuple format
				const innerContent = rawContent.slice(1, -1);
				const match = innerContent.match(/^(.+),\s*(\d+)$/);
				if (match) {
					let arrayString = match[1];
					arrayString = arrayString
						.replace(/None/g, "null")
						.replace(/True/g, "true")
						.replace(/False/g, "false")
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
				const memoryList = container.createEl("div", {
					cls: "letta-memory-list",
				});

				// Filter out non-memory items (like count at the end)
				const memoryItems = result.filter(
					(item) =>
						typeof item === "object" &&
						item !== null &&
						(item.content || item.text || item.message),
				);

				memoryItems.forEach((item, index) => {
					// Create expandable memory item
					const memoryItem = memoryList.createEl("div", {
						cls: "letta-memory-item",
					});

					// Extract content and timestamp
					const content =
						item.content || item.text || item.message || "";
					const timestamp = item.timestamp || "";

					// Create expandable header
					const itemHeader = memoryItem.createEl("div", {
						cls: "letta-memory-item-header letta-expandable-header",
					});

					// Add expand/collapse indicator
					const chevron = itemHeader.createEl("span", {
						cls: "letta-expandable-chevron",
						text: "○",
					});

					// Add memory item title with timestamp
					const titleText = "";

					itemHeader.createEl("span", {
						cls: "letta-memory-title",
						text: titleText,
					});

					// Add preview of content (first 80 characters)
					const preview =
						content.length > 80
							? content.substring(0, 80).trim() + "..."
							: content;

					itemHeader.createEl("span", {
						cls: "letta-memory-preview",
						text: preview,
					});

					// Create collapsible content area
					const itemContent = memoryItem.createEl("div", {
						cls: "letta-memory-content letta-expandable-content letta-expandable-collapsed",
					});

					// Apply markdown formatting to the full content
					let formattedContent = content
						.trim()
						.replace(/\n{3,}/g, "\n\n")
						// Handle headers
						.replace(/^### (.+)$/gm, "<h3>$1</h3>")
						.replace(/^## (.+)$/gm, "<h2>$1</h2>")
						.replace(/^# (.+)$/gm, "<h1>$1</h1>")
						// Handle bold and italic
						.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
						.replace(/\*(.*?)\*/g, "<em>$1</em>")
						.replace(/`([^`]+)`/g, "<code>$1</code>")
						// Handle bullet lists
						.replace(/^[•*-]\s+(.+)$/gm, "<li>$1</li>")
						// Convert line breaks to HTML
						.replace(/\n/g, "<br>");

					// Wrap consecutive list items in ul tags
					formattedContent = formattedContent.replace(
						/(<li>.*?<\/li>)(?:\s*<li>.*?<\/li>)*/g,
						(match: string) => {
							return "<ul>" + match + "</ul>";
						},
					);

					itemContent.innerHTML = formattedContent;

					// Add click handler for expand/collapse
					itemHeader.addEventListener("click", () => {
						const isCollapsed = itemContent.classList.contains(
							"letta-expandable-collapsed",
						);
						if (isCollapsed) {
							itemContent.removeClass(
								"letta-expandable-collapsed",
							);
							chevron.textContent = "●";
						} else {
							itemContent.addClass("letta-expandable-collapsed");
							chevron.textContent = "○";
						}
					});
				});

				// Add summary at the bottom
				if (memoryItems.length > 0) {
					const summary = container.createEl("div", {
						cls: "letta-memory-summary",
					});
					summary.createEl("span", {
						text: `Found ${memoryItems.length} memory item${memoryItems.length === 1 ? "" : "s"}`,
					});
				}
			} else if (result && typeof result === "object") {
				// Single item or different structure
				const singleItem = container.createEl("div", {
					cls: "letta-memory-single",
				});

				let content =
					result.content ||
					result.text ||
					result.message ||
					JSON.stringify(result, null, 2);
				let formattedContent = content
					.trim()
					.replace(/\n{3,}/g, "\n\n")
					.replace(/^### (.+)$/gm, "<h3>$1</h3>")
					.replace(/^## (.+)$/gm, "<h2>$1</h2>")
					.replace(/^# (.+)$/gm, "<h1>$1</h1>")
					.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
					.replace(/\*(.*?)\*/g, "<em>$1</em>")
					.replace(/`([^`]+)`/g, "<code>$1</code>")
					.replace(/\n/g, "<br>");

				singleItem.innerHTML = formattedContent;
			} else {
				// Fallback to raw display
				const fallback = container.createEl("div", {
					cls: "letta-tool-result-text",
				});
				fallback.textContent = toolResult;
			}
		} catch (e) {
			// If parsing fails, fall back to raw display
			const fallback = container.createEl("div", {
				cls: "letta-tool-result-text",
			});
			fallback.textContent = toolResult;
		}
	}

	createArchivalMemoryInsertDisplay(
		container: HTMLElement,
		toolCallData: any,
		toolResult: string,
	) {
		try {
			// Extract the content from the tool call arguments
			let memoryContent = "";

			if (toolCallData) {
				let args = null;

				// Try different argument formats
				if (toolCallData.arguments) {
					// Standard format: { arguments: "..." } or { arguments: {...} }
					if (typeof toolCallData.arguments === "string") {
						try {
							args = JSON.parse(toolCallData.arguments);
						} catch (e) {
							console.warn(
								"[Letta Plugin] Failed to parse arguments string:",
								toolCallData.arguments,
							);
						}
					} else {
						args = toolCallData.arguments;
					}
				} else if (
					toolCallData.function &&
					toolCallData.function.arguments
				) {
					// OpenAI format: { function: { arguments: "..." } }
					if (typeof toolCallData.function.arguments === "string") {
						try {
							args = JSON.parse(toolCallData.function.arguments);
						} catch (e) {
							console.warn(
								"[Letta Plugin] Failed to parse function arguments string:",
								toolCallData.function.arguments,
							);
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
				const header = container.createEl("div", {
					cls: "letta-memory-insert-header",
				});
				header.createEl("span", {
					cls: "letta-memory-insert-label",
					text: "Content stored in archival memory:",
				});

				// Create simple content area with markdown formatting
				const contentArea = container.createEl("div", {
					cls: "letta-memory-insert-content",
				});

				// Apply basic markdown formatting to the content
				let formattedContent = memoryContent
					.trim()
					.replace(/\n{3,}/g, "\n\n")
					// Handle headers
					.replace(/^### (.+)$/gm, "<h3>$1</h3>")
					.replace(/^## (.+)$/gm, "<h2>$1</h2>")
					.replace(/^# (.+)$/gm, "<h1>$1</h1>")
					// Handle bold and italic
					.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
					.replace(/\*(.*?)\*/g, "<em>$1</em>")
					.replace(/`([^`]+)`/g, "<code>$1</code>")
					// Convert line breaks to HTML
					.replace(/\n/g, "<br>");

				contentArea.innerHTML = formattedContent;
			} else {
				// Fallback if we can't extract the content
				const fallback = container.createEl("div", {
					cls: "letta-tool-result-text",
				});
				fallback.textContent = `Memory insert completed. Result: ${toolResult}`;
			}
		} catch (e) {
			console.error(
				"[Letta Plugin] Error creating archival memory insert display:",
				e,
			);
			// If parsing fails, fall back to raw display
			const fallback = container.createEl("div", {
				cls: "letta-tool-result-text",
			});
			fallback.textContent = `Memory insert completed. Result: ${toolResult}`;
		}
	}

	async createTempNoteForProposal(proposal: ObsidianNoteProposal): Promise<string> {
		console.log("[Letta Plugin] Creating temp note for proposal:", proposal);
		
		// Create .letta/temp directory if it doesn't exist
		const tempDir = ".letta/temp";
		let tempFolder = this.app.vault.getAbstractFileByPath(tempDir);
		console.log("[Letta Plugin] Temp folder check:", tempFolder ? "exists" : "does not exist");
		
		if (!tempFolder) {
			try {
				await this.app.vault.createFolder(tempDir);
				console.log(`[Letta Plugin] Created temp directory: ${tempDir}`);
			} catch (error: any) {
				console.log("[Letta Plugin] Error creating temp directory:", error);
				// Check if it's specifically a "folder already exists" error
				if (error.message && error.message.includes("Folder already exists")) {
					console.log(`[Letta Plugin] Temp directory already exists: ${tempDir}`);
					// Don't throw the error, just continue
				} else {
					console.error(`[Letta Plugin] Failed to create temp directory: ${error.message}`);
					throw error;
				}
			}
		} else {
			console.log(`[Letta Plugin] Using existing temp directory: ${tempDir}`);
		}

		// Generate simple filename without timestamp (can overwrite existing temp files)
		const sanitizedTitle = proposal.title.replace(/[\\/:*?"<>|]/g, "_");
		const tempFileName = `${sanitizedTitle}.md`;
		const tempPath = `${tempDir}/${tempFileName}`;
		console.log("[Letta Plugin] Generated temp path:", tempPath);

		// Create note content with tags as hashtags and metadata at bottom
		let content = proposal.content || "";
		
		// Add tags as hashtags at the bottom
		if (proposal.tags && proposal.tags.length > 0) {
			content += "\n\n";
			const tagString = `#lettamade ${proposal.tags.map(tag => `#${tag.toLowerCase().replace(/\s+/g, '-')}`).join(" ")}`;
			content += tagString;
		} else {
			content += "\n\n#lettamade";
		}
		
		// Add timestamp and agent info at the bottom
		const timestamp = new Date().toISOString();
		const agentId = this.plugin.agent?.id || "unknown";
		content += `\n\n<small>Created: ${timestamp} | Agent: \`${agentId}\`</small>`;
		
		console.log("[Letta Plugin] Generated content length:", content.length);

		// Create or overwrite temp file
		try {
			const existingFile = this.app.vault.getAbstractFileByPath(tempPath);
			let tempFile;
			
			if (existingFile) {
				// Overwrite existing temp file
				await this.app.vault.modify(existingFile as any, content);
				tempFile = existingFile;
				console.log(`[Letta Plugin] Successfully overwritten existing temp note: ${tempPath}`);
			} else {
				// Create new temp file
				tempFile = await this.app.vault.create(tempPath, content);
				console.log(`[Letta Plugin] Successfully created new temp note: ${tempPath}`);
			}
			
			return tempPath;
		} catch (error) {
			console.error("[Letta Plugin] Failed to create/update temp file:", error);
			throw error;
		}
	}

	async createNotePreviewDisplay(container: HTMLElement, toolResult: string) {
		try {
			console.log("[Letta Plugin] Creating note preview, raw toolResult:", toolResult);
			const firstParse = JSON.parse(toolResult);
			console.log("[Letta Plugin] First parse result:", firstParse);
			let proposal = firstParse;
			
			// Handle double-encoded JSON if needed (same logic as enhancement)
			if (typeof firstParse === 'string') {
				proposal = JSON.parse(firstParse);
				console.log("[Letta Plugin] Double-encoded JSON detected, reparsed:", proposal);
			} else if (firstParse.data) {
				proposal = firstParse.data;
				console.log("[Letta Plugin] Found data property:", proposal);
			} else if (firstParse.result) {
				proposal = firstParse.result;
				console.log("[Letta Plugin] Found result property:", proposal);
			} else if (firstParse.value) {
				proposal = firstParse.value;
				console.log("[Letta Plugin] Found value property:", proposal);
			}
			
			const finalProposal = proposal as ObsidianNoteProposal;
			console.log("[Letta Plugin] Final proposal object:", finalProposal);
			console.log("[Letta Plugin] Content check - proposal.content:", finalProposal.content);
			
			// Create preview container
			const preview = container.createEl("div", { cls: "letta-note-preview" });
			
			// Title
			const titleEl = preview.createEl("h2", {
				text: `📝 ${finalProposal.title}`,
				cls: "letta-note-preview-title"
			});
			
			// Tags
			if (finalProposal.tags && finalProposal.tags.length > 0) {
				const tagsContainer = preview.createEl("div", { cls: "letta-note-preview-tags" });
				finalProposal.tags.forEach(tag => {
					tagsContainer.createEl("span", {
						text: tag,
						cls: "letta-note-preview-tag"
					});
				});
			}
			
			// Content preview (render markdown)
			if (finalProposal.content) {
				console.log("[Letta Plugin] Content found, rendering...");
				const contentEl = preview.createEl("div", { cls: "letta-note-preview-content" });
				
				// Extract the main content (skip frontmatter)
				let displayContent = finalProposal.content;
				if (displayContent.startsWith('---')) {
					const parts = displayContent.split('---');
					if (parts.length >= 3) {
						displayContent = parts.slice(2).join('---').trim();
					}
				}
				console.log("[Letta Plugin] Display content after processing:", displayContent);
				
				// Render the markdown content
				await this.renderMarkdownContent(contentEl, displayContent);
			} else {
				console.log("[Letta Plugin] No content found in proposal");
				const noContentEl = preview.createEl("div", { 
					cls: "letta-note-preview-content",
					text: "⚠️ No content available for preview"
				});
				noContentEl.style.color = "var(--text-muted)";
				noContentEl.style.fontStyle = "italic";
			}
			
			// Folder info
			if (finalProposal.folder) {
				const folderEl = preview.createEl("div", {
					text: `📁 ${finalProposal.folder}`,
					cls: "letta-note-preview-folder"
				});
			}
			
		} catch (error) {
			console.error("Failed to create note preview:", error);
			// Fallback to regular text display
			const fallback = container.createEl("div", {
				cls: "letta-tool-result-text",
				text: toolResult
			});
		}
	}

	async enhanceNoteProposalDisplay(container: HTMLElement, toolResult: string) {
		console.log("[Letta Plugin] 🚀 enhanceNoteProposalDisplay called!");
		console.log("[Letta Plugin] Tool result to enhance:", toolResult);
		
		try {
			const firstParse = JSON.parse(toolResult);
			console.log("[Letta Plugin] First parse result:", firstParse);
			console.log("[Letta Plugin] First parse keys:", Object.keys(firstParse));
			console.log("[Letta Plugin] First parse type:", typeof firstParse);
			
			// Handle double-encoded JSON or wrapper objects
			let proposal = firstParse;
			
			// If it's still a string, parse it again
			if (typeof firstParse === 'string') {
				console.log("[Letta Plugin] Double-parsing JSON string...");
				proposal = JSON.parse(firstParse);
			} 
			// Check for common wrapper patterns
			else if (firstParse.data) {
				console.log("[Letta Plugin] Found data wrapper, using firstParse.data");
				proposal = firstParse.data;
			} else if (firstParse.result) {
				console.log("[Letta Plugin] Found result wrapper, using firstParse.result");
				proposal = firstParse.result;
			} else if (firstParse.value) {
				console.log("[Letta Plugin] Found value wrapper, using firstParse.value");
				proposal = firstParse.value;
			}
			
			console.log("[Letta Plugin] Final proposal:", proposal);
			console.log("[Letta Plugin] Final proposal keys:", Object.keys(proposal));
			console.log("[Letta Plugin] Final proposal.action:", proposal.action);
			
			// Type assertion for the final proposal
			const finalProposal = proposal as ObsidianNoteProposal;
			
			// Use more robust comparison
			const actionValue = finalProposal.action?.trim() || "";
			if (actionValue !== "create_note" && !actionValue.includes("create_note")) {
				console.log("[Letta Plugin] ❌ Proposal action is not 'create_note', skipping enhancement");
				console.log("[Letta Plugin] Expected: 'create_note', Got:", actionValue);
				return;
			}
			
			console.log("[Letta Plugin] ✅ Action check passed, continuing with enhancement...");

			// Create temp file for preview
			const tempPath = await this.createTempNoteForProposal(finalProposal);

			// Create enhancement container below the existing tool result
			const enhancement = container.createEl("div", { 
				cls: "letta-note-proposal-enhancement" 
			});

			// Create note proposal header
			const header = enhancement.createEl("div", { cls: "letta-note-proposal-header" });
			const titleEl = header.createEl("h3", { 
				text: `📝 ${finalProposal.title}`,
				cls: "letta-note-proposal-title" 
			});

			// Add folder info if specified
			if (finalProposal.folder) {
				header.createEl("div", {
					text: `📁 Folder: ${finalProposal.folder}`,
					cls: "letta-note-proposal-folder"
				});
			}

			// Add tags if specified
			if (finalProposal.tags && finalProposal.tags.length > 0) {
				const tagsEl = header.createEl("div", { cls: "letta-note-proposal-tags" });
				tagsEl.createEl("span", { text: "🏷️ Tags: " });
				finalProposal.tags.forEach((tag, index) => {
					const tagSpan = tagsEl.createEl("span", { 
						text: tag,
						cls: "letta-note-proposal-tag" 
					});
					if (index < finalProposal.tags!.length - 1) {
						tagsEl.createEl("span", { text: ", " });
					}
				});
			}

			// Click to open temp file  
			titleEl.style.cursor = "pointer";
			titleEl.addEventListener("click", async () => {
				try {
					const tempFile = this.app.vault.getAbstractFileByPath(tempPath);
					if (tempFile) {
						const leaf = this.app.workspace.getLeaf('tab');
						await leaf.openFile(tempFile as any);
					}
				} catch (error) {
					console.error("Failed to open temp file:", error);
				}
			});

			// Action buttons
			const buttonContainer = enhancement.createEl("div", { cls: "letta-note-proposal-buttons" });
			
			const acceptButton = buttonContainer.createEl("button", {
				text: "Accept",
				cls: "letta-button letta-button-accept"
			});
			
			const editButton = buttonContainer.createEl("button", {
				text: "Edit",
				cls: "letta-button letta-button-edit"
			});
			
			const rejectButton = buttonContainer.createEl("button", {
				text: "Reject", 
				cls: "letta-button letta-button-reject"
			});

			// Add button event handlers
			acceptButton.addEventListener("click", async () => {
				await this.acceptNoteProposal(enhancement, finalProposal, tempPath);
			});

			editButton.addEventListener("click", async () => {
				await this.editNoteProposal(enhancement, finalProposal, tempPath);
			});

			rejectButton.addEventListener("click", async () => {
				await this.rejectNoteProposal(enhancement, tempPath);
			});

			// Auto-expand the tool result section for note proposals
			// The container itself is the expandable content that might be collapsed
			if (container.classList.contains("letta-expandable-collapsed")) {
				container.removeClass("letta-expandable-collapsed");
				console.log("[Letta Plugin] Auto-expanded tool result section for note proposal");
				
				// Update the chevron indicator
				const parentBubble = container.closest(".letta-message-bubble");
				if (parentBubble) {
					const chevron = parentBubble.querySelector(".letta-expandable-chevron");
					if (chevron) {
						chevron.textContent = "●";
					}
				}
			}
			
			console.log("[Letta Plugin] ✅ Note proposal enhancement created successfully!");
			
		} catch (error) {
			console.error("[Letta Plugin] ❌ Failed to enhance note proposal display:", error);
		}
	}

	createNoteProposalDisplay(container: HTMLElement, toolResult: string, tempPath?: string | null) {
		try {
			const proposal = JSON.parse(toolResult) as ObsidianNoteProposal;
			
			// Create note proposal header
			const header = container.createEl("div", { cls: "letta-note-proposal-header" });
			const titleEl = header.createEl("h3", { 
				text: `📝 Note Proposal: ${proposal.title}`,
				cls: "letta-note-proposal-title" 
			});

			// Add folder info if specified
			if (proposal.folder) {
				header.createEl("div", {
					text: `📁 Folder: ${proposal.folder}`,
					cls: "letta-note-proposal-folder"
				});
			}

			// Add tags if specified
			if (proposal.tags && proposal.tags.length > 0) {
				const tagsEl = header.createEl("div", { cls: "letta-note-proposal-tags" });
				tagsEl.createEl("span", { text: "🏷️ Tags: " });
				proposal.tags.forEach((tag, index) => {
					const tagSpan = tagsEl.createEl("span", { 
						text: tag,
						cls: "letta-note-proposal-tag" 
					});
					if (index < proposal.tags!.length - 1) {
						tagsEl.createEl("span", { text: ", " });
					}
				});
			}

			// Content preview (scrollable)
			const contentContainer = container.createEl("div", { cls: "letta-note-proposal-content" });
			const contentHeader = contentContainer.createEl("div", { 
				text: "Content Preview:",
				cls: "letta-note-proposal-content-header" 
			});
			
			const contentArea = contentContainer.createEl("div", { cls: "letta-note-proposal-content-area" });
			const previewEl = contentArea.createEl("pre", { cls: "letta-note-proposal-preview" });
			previewEl.textContent = proposal.content;

			// Click to open temp file  
			const finalTempPath = tempPath || (() => {
				// Fallback calculation if tempPath wasn't provided
				const timestamp = new Date().toISOString().slice(0, 19).replace(/[:-]/g, "");
				const sanitizedTitle = proposal.title.replace(/[\\/:*?"<>|]/g, "_");
				return `.letta/temp/${sanitizedTitle}_${timestamp}.md`;
			})();
			
			titleEl.style.cursor = "pointer";
			titleEl.addEventListener("click", async () => {
				try {
					const tempFile = this.app.vault.getAbstractFileByPath(finalTempPath);
					if (tempFile) {
						const leaf = this.app.workspace.getLeaf('tab');
						await leaf.openFile(tempFile as any);
					}
				} catch (error) {
					console.error("Failed to open temp file:", error);
				}
			});

			// Action buttons
			const buttonContainer = container.createEl("div", { cls: "letta-note-proposal-buttons" });
			
			const acceptButton = buttonContainer.createEl("button", {
				text: "Accept",
				cls: "letta-button letta-button-accept"
			});
			
			const editButton = buttonContainer.createEl("button", {
				text: "Edit",
				cls: "letta-button letta-button-edit"
			});
			
			const rejectButton = buttonContainer.createEl("button", {
				text: "Reject", 
				cls: "letta-button letta-button-reject"
			});

			// Store proposal data for button handlers
			container.setAttribute("data-proposal", JSON.stringify(proposal));
			container.setAttribute("data-temp-path", finalTempPath);

			// Add button event handlers
			acceptButton.addEventListener("click", async () => {
				await this.acceptNoteProposal(container, proposal, finalTempPath);
			});

			editButton.addEventListener("click", async () => {
				await this.editNoteProposal(container, proposal, finalTempPath);
			});

			rejectButton.addEventListener("click", async () => {
				await this.rejectNoteProposal(container, finalTempPath);
			});

		} catch (error) {
			console.error("Failed to parse note proposal:", error);
			const fallback = container.createEl("div", {
				cls: "letta-tool-result-text",
				text: "Invalid note proposal format"
			});
		}
	}

	async acceptNoteProposal(container: HTMLElement, proposal: ObsidianNoteProposal, tempPath: string) {
		try {
			// Determine target path
			const sanitizedTitle = proposal.title.replace(/[\\/:*?"<>|]/g, "_");
			const fileName = `${sanitizedTitle}.md`;
			const folder = proposal.folder?.trim() || this.plugin.settings.defaultNoteFolder;
			const targetPath = folder ? `${folder}/${fileName}` : fileName;

			// Check if target path already exists
			const existingFile = this.app.vault.getAbstractFileByPath(targetPath);
			if (existingFile) {
				// Show error and keep temp file
				this.showNoteProposalError(container, `A file already exists at: ${targetPath}. Please ask the agent to choose a different name or location.`);
				return;
			}

			// Create target folder if needed
			if (folder) {
				const folderExists = this.app.vault.getAbstractFileByPath(folder);
				if (!folderExists) {
					await this.app.vault.createFolder(folder);
					console.log(`[Letta Plugin] Created folder: ${folder}`);
				}
			}

			// Get temp file and move it
			console.log("[Letta Plugin] Looking for temp file at path:", tempPath);
			const tempFile = this.app.vault.getAbstractFileByPath(tempPath);
			console.log("[Letta Plugin] Temp file found:", tempFile ? "yes" : "no");
			
			if (tempFile) {
				// Read content from temp file and create at target location
				const content = await this.app.vault.read(tempFile as any);
				console.log("[Letta Plugin] Read content from temp file, length:", content.length);
				const newFile = await this.app.vault.create(targetPath, content);

				// Delete temp file
				await this.app.vault.delete(tempFile as any);

				// Open the new file
				const leaf = this.app.workspace.getLeaf('tab');
				await leaf.openFile(newFile);

				// Update UI to show success
				this.showNoteProposalSuccess(container, `Note created: [[${proposal.title}]] at \`${targetPath}\``);

				console.log(`[Letta Plugin] Note accepted and created: ${targetPath}`);
			} else {
				console.error("[Letta Plugin] Temp file not found at:", tempPath);
				// Fallback: create the note directly from proposal content
				console.log("[Letta Plugin] Attempting fallback creation with proposal content");
				let content = proposal.content || "";
				
				// Add tags as hashtags at the bottom
				if (proposal.tags && proposal.tags.length > 0) {
					content += "\n\n";
					const tagString = `#lettamade ${proposal.tags.map(tag => `#${tag.toLowerCase().replace(/\s+/g, '-')}`).join(" ")}`;
					content += tagString;
				} else {
					content += "\n\n#lettamade";
				}
				
				// Add timestamp and agent info at the bottom
				const timestamp = new Date().toISOString();
				const agentId = this.plugin.agent?.id || "unknown";
				content += `\n\n<small>Created: ${timestamp} | Agent: \`${agentId}\`</small>`;
				
				const newFile = await this.app.vault.create(targetPath, content);
				
				// Open the new file
				const leaf = this.app.workspace.getLeaf('tab');
				await leaf.openFile(newFile);

				// Update UI to show success
				this.showNoteProposalSuccess(container, `Note created: [[${proposal.title}]] at \`${targetPath}\` (fallback)`);

				console.log(`[Letta Plugin] Note accepted and created via fallback: ${targetPath}`);
			}
		} catch (error) {
			console.error("Failed to accept note proposal:", error);
			this.showNoteProposalError(container, `Failed to create note: ${error.message}`);
		}
	}

	async editNoteProposal(container: HTMLElement, proposal: ObsidianNoteProposal, tempPath: string) {
		try {
			// Create and show the editing modal
			const modal = new NoteProposalModal(this.app, proposal, async (accepted: boolean, editedProposal?: ObsidianNoteProposal) => {
				if (accepted && editedProposal) {
					// Generate new temp path based on edited proposal
					const tempDir = ".letta/temp";
					const sanitizedTitle = editedProposal.title.replace(/[\\/:*?"<>|]/g, "_");
					const newTempPath = `${tempDir}/${sanitizedTitle}.md`;
					
					// Clean up original temp file and create new one
					await this.updateTempFileWithEditedProposal(tempPath, newTempPath, editedProposal);
					// Accept the edited proposal with new temp path
					await this.acceptNoteProposal(container, editedProposal, newTempPath);
				}
				// If not accepted, modal just closes without doing anything
			});
			modal.open();
		} catch (error) {
			console.error("Failed to open edit modal:", error);
			this.showNoteProposalError(container, `Failed to open editor: ${error.message}`);
		}
	}

	async updateTempFileWithEditedProposal(oldTempPath: string, newTempPath: string, proposal: ObsidianNoteProposal) {
		try {
			// Create updated content with the same format as createTempNoteForProposal
			let content = proposal.content || "";
			
			// Add tags as hashtags at the bottom
			if (proposal.tags && proposal.tags.length > 0) {
				content += "\n\n";
				const tagString = `#lettamade ${proposal.tags.map(tag => `#${tag.toLowerCase().replace(/\s+/g, '-')}`).join(" ")}`;
				content += tagString;
			} else {
				content += "\n\n#lettamade";
			}
			
			// Add timestamp and agent info at the bottom
			const timestamp = new Date().toISOString();
			const agentId = this.plugin.agent?.id || "unknown";
			content += `\n\n<small>Created: ${timestamp} | Agent: \`${agentId}\`</small>`;

			// Delete the original temp file if it exists
			const oldTempFile = this.app.vault.getAbstractFileByPath(oldTempPath);
			if (oldTempFile) {
				await this.app.vault.delete(oldTempFile as any);
				console.log("[Letta Plugin] Deleted original temp file");
			}
			
			// Try to modify existing file first, create if it doesn't exist
			const newTempFile = this.app.vault.getAbstractFileByPath(newTempPath);
			if (newTempFile) {
				// File exists, modify it
				await this.app.vault.modify(newTempFile as any, content);
				console.log("[Letta Plugin] Modified existing temp file with edited content");
			} else {
				// File doesn't exist in cache, try to create it
				try {
					await this.app.vault.create(newTempPath, content);
					console.log("[Letta Plugin] Created new temp file with edited content");
				} catch (createError: any) {
					if (createError.message && createError.message.includes("File already exists")) {
						// File exists but not in cache - try to get it and modify
						console.log("[Letta Plugin] File exists but not cached, attempting to modify");
						const existingFile = this.app.vault.getAbstractFileByPath(newTempPath);
						if (existingFile) {
							await this.app.vault.modify(existingFile as any, content);
							console.log("[Letta Plugin] Modified file that wasn't cached");
						} else {
							// Last resort - force delete and recreate
							try {
								await this.app.vault.adapter.remove(newTempPath);
								await this.app.vault.create(newTempPath, content);
								console.log("[Letta Plugin] Force deleted and recreated temp file");
							} catch (forceError) {
								console.error("[Letta Plugin] All recovery attempts failed:", forceError);
								throw forceError;
							}
						}
					} else {
						throw createError;
					}
				}
			}
		} catch (error) {
			console.error("Failed to update temp file:", error);
			throw error;
		}
	}

	async rejectNoteProposal(container: HTMLElement, tempPath: string) {
		try {
			// Delete temp file
			const tempFile = this.app.vault.getAbstractFileByPath(tempPath);
			if (tempFile) {
				await this.app.vault.delete(tempFile as any);
				console.log(`[Letta Plugin] Temp file deleted: ${tempPath}`);
			}

			// Update UI to show rejection
			this.showNoteProposalSuccess(container, "Note proposal rejected and temp file cleaned up");
		} catch (error) {
			console.error("Failed to reject note proposal:", error);
			this.showNoteProposalError(container, `Failed to clean up temp file: ${error.message}`);
		}
	}

	showNoteProposalSuccess(container: HTMLElement, message: string) {
		// Hide buttons and show success message
		const buttonContainer = container.querySelector(".letta-note-proposal-buttons");
		if (buttonContainer) {
			buttonContainer.remove();
		}

		const successEl = container.createEl("div", {
			cls: "letta-note-proposal-result letta-note-proposal-success",
			text: message
		});
	}

	showNoteProposalError(container: HTMLElement, message: string) {
		// Show error message but keep buttons visible for retry
		let errorContainer = container.querySelector(".letta-note-proposal-error");
		if (!errorContainer) {
			errorContainer = container.createEl("div", {
				cls: "letta-note-proposal-error"
			});
		}
		errorContainer.textContent = `⚠️ ${message}`;
	}

	async processNonStreamingMessages(messages: any[]) {
		// Processing non-streaming messages

		// Process response messages (fallback for when streaming fails)
		let tempReasoning = "";
		let tempToolMessage: HTMLElement | null = null;
		let tempToolName = "";
		let tempToolCallData: any = null;

		for (const responseMessage of messages) {
			// Handle system messages - capture system_alert for hidden viewing, skip heartbeats
			if (
				responseMessage.type === "system_alert" ||
				(responseMessage.message &&
					typeof responseMessage.message === "string" &&
					responseMessage.message.includes(
						"prior messages have been hidden",
					))
			) {
				// Capturing non-streaming system_alert message
				this.addSystemMessage(responseMessage);
				continue;
			}

			// Handle heartbeat messages - show typing indicator
			if (
				responseMessage.type === "heartbeat" ||
				responseMessage.message_type === "heartbeat" ||
				responseMessage.role === "heartbeat" ||
				(responseMessage.reason &&
					(responseMessage.reason.includes(
						"automated system message",
					) ||
						responseMessage.reason.includes(
							"Function call failed, returning control",
						) ||
						responseMessage.reason.includes(
							"request_heartbeat=true",
						)))
			) {
				this.handleHeartbeat();
				continue;
			}

			switch (responseMessage.message_type || responseMessage.messageType) {
				case "reasoning_message":
					if (responseMessage.reasoning) {
						// Accumulate reasoning for the next tool call or assistant message
						tempReasoning += responseMessage.reasoning;
					}
					break;
				case "usage_statistics":
					// Received non-streaming usage statistics
					this.addUsageStatisticsToLastMessage(responseMessage);
					break;
				case "tool_call_message":
					const toolCallData = responseMessage.tool_call || responseMessage.toolCall;
					if (toolCallData) {
						// Store tool information for later use
						tempToolName = toolCallData.name || 
							(toolCallData.function && toolCallData.function.name) || 
							"";
						tempToolCallData = toolCallData;
						
						console.log("[Letta Plugin] Non-streaming tool call detected:", tempToolName);
						if (tempToolName === "propose_obsidian_note") {
							console.log("[Letta Plugin] 🔥 PROPOSE_OBSIDIAN_NOTE detected in non-streaming!");
						}
						
						// Create tool interaction with reasoning
						tempToolMessage = this.addToolInteractionMessage(
							tempReasoning,
							JSON.stringify(toolCallData, null, 2),
						);
						// Clear reasoning after using it
						tempReasoning = "";
					}
					break;
				case "tool_return_message":
					const toolReturnData = responseMessage.tool_return || responseMessage.toolReturn;
					if (toolReturnData && tempToolMessage) {
						console.log("[Letta Plugin] Non-streaming tool return for tool:", tempToolName);
						if (tempToolName === "propose_obsidian_note") {
							console.log("[Letta Plugin] 🔥 PROPOSE_OBSIDIAN_NOTE tool return in non-streaming!", toolReturnData);
						}

						// Add tool result to the existing tool interaction message
						await this.addToolResultToMessage(
							tempToolMessage,
							JSON.stringify(
								toolReturnData,
								null,
								2,
							),
							tempToolName,
							tempToolCallData,
						);
						// Clear the temp tool message reference and data
						tempToolMessage = null;
						tempToolName = "";
						tempToolCallData = null;
					}
					break;
				case "approval_request_message":
					console.log("[Letta Plugin] Non-streaming approval request:", responseMessage);
					await this.handleApprovalRequest(responseMessage);
					break;
				case "assistant_message":
					// Processing assistant message

					// Try multiple possible content fields
					let content =
						responseMessage.content ||
						responseMessage.text ||
						responseMessage.message;

					// Handle array content by extracting text from array elements
					if (Array.isArray(content)) {
						content = content
							.map((item) => {
								if (typeof item === "string") {
									return item;
								} else if (item && typeof item === "object") {
									return (
										item.text ||
										item.content ||
										item.message ||
										item.value ||
										JSON.stringify(item)
									);
								}
								return String(item);
							})
							.join("");
						// Non-streaming: Converted array content to string
					}

					if (content) {
						// Filter out system prompt content and use accumulated reasoning
						const filteredContent =
							this.filterSystemPromptContent(content);
						await this.addMessage(
							"assistant",
							filteredContent,
							this.plugin.settings.agentName,
							tempReasoning || undefined,
						);
						// Clear temp reasoning after using it
						tempReasoning = "";
					} else {
						console.warn(
							"[Letta Plugin] Assistant message has no recognizable content field:",
							Object.keys(responseMessage),
						);
						// Fallback: display the whole message structure for debugging
						await this.addMessage(
							"assistant",
							`**Debug**: ${JSON.stringify(responseMessage, null, 2)}`,
							"Debug",
						);
					}
					break;

				case "heartbeat":
					// Skip heartbeat messages - should already be filtered above
					// Heartbeat message reached switch statement
					break;

				default:
					// Unrecognized message type

					// Fallback handling for messages without proper message_type
					if (
						responseMessage.content ||
						responseMessage.text ||
						responseMessage.message
					) {
						let content =
							responseMessage.content ||
							responseMessage.text ||
							responseMessage.message;

						// Handle array content by extracting text from array elements
						if (Array.isArray(content)) {
							content = content
								.map((item) => {
									if (typeof item === "string") {
										return item;
									} else if (
										item &&
										typeof item === "object"
									) {
										return (
											item.text ||
											item.content ||
											item.message ||
											item.value ||
											JSON.stringify(item)
										);
									}
									return String(item);
								})
								.join("");
							// Fallback: Converted array content to string
						}

						const filteredContent =
							this.filterSystemPromptContent(content);
						await this.addMessage(
							"assistant",
							filteredContent,
							this.plugin.settings.agentName,
						);
					} else {
						// Last resort: show the JSON structure for debugging
						console.warn(
							"[Letta Plugin] Message has no recognizable content, displaying as debug info",
						);
						await this.addMessage(
							"assistant",
							`**Debug**: Unknown message structure\n\`\`\`json\n${JSON.stringify(responseMessage, null, 2)}\n\`\`\``,
							"Debug",
						);
					}
					break;
			}
		}
	}

	async processStreamingMessage(message: any) {
		// Handle system messages - capture system_alert for hidden viewing, skip heartbeats
		if (
			message.type === "system_alert" ||
			(message.message &&
				typeof message.message === "string" &&
				message.message.includes("prior messages have been hidden"))
		) {
			// Capturing streaming system_alert message
			this.addSystemMessage(message);
			return;
		}

		// Handle heartbeat messages - show typing indicator
		if (
			message.type === "heartbeat" ||
			message.message_type === "heartbeat" ||
			message.messageType === "heartbeat" ||
			message.role === "heartbeat" ||
			(message.reason &&
				(message.reason.includes("automated system message") ||
					message.reason.includes(
						"Function call failed, returning control",
					) ||
					message.reason.includes("request_heartbeat=true")))
		) {
			this.handleHeartbeat();
			return;
		}

		// Filter out login messages - check both direct type and content containing login JSON
		if (
			message.type === "login" ||
			message.message_type === "login" ||
			message.messageType === "login"
		) {
			return;
		}

		// Check if this is a user_message containing login JSON
		if (
			(message.message_type === "user_message" ||
				message.messageType === "user_message") &&
			message.content &&
			typeof message.content === "string"
		) {
			try {
				const parsedContent = JSON.parse(message.content.trim());
				if (parsedContent.type === "login") {
					return;
				}
			} catch (e) {
				// Not JSON, continue processing normally
			}
		}

		// Handle usage statistics
		if (
			message.message_type === "usage_statistics" ||
			message.messageType === "usage_statistics"
		) {
			// Received usage statistics
			this.addUsageStatistics(message);
			return;
		}

		switch (message.message_type || message.messageType) {
			case "reasoning_message":
				if (message.reasoning) {
					// For streaming, we accumulate reasoning and show it in real-time
					this.updateOrCreateReasoningMessage(message.reasoning);
				}
				break;
			case "tool_call_message":
				const streamingToolCallData = message.tool_call || message.toolCall;
				if (streamingToolCallData) {
					// Handle streaming tool call chunks
					console.log("[Letta Plugin] Received tool_call_message:", streamingToolCallData);
					this.handleStreamingToolCall(streamingToolCallData);
				} else {
					console.log("[Letta Plugin] Received tool_call_message but no tool_call/toolCall field:", message);
				}
				break;
			case "stop_reason":
				// DISABLED: Approval handling commented out due to upstream API issues
				// if (message.stopReason === "requires_approval" || message.stop_reason === "requires_approval") {
				// 	console.log("[Letta Plugin] Stream stopped for approval");
				// }
				break;
			case "tool_return_message":
				const streamingToolReturnData = message.tool_return || message.toolReturn;
				if (streamingToolReturnData) {
					// Tool return received
					console.log("[Letta Plugin] Received tool_return_message:", streamingToolReturnData);
					console.log("[Letta Plugin] Current tool call name:", this.currentToolCallName);
					// Update the current tool interaction with the result
					await this.updateStreamingToolResult(streamingToolReturnData);
					// Clear the current tool call state since it's complete
					this.currentToolCallId = null;
					this.currentToolCallArgs = "";
					this.currentToolCallName = "";
					this.currentToolCallData = null;
				}
				break;
			case "approval_request_message":
				// DISABLED: Approval handling commented out due to upstream API issues
				// console.log("[Letta Plugin] Received approval_request_message:", message);
				// await this.handleApprovalRequest(message);
				break;
			case "assistant_message":
				// Processing streaming assistant message

				// Try multiple possible content fields
				let content =
					message.content ||
					message.text ||
					message.message ||
					message.assistant_message;

				// Handle array content by extracting text from array elements
				if (Array.isArray(content)) {
					content = content
						.map((item) => {
							if (typeof item === "string") {
								return item;
							} else if (item && typeof item === "object") {
								return (
									item.text ||
									item.content ||
									item.message ||
									item.value ||
									JSON.stringify(item)
								);
							}
							return String(item);
						})
						.join("");
					// Streaming: Converted array content to string
				}

				if (content) {
					// Filter out system prompt content
					const filteredContent =
						this.filterSystemPromptContent(content);
					await this.updateOrCreateAssistantMessage(filteredContent);
				} else {
					console.warn(
						"[Letta Plugin] Streaming assistant message has no recognizable content field:",
						Object.keys(message),
					);
				}
				break;

			case "heartbeat":
				// Skip heartbeat messages - should already be filtered above
				// Heartbeat message reached switch statement
				break;

			default:
				// Unrecognized streaming message type
				break;
		}
	}

	// State for streaming messages
	private currentReasoningContent: string = "";
	private assistantReasoningContent: string = ""; // Separate reasoning storage for assistant messages
	private currentAssistantContent: string = "";
	private currentAssistantMessageEl: HTMLElement | null = null;
	private currentReasoningMessageEl: HTMLElement | null = null;
	private currentToolMessageEl: HTMLElement | null = null;
	private currentToolCallId: string | null = null;
	private currentToolCallArgs: string = "";
	private currentToolCallName: string = "";
	private currentToolCallData: any = null;
	private currentApprovalRequestId: string | null = null;
	private currentApprovalArgs: string = "";
	private currentApprovalToolName: string = "";
	private hasCreatedApprovalUI: boolean = false;

	updateOrCreateReasoningMessage(reasoning: string) {
		// Accumulate reasoning content for both tool interactions and assistant messages
		this.currentReasoningContent += reasoning;
		this.assistantReasoningContent += reasoning;
	}

	async updateOrCreateAssistantMessage(content: string) {
		// Process escape sequences in the chunk before accumulating
		const processedContent = this.processEscapeSequences(content);
		this.currentAssistantContent += processedContent;

		// Create or update assistant message
		if (!this.currentAssistantMessageEl) {
			this.currentAssistantMessageEl = this.chatContainer.createEl(
				"div",
				{
					cls: "letta-message letta-message-assistant",
				},
			);
			const bubbleEl = this.currentAssistantMessageEl.createEl("div", {
				cls: "letta-message-bubble",
			});

			// Add header
			const headerEl = bubbleEl.createEl("div", {
				cls: "letta-message-header",
			});
			const leftSide = headerEl.createEl("div", {
				cls: "letta-message-header-left",
			});
			leftSide.createEl("span", {
				cls: "letta-message-title",
				text: this.plugin.settings.agentName,
			});
			leftSide.createEl("span", {
				cls: "letta-message-timestamp",
				text: new Date().toLocaleTimeString([], {
					hour: "2-digit",
					minute: "2-digit",
				}),
			});

			// Skip creating reasoning content here - it will be handled properly in markStreamingComplete()
			// when the streaming is finished to create the proper reasoning button structure

			// Add content container
			bubbleEl.createEl("div", { cls: "letta-message-content" });
		}

		// Update the assistant content with markdown formatting
		const contentEl = this.currentAssistantMessageEl.querySelector(
			".letta-message-content",
		);
		if (contentEl) {
			// Use robust markdown rendering instead of manual HTML formatting
			await this.renderMarkdownContent(contentEl as HTMLElement, this.currentAssistantContent);
		}

		// Scroll to bottom
		setTimeout(() => {
			this.chatContainer.scrollTo({
				top: this.chatContainer.scrollHeight,
				behavior: "smooth",
			});
		}, 10);
	}

	createStreamingToolInteraction(toolCall: any) {
		// Clean up previous tool calls
		this.cleanupPreviousToolCalls();

		// Parse tool call to extract tool name
		let toolName = "Tool Call";
		try {
			if (toolCall.name) {
				toolName = toolCall.name;
			} else if (toolCall.function && toolCall.function.name) {
				toolName = toolCall.function.name;
			}
		} catch (e) {
			// Keep default if parsing fails
		}

		console.log("[Letta Plugin] Creating tool interaction DOM element for tool:", toolName);

		// Create tool interaction message
		this.currentToolMessageEl = this.chatContainer.createEl("div", {
			cls: "letta-message letta-message-tool-interaction",
		});

		const bubbleEl = this.currentToolMessageEl.createEl("div", {
			cls: "letta-message-bubble",
		});

		// Add timestamp
		const timestamp = new Date().toLocaleTimeString([], {
			hour: "2-digit",
			minute: "2-digit",
		});

		// Header with timestamp
		const headerEl = bubbleEl.createEl("div", {
			cls: "letta-message-header",
		});
		const leftSide = headerEl.createEl("div", {
			cls: "letta-message-header-left",
		});
		leftSide.createEl("span", {
			cls: "letta-message-title",
			text: "Tool Usage",
		});
		leftSide.createEl("span", {
			cls: "letta-message-timestamp",
			text: timestamp,
		});

		// Add reasoning content if available and setting is enabled
		console.log(
			"[Letta Plugin] Creating tool interaction with reasoning content:",
			this.currentReasoningContent,
		);
		console.log(
			"[Letta Plugin] showReasoning setting:",
			this.plugin.settings.showReasoning,
		);
		if (
			this.currentReasoningContent &&
			this.plugin.settings.showReasoning
		) {
			const reasoningEl = bubbleEl.createEl("div", {
				cls: "letta-tool-reasoning",
			});

			// Apply markdown formatting to reasoning
			let formattedReasoning = this.currentReasoningContent
				.trim()
				.replace(/\n{3,}/g, "\n\n")
				.replace(/^### (.+)$/gm, "<h3>$1</h3>")
				.replace(/^## (.+)$/gm, "<h2>$1</h2>")
				.replace(/^# (.+)$/gm, "<h1>$1</h1>")
				.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
				.replace(/\*(.*?)\*/g, "<em>$1</em>")
				.replace(/`([^`]+)`/g, "<code>$1</code>")
				.replace(
					/^(\d+)\.\s+(.+)$/gm,
					'<li class="numbered-list">$2</li>',
				)
				.replace(/^[•*-]\s+(.+)$/gm, "<li>$1</li>")
				.replace(/\n\n/g, "</p><p>")
				.replace(/\n/g, "<br>");

			// Wrap consecutive numbered list items in <ol> tags
			formattedReasoning = formattedReasoning.replace(
				/(<li class="numbered-list">.*?<\/li>)(\s*<br>\s*<li class="numbered-list">.*?<\/li>)*/g,
				(match) => {
					const cleanMatch = match.replace(/<br>\s*/g, "");
					return "<ol>" + cleanMatch + "</ol>";
				},
			);

			// Wrap consecutive regular list items in <ul> tags
			formattedReasoning = formattedReasoning.replace(
				/(<li>(?!.*class="numbered-list").*?<\/li>)(\s*<br>\s*<li>(?!.*class="numbered-list").*?<\/li>)*/g,
				(match) => {
					const cleanMatch = match.replace(/<br>\s*/g, "");
					return "<ul>" + cleanMatch + "</ul>";
				},
			);

			// Wrap in paragraphs if needed
			if (
				formattedReasoning.includes("</p><p>") &&
				!formattedReasoning.startsWith("<")
			) {
				formattedReasoning = "<p>" + formattedReasoning + "</p>";
			}

			reasoningEl.innerHTML = formattedReasoning;
			console.log(
				"[Letta Plugin] Successfully created reasoning element with content",
			);
		} else {
			console.log(
				"[Letta Plugin] Not displaying reasoning content - either empty or setting disabled",
			);
			console.log(
				"[Letta Plugin] Reasoning content length:",
				this.currentReasoningContent.length,
			);
			console.log(
				"[Letta Plugin] showReasoning setting:",
				this.plugin.settings.showReasoning,
			);
		}

		// Tool call expandable section
		const toolCallHeader = bubbleEl.createEl("div", {
			cls: "letta-expandable-header letta-tool-section letta-tool-prominent",
		});

		const toolLeftSide = toolCallHeader.createEl("div", {
			cls: "letta-tool-left",
		});
		toolLeftSide.createEl("span", {
			cls: "letta-expandable-title letta-tool-name",
			text: toolName,
		});

		// Curvy connecting line (SVG)
		const connectionLine = toolCallHeader.createEl("div", {
			cls: "letta-tool-connection",
		});
		const svg = document.createElementNS(
			"http://www.w3.org/2000/svg",
			"svg",
		);
		svg.setAttribute("viewBox", "0 0 400 12");
		svg.setAttribute("preserveAspectRatio", "none");
		svg.setAttribute("class", "letta-tool-curve");

		const path = document.createElementNS(
			"http://www.w3.org/2000/svg",
			"path",
		);
		path.setAttribute(
			"d",
			"M 0,6 Q 12.5,2 25,6 Q 37.5,10 50,6 Q 62.5,2 75,6 Q 87.5,10 100,6 Q 112.5,2 125,6 Q 137.5,10 150,6 Q 162.5,2 175,6 Q 187.5,10 200,6 Q 212.5,2 225,6 Q 237.5,10 250,6 Q 262.5,2 275,6 Q 287.5,10 300,6 Q 312.5,2 325,6 Q 337.5,10 350,6 Q 362.5,2 375,6 Q 387.5,10 400,6 Q 412.5,2 425,6 Q 437.5,10 450,6",
		);
		path.setAttribute("stroke", "var(--interactive-accent)");
		path.setAttribute("stroke-width", "1.5");
		path.setAttribute("fill", "none");
		path.setAttribute("opacity", "0.7");

		svg.appendChild(path);
		connectionLine.appendChild(svg);

		const toolRightSide = toolCallHeader.createEl("div", {
			cls: "letta-tool-right",
		});
		toolRightSide.createEl("span", {
			cls: "letta-expandable-chevron letta-tool-circle",
			text: "○",
		});

		const toolCallContent = bubbleEl.createEl("div", {
			cls: "letta-expandable-content letta-expandable-collapsed",
		});
		const toolCallPre = toolCallContent.createEl("pre", {
			cls: "letta-code-block",
		});
		const streamingCodeEl = toolCallPre.createEl("code", {
			text: JSON.stringify(toolCall, null, 2),
		});
		// Store the tool name in a data attribute for reliable parsing
		streamingCodeEl.setAttribute("data-tool-name", toolName);

		// Add click handler for tool call expand/collapse
		toolCallHeader.addEventListener("click", () => {
			const isCollapsed = toolCallContent.classList.contains(
				"letta-expandable-collapsed",
			);
			if (isCollapsed) {
				toolCallContent.removeClass("letta-expandable-collapsed");
				toolCallHeader.querySelector(
					".letta-expandable-chevron",
				)!.textContent = "●";
			} else {
				toolCallContent.addClass("letta-expandable-collapsed");
				toolCallHeader.querySelector(
					".letta-expandable-chevron",
				)!.textContent = "○";
			}
		});

		// Tool result placeholder (will be filled later)
		const toolResultHeader = bubbleEl.createEl("div", {
			cls: "letta-expandable-header letta-tool-section letta-tool-result-pending",
		});
		toolResultHeader.addClass("letta-tool-result-hidden");
		toolResultHeader.createEl("span", {
			cls: "letta-expandable-title",
			text: "Tool Result",
		});
		toolResultHeader.createEl("span", {
			cls: "letta-expandable-chevron letta-tool-circle",
			text: "○",
		});

		const toolResultContent = bubbleEl.createEl("div", {
			cls: "letta-expandable-content letta-expandable-collapsed",
		});
		toolResultContent.addClass("letta-tool-content-hidden");

		// Auto-scroll to bottom
		setTimeout(() => {
			this.chatContainer.scrollTo({
				top: this.chatContainer.scrollHeight,
				behavior: "smooth",
			});
		}, 10);

		// Don't clear reasoning content here - preserve it for potential assistant messages
		// The reasoning content is copied to tool interactions but should remain available
		console.log(
			"[Letta Plugin] Preserving reasoning content for potential assistant messages",
		);
	}

	async handleApprovalRequest(message: any) {
		console.log("[Letta Plugin] handleApprovalRequest called with message:", message);

		const approvalRequestId = message.id;
		const toolCall = message.tool_call || message.toolCall;

		if (!toolCall) {
			console.error("[Letta Plugin] Approval request missing tool_call data");
			return;
		}

		const toolName = toolCall.name || (toolCall.function && toolCall.function.name);
		const toolArgsChunk = toolCall.arguments || "";

		console.log("[Letta Plugin] Approval request - ID:", approvalRequestId, "Tool:", toolName, "Args chunk:", toolArgsChunk);

		// Check if this is a new approval request or a continuation
		if (this.currentApprovalRequestId !== approvalRequestId) {
			// New approval request - initialize accumulation
			console.log("[Letta Plugin] New approval request detected");
			this.currentApprovalRequestId = approvalRequestId;
			this.currentApprovalToolName = toolName;
			this.currentApprovalArgs = toolArgsChunk;
			this.hasCreatedApprovalUI = false;
		} else {
			// Continuation - accumulate arguments
			console.log("[Letta Plugin] Accumulating approval request arguments");
			this.currentApprovalArgs += toolArgsChunk;
		}

		console.log("[Letta Plugin] Accumulated args so far:", this.currentApprovalArgs);

		// Try to parse the accumulated arguments - if it fails, we're still streaming
		let toolArgs: any;
		try {
			toolArgs = typeof this.currentApprovalArgs === 'string'
				? JSON.parse(this.currentApprovalArgs)
				: this.currentApprovalArgs;
			console.log("[Letta Plugin] Successfully parsed accumulated arguments:", toolArgs);
		} catch (parseError) {
			console.log("[Letta Plugin] Arguments not yet complete, waiting for more chunks...");
			return; // Wait for more chunks
		}

		// If we've already created the UI for this request, don't create it again
		if (this.hasCreatedApprovalUI) {
			console.log("[Letta Plugin] Approval UI already created for this request");
			return;
		}

		// Mark that we're creating the UI
		this.hasCreatedApprovalUI = true;

		console.log("[Letta Plugin] Creating approval UI for tool:", toolName);
		console.log("[Letta Plugin] Final tool arguments:", toolArgs);

		// Create approval request UI
		const approvalEl = this.chatContainer.createEl("div", {
			cls: "letta-approval-request",
		});

		// Header
		const headerEl = approvalEl.createEl("div", {
			cls: "letta-approval-header",
		});
		headerEl.createEl("span", {
			text: "🔐 Approval Required",
			cls: "letta-approval-title",
		});

		// Tool info
		const infoEl = approvalEl.createEl("div", {
			cls: "letta-approval-info",
		});
		infoEl.createEl("div", {
			text: `Tool: ${toolName}`,
			cls: "letta-approval-tool-name",
		});

		// Show tool arguments in a formatted way
		const argsEl = infoEl.createEl("div", {
			cls: "letta-approval-args",
		});

		if (toolName === "write_obsidian_note") {
			argsEl.createEl("div", {
				text: `Block Label: ${toolArgs.block_label || 'N/A'}`,
			});
			argsEl.createEl("div", {
				text: `File Path: ${toolArgs.file_path || 'N/A'}`,
			});
		} else {
			argsEl.createEl("pre", {
				text: JSON.stringify(toolArgs, null, 2),
			});
		}

		// Buttons container
		const buttonsEl = approvalEl.createEl("div", {
			cls: "letta-approval-buttons",
		});

		const approveBtn = buttonsEl.createEl("button", {
			text: "Approve",
			cls: "letta-approval-approve-btn",
		});

		const denyBtn = buttonsEl.createEl("button", {
			text: "Deny",
			cls: "letta-approval-deny-btn",
		});

		// Handle approval
		approveBtn.addEventListener("click", async () => {
			console.log("[Letta Plugin] User approved tool call");
			approvalEl.addClass("letta-approval-processing");
			approveBtn.disabled = true;
			denyBtn.disabled = true;
			approveBtn.textContent = "Approving...";

			await this.sendApprovalResponse(approvalRequestId, true, toolArgs);

			// Remove the approval UI after a short delay
			setTimeout(() => {
				approvalEl.remove();
			}, 500);
		});

		// Handle denial
		denyBtn.addEventListener("click", async () => {
			console.log("[Letta Plugin] User denied tool call");

			// Show reason input
			const reasonInput = approvalEl.createEl("textarea", {
				cls: "letta-approval-reason-input",
				attr: {
					placeholder: "Optional: Provide feedback for the agent...",
					rows: "3",
				},
			});

			approveBtn.disabled = true;
			denyBtn.textContent = "Submit Denial";

			// Change deny button to submit the denial
			denyBtn.removeEventListener("click", arguments.callee as any);
			denyBtn.addEventListener("click", async () => {
				const reason = reasonInput.value || "Request denied";
				approvalEl.addClass("letta-approval-processing");
				denyBtn.disabled = true;
				denyBtn.textContent = "Denying...";

				await this.sendApprovalResponse(approvalRequestId, false, toolArgs, reason);

				// Remove the approval UI after a short delay
				setTimeout(() => {
					approvalEl.remove();
				}, 500);
			});
		});

		// Auto-scroll to approval request
		setTimeout(() => {
			this.chatContainer.scrollTo({
				top: this.chatContainer.scrollHeight,
				behavior: "smooth",
			});
		}, 10);
	}

	async sendApprovalResponse(approvalRequestId: string, approve: boolean, toolArgs: any, reason?: string) {
		console.log("[Letta Plugin] sendApprovalResponse:", { approvalRequestId, approve, reason });

		let finalApprove = approve;
		let finalReason = reason;

		try {
			// If approved and it's a write_obsidian_note call, execute the write
			if (approve && toolArgs.block_label && toolArgs.file_path) {
				console.log("[Letta Plugin] Executing note write...");
				try {
					await this.executeNoteWrite(toolArgs.block_label, toolArgs.file_path);
				} catch (writeError: any) {
					// If the write fails, convert approval to denial with error message
					console.error("[Letta Plugin] Note write failed, converting to denial:", writeError);
					finalApprove = false;
					finalReason = `Failed to write note: ${writeError.message}`;
					new Notice(`Failed to write note: ${writeError.message}`);
				}
			}

			// Send approval/denial message to agent
			const approvalMessage = {
				id: `approval-response-${Date.now()}`,
				date: new Date().toISOString(),
				messageType: "approval_response_message",
				approve: finalApprove,
				approvalRequestId: approvalRequestId,
				...(finalReason && !finalApprove ? { reason: finalReason } : {})
			};

			console.log("[Letta Plugin] Sending approval response:", approvalMessage);

			// Send the approval message using the streaming API
			if (!this.plugin.agent || !this.plugin.client) {
				throw new Error("Agent or client not initialized");
			}

			const stream = await this.plugin.client.agents.messages.createStream(
				this.plugin.agent.id,
				{
					messages: [approvalMessage as any],
					streamTokens: true,
				},
			);

			// Process the stream responses
			for await (const chunk of stream) {
				if (chunk && typeof chunk === "object") {
					await this.processStreamingMessage(chunk);
				}
			}

			// Re-enable input after response is processed
			this.messageInput.disabled = false;
			this.sendButton.disabled = false;
			this.sendButton.textContent = "Send";
			this.sendButton.removeClass("letta-button-loading");

			// Reset approval state after completion
			this.currentApprovalRequestId = null;
			this.currentApprovalArgs = "";
			this.currentApprovalToolName = "";
			this.hasCreatedApprovalUI = false;

		} catch (error: any) {
			console.error("[Letta Plugin] Error sending approval response:", error);
			new Notice(`Failed to send approval response: ${error.message}`);

			// Re-enable input on error
			this.messageInput.disabled = false;
			this.sendButton.disabled = false;
			this.sendButton.textContent = "Send";
			this.sendButton.removeClass("letta-button-loading");
		}
	}

	async executeNoteWrite(blockLabel: string, filePath: string) {
		console.log("[Letta Plugin] executeNoteWrite:", { blockLabel, filePath });

		try {
			if (!this.plugin.client) {
				throw new Error("Letta client not initialized");
			}

			// Fetch the block content
			const blocks = await this.plugin.client.blocks.list({ label: blockLabel });
			if (!blocks || blocks.length === 0) {
				throw new Error(`Memory block with label '${blockLabel}' not found`);
			}

			const block = blocks[0];
			const content = block.value || "";

			// Sanitize the file path
			let sanitizedPath = filePath.replace(/[\\:*?"<>|]/g, "_");

			// Prepend default note folder if configured and path doesn't already start with it
			const defaultFolder = this.plugin.settings.defaultNoteFolder?.trim();
			if (defaultFolder && !sanitizedPath.startsWith(defaultFolder + '/')) {
				sanitizedPath = `${defaultFolder}/${sanitizedPath}`;
			}

			// Ensure .md extension
			const fullPath = sanitizedPath.endsWith('.md') ? sanitizedPath : `${sanitizedPath}.md`;

			// Create parent directories if they don't exist
			const pathParts = fullPath.split('/');
			if (pathParts.length > 1) {
				const folderPath = pathParts.slice(0, -1).join('/');
				const folder = this.app.vault.getAbstractFileByPath(folderPath);
				if (!folder) {
					await this.app.vault.createFolder(folderPath);
				}
			}

			// Create or overwrite the file
			const existingFile = this.app.vault.getAbstractFileByPath(fullPath);
			if (existingFile instanceof TFile) {
				await this.app.vault.modify(existingFile, content);
				new Notice(`Updated note: ${fullPath}`);
			} else {
				await this.app.vault.create(fullPath, content);
				new Notice(`Created note: ${fullPath}`);
			}

			console.log("[Letta Plugin] Note written successfully:", fullPath);

		} catch (error) {
			console.error("[Letta Plugin] Error writing note:", error);
			throw error;
		}
	}

	async updateStreamingToolResult(toolReturn: any) {
		console.log("[Letta Plugin] updateStreamingToolResult called for tool:", this.currentToolCallName);
		console.log("[Letta Plugin] Tool return data:", toolReturn);
		
		if (!this.currentToolMessageEl) {
			console.log("[Letta Plugin] ⚠️ No currentToolMessageEl found - tool message may have been removed!");
			return;
		}

		// Use the unified addToolResultToMessage method for consistency
		await this.addToolResultToMessage(
			this.currentToolMessageEl,
			JSON.stringify(toolReturn, null, 2),
			this.currentToolCallName,
			this.currentToolCallData,
		);

		// Auto-scroll to bottom
		setTimeout(() => {
			this.chatContainer.scrollTo({
				top: this.chatContainer.scrollHeight,
				behavior: "smooth",
			});
		}, 10);
	}

	resetStreamingState() {
		// Remove any existing streaming assistant message from DOM
		if (this.currentAssistantMessageEl) {
			this.currentAssistantMessageEl.remove();
		}

		// DON'T remove tool messages - they should persist in the chat
		// Just clear the reference so we don't update them anymore
		// if (this.currentToolMessageEl) {
		//     this.currentToolMessageEl.remove();
		// }

		this.currentReasoningContent = "";
		this.assistantReasoningContent = "";
		this.currentAssistantContent = "";
		this.currentAssistantMessageEl = null;
		this.currentReasoningMessageEl = null;
		this.currentToolMessageEl = null;
		this.currentToolCallId = null;
		this.currentToolCallArgs = "";
		this.currentToolCallName = "";
		this.currentToolCallData = null;
		this.currentApprovalRequestId = null;
		this.currentApprovalArgs = "";
		this.currentApprovalToolName = "";
		this.hasCreatedApprovalUI = false;
	}

	markStreamingComplete() {
		// If we have accumulated reasoning content, rebuild the assistant message with proper reasoning structure
		if (this.currentAssistantMessageEl && this.assistantReasoningContent && this.currentAssistantContent) {
			// Remove the current streaming message
			this.currentAssistantMessageEl.remove();

			// Recreate it using the proper addMessage method with reasoning
			this.addMessage(
				"assistant",
				this.currentAssistantContent,
				this.plugin.settings.agentName,
				this.assistantReasoningContent
			);

			// Clear the reasoning content after using it in the assistant message
			this.assistantReasoningContent = "";
		} else {
			// No reasoning content, just mark as complete
			if (this.currentAssistantMessageEl) {
				this.currentAssistantMessageEl.classList.add("streaming-complete");
			}
		}

		// Hide typing indicator
		this.hideTypingIndicator();
	}

	addUsageStatistics(usageMessage: any) {
		// Add usage statistics to the current streaming assistant message
		if (!this.currentAssistantMessageEl) return;

		this.addUsageStatsToElement(
			this.currentAssistantMessageEl,
			usageMessage,
		);
	}

	addUsageStatisticsToLastMessage(usageMessage: any) {
		// Add usage statistics to the most recent assistant message in the chat
		const assistantMessages = this.chatContainer.querySelectorAll(
			".letta-message-assistant",
		);
		if (assistantMessages.length === 0) return;

		const lastAssistantMessage = assistantMessages[
			assistantMessages.length - 1
		] as HTMLElement;
		this.addUsageStatsToElement(lastAssistantMessage, usageMessage);
	}

	addUsageStatsToElement(messageEl: HTMLElement, usageMessage: any) {
		const bubbleEl = messageEl.querySelector(".letta-message-bubble");
		if (!bubbleEl) return;

		// Check if usage info already exists to avoid duplicates
		const existingUsage = bubbleEl.querySelector(".letta-usage-stats");
		if (existingUsage) return;

		// Create usage statistics display
		const usageEl = bubbleEl.createEl("div", { cls: "letta-usage-stats" });

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
			parts.push(
				`${usageMessage.step_count} step${usageMessage.step_count === 1 ? "" : "s"}`,
			);
		}

		if (parts.length > 0) {
			usageEl.textContent = parts.join(" • ");
		}
	}

	handleStreamingToolCall(toolCall: any) {
		const toolCallId = toolCall.tool_call_id || toolCall.id;
		const toolName =
			toolCall.name ||
			(toolCall.function && toolCall.function.name) ||
			"Tool Call";
		const toolArgs = toolCall.arguments || toolCall.args || "";

		console.log("[Letta Plugin] handleStreamingToolCall - toolName:", toolName, "toolCallId:", toolCallId);
		
		// Special logging for propose_obsidian_note
		if (toolName === "propose_obsidian_note") {
			console.log("[Letta Plugin] 🔥 PROPOSE_OBSIDIAN_NOTE tool detected in streaming!");
			console.log("[Letta Plugin] Tool call data:", JSON.stringify(toolCall, null, 2));
		}

		// Check if this is a new tool call or a continuation of the current one
		if (this.currentToolCallId !== toolCallId) {
			// New tool call - create the interaction
			console.log(
				"[Letta Plugin] Creating new tool interaction with reasoning content:",
				this.currentReasoningContent,
			);
			this.currentToolCallId = toolCallId;
			this.currentToolCallName = toolName;
			this.currentToolCallArgs = toolArgs;
			this.currentToolCallData = toolCall;
			this.createStreamingToolInteraction(toolCall);
		} else {
			// Continuation of current tool call - accumulate arguments
			this.currentToolCallArgs += toolArgs;

			// Update the tool call display with accumulated arguments
			if (this.currentToolMessageEl) {
				const toolCallPre = this.currentToolMessageEl.querySelector(
					".letta-code-block code",
				);
				if (toolCallPre) {
					const updatedToolCall = {
						...toolCall,
						arguments: this.currentToolCallArgs,
					};
					toolCallPre.textContent = JSON.stringify(
						updatedToolCall,
						null,
						2,
					);
				}
			}
		}

		console.log(
			`[Letta Plugin] Tool call chunk received: ${toolCallId}, args: "${toolArgs}" (accumulated: "${this.currentToolCallArgs}")`,
		);
	}

	async openAgentSwitcher() {
		if (!this.plugin.settings.lettaApiKey) {
			new Notice("Please configure your Letta API key first");
			return;
		}

		const isCloudInstance =
			this.plugin.settings.lettaBaseUrl.includes("api.letta.com");

		if (isCloudInstance) {
			// For cloud instances, check if we have a valid project slug
			const projectSlug = this.plugin.settings.lettaProjectSlug;

			// Check if project slug looks valid
			const isValidProjectSlug =
				projectSlug &&
				projectSlug !== "obsidian-vault" &&
				projectSlug !== "default-project" &&
				projectSlug !== "filesystem";

			if (!isValidProjectSlug) {
				// Invalid project slug for cloud instances, show project selector
				new Notice("Please select a valid project first");
				this.openProjectSelector();
				return;
			}

			try {
				// Look up the actual project by slug to get the correct ID
				const projectsResponse =
					await this.plugin.makeRequest("/v1/projects");
				const projects = projectsResponse.projects || projectsResponse;
				const currentProject = projects.find(
					(p: any) => p.slug === projectSlug,
				);

				if (!currentProject) {
					new Notice(
						"Project not found. Please select a valid project.",
					);
					this.openProjectSelector();
					return;
				}

				this.openAgentSelector(currentProject, true); // true indicates it's the current project
			} catch (error: any) {
				console.error("Failed to load projects:", error);
				new Notice(
					"Failed to load projects. Please check your connection and try again.",
				);
				return;
			}
		} else {
			// For local instances, show all agents directly
			this.openAgentSelector();
		}
	}

	async openProjectSelector() {
		const modal = new Modal(this.app);
		modal.setTitle("Select Project");

		const { contentEl } = modal;

		// Add search input
		const searchContainer = contentEl.createEl("div", {
			attr: { style: "margin-bottom: 16px;" },
		});

		const searchInput = searchContainer.createEl("input", {
			type: "text",
			placeholder: "Search projects...",
			attr: {
				style: "width: 100%; padding: 8px; border: 1px solid var(--background-modifier-border); border-radius: 4px;",
			},
		});

		// Container for projects list
		const projectsContainer = contentEl.createEl("div");

		// Pagination state
		let currentOffset = 0;
		const limit = 10;
		let currentSearch = "";
		let hasMore = true;

		const loadProjects = async (reset = false) => {
			if (reset) {
				currentOffset = 0;
				projectsContainer.empty();
				hasMore = true;
			}

			if (!hasMore && !reset) return;

			const loadingEl = projectsContainer.createEl("div", {
				text: reset
					? "Loading projects..."
					: "Loading more projects...",
				cls: "letta-memory-empty",
			});

			try {
				const params = new URLSearchParams();
				params.append("limit", limit.toString());
				params.append("offset", currentOffset.toString());
				if (currentSearch) {
					params.append("name", currentSearch);
				}

				const projectsResponse = await this.plugin.makeRequest(
					`/v1/projects?${params.toString()}`,
				);
				loadingEl.remove();

				const projects = projectsResponse?.projects || [];
				hasMore = projectsResponse?.hasNextPage || false;

				if (projects.length === 0 && currentOffset === 0) {
					projectsContainer.createEl("div", {
						text: currentSearch
							? "No projects found matching your search"
							: "No projects found",
						cls: "letta-memory-empty",
					});
					return;
				}

				for (const project of projects) {
					const projectEl = projectsContainer.createEl("div");
					projectEl.style.padding = "12px";
					projectEl.style.borderBottom =
						"1px solid var(--background-modifier-border)";
					projectEl.style.cursor = "pointer";

					projectEl.createEl("div", {
						text: project.name,
						attr: {
							style: "font-weight: 500; margin-bottom: 4px;",
						},
					});

					if (project.description) {
						projectEl.createEl("div", {
							text: project.description,
							attr: {
								style: "color: var(--text-muted); font-size: 0.9em;",
							},
						});
					}

					projectEl.addEventListener("click", () => {
						modal.close();
						this.openAgentSelector(project);
					});

					projectEl.addEventListener("mouseenter", () => {
						projectEl.style.backgroundColor =
							"var(--background-modifier-hover)";
					});

					projectEl.addEventListener("mouseleave", () => {
						projectEl.style.backgroundColor = "";
					});
				}

				currentOffset += projects.length;

				// Add "Load More" button if there are more projects
				if (hasMore) {
					const loadMoreBtn = projectsContainer.createEl("button", {
						text: "Load More",
						attr: {
							style: "width: 100%; padding: 10px; margin-top: 10px; border: 1px solid var(--background-modifier-border); background: var(--background-primary); cursor: pointer;",
						},
					});

					loadMoreBtn.addEventListener("click", () => {
						loadMoreBtn.remove();
						loadProjects(false);
					});
				}
			} catch (error: any) {
				loadingEl.textContent = `Failed to load projects: ${error.message}`;
			}
		};

		// Search debouncing
		let searchTimeout: NodeJS.Timeout;
		searchInput.addEventListener("input", () => {
			clearTimeout(searchTimeout);
			searchTimeout = setTimeout(() => {
				currentSearch = searchInput.value.trim();
				loadProjects(true);
			}, 300);
		});

		// Initial load
		loadProjects(true);

		modal.open();

		// Focus search input after modal opens
		setTimeout(() => searchInput.focus(), 100);
	}

	async openAgentSelector(project?: any, isCurrentProject?: boolean) {
		const modal = new Modal(this.app);
		modal.setTitle(
			project ? `Select Agent - ${project.name}` : "Select Agent",
		);

		const { contentEl } = modal;

		const isCloudInstance =
			this.plugin.settings.lettaBaseUrl.includes("api.letta.com");

		if (
			isCloudInstance &&
			this.plugin.settings.lettaApiKey &&
			project &&
			!isCurrentProject
		) {
			const backButton = contentEl.createEl("button", {
				text: "← Back to Projects",
				attr: { style: "margin-bottom: 16px;" },
			});
			backButton.addEventListener("click", () => {
				modal.close();
				this.openProjectSelector();
			});
		}

		const loadingEl = contentEl.createEl("div", {
			text: "Loading agents...",
			cls: "letta-memory-empty",
		});

		try {
			const params = new URLSearchParams();
			if (project) {
				params.append("project_id", project.id);
			}

			const queryString = params.toString();
			const endpoint = `/v1/agents${queryString ? "?" + queryString : ""}`;

			const agents = await this.plugin.makeRequest(endpoint);
			loadingEl.remove();

			if (!agents || agents.length === 0) {
				const emptyDiv = contentEl.createEl("div", {
					text: project
						? `No agents found in "${project.name}"`
						: "No agents found",
					attr: { style: "text-align: center; padding: 40px;" },
				});

				if (project && !isCurrentProject) {
					const backButton = emptyDiv.createEl("button", {
						text: "← Back to Projects",
						attr: { style: "margin-top: 16px;" },
					});
					backButton.addEventListener("click", () => {
						modal.close();
						this.openProjectSelector();
					});
				}
				return;
			}

			for (const agent of agents) {
				const agentEl = contentEl.createEl("div");
				agentEl.style.padding = "12px";
				agentEl.style.borderBottom =
					"1px solid var(--background-modifier-border)";
				agentEl.style.cursor = "pointer";

				const isCurrentAgent = agent.id === this.plugin.agent?.id;

				const nameEl = agentEl.createEl("div", {
					text: agent.name,
					attr: { style: "font-weight: 500; margin-bottom: 4px;" },
				});

				const infoEl = agentEl.createEl("div", {
					text: `${agent.id.substring(0, 8)}... ${isCurrentAgent ? "(Current)" : ""}`,
					attr: {
						style: "color: var(--text-muted); font-size: 0.9em;",
					},
				});

				if (isCurrentAgent) {
					agentEl.style.backgroundColor =
						"var(--background-modifier-border-hover)";
				}

				agentEl.addEventListener("click", () => {
					modal.close();
					this.switchToAgent(agent, project);
				});

				agentEl.addEventListener("mouseenter", () => {
					agentEl.style.backgroundColor =
						"var(--background-modifier-hover)";
				});

				agentEl.addEventListener("mouseleave", () => {
					if (!isCurrentAgent) {
						agentEl.style.backgroundColor = "";
					} else {
						agentEl.style.backgroundColor =
							"var(--background-modifier-border-hover)";
					}
				});
			}
		} catch (error: any) {
			loadingEl.textContent = `Failed to load agents: ${error.message}`;
		}

		modal.open();
	}

	async switchToAgent(agent: any, project?: any) {
		try {
			console.log(
				`[Letta Plugin] Switching to agent: ${agent.name} (ID: ${agent.id})`,
			);

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
				...agent,
			};

			// Verify the agent switch by checking if we can access it
			const verifyAgent = await this.plugin.makeRequest(
				`/v1/agents/${agent.id}`,
			);
			if (!verifyAgent) {
				throw new Error(
					`Cannot access agent ${agent.id} - may not exist or lack permissions`,
				);
			}

			console.log(
				`[Letta Plugin] Successfully verified agent access: ${verifyAgent.name}`,
			);

			// Ensure Obsidian tools are registered and configured for this agent
			await this.plugin.registerObsidianTools();

			// Update UI - agent name
			this.updateAgentNameDisplay();

			// Update chat status without loading historical messages for fresh start
			await this.updateChatStatus(false);

			// Show success message for fresh conversation
			await this.addMessage(
				"assistant",
				`Started fresh conversation with **${agent.name}**${project ? ` (Project: ${project.name})` : ""}`,
				"System",
			);

			new Notice(`Switched to agent: ${agent.name}`);
		} catch (error) {
			console.error("Failed to switch agent:", error);
			new Notice(`Failed to switch agent: ${error.message}`);
			await this.addMessage(
				"assistant",
				`**Error**: Failed to switch agent: ${error.message}`,
				"Error",
			);
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
		return "Memory Blocks";
	}

	getIcon() {
		return "brain-circuit";
	}

	async onOpen() {
		const container = this.containerEl.children[1];
		container.empty();
		container.addClass("letta-memory-view");

		// Header
		const header = container.createEl("div", {
			cls: "letta-memory-header",
		});
		header.createEl("h3", { text: "Memory", cls: "letta-memory-title" });

		const buttonContainer = header.createEl("div");
		buttonContainer.style.display = "flex";
		buttonContainer.style.gap = "8px";

		const createButton = buttonContainer.createEl("span", { text: "New" });
		createButton.style.cssText =
			"cursor: pointer; opacity: 0.7; padding: 2px 6px; margin: 0 4px;";
		createButton.addEventListener("mouseenter", () => {
			createButton.style.opacity = "1";
		});
		createButton.addEventListener("mouseleave", () => {
			createButton.style.opacity = "0.7";
		});
		createButton.addEventListener("click", () => this.createNewBlock());

		const attachButton = buttonContainer.createEl("span", {
			text: "Manage",
		});
		attachButton.style.cssText =
			"cursor: pointer; opacity: 0.7; padding: 2px 6px; margin: 0 4px;";
		attachButton.addEventListener("mouseenter", () => {
			attachButton.style.opacity = "1";
		});
		attachButton.addEventListener("mouseleave", () => {
			attachButton.style.opacity = "0.7";
		});
		attachButton.addEventListener("click", () =>
			this.searchAndAttachBlocks(),
		);

		this.refreshButton = buttonContainer.createEl("span", {
			text: "Refresh",
		});
		this.refreshButton.style.cssText =
			"cursor: pointer; opacity: 0.7; padding: 2px 6px; margin: 0 4px;";
		this.refreshButton.addEventListener("mouseenter", () => {
			this.refreshButton.style.opacity = "1";
		});
		this.refreshButton.addEventListener("mouseleave", () => {
			this.refreshButton.style.opacity = "0.7";
		});
		this.refreshButton.addEventListener("click", () => this.loadBlocks());

		// Content container
		const contentContainer = container.createEl("div", {
			cls: "letta-memory-content",
		});

		// Load initial blocks
		await this.loadBlocks();
	}

	async loadBlocks() {
		try {
			// Auto-connect if not connected to server
			if (!this.plugin.agent) {
				new Notice("Connecting to Letta...");
				const connected = await this.plugin.connectToLetta();
				if (!connected) {
					this.showError("Failed to connect to Letta");
					return;
				}
			}

			this.refreshButton.style.opacity = "0.5";
			this.refreshButton.style.pointerEvents = "none";
			this.refreshButton.textContent = "Loading...";

			// Fetch blocks from API
			this.blocks = await this.plugin.makeRequest(
				`/v1/agents/${this.plugin.agent?.id}/core-memory/blocks`,
			);
			this.lastRefreshTime = new Date();

			this.renderBlocks();
		} catch (error) {
			console.error("Failed to load memory blocks:", error);
			this.showError("Failed to load memory blocks");
		} finally {
			this.refreshButton.style.opacity = "0.7";
			this.refreshButton.style.pointerEvents = "auto";
			this.refreshButton.textContent = "↻ Refresh";
		}
	}

	renderBlocks() {
		const contentContainer = this.containerEl.querySelector(
			".letta-memory-content",
		) as HTMLElement;
		contentContainer.empty();

		if (!this.blocks || this.blocks.length === 0) {
			contentContainer.createEl("div", {
				text: "No memory blocks found",
				cls: "letta-memory-empty",
			});
			return;
		}

		// Create block editors
		this.blocks.forEach((block) => {
			const blockContainer = contentContainer.createEl("div", {
				cls: "letta-memory-block",
			});

			// Block header
			const blockHeader = blockContainer.createEl("div", {
				cls: "letta-memory-block-header",
			});

			const titleSection = blockHeader.createEl("div", {
				cls: "letta-memory-title-section",
			});
			titleSection.createEl("h4", {
				text: block.label || block.name || "Unnamed Block",
				cls: "letta-memory-block-title",
			});

			const headerActions = blockHeader.createEl("div", {
				cls: "letta-memory-header-actions",
			});

			// Character counter
			const charCounter = headerActions.createEl("span", {
				text: `${(block.value || "").length}/${block.limit || 5000}`,
				cls: "letta-memory-char-counter",
			});

			// Detach button
			const detachButton = headerActions.createEl("button", {
				text: "Detach",
				cls: "letta-memory-action-btn letta-memory-detach-btn",
				attr: {
					title: "Detach block from agent (keeps block in system)",
				},
			});

			// Delete button
			const deleteButton = headerActions.createEl("button", {
				text: "Delete",
				cls: "letta-memory-action-btn letta-memory-delete-btn",
				attr: { title: "Permanently delete this block" },
			});

			// Event listeners for buttons
			detachButton.addEventListener("click", () =>
				this.detachBlock(block),
			);
			deleteButton.addEventListener("click", () =>
				this.deleteBlock(block),
			);

			// Block description
			if (block.description) {
				blockContainer.createEl("div", {
					text: block.description,
					cls: "letta-memory-block-description",
				});
			}

			// Editor textarea
			const editor = blockContainer.createEl("textarea", {
				cls: "letta-memory-block-editor",
				attr: {
					placeholder: "Enter block content...",
					"data-block-label": block.label || block.name,
				},
			});
			editor.value = block.value || "";

			if (block.read_only) {
				editor.disabled = true;
				editor.style.opacity = "0.6";
			}

			// Update character counter on input
			editor.addEventListener("input", () => {
				const currentLength = editor.value.length;
				const limit = block.limit || 5000;
				charCounter.textContent = `${currentLength}/${limit}`;

				if (currentLength > limit) {
					charCounter.style.color = "var(--text-error)";
				} else {
					charCounter.style.color = "var(--text-muted)";
				}

				// Track dirty state
				const isDirty = editor.value !== (block.value || "");
				this.blockDirtyStates.set(block.label || block.name, isDirty);
				this.updateSaveButton(block.label || block.name, isDirty);
			});

			// Save button
			const saveButton = blockContainer.createEl("button", {
				text: "Save Changes",
				cls: "letta-memory-save-btn",
			});
			saveButton.disabled = true;

			saveButton.addEventListener("click", () =>
				this.saveBlock(block.label || block.name),
			);

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
			saveButton.textContent = isDirty ? "Save Changes" : "No Changes";
		}
	}

	async saveBlock(blockLabel: string) {
		const editor = this.blockEditors.get(blockLabel);
		const saveButton = this.blockSaveButtons.get(blockLabel);

		if (!editor || !saveButton) return;

		try {
			saveButton.disabled = true;
			saveButton.textContent = "Checking...";

			// Step 1: Fetch current server state to check for conflicts
			const serverBlock = await this.plugin.makeRequest(
				`/v1/agents/${this.plugin.agent?.id}/core-memory/blocks/${blockLabel}`,
			);
			const localBlock = this.blocks.find(
				(b) => (b.label || b.name) === blockLabel,
			);

			if (!localBlock) {
				throw new Error("Local block not found");
			}

			// Step 2: Check for conflicts (server value differs from our original local value)
			const serverValue = (serverBlock.value || "").trim();
			const originalLocalValue = (localBlock.value || "").trim();
			const newValue = editor.value.trim();

			if (serverValue !== originalLocalValue) {
				// Conflict detected - show resolution dialog
				saveButton.textContent = "Conflict Detected";

				const resolution = await this.showConflictDialog(
					blockLabel,
					originalLocalValue,
					serverValue,
					newValue,
				);

				if (resolution === "cancel") {
					saveButton.textContent = "Save Changes";
					return;
				} else if (resolution === "keep-server") {
					// Update editor and local state with server version
					editor.value = serverValue;
					localBlock.value = serverValue;
					this.blockDirtyStates.set(blockLabel, false);
					saveButton.textContent = "No Changes";

					// Update character counter
					const charCounter = this.containerEl
						.querySelector(`[data-block-label="${blockLabel}"]`)
						?.parentElement?.querySelector(
							".letta-memory-char-counter",
						) as HTMLElement;
					if (charCounter) {
						const limit = localBlock.limit || 5000;
						charCounter.textContent = `${serverValue.length}/${limit}`;
						if (serverValue.length > limit) {
							charCounter.style.color = "var(--text-error)";
						} else {
							charCounter.style.color = "var(--text-muted)";
						}
					}

					new Notice(
						`Memory block "${blockLabel}" updated with server version`,
					);
					return;
				}
				// If resolution === 'overwrite', continue with save
			}

			// Step 3: Save our changes (no conflict or user chose to overwrite)
			saveButton.textContent = "Saving...";

			await this.plugin.makeRequest(
				`/v1/agents/${this.plugin.agent?.id}/core-memory/blocks/${blockLabel}`,
				{
					method: "PATCH",
					body: { value: newValue },
				},
			);

			// Update local state
			localBlock.value = newValue;
			this.blockDirtyStates.set(blockLabel, false);
			saveButton.textContent = "Saved ✓";

			setTimeout(() => {
				saveButton.textContent = "No Changes";
			}, 2000);

			new Notice(`Memory block "${blockLabel}" updated successfully`);
		} catch (error) {
			console.error(`Failed to save block ${blockLabel}:`, error);
			new Notice(
				`Failed to save block "${blockLabel}". Please try again.`,
			);
			saveButton.textContent = "Save Changes";
		} finally {
			saveButton.disabled =
				this.blockDirtyStates.get(blockLabel) !== true;
		}
	}

	private showConflictDialog(
		blockLabel: string,
		originalValue: string,
		serverValue: string,
		localValue: string,
	): Promise<"keep-server" | "overwrite" | "cancel"> {
		return new Promise((resolve) => {
			const modal = new Modal(this.app);
			modal.setTitle("Memory Block Conflict");

			const { contentEl } = modal;

			// Warning message
			const warningEl = contentEl.createEl("div", {
				cls: "conflict-warning",
			});
			warningEl.createEl("p", {
				text: `The memory block "${blockLabel}" has been changed on the server since you started editing.`,
				cls: "conflict-message",
			});

			// Create tabs/sections for different versions
			const versionsContainer = contentEl.createEl("div", {
				cls: "conflict-versions",
			});

			// Server version section
			const serverSection = versionsContainer.createEl("div", {
				cls: "conflict-section",
			});
			serverSection.createEl("h4", {
				text: "🌐 Server Version (Current)",
				cls: "conflict-section-title",
			});
			const serverTextarea = serverSection.createEl("textarea", {
				cls: "conflict-textarea",
				attr: { readonly: "true", rows: "6" },
			});
			serverTextarea.value = serverValue;

			// Your version section
			const localSection = versionsContainer.createEl("div", {
				cls: "conflict-section",
			});
			localSection.createEl("h4", {
				text: "✏️ Your Changes",
				cls: "conflict-section-title",
			});
			const localTextarea = localSection.createEl("textarea", {
				cls: "conflict-textarea",
				attr: { readonly: "true", rows: "6" },
			});
			localTextarea.value = localValue;

			// Character counts
			const serverCount = contentEl.createEl("p", {
				text: `Server version: ${serverValue.length} characters`,
				cls: "conflict-char-count",
			});
			const localCount = contentEl.createEl("p", {
				text: `Your version: ${localValue.length} characters`,
				cls: "conflict-char-count",
			});

			// Action buttons
			const buttonContainer = contentEl.createEl("div", {
				cls: "conflict-buttons",
			});

			const keepServerButton = buttonContainer.createEl("button", {
				text: "Keep Server Version",
				cls: "conflict-btn conflict-btn-server",
			});

			const overwriteButton = buttonContainer.createEl("button", {
				text: "Overwrite with My Changes",
				cls: "conflict-btn conflict-btn-overwrite",
			});

			const cancelButton = buttonContainer.createEl("button", {
				text: "Cancel",
				cls: "conflict-btn conflict-btn-cancel",
			});

			// Event handlers
			keepServerButton.addEventListener("click", () => {
				resolve("keep-server");
				modal.close();
			});

			overwriteButton.addEventListener("click", () => {
				resolve("overwrite");
				modal.close();
			});

			cancelButton.addEventListener("click", () => {
				resolve("cancel");
				modal.close();
			});

			modal.open();
		});
	}

	showError(message: string) {
		const contentContainer = this.containerEl.querySelector(
			".letta-memory-content",
		) as HTMLElement;
		contentContainer.empty();
		contentContainer.createEl("div", {
			text: message,
			cls: "letta-memory-error",
		});
	}

	async createNewBlock() {
		if (!this.plugin.agent) {
			new Notice("Please connect to Letta first");
			return;
		}

		const blockData = await this.promptForNewBlock();
		if (!blockData) return;

		try {
			// Step 1: Create the block using the blocks endpoint
			console.log("[Letta Plugin] Creating block with data:", blockData);

			const createResponse = await this.plugin.makeRequest("/v1/blocks", {
				method: "POST",
				body: {
					label: blockData.label,
					description: blockData.description,
					value: blockData.value,
					limit: blockData.limit,
				},
			});

			console.log(
				"[Letta Plugin] Block created successfully:",
				createResponse,
			);

			// Step 2: Attach the block to the agent
			console.log(
				`[Letta Plugin] Attaching block ${createResponse.id} to agent ${this.plugin.agent?.id}`,
			);

			const attachResponse = await this.plugin.makeRequest(
				`/v1/agents/${this.plugin.agent?.id}/core-memory/blocks/attach/${createResponse.id}`,
				{
					method: "PATCH",
				},
			);

			console.log(
				"[Letta Plugin] Block attached successfully:",
				attachResponse,
			);

			new Notice(`Created and attached memory block: ${blockData.label}`);

			// Refresh the blocks list
			await this.loadBlocks();
		} catch (error) {
			console.error("Failed to create and attach memory block:", error);

			// Fallback: Try the message approach as last resort
			try {
				console.log(
					"[Letta Plugin] Trying message approach as fallback",
				);

				const messageResponse = await this.plugin.makeRequest(
					`/v1/agents/${this.plugin.agent?.id}/messages`,
					{
						method: "POST",
						body: {
							messages: [
								{
									role: "user",
									content: [
										{
											type: "text",
											text: `Please create a new memory block with label "${blockData.label}", description "${blockData.description}", and initial content: "${blockData.value}". Use core_memory_append or appropriate memory tools to add this information to your memory.`,
										},
									],
								},
							],
						},
					},
				);

				console.log(
					"[Letta Plugin] Message approach result:",
					messageResponse,
				);
				new Notice(
					`Requested agent to create memory block: ${blockData.label}`,
				);

				// Refresh the blocks list after a short delay to allow agent processing
				setTimeout(() => this.loadBlocks(), 2000);
			} catch (messageError) {
				console.error(
					"Both creation approaches failed:",
					error,
					messageError,
				);
				new Notice(
					"Failed to create memory block. This feature may not be available in the current API version.",
				);
			}
		}
	}

	private promptForNewBlock(): Promise<{
		label: string;
		value: string;
		limit: number;
		description: string;
	} | null> {
		return new Promise((resolve) => {
			const modal = new Modal(this.app);
			modal.setTitle("Create New Memory Block");

			const { contentEl } = modal;
			contentEl.style.width = "500px";

			// Label input
			contentEl.createEl("div", {
				text: "Block Label:",
				cls: "config-label",
			});
			const labelInput = contentEl.createEl("input", {
				type: "text",
				placeholder: "e.g., user_preferences, project_context",
				cls: "config-input",
			});
			labelInput.style.marginBottom = "16px";

			// Description input
			contentEl.createEl("div", {
				text: "Description:",
				cls: "config-label",
			});
			const descriptionInput = contentEl.createEl("input", {
				type: "text",
				placeholder: "Brief description of what this block is for...",
				cls: "config-input",
			});
			descriptionInput.style.marginBottom = "16px";

			// Value textarea
			contentEl.createEl("div", {
				text: "Initial Content (optional):",
				cls: "config-label",
			});
			const valueInput = contentEl.createEl("textarea", {
				placeholder:
					"Enter initial content for this memory block (can be left empty)...",
				cls: "config-textarea",
			});
			valueInput.style.height = "120px";
			valueInput.style.marginBottom = "16px";

			// Limit input
			contentEl.createEl("div", {
				text: "Character Limit:",
				cls: "config-label",
			});
			const limitInput = contentEl.createEl("input", {
				cls: "config-input",
			}) as HTMLInputElement;
			limitInput.type = "number";
			limitInput.value = "2000";
			limitInput.min = "100";
			limitInput.max = "8000";
			limitInput.style.marginBottom = "16px";

			const buttonContainer = contentEl.createEl("div");
			buttonContainer.style.display = "flex";
			buttonContainer.style.gap = "8px";
			buttonContainer.style.justifyContent = "flex-end";

			const createButton = buttonContainer.createEl("button", {
				text: "Create Block",
				cls: "mod-cta",
			});

			const cancelButton = buttonContainer.createEl("button", {
				text: "Cancel",
			});

			createButton.addEventListener("click", () => {
				const label = labelInput.value.trim();
				const description = descriptionInput.value.trim();
				const value = valueInput.value; // Don't trim - allow empty content
				const limit = parseInt(limitInput.value) || 2000;

				if (!label) {
					new Notice("Please enter a block label");
					labelInput.focus();
					return;
				}

				if (!description) {
					new Notice("Please enter a description");
					descriptionInput.focus();
					return;
				}

				// Allow empty blocks - content can be added later

				resolve({ label, description, value, limit });
				modal.close();
			});

			cancelButton.addEventListener("click", () => {
				resolve(null);
				modal.close();
			});

			modal.open();
			labelInput.focus();
		});
	}

	async detachBlock(block: any) {
		if (!this.plugin.agent) {
			new Notice("Please connect to Letta first");
			return;
		}

		try {
			// Show confirmation dialog
			const confirmed = await this.showConfirmDialog(
				"Detach Memory Block",
				`Are you sure you want to detach "${block.label || block.name}" from this agent? The block will remain in the system but won't be accessible to this agent.`,
				"Detach",
				"var(--color-orange)",
			);

			if (!confirmed) return;

			console.log(
				"[Letta Plugin] Detaching block:",
				block.label || block.name,
			);

			await this.plugin.makeRequest(
				`/v1/agents/${this.plugin.agent?.id}/core-memory/blocks/detach/${block.id}`,
				{
					method: "PATCH",
				},
			);

			new Notice(
				`Memory block "${block.label || block.name}" detached successfully`,
			);

			// Refresh the blocks list
			await this.loadBlocks();
		} catch (error) {
			console.error("Failed to detach block:", error);
			new Notice(
				`Failed to detach block "${block.label || block.name}". Please try again.`,
			);
		}
	}

	async deleteBlock(block: any) {
		if (!this.plugin.agent) {
			new Notice("Please connect to Letta first");
			return;
		}

		try {
			// Show confirmation dialog with stronger warning
			const confirmed = await this.showConfirmDialog(
				"Delete Memory Block",
				`⚠️ Are you sure you want to PERMANENTLY DELETE "${block.label || block.name}"? This action cannot be undone and will remove the block from the entire system.`,
				"Delete Forever",
				"var(--text-error)",
			);

			if (!confirmed) return;

			console.log(
				"[Letta Plugin] Deleting block:",
				block.label || block.name,
			);

			await this.plugin.makeRequest(`/v1/blocks/${block.id}`, {
				method: "DELETE",
			});

			new Notice(
				`Memory block "${block.label || block.name}" deleted permanently`,
			);

			// Refresh the blocks list
			await this.loadBlocks();
		} catch (error) {
			console.error("Failed to delete block:", error);
			new Notice(
				`Failed to delete block "${block.label || block.name}". Please try again.`,
			);
		}
	}

	private showConfirmDialog(
		title: string,
		message: string,
		confirmText: string,
		confirmColor: string,
	): Promise<boolean> {
		return new Promise((resolve) => {
			const modal = new Modal(this.app);
			modal.setTitle(title);

			const { contentEl } = modal;

			// Warning message
			const messageEl = contentEl.createEl("p", { text: message });
			messageEl.style.marginBottom = "20px";
			messageEl.style.lineHeight = "1.4";

			// Button container
			const buttonContainer = contentEl.createEl("div");
			buttonContainer.style.display = "flex";
			buttonContainer.style.gap = "12px";
			buttonContainer.style.justifyContent = "flex-end";

			// Cancel button
			const cancelButton = buttonContainer.createEl("button", {
				text: "Cancel",
				cls: "conflict-btn conflict-btn-cancel",
			});

			// Confirm button
			const confirmButton = buttonContainer.createEl("button", {
				text: confirmText,
				cls: "conflict-btn",
			});
			confirmButton.style.background = confirmColor;
			confirmButton.style.color = "var(--text-on-accent)";

			// Event handlers
			cancelButton.addEventListener("click", () => {
				resolve(false);
				modal.close();
			});

			confirmButton.addEventListener("click", () => {
				resolve(true);
				modal.close();
			});

			modal.open();
		});
	}

	async searchAndAttachBlocks() {
		if (!this.plugin.agent) {
			new Notice("Please connect to Letta first");
			return;
		}

		try {
			// Get current agent's attached blocks to filter them out
			const attachedBlocks = await this.plugin.makeRequest(
				`/v1/agents/${this.plugin.agent?.id}/core-memory/blocks`,
			);
			const attachedBlockIds = new Set(
				attachedBlocks.map((block: any) => block.id),
			);

			// Build query parameters for block search
			let queryParams = "?limit=20"; // Get more blocks for searching

			// If we have a project, filter by project_id
			if (this.plugin.settings.lettaProjectSlug) {
				// Try to get project ID from slug - we'll need to look this up
				try {
					const projects =
						await this.plugin.makeRequest("/v1/projects");
					const currentProject = projects.find(
						(p: any) =>
							p.slug === this.plugin.settings.lettaProjectSlug,
					);
					if (currentProject) {
						queryParams += `&project_id=${currentProject.id}`;
					}
				} catch (error) {
					console.warn(
						"Could not get project ID for filtering blocks:",
						error,
					);
					// Continue without project filter
				}
			}

			// Fetch all available blocks
			const allBlocks = await this.plugin.makeRequest(
				`/v1/blocks${queryParams}`,
			);

			// Filter out already attached blocks and templates
			const availableBlocks = allBlocks.filter(
				(block: any) =>
					!attachedBlockIds.has(block.id) && !block.is_template,
			);

			if (availableBlocks.length === 0) {
				new Notice("No unattached blocks found in the current scope");
				return;
			}

			// Show search/selection modal
			this.showBlockSearchModal(availableBlocks);
		} catch (error) {
			console.error("Failed to search blocks:", error);
			new Notice("Failed to search for blocks. Please try again.");
		}
	}

	private showBlockSearchModal(blocks: any[]) {
		const modal = new Modal(this.app);
		modal.setTitle("Manage Memory Blocks");

		const { contentEl } = modal;
		contentEl.addClass("block-search-modal");

		// Content section
		const content = contentEl.createEl("div", {
			cls: "block-search-content",
		});

		// Search input
		const searchInput = content.createEl("input", {
			type: "text",
			placeholder: "Search blocks by label, description, or content...",
			cls: "block-search-input",
		});

		// Results info
		const resultsInfo = content.createEl("div", {
			text: `Found ${blocks.length} available blocks`,
			cls: "block-search-results-info",
		});

		// Scrollable blocks container
		const blocksContainer = content.createEl("div", {
			cls: "block-search-list",
		});

		// Render all blocks initially
		const renderBlocks = (filteredBlocks: any[]) => {
			blocksContainer.empty();
			resultsInfo.textContent = `Found ${filteredBlocks.length} available blocks`;

			if (filteredBlocks.length === 0) {
				blocksContainer.createEl("div", {
					text: "No blocks match your search",
					cls: "block-search-empty",
				});
				return;
			}

			filteredBlocks.forEach((block) => {
				const blockEl = blocksContainer.createEl("div", {
					cls: "block-search-item",
				});

				// Block header
				const headerEl = blockEl.createEl("div", {
					cls: "block-search-item-header",
				});

				const titleEl = headerEl.createEl("div", {
					cls: "block-search-item-title",
				});

				titleEl.createEl("h4", {
					text: block.label || "Unnamed Block",
				});

				if (block.description) {
					titleEl.createEl("div", {
						text: block.description,
						cls: "block-search-item-description",
					});
				}

				// Character count
				headerEl.createEl("span", {
					text: `${(block.value || "").length} chars`,
					cls: "block-search-item-chars",
				});

				// Preview of content
				const preview = (block.value || "").slice(0, 200);
				const contentPreview = blockEl.createEl("div", {
					cls: "block-search-item-preview",
				});
				contentPreview.textContent =
					preview +
					(block.value && block.value.length > 200 ? "..." : "");

				// Click to attach
				blockEl.addEventListener("click", () => {
					modal.close();
					this.attachBlock(block);
				});
			});
		};

		// Initial render
		renderBlocks(blocks);

		// Search functionality
		searchInput.addEventListener("input", () => {
			const searchTerm = searchInput.value.toLowerCase();
			const filteredBlocks = blocks.filter((block) => {
				const label = (block.label || "").toLowerCase();
				const description = (block.description || "").toLowerCase();
				const content = (block.value || "").toLowerCase();
				return (
					label.includes(searchTerm) ||
					description.includes(searchTerm) ||
					content.includes(searchTerm)
				);
			});
			renderBlocks(filteredBlocks);
		});

		// Button container
		const buttonContainer = content.createEl("div", {
			cls: "block-search-buttons",
		});

		const cancelButton = buttonContainer.createEl("button", {
			text: "Cancel",
			cls: "conflict-btn conflict-btn-cancel",
		});

		cancelButton.addEventListener("click", () => modal.close());

		modal.open();
		searchInput.focus();
	}

	async attachBlock(block: any) {
		if (!this.plugin.agent) {
			new Notice("Please connect to Letta first");
			return;
		}

		try {
			console.log(
				"[Letta Plugin] Attaching block:",
				block.label || "Unnamed",
				"to agent:",
				this.plugin.agent?.id,
			);

			// First, get current agent state to ensure we have the latest block list
			const currentAgent = await this.plugin.makeRequest(
				`/v1/agents/${this.plugin.agent?.id}`,
			);
			const currentBlocks = currentAgent.memory?.blocks || [];

			console.log(
				"[Letta Plugin] Current blocks before attach:",
				currentBlocks.map((b: any) => b.label || b.id),
			);

			// Check if block is already attached
			const isAlreadyAttached = currentBlocks.some(
				(b: any) => b.id === block.id,
			);
			if (isAlreadyAttached) {
				new Notice(
					`Memory block "${block.label || "Unnamed"}" is already attached to this agent`,
				);
				return;
			}

			// Try the standard attach endpoint first
			try {
				await this.plugin.makeRequest(
					`/v1/agents/${this.plugin.agent?.id}/core-memory/blocks/attach/${block.id}`,
					{
						method: "PATCH",
					},
				);

				console.log(
					"[Letta Plugin] Successfully attached block using attach endpoint",
				);
				new Notice(
					`Memory block "${block.label || "Unnamed"}" attached successfully`,
				);
			} catch (attachError) {
				console.warn(
					"[Letta Plugin] Attach endpoint failed, trying alternative approach:",
					attachError,
				);

				// Alternative approach: Update agent with complete block list
				const updatedBlockIds = [
					...currentBlocks.map((b: any) => b.id),
					block.id,
				];

				await this.plugin.makeRequest(
					`/v1/agents/${this.plugin.agent?.id}`,
					{
						method: "PATCH",
						body: {
							memory: {
								...currentAgent.memory,
								blocks: updatedBlockIds,
							},
						},
					},
				);

				console.log(
					"[Letta Plugin] Successfully attached block using agent update approach",
				);
				new Notice(
					`Memory block "${block.label || "Unnamed"}" attached successfully`,
				);
			}

			// Refresh the blocks list to show the newly attached block
			await this.loadBlocks();
		} catch (error) {
			console.error("Failed to attach block:", error);
			new Notice(
				`Failed to attach block "${block.label || "Unnamed"}". Please try again.`,
			);
		}
	}

	async onClose() {
		// Clean up any resources if needed
	}
}



class ToolRegistrationConsentModal extends Modal {
	plugin: LettaPlugin;
	resolve: (consent: boolean) => void;
	
	constructor(app: App, plugin: LettaPlugin) {
		super(app);
		this.plugin = plugin;
	}
	
	async show(): Promise<boolean> {
		return new Promise<boolean>((resolve) => {
			this.resolve = resolve;
			this.open();
		});
	}
	
	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: "Register Custom Tools?" });
		
		const description = contentEl.createEl("div", {
			cls: "modal-description",
		});
		description.innerHTML = `
			<p>Letta wants to register the following custom Obsidian tool:</p>
			<ul>
				<li><code>write_obsidian_note</code> - Write a memory block's content to a specified file path in your vault</li>
			</ul>
			<p><strong>Note:</strong> Tools will be installed for your entire Letta organization but will only be attached to your current agent. Each tool use requires your explicit approval before execution.</p>
			<p><em>You can change this preference in the plugin settings at any time.</em></p>
		`;
		
		const buttonContainer = contentEl.createEl("div", {
			cls: "modal-button-container",
		});
		
		const allowButton = buttonContainer.createEl("button", {
			text: "Register Tools",
			cls: "mod-cta",
		});
		allowButton.onclick = () => {
			this.resolve(true);
			this.close();
		};
		
		const denyButton = buttonContainer.createEl("button", {
			text: "Not Now",
		});
		denyButton.onclick = () => {
			this.resolve(false);
			this.close();
		};
		
		// Auto-focus the deny button for safety
		denyButton.focus();
	}
	
	onClose() {
		const { contentEl } = this;
		contentEl.empty();
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
			agent_type: "memgpt_v2_agent", // Default to MemGPT v2 architecture
			description: "An AI assistant for your Obsidian vault",
			include_base_tools: false, // Don't include core_memory* tools
			include_multi_agent_tools: false,
			include_default_source: false,
			tags: ["obsidian", "assistant"],
			model: "letta/letta-free",
			memory_blocks: [
				{
					value: "You are an AI assistant integrated with an Obsidian vault. You have access to the user's markdown files and can help them explore, organize, and work with their notes. Be helpful, knowledgeable, and concise.",
					label: "system",
					limit: 2000,
					description: "Core system instructions",
				},
			],
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
		contentEl.addClass("agent-config-modal");

		// Header
		const header = contentEl.createEl("div", {
			cls: "agent-config-header",
		});
		header.createEl("h2", { text: "Configure New Agent" });
		header.createEl("p", {
			text: "Set up your Letta AI agent with custom configuration",
			cls: "agent-config-subtitle",
		});

		// Form container
		const formEl = contentEl.createEl("div", { cls: "agent-config-form" });

		// Basic Configuration
		const basicSection = formEl.createEl("div", { cls: "config-section" });
		basicSection.createEl("h3", { text: "Basic Configuration" });

		// Agent Name
		const nameGroup = basicSection.createEl("div", { cls: "config-group" });
		nameGroup.createEl("label", {
			text: "Agent Name",
			cls: "config-label",
		});
		const nameInput = nameGroup.createEl("input", {
			type: "text",
			value: this.config.name,
			cls: "config-input",
		});
		nameInput.addEventListener("input", () => {
			this.config.name = nameInput.value;
		});

		// Agent Type
		const typeGroup = basicSection.createEl("div", { cls: "config-group" });
		typeGroup.createEl("label", {
			text: "Agent Type",
			cls: "config-label",
		});
		const typeSelect = typeGroup.createEl("select", {
			cls: "config-select",
		});

		const agentTypes = [
			{
				value: "memgpt_v2_agent",
				label: "MemGPT v2 Agent (Recommended)",
			},
			{ value: "memgpt_agent", label: "MemGPT v1 Agent" },
			{ value: "react_agent", label: "ReAct Agent" },
			{ value: "workflow_agent", label: "Workflow Agent" },
			{ value: "sleeptime_agent", label: "Sleeptime Agent" },
		];

		agentTypes.forEach((type) => {
			const option = typeSelect.createEl("option", {
				value: type.value,
				text: type.label,
			});
			if (type.value === this.config.agent_type) {
				option.selected = true;
			}
		});

		typeSelect.addEventListener("change", () => {
			this.config.agent_type = typeSelect.value as AgentType;
		});

		// Description
		const descGroup = basicSection.createEl("div", { cls: "config-group" });
		descGroup.createEl("label", {
			text: "Description",
			cls: "config-label",
		});
		const descInput = descGroup.createEl("textarea", {
			value: this.config.description || "",
			cls: "config-textarea",
			attr: { rows: "3" },
		});
		descInput.addEventListener("input", () => {
			this.config.description = descInput.value;
		});

		// Advanced Configuration
		const advancedSection = formEl.createEl("div", {
			cls: "config-section",
		});
		advancedSection.createEl("h3", { text: "Advanced Configuration" });

		// Model Configuration
		const modelGroup = advancedSection.createEl("div", {
			cls: "config-group",
		});
		modelGroup.createEl("label", {
			text: "Model (Optional)",
			cls: "config-label",
		});
		const modelHelp = modelGroup.createEl("div", {
			text: "Format: provider/model-name (default: letta/letta-free)",
			cls: "config-help",
		});
		const modelInput = modelGroup.createEl("input", {
			type: "text",
			value: this.config.model || "letta/letta-free",
			cls: "config-input",
			attr: { placeholder: "letta/letta-free" },
		});
		modelInput.addEventListener("input", () => {
			this.config.model = modelInput.value || undefined;
		});

		// Tool Configuration
		const toolsSection = advancedSection.createEl("div", {
			cls: "config-subsection",
		});
		toolsSection.createEl("h4", { text: "Tool Configuration" });

		// Include Base Tools
		const baseToolsGroup = toolsSection.createEl("div", {
			cls: "config-checkbox-group",
		});
		const baseToolsCheckbox = baseToolsGroup.createEl("input", {
			cls: "config-checkbox",
		}) as HTMLInputElement;
		baseToolsCheckbox.type = "checkbox";
		baseToolsCheckbox.checked = this.config.include_base_tools ?? true;
		baseToolsGroup.createEl("label", {
			text: "Include Base Tools (Core memory functions)",
			cls: "config-checkbox-label",
		});
		baseToolsCheckbox.addEventListener("change", () => {
			this.config.include_base_tools = baseToolsCheckbox.checked;
		});

		// Include Multi-Agent Tools
		const multiAgentToolsGroup = toolsSection.createEl("div", {
			cls: "config-checkbox-group",
		});
		const multiAgentToolsCheckbox = multiAgentToolsGroup.createEl("input", {
			cls: "config-checkbox",
		}) as HTMLInputElement;
		multiAgentToolsCheckbox.type = "checkbox";
		multiAgentToolsCheckbox.checked =
			this.config.include_multi_agent_tools ?? false;
		multiAgentToolsGroup.createEl("label", {
			text: "Include Multi-Agent Tools",
			cls: "config-checkbox-label",
		});
		multiAgentToolsCheckbox.addEventListener("change", () => {
			this.config.include_multi_agent_tools =
				multiAgentToolsCheckbox.checked;
		});

		// System Prompt Configuration
		const systemSection = formEl.createEl("div", { cls: "config-section" });
		systemSection.createEl("h3", { text: "System Prompt" });

		const systemGroup = systemSection.createEl("div", {
			cls: "config-group",
		});
		systemGroup.createEl("label", {
			text: "System Instructions",
			cls: "config-label",
		});
		const systemHelp = systemGroup.createEl("div", {
			text: "These instructions define how the agent behaves and responds",
			cls: "config-help",
		});
		const systemInput = systemGroup.createEl("textarea", {
			value: this.config.memory_blocks?.[0]?.value || "",
			cls: "config-textarea",
			attr: { rows: "6" },
		});
		systemInput.addEventListener("input", () => {
			if (!this.config.memory_blocks) {
				this.config.memory_blocks = [];
			}
			if (this.config.memory_blocks.length === 0) {
				this.config.memory_blocks.push({
					value: "",
					label: "system",
					limit: 2000,
					description: "Core system instructions",
				});
			}
			this.config.memory_blocks[0].value = systemInput.value;
		});

		// Tags
		const tagsGroup = systemSection.createEl("div", {
			cls: "config-group",
		});
		tagsGroup.createEl("label", {
			text: "Tags (Optional)",
			cls: "config-label",
		});
		const tagsHelp = tagsGroup.createEl("div", {
			text: "Comma-separated tags for organizing agents",
			cls: "config-help",
		});
		const tagsInput = tagsGroup.createEl("input", {
			type: "text",
			value: this.config.tags?.join(", ") || "",
			cls: "config-input",
			attr: { placeholder: "obsidian, assistant, helpful" },
		});
		tagsInput.addEventListener("input", () => {
			const tags = tagsInput.value
				.split(",")
				.map((tag) => tag.trim())
				.filter((tag) => tag.length > 0);
			this.config.tags = tags.length > 0 ? tags : undefined;
		});

		// Buttons
		const buttonContainer = contentEl.createEl("div", {
			cls: "agent-config-buttons",
		});

		const createButton = buttonContainer.createEl("button", {
			text: "Create Agent",
			cls: "mod-cta agent-config-create-btn",
		});
		createButton.addEventListener("click", () => {
			this.resolve(this.config);
			this.close();
		});

		const cancelButton = buttonContainer.createEl("button", {
			text: "Cancel",
			cls: "agent-config-cancel-btn",
		});
		cancelButton.addEventListener("click", () => {
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

class AgentPropertyModal extends Modal {
	agent: any;
	blocks: any[];
	onSave: (config: any) => Promise<void>;

	constructor(
		app: App,
		agent: any,
		blocks: any[],
		onSave: (config: any) => Promise<void>,
	) {
		super(app);
		this.agent = agent;
		this.blocks = blocks;
		this.onSave = onSave;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.addClass("agent-property-modal");

		// Header
		const header = contentEl.createEl("div", {
			cls: "agent-config-header",
		});
		header.createEl("h2", { text: "Agent Configuration" });
		header.createEl("p", {
			text: "Customize your agent's properties and behavior",
			cls: "agent-config-subtitle",
		});

		// Form container
		const form = contentEl.createEl("div", { cls: "agent-config-form" });

		// Name section
		const nameSection = form.createEl("div", { cls: "config-section" });
		nameSection.createEl("h3", { text: "Basic Information" });

		const nameGroup = nameSection.createEl("div", { cls: "config-group" });
		nameGroup.createEl("label", {
			text: "Agent Name",
			cls: "config-label",
		});
		const nameInput = nameGroup.createEl("input", {
			type: "text",
			cls: "config-input",
			value: this.agent.name || "",
		});

		const descGroup = nameSection.createEl("div", { cls: "config-group" });
		descGroup.createEl("label", {
			text: "Description",
			cls: "config-label",
		});
		descGroup.createEl("div", {
			text: "Optional description for your agent",
			cls: "config-help",
		});
		const descInput = descGroup.createEl("textarea", {
			cls: "config-textarea",
			attr: { rows: "3" },
		});
		descInput.value = this.agent.description || "";

		// System prompt section
		const systemSection = form.createEl("div", { cls: "config-section" });
		systemSection.createEl("h3", { text: "System Prompt" });

		const systemGroup = systemSection.createEl("div", {
			cls: "config-group",
		});
		systemGroup.createEl("label", {
			text: "System Instructions",
			cls: "config-label",
		});
		systemGroup.createEl("div", {
			text: "Instructions that define how your agent behaves and responds",
			cls: "config-help",
		});
		const systemInput = systemGroup.createEl("textarea", {
			cls: "config-textarea",
			attr: { rows: "6" },
		});
		systemInput.value = this.agent.system || "";

		// Tags section
		const tagsSection = form.createEl("div", { cls: "config-section" });
		tagsSection.createEl("h3", { text: "Tags" });

		const tagsGroup = tagsSection.createEl("div", { cls: "config-group" });
		tagsGroup.createEl("label", {
			text: "Tags (comma-separated)",
			cls: "config-label",
		});
		tagsGroup.createEl("div", {
			text: "Organize your agent with tags for easy discovery",
			cls: "config-help",
		});
		const tagsInput = tagsGroup.createEl("input", {
			type: "text",
			cls: "config-input",
			value: this.agent.tags ? this.agent.tags.join(", ") : "",
		});

		// Memory blocks section
		const blocksSection = form.createEl("div", { cls: "config-section" });
		blocksSection.createEl("h3", { text: "Core Memory Blocks" });

		// Create block editors
		this.blocks.forEach((block) => {
			const blockGroup = blocksSection.createEl("div", {
				cls: "config-group",
			});
			const blockHeader = blockGroup.createEl("div", {
				cls: "block-header",
			});

			blockHeader.createEl("label", {
				text: `${block.label || block.name || "Unnamed Block"}`,
				cls: "config-label",
			});

			const blockInfo = blockHeader.createEl("span", {
				text: `${block.value?.length || 0}/${block.limit || 5000} chars`,
				cls: "block-char-count",
			});

			if (block.description) {
				blockGroup.createEl("div", {
					text: block.description,
					cls: "config-help",
				});
			}

			const blockTextarea = blockGroup.createEl("textarea", {
				cls: "config-textarea block-editor",
				attr: {
					rows: "8",
					"data-block-label": block.label || block.name,
				},
			});
			blockTextarea.value = block.value || "";

			if (block.read_only) {
				blockTextarea.disabled = true;
				blockTextarea.style.opacity = "0.6";
			}

			// Add character counter update
			blockTextarea.addEventListener("input", () => {
				const currentLength = blockTextarea.value.length;
				const limit = block.limit || 5000;
				blockInfo.textContent = `${currentLength}/${limit} chars`;

				if (currentLength > limit) {
					blockInfo.style.color = "var(--text-error)";
				} else {
					blockInfo.style.color = "var(--text-muted)";
				}
			});
		});

		// Memory management section
		const memorySection = form.createEl("div", { cls: "config-section" });
		memorySection.createEl("h3", { text: "Memory Management" });

		const clearGroup = memorySection.createEl("div", {
			cls: "config-checkbox-group",
		});
		const clearCheckbox = clearGroup.createEl("input", {
			type: "checkbox",
			cls: "config-checkbox",
		});
		clearCheckbox.checked = this.agent.message_buffer_autoclear || false;
		clearGroup.createEl("label", {
			text: "Auto-clear message buffer (agent won't remember previous messages)",
			cls: "config-checkbox-label",
		});

		// Buttons
		const buttonContainer = contentEl.createEl("div", {
			cls: "agent-config-buttons",
		});

		const saveButton = buttonContainer.createEl("button", {
			text: "Save Changes",
			cls: "agent-config-create-btn",
		});

		const cancelButton = buttonContainer.createEl("button", {
			text: "Cancel",
			cls: "agent-config-cancel-btn",
		});

		// Event handlers

		saveButton.addEventListener("click", async () => {
			const config: any = {};
			const blockUpdates: any[] = [];

			// Only include fields that have changed
			if (nameInput.value.trim() !== this.agent.name) {
				config.name = nameInput.value.trim();
			}

			if (descInput.value.trim() !== (this.agent.description || "")) {
				config.description = descInput.value.trim() || null;
			}

			if (systemInput.value.trim() !== (this.agent.system || "")) {
				config.system = systemInput.value.trim() || null;
			}

			const newTags = tagsInput.value.trim()
				? tagsInput.value
						.split(",")
						.map((tag) => tag.trim())
						.filter((tag) => tag)
				: [];
			const currentTags = this.agent.tags || [];
			if (JSON.stringify(newTags) !== JSON.stringify(currentTags)) {
				config.tags = newTags;
			}

			if (
				clearCheckbox.checked !==
				(this.agent.message_buffer_autoclear || false)
			) {
				config.message_buffer_autoclear = clearCheckbox.checked;
			}

			// Check for block changes
			const blockTextareas = form.querySelectorAll(
				".block-editor",
			) as NodeListOf<HTMLTextAreaElement>;
			blockTextareas.forEach((textarea) => {
				const blockLabel = textarea.getAttribute("data-block-label");
				const originalBlock = this.blocks.find(
					(b) => (b.label || b.name) === blockLabel,
				);

				if (
					originalBlock &&
					textarea.value !== (originalBlock.value || "")
				) {
					blockUpdates.push({
						label: blockLabel,
						value: textarea.value,
					});
				}
			});

			// Save changes
			if (Object.keys(config).length > 0 || blockUpdates.length > 0) {
				await this.onSave({ ...config, blockUpdates });
			}

			this.close();
		});

		cancelButton.addEventListener("click", () => {
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

class NoteProposalModal extends Modal {
	proposal: ObsidianNoteProposal;
	onSubmit: (accepted: boolean, proposal?: ObsidianNoteProposal) => void;
	titleInput: HTMLInputElement;
	folderInput: HTMLInputElement;
	contentEl: HTMLTextAreaElement;

	constructor(
		app: App,
		proposal: ObsidianNoteProposal,
		onSubmit: (accepted: boolean, proposal?: ObsidianNoteProposal) => void
	) {
		super(app);
		this.proposal = { ...proposal }; // Create a copy to avoid mutating original
		this.onSubmit = onSubmit;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("note-proposal-modal");

		// Header
		contentEl.createEl("h2", { 
			text: "Proposed Note",
			cls: "note-proposal-title"
		});

		// Title section
		const titleContainer = contentEl.createEl("div", { cls: "note-proposal-field" });
		titleContainer.createEl("label", { 
			text: "Title:",
			cls: "note-proposal-label"
		});
		this.titleInput = titleContainer.createEl("input", {
			type: "text",
			value: this.proposal.title,
			cls: "note-proposal-input"
		});
		this.titleInput.addEventListener("input", () => {
			this.proposal.title = this.titleInput.value;
		});

		// Folder section
		const folderContainer = contentEl.createEl("div", { cls: "note-proposal-field" });
		folderContainer.createEl("label", { 
			text: "Folder:",
			cls: "note-proposal-label"
		});
		this.folderInput = folderContainer.createEl("input", {
			type: "text",
			value: this.proposal.folder || "",
			placeholder: "Leave empty for root folder",
			cls: "note-proposal-input"
		});
		this.folderInput.addEventListener("input", () => {
			this.proposal.folder = this.folderInput.value;
		});

		// Tags section (if any)
		if (this.proposal.tags && this.proposal.tags.length > 0) {
			const tagsContainer = contentEl.createEl("div", { cls: "note-proposal-field" });
			tagsContainer.createEl("label", { 
				text: "Tags:",
				cls: "note-proposal-label"
			});
			const tagsDisplay = tagsContainer.createEl("div", { cls: "note-proposal-tags" });
			this.proposal.tags.forEach(tag => {
				tagsDisplay.createEl("span", {
					text: `#${tag}`,
					cls: "note-proposal-tag"
				});
			});
		}

		// Content preview section
		const previewContainer = contentEl.createEl("div", { cls: "note-proposal-preview" });
		previewContainer.createEl("label", { 
			text: "Content Preview:",
			cls: "note-proposal-label"
		});
		
		const contentPreview = previewContainer.createEl("div", { cls: "note-proposal-content-preview" });
		
		// Show a truncated version for preview, full content in textarea
		const previewText = this.proposal.content.length > 300 
			? this.proposal.content.substring(0, 300) + "..."
			: this.proposal.content;
		
		contentPreview.createEl("pre", { 
			text: previewText,
			cls: "note-proposal-preview-text"
		});

		// Full content textarea (initially hidden)
		this.contentEl = previewContainer.createEl("textarea", {
			value: this.proposal.content,
			cls: "note-proposal-content-full"
		});
		this.contentEl.style.display = "none";
		this.contentEl.addEventListener("input", () => {
			this.proposal.content = this.contentEl.value;
		});

		// Toggle button to show/hide full content editor
		const toggleButton = previewContainer.createEl("button", {
			text: "Edit Content",
			cls: "note-proposal-toggle-btn"
		});

		let isEditing = false;
		toggleButton.addEventListener("click", () => {
			isEditing = !isEditing;
			if (isEditing) {
				contentPreview.style.display = "none";
				this.contentEl.style.display = "block";
				this.contentEl.style.height = "200px";
				toggleButton.textContent = "Preview";
			} else {
				contentPreview.style.display = "block";
				this.contentEl.style.display = "none";
				toggleButton.textContent = "Edit Content";
			}
		});

		// Action buttons
		const buttonContainer = contentEl.createEl("div", { cls: "note-proposal-actions" });
		
		const createButton = buttonContainer.createEl("button", {
			text: "Create Note",
			cls: "mod-cta note-proposal-btn"
		});
		createButton.addEventListener("click", () => {
			this.onSubmit(true, this.proposal);
			this.close();
		});

		const cancelButton = buttonContainer.createEl("button", {
			text: "Cancel",
			cls: "note-proposal-btn"
		});
		cancelButton.addEventListener("click", () => {
			this.onSubmit(false);
			this.close();
		});

		// Focus the title input
		setTimeout(() => this.titleInput.focus(), 10);
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

		containerEl.createEl("h2", { text: "Letta AI Agent Settings" });

		// API Configuration
		containerEl.createEl("h3", { text: "API Configuration" });

		new Setting(containerEl)
			.setName("Letta API Key")
			.setDesc("Your Letta API key for authentication")
			.addText((text) =>
				text
					.setPlaceholder("sk-let-...")
					.setValue(this.plugin.settings.lettaApiKey)
					.onChange(async (value) => {
						this.plugin.settings.lettaApiKey = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Letta Base URL")
			.setDesc("Base URL for Letta API")
			.addText((text) =>
				text
					.setPlaceholder("https://api.letta.com")
					.setValue(this.plugin.settings.lettaBaseUrl)
					.onChange(async (value) => {
						this.plugin.settings.lettaBaseUrl = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Project ID")
			.setDesc(
				"Current project identifier (automatically set when selecting agents)",
			)
			.addText((text) =>
				text
					.setPlaceholder("Auto-detected from agent selection")
					.setValue(this.plugin.settings.lettaProjectSlug)
					.onChange(async (value) => {
						this.plugin.settings.lettaProjectSlug = value;
						await this.plugin.saveSettings();
					}),
			);

		// Agent Configuration
		containerEl.createEl("h3", { text: "Agent Configuration" });

		// Agent ID Setting
		new Setting(containerEl)
			.setName("Agent ID")
			.setDesc(
				"ID of the agent to use with this vault. Leave empty to select an agent when starting chat.",
			)
			.addText((text) =>
				text
					.setPlaceholder("Enter agent ID...")
					.setValue(this.plugin.settings.agentId)
					.onChange(async (value) => {
						this.plugin.settings.agentId = value.trim();
						// Clear agent name when ID changes
						if (value.trim() !== this.plugin.settings.agentId) {
							this.plugin.settings.agentName = "";
						}
						await this.plugin.saveSettings();
					}),
			);


		new Setting(containerEl)
			.setName("Auto-Connect on Startup")
			.setDesc("Automatically connect to Letta when Obsidian starts")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.autoConnect)
					.onChange(async (value) => {
						this.plugin.settings.autoConnect = value;
						await this.plugin.saveSettings();
					}),
			);

		// Chat Configuration
		containerEl.createEl("h3", { text: "Chat Configuration" });

		new Setting(containerEl)
			.setName("Show Reasoning Messages")
			.setDesc(
				"Display AI reasoning messages in the chat (useful for debugging)",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showReasoning)
					.onChange(async (value) => {
						this.plugin.settings.showReasoning = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Enable Streaming")
			.setDesc(
				"Use streaming API for real-time responses (disable for slower but more stable responses)",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.enableStreaming)
					.onChange(async (value) => {
						this.plugin.settings.enableStreaming = value;
						await this.plugin.saveSettings();
					}),
			);

		// Focus Mode Settings
		containerEl.createEl("h3", { text: "Focus Mode" });

		new Setting(containerEl)
			.setName("Enable Focus Mode")
			.setDesc(
				"Track and share the currently viewed note with the agent via a special memory block",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.focusMode)
					.onChange(async (value) => {
						this.plugin.settings.focusMode = value;
						await this.plugin.saveSettings();

						// Enable or disable focus block based on setting
						if (this.plugin.agent) {
							if (value) {
								await this.plugin.ensureFocusBlock();
								await this.plugin.attachFocusBlock();
								// Update with current file
								const activeFile = this.plugin.app.workspace.getActiveFile();
								if (activeFile) {
									await this.plugin.updateFocusBlock(activeFile);
								}
							} else {
								await this.plugin.detachFocusBlock();
							}
						}

						new Notice(value
							? "Focus mode enabled - agent can now see your current note"
							: "Focus mode disabled"
						);
					}),
			);

		new Setting(containerEl)
			.setName("Focus Block Character Limit")
			.setDesc(
				"Maximum number of characters to include in the focus block (default: 4000)",
			)
			.addText((text) =>
				text
					.setPlaceholder("4000")
					.setValue(this.plugin.settings.focusBlockCharLimit.toString())
					.onChange(async (value) => {
						const numValue = parseInt(value, 10);
						if (!isNaN(numValue) && numValue > 0) {
							this.plugin.settings.focusBlockCharLimit = numValue;
							await this.plugin.saveSettings();

							// Update the block limit if it exists
							if (this.plugin.agent && this.plugin.focusBlockId) {
								const focusBlockLabel = `obsidian-${this.plugin.agent.id}-focused-note`;
								try {
									await this.plugin.client?.agents.blocks.modify(
										this.plugin.agent.id,
										focusBlockLabel,
										{
											limit: numValue,
										}
									);
									new Notice(`Focus block character limit updated to ${numValue}`);
								} catch (error) {
									console.error("[Letta Plugin] Failed to update block limit:", error);
								}
							}
						}
					}),
			);

		// Custom Tools Settings
		containerEl.createEl("h3", { text: "Custom Tools" });

		new Setting(containerEl)
			.setName("Enable Custom Tools")
			.setDesc(
				"Allow the agent to use custom Obsidian tools like creating notes, searching vault, etc."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.enableCustomTools)
					.onChange(async (value) => {
						this.plugin.settings.enableCustomTools = value;
						await this.plugin.saveSettings();
						
						// Register tools immediately if enabled and agent is available
						if (value && this.plugin.agent) {
							await this.plugin.registerObsidianTools();
						}
						
						new Notice(value 
							? "Custom tools enabled - agent can now create notes and more"
							: "Custom tools disabled"
						);
					}),
			);

		new Setting(containerEl)
			.setName("Ask Before Tool Registration")
			.setDesc(
				"Require user consent before registering custom tools with the agent"
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.askBeforeToolRegistration)
					.onChange(async (value) => {
						this.plugin.settings.askBeforeToolRegistration = value;
						await this.plugin.saveSettings();
						
						new Notice(value 
							? "Tool registration consent enabled - you'll be asked before tools are registered"
							: "Tool registration consent disabled - tools will register automatically"
						);
					}),
			);

		new Setting(containerEl)
			.setName("Default Note Folder")
			.setDesc(
				"Default folder for new notes created by the agent (leave empty for root folder)"
			)
			.addText((text) =>
				text
					.setPlaceholder("e.g., journal, notes, drafts")
					.setValue(this.plugin.settings.defaultNoteFolder)
					.onChange(async (value) => {
						this.plugin.settings.defaultNoteFolder = value.trim();
						await this.plugin.saveSettings();
					})
			);


		// Actions
		containerEl.createEl("h3", { text: "Actions" });

		new Setting(containerEl)
			.setName("Connect to Letta")
			.setDesc("Test connection and setup agent")
			.addButton((button) =>
				button
					.setButtonText("Connect")
					.setCta()
					.onClick(async () => {
						await this.plugin.connectToLetta();
					}),
			);

	}

	async addEmbeddingModelDropdown(setting: Setting) {
		try {
			// Fetch available embedding models
			const embeddingModels = await this.plugin.makeRequest(
				"/v1/models/embedding",
			);

			setting.addDropdown((dropdown) => {
				// Add options for each embedding model
				embeddingModels.forEach((model: any) => {
					if (model.handle) {
						dropdown.addOption(model.handle, model.handle);
					}
				});

				// Set current value
				dropdown.setValue("letta/letta-free");

				// Handle changes
				dropdown.onChange(async (value) => {
					// Check if the embedding model has actually changed
					// Remove embedding model setting
					await this.plugin.saveSettings();
				});
			});
		} catch (error) {
			console.error("Failed to fetch embedding models:", error);

			// Fallback to text input if API call fails
			setting.addText((text) =>
				text
					.setPlaceholder("letta/letta-free")
					.setValue("letta/letta-free")
					.onChange(async (value) => {
						// Remove embedding model setting
						await this.plugin.saveSettings();
					}),
			);
		}

	}





	async showAgentSelector(): Promise<void> {
		try {
			if (!this.plugin.client) throw new Error("Client not initialized");

			// Fetch agents from server
			const agents = await this.plugin.client.agents.list();

			if (!agents || agents.length === 0) {
				new Notice("No agents found. Please create an agent first.");
				return;
			}

			return new Promise((resolve) => {
				const modal = new Modal(this.app);
				modal.setTitle("Select Agent");

				const { contentEl } = modal;

				contentEl.createEl("p", {
					text: "Choose an agent to use with this Obsidian vault:",
					cls: "setting-item-description",
				});

				const agentList = contentEl.createEl("div", {
					cls: "letta-agent-list",
				});

				agents.forEach((agent: any) => {
					const agentItem = agentList.createEl("div", {
						cls: "letta-agent-item",
					});

					const agentInfo = agentItem.createEl("div", {
						cls: "letta-agent-info",
					});
					agentInfo.createEl("div", {
						text: agent.name,
						cls: "letta-agent-item-name",
					});
					agentInfo.createEl("div", {
						text: `ID: ${agent.id}`,
						cls: "letta-agent-item-id",
					});
					if (agent.description) {
						agentInfo.createEl("div", {
							text: agent.description,
							cls: "letta-agent-item-desc",
						});
					}

					const selectButton = agentItem.createEl("button", {
						text: "Select",
						cls: "mod-cta",
					});

					selectButton.addEventListener("click", async () => {
						this.plugin.settings.agentId = agent.id;
						this.plugin.settings.agentName = agent.name;
						await this.plugin.saveSettings();

						// Attempt to connect to the selected agent
						try {
							await this.plugin.setupAgent();
							new Notice(
								`Selected and connected to agent: ${agent.name}`,
							);

							// Update the chat interface to reflect the agent connection
							const chatLeaf =
								this.app.workspace.getLeavesOfType(
									LETTA_CHAT_VIEW_TYPE,
								)[0];
							if (
								chatLeaf &&
								chatLeaf.view instanceof LettaChatView
							) {
								await (
									chatLeaf.view as LettaChatView
								).updateChatStatus();
							}
						} catch (error) {
							console.error(
								"[Letta Plugin] Failed to connect to selected agent:",
								error,
							);
							new Notice(
								`Selected agent ${agent.name}, but failed to connect: ${error.message}`,
							);
						}

						modal.close();

						// Refresh the settings display
						this.display();
						resolve();
					});
				});

				const buttonContainer = contentEl.createEl("div", {
					cls: "modal-button-container",
				});
				const cancelButton = buttonContainer.createEl("button", {
					text: "Cancel",
				});
				cancelButton.addEventListener("click", () => {
					modal.close();
					resolve();
				});

				modal.open();
			});
		} catch (error) {
			console.error("Failed to fetch agents:", error);
			new Notice(
				"Failed to fetch agents. Please check your connection and try again.",
			);
		}
	}
}
