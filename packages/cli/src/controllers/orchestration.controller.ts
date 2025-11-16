import { Body, GlobalScope, Param, Post, RestController } from '@n8n/decorators';
import type { AuthenticatedRequest } from '@n8n/db';
import type { Response } from 'express';
import { Container } from '@n8n/di';
import { Logger } from '@n8n/backend-common';

import { License } from '@/license';
import { WorkerStatusService } from '@/scaling/worker-status.service.ee';
import { BadRequestError } from '@/errors/response-errors/bad-request.error';
import { NotFoundError } from '@/errors/response-errors/not-found.error';
import { WorkflowDescriptionAiService } from '@/workflows/workflow-description-ai.service';
import { TaskChainExecutionService } from '@/workflows/task-chain-execution.service';
import { STREAM_SEPARATOR } from '@/constants';
import { OrchestratorChatRepository } from './orchestrator-chat.repository';

export type FlushableResponse = Response & { flush: () => void };

type ChatMessage = {
	role: 'system' | 'user' | 'assistant';
	content: string;
};

type ToolResult = {
	source: string;
	reply: string;
	data?: any;
};

type OrchestratorChatRequest = {
	userInput?: string;
	userContext?: Record<string, unknown>;
	messages?: Array<{ role: 'user' | 'assistant'; content: string }>;
};

type OrchestratorChatResponse = {
	content: string;
	isTaskList?: boolean;
	tasks?: Array<{ workflowId: string; task: string }>;
};

type ExecuteTasksRequest = {
	tasks: Array<{
		workflowId: string;
		task: string;
		input: string; // "JSON" | "png" | "noInput"
		output: string; // "JSON" | "png" | "noOutput"
	}>;
	userPrompt?: string;
};

type ExecuteTasksResponse = {
	success: boolean;
	output?: any;
	summary?: string;
	error?: string;
	executedTasks: number;
	failedTask?: string;
	toolResults?: ToolResult[];
};

type SaveChatMessage = {
	id: string;
	type: 'user' | 'assistant';
	content: string;
	timestamp: Date | string;
	isTaskList?: boolean;
	tasks?: Array<{ workflowId: string; task: string }>;
};

type SaveChatRequest = {
	chatId?: string;
	title?: string;
	messages: SaveChatMessage[];
};

type SynthesizeRequest = {
	userPrompt: string;
	toolResults: ToolResult[];
	conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }>;
};

type SynthesizeResponse = {
	content: string;
};

@RestController('/orchestration')
export class OrchestrationController {
	constructor(
		private readonly logger: Logger,
		private readonly licenseService: License,
		private readonly workerStatusService: WorkerStatusService,
		private readonly orchestratorChatRepository: OrchestratorChatRepository,
	) {}

	/**
	 * This endpoint does not return anything, it just triggers the message to
	 * the workers to respond on Redis with their status.
	 */
	@GlobalScope('orchestration:read')
	@Post('/worker/status')
	async getWorkersStatusAll() {
		if (!this.licenseService.isWorkerViewLicensed()) return;

		return await this.workerStatusService.requestWorkerStatus();
	}

	@Post('/chat/stream', { usesTemplates: true })
	async createChatPlanStream(
		req: AuthenticatedRequest,
		res: FlushableResponse,
		@Body body: OrchestratorChatRequest,
	) {
		const requestBody =
			body && Object.keys(body).length > 0 ? body : (req.body as OrchestratorChatRequest);

		const { userInput, messages } = requestBody ?? {};

		const trimmedInput = userInput?.trim() || '';
		const conversationHistory = messages || [];

		if (!trimmedInput && conversationHistory.length === 0) {
			throw new BadRequestError(
				`userInput or messages is required. Received: ${JSON.stringify(requestBody)}`,
			);
		}

		res.header('Content-Type', 'application/json-lines').flush();

		try {
			const isTask = await this.detectTask(trimmedInput);

			if (isTask) {
				// For tasks, return formatted response immediately
				const workflowDescriptionAiService = Container.get(WorkflowDescriptionAiService);
				const taskList = await workflowDescriptionAiService.taskmaster(req.user, trimmedInput);

				const formattedTasks = this.formatTaskList(taskList);

				const response = {
					content: formattedTasks,
					isTaskList: true,
					tasks: taskList.tasks || [],
				};

				res.write(JSON.stringify(response) + STREAM_SEPARATOR);
				res.end();
				return;
			}

			// Stream OpenRouter response
			await this.streamOpenRouterResponse(trimmedInput, conversationHistory, res);
		} catch (error: any) {
			const errorChunk = {
				content: error.message || 'An error occurred',
				isTaskList: false,
				tasks: [],
			};
			res.write(JSON.stringify(errorChunk) + STREAM_SEPARATOR);
			res.end();
		}
	}

	@Post('/chat')
	async createChatPlan(
		req: AuthenticatedRequest,
		_res: Response,
		@Body body: OrchestratorChatRequest,
	) {
		// Use req.body directly if body parameter is empty/undefined
		const requestBody =
			body && Object.keys(body).length > 0 ? body : (req.body as OrchestratorChatRequest);

		const { userInput, messages } = requestBody ?? {};

		// Ensure we have at least userInput or non-empty messages
		const trimmedInput = userInput?.trim() || '';
		const conversationHistory = messages || [];

		if (!trimmedInput && conversationHistory.length === 0) {
			throw new BadRequestError(
				`userInput or messages is required. Received: ${JSON.stringify(requestBody)}`,
			);
		}

		// Detect if user is giving a task
		const isTask = await this.detectTask(trimmedInput);

		if (isTask) {
			// User is giving a task - call taskmaster
			const workflowDescriptionAiService = Container.get(WorkflowDescriptionAiService);
			const taskList = await workflowDescriptionAiService.taskmaster(req.user, trimmedInput);

			// Format task list as a readable response
			const formattedTasks = this.formatTaskList(taskList);

			return {
				content: formattedTasks,
				isTaskList: true,
				tasks: taskList.tasks || [],
			} as OrchestratorChatResponse;
		}

		// Regular chat with OpenRouter
		return await this.chatWithOpenRouter(trimmedInput, conversationHistory);
	}

	private async detectTask(userInput: string): Promise<boolean> {
		// Simple detection: check for task-related keywords
		const taskKeywords = [
			'create',
			'make',
			'build',
			'generate',
			'set up',
			'setup',
			'do',
			'perform',
			'execute',
			'run',
			'complete',
			'finish',
			'task',
			'workflow',
			'automate',
		];

		const lowerInput = userInput.toLowerCase();

		// Check if input contains task keywords
		const hasTaskKeyword = taskKeywords.some((keyword) => lowerInput.includes(keyword));

		// Also check if it's a command-like statement (starts with action verbs)
		const actionVerbs = ['create', 'make', 'build', 'generate', 'set up', 'do', 'perform'];
		const startsWithAction = actionVerbs.some((verb) => lowerInput.startsWith(verb));

		return hasTaskKeyword || startsWithAction;
	}

	private formatTaskList(taskList: any): string {
		if (!taskList || !taskList.tasks || !Array.isArray(taskList.tasks)) {
			return 'No tasks were generated.';
		}

		if (taskList.tasks.length === 0) {
			return 'No tasks were generated.';
		}

		const intro = `**Task Manager** has analyzed your request and broken it down into ${taskList.tasks.length} task${taskList.tasks.length > 1 ? 's' : ''}:\n\n`;

		const formattedTasks = taskList.tasks
			.map((task: any, index: number) => {
				const workflowId = task.workflowId || `Workflow ${index + 1}`;
				const taskDescription = task.task || task.description || 'No description provided';
				// Keep descriptions concise - limit to 150 characters
				const shortDescription =
					taskDescription.length > 150
						? taskDescription.substring(0, 147) + '...'
						: taskDescription;
				return `**${index + 1}. ${workflowId}**\n${shortDescription}`;
			})
			.join('\n\n');

		const explanation =
			'\n\n*The orchestrator coordinates these tasks across your workflows. Click "Run" to execute them or "Cancel" to go back.*';

		return intro + formattedTasks + explanation;
	}

	private async chatWithOpenRouter(
		userInput: string,
		conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }>,
	): Promise<OrchestratorChatResponse> {
		const apiKey = process.env.OPENROUTER_API_KEY;
		if (!apiKey) {
			throw new Error('OPENROUTER_API_KEY env variable is not set');
		}

		const modelId = process.env.OPENROUTER_MODEL_ID || 'google/gemini-2.5-flash';
		const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

		// Build messages array from conversation history
		const messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> = [
			{
				role: 'system',
				content: 'You are a helpful AI assistant.',
			},
		];

		// Add conversation history
		conversationHistory.forEach((msg) => {
			if (msg.content?.trim()) {
				messages.push({
					role: msg.role,
					content: msg.content,
				});
			}
		});

		// Add current user input if provided (required for new messages)
		if (userInput && userInput.trim()) {
			messages.push({
				role: 'user',
				content: userInput,
			});
		}

		// Ensure we have at least one user message
		if (messages.length === 1) {
			// Only system message, no user input
			throw new Error('At least one user message is required');
		}

		const res = await fetch(OPENROUTER_URL, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${apiKey}`,
			},
			body: JSON.stringify({
				model: modelId,
				messages,
			}),
		});

		if (!res.ok) {
			const text = await res.text();
			throw new Error(`OpenRouter chat failed: ${res.status} ${res.statusText}: ${text}`);
		}

		const data = await res.json();
		const content = data?.choices?.[0]?.message?.content;
		if (!content) {
			throw new Error('OpenRouter returned no content');
		}

		return { content };
	}

	private async streamOpenRouterResponse(
		userInput: string,
		conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }>,
		res: FlushableResponse,
	): Promise<void> {
		const apiKey = process.env.OPENROUTER_API_KEY;
		if (!apiKey) {
			throw new Error('OPENROUTER_API_KEY env variable is not set');
		}

		const modelId = process.env.OPENROUTER_MODEL_ID || 'google/gemini-2.5-flash';
		const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

		// Build messages array from conversation history
		const messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> = [
			{
				role: 'system',
				content: 'You are a helpful AI assistant.',
			},
		];

		// Add conversation history
		conversationHistory.forEach((msg) => {
			if (msg.content?.trim()) {
				messages.push({
					role: msg.role,
					content: msg.content,
				});
			}
		});

		// Add current user input if provided
		if (userInput && userInput.trim()) {
			messages.push({
				role: 'user',
				content: userInput,
			});
		}

		// Ensure we have at least one user message
		if (messages.length === 1) {
			throw new Error('At least one user message is required');
		}

		const fetchResponse = await fetch(OPENROUTER_URL, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${apiKey}`,
			},
			body: JSON.stringify({
				model: modelId,
				messages,
				stream: true,
			}),
		});

		if (!fetchResponse.ok) {
			const text = await fetchResponse.text();
			throw new Error(
				`OpenRouter chat failed: ${fetchResponse.status} ${fetchResponse.statusText}: ${text}`,
			);
		}

		if (!fetchResponse.body) {
			throw new Error('OpenRouter response body is not readable');
		}

		const reader = fetchResponse.body.getReader();
		const decoder = new TextDecoder('utf-8');
		let buffer = '';

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split('\n');
				buffer = lines.pop() || '';

				for (const line of lines) {
					if (line.trim() === '' || !line.startsWith('data: ')) continue;

					const data = line.slice(6); // Remove 'data: ' prefix
					if (data === '[DONE]') {
						res.end();
						return;
					}

					try {
						const parsed = JSON.parse(data);
						const delta = parsed.choices?.[0]?.delta;
						if (delta?.content) {
							const chunk = {
								chunk: delta.content,
							};
							res.write(JSON.stringify(chunk) + STREAM_SEPARATOR);
							res.flush();
						}
					} catch (e) {
						// Skip invalid JSON
					}
				}
			}

			// Process remaining buffer
			if (buffer.trim() && buffer.startsWith('data: ')) {
				const data = buffer.slice(6);
				if (data !== '[DONE]') {
					try {
						const parsed = JSON.parse(data);
						const delta = parsed.choices?.[0]?.delta;
						if (delta?.content) {
							const chunk = {
								chunk: delta.content,
							};
							res.write(JSON.stringify(chunk) + STREAM_SEPARATOR);
						}
					} catch (e) {
						// Skip invalid JSON
					}
				}
			}

			res.end();
		} finally {
			reader.releaseLock();
		}
	}

	@Post('/execute-tasks', { usesTemplates: true })
	async executeTasks(
		req: AuthenticatedRequest,
		res: FlushableResponse,
		@Body body: ExecuteTasksRequest,
	) {
		// Set streaming headers first
		res.header('Content-Type', 'application/json-lines').flush();

		try {
			const requestBody =
				body && Object.keys(body).length > 0 ? body : (req.body as ExecuteTasksRequest);
			const { tasks, userPrompt } = requestBody ?? {};

			if (!tasks || !Array.isArray(tasks) || tasks.length === 0) {
				const errorResponse = {
					success: false,
					error: 'Tasks array is required and must not be empty',
					executedTasks: 0,
					isFinal: true,
				};
				res.write(JSON.stringify(errorResponse) + STREAM_SEPARATOR);
				res.end();
				return;
			}

			// Console log the task list being executed
			console.log('========================================');
			console.log('ORCHESTRATOR EXECUTING TASK LIST:');
			console.log('========================================');
			console.log(JSON.stringify(tasks, null, 2));
			console.log(`Total tasks to execute: ${tasks.length}`);
			console.log('========================================\n');

			const taskChainExecutionService = Container.get(TaskChainExecutionService);

			// Execute the task chain
			const result = await taskChainExecutionService.runTaskChain({
				user: req.user,
				tasks: tasks.map((t) => ({
					workflowId: t.workflowId,
					task: t.task,
					input: t.input,
					output: t.output,
				})),
				userPrompt: userPrompt || undefined,
			});

			// Stream progress updates as tasks complete
			for (const taskResult of result.tasks) {
				try {
					const progress = {
						currentTaskIndex: taskResult.index,
						totalTasks: result.tasks.length,
						currentWorkflowId: taskResult.workflowId,
						status: taskResult.status,
						workflowName: taskResult.workflowName,
						taskSummary: taskResult.taskSummary,
					};
					res.write(JSON.stringify(progress) + STREAM_SEPARATOR);
					res.flush();
				} catch (writeError) {
					console.error('Error writing progress update:', writeError);
				}
			}

			// Build normalized ToolResult[] from each task's output payload for downstream LLM orchestration
			const toolResults: ToolResult[] = [];

			for (const taskResult of result.tasks) {
				const payload = taskResult.outputPayload as any;
				if (!payload) continue;

				// The workflow may already return the canonical ToolResult or an array of them
				const payloadItems = Array.isArray(payload) ? payload : [payload];

				for (const raw of payloadItems) {
					if (!raw) continue;

					if (typeof raw === 'object' && 'source' in raw && 'reply' in raw) {
						toolResults.push({
							source:
								typeof (raw as any).source === 'string' && (raw as any).source.trim()
									? (raw as any).source
									: taskResult.workflowId,
							reply:
								typeof (raw as any).reply === 'string' && (raw as any).reply.trim()
									? (raw as any).reply
									: `Result from workflow ${taskResult.workflowName ?? taskResult.workflowId}`,
							data:
								(raw as any).data !== undefined && (raw as any).data !== null
									? (raw as any).data
									: raw,
						});
					} else {
						toolResults.push({
							source: taskResult.workflowId,
							reply: `Result from workflow ${taskResult.workflowName ?? taskResult.workflowId}`,
							data: raw,
						});
					}
				}
			}

			// Check if the last task has no output and we need to generate a summary
			const lastTask = tasks[tasks.length - 1];
			let finalResponse: ExecuteTasksResponse;

			this.logger.info('📊 Task chain execution completed', {
				success: result.success,
				totalTasks: result.tasks.length,
				succeededTasks: result.tasks.filter((t) => t.status === 'succeeded').length,
				hasFinalOutput: !!result.finalOutput,
				finalOutputType: result.finalOutput ? typeof result.finalOutput : 'undefined',
				lastTaskOutputType: lastTask?.output,
			});

			// Log output from each task for debugging
			for (const taskResult of result.tasks) {
				this.logger.debug('Task result details', {
					taskIndex: taskResult.index,
					workflowId: taskResult.workflowId,
					status: taskResult.status,
					hasOutputPayload: !!taskResult.outputPayload,
					outputPayloadKeys: taskResult.outputPayload ? Object.keys(taskResult.outputPayload) : [],
					hasRawOutput: !!taskResult.rawOutput,
					rawOutputLength: taskResult.rawOutput?.length || 0,
				});
			}

			if (result.success && lastTask?.output === 'noOutput') {
				// Generate AI summary
				this.logger.info('Generating AI summary for no-output task');
				const summary = await this.generateTaskSummary(result, tasks, userPrompt || '');
				finalResponse = {
					success: true,
					summary,
					executedTasks: result.tasks.filter((t) => t.status === 'succeeded').length,
				};
			} else {
				finalResponse = {
					success: result.success,
					output: result.finalOutput,
					error: result.error,
					executedTasks: result.tasks.filter((t) => t.status === 'succeeded').length,
					failedTask: result.failedTask?.taskSummary,
				};
			}

			// Always include normalized toolResults for the frontend orchestrator
			finalResponse.toolResults = toolResults;

			this.logger.info('📤 Sending final response to frontend', {
				success: finalResponse.success,
				hasOutput: !!finalResponse.output,
				hasSummary: !!finalResponse.summary,
				outputKeys: finalResponse.output ? Object.keys(finalResponse.output) : [],
				outputPreview: finalResponse.output
					? JSON.stringify(finalResponse.output).substring(0, 300)
					: null,
			});

			// Send final response
			res.write(JSON.stringify({ ...finalResponse, isFinal: true }) + STREAM_SEPARATOR);
			res.end();
		} catch (error: any) {
			console.error('Error in executeTasks:', error);
			const errorResponse = {
				success: false,
				error: error.message || 'Unknown error occurred',
				executedTasks: 0,
				isFinal: true,
			};
			try {
				res.write(JSON.stringify(errorResponse) + STREAM_SEPARATOR);
				res.end();
			} catch (writeError) {
				console.error('Error writing error response:', writeError);
				// Response might already be closed, just log it
			}
		}
	}

	private async generateTaskSummary(
		_result: any,
		tasks: any[],
		userPrompt: string,
	): Promise<string> {
		const apiKey = process.env.OPENROUTER_API_KEY;
		if (!apiKey) {
			return 'All tasks completed successfully. No output was generated from the final workflow.';
		}

		const modelId = process.env.OPENROUTER_MODEL_ID || 'google/gemini-2.5-flash';
		const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

		try {
			const systemPrompt =
				'You are a helpful AI assistant. Provide a brief summary of what was accomplished based on the completed tasks and user prompt.';
			const userMessage = `User requested: "${userPrompt}"\n\nCompleted tasks:\n${tasks
				.map((t, i) => `${i + 1}. ${t.task}`)
				.join('\n')}\n\nProvide a brief summary of what was accomplished.`;

			const response = await fetch(OPENROUTER_URL, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${apiKey}`,
				},
				body: JSON.stringify({
					model: modelId,
					messages: [
						{ role: 'system', content: systemPrompt },
						{ role: 'user', content: userMessage },
					],
				}),
			});

			if (!response.ok) {
				throw new Error(`OpenRouter API failed: ${response.status}`);
			}

			const data = await response.json();
			return data?.choices?.[0]?.message?.content || 'All tasks completed successfully.';
		} catch (error) {
			console.error('Failed to generate summary:', error);
			return 'All tasks completed successfully. Summary generation failed.';
		}
	}

	@Post('/chats')
	async saveChat(
		req: AuthenticatedRequest,
		@Body body: SaveChatRequest | { messages: ChatMessage[]; taskResults?: ToolResult[] },
	) {
		// Branch 1: tool-results summarization for the orchestrator (LLM answer)
		if (
			Array.isArray((body as any).messages) &&
			(Array.isArray((body as any).taskResults) ||
				((body as any).messages[0] && 'role' in (body as any).messages[0]))
		) {
			const { messages, taskResults } = body as {
				messages: ChatMessage[];
				taskResults?: ToolResult[];
			};

			if (!messages || !Array.isArray(messages) || messages.length === 0) {
				throw new BadRequestError('Messages array is required and must not be empty');
			}

			const apiKey = process.env.OPENROUTER_API_KEY;
			if (!apiKey) {
				throw new Error('OPENROUTER_API_KEY env variable is not set');
			}

			const modelId = process.env.OPENROUTER_MODEL_ID || 'google/gemini-2.5-flash';
			const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

			this.logger.info('Orchestrator summarizing tool results', {
				userId: req.user.id,
				messageCount: messages.length,
				toolResultCount: taskResults?.length ?? 0,
			});

			const response = await fetch(OPENROUTER_URL, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${apiKey}`,
				},
				body: JSON.stringify({
					model: modelId,
					messages,
				}),
			});

			if (!response.ok) {
				const text = await response.text();
				throw new Error(
					`OpenRouter chat failed: ${response.status} ${response.statusText}: ${text}`,
				);
			}

			const data = await response.json();
			const content = data?.choices?.[0]?.message?.content;
			if (!content) {
				throw new Error('OpenRouter returned no content');
			}

			return {
				answer: content,
			};
		}

		// Branch 2: persist orchestrator chat history (existing behaviour)
		const { chatId, title, messages } = body as SaveChatRequest;

		this.logger.debug('Save chat request received', {
			userId: req.user.id,
			chatId,
			messageCount: messages?.length || 0,
			hasTitle: !!title,
			bodyType: typeof body,
			messagesType: typeof messages,
			isMessagesArray: Array.isArray(messages),
			bodyKeys: body ? Object.keys(body) : [],
		});

		// Validate messages array - but fail soft, as chat saving is non-critical
		if (!messages || !Array.isArray(messages)) {
			this.logger.warn('Save chat skipped: messages is not an array', {
				userId: req.user.id,
				chatId,
				messagesType: typeof messages,
				bodyKeys: body ? Object.keys(body) : [],
			});
			// Soft success - nothing to save, but not an error for the user
			return {
				id: chatId ?? '',
				title: title || 'Untitled Chat',
			};
		}

		// Filter out any invalid messages (empty content, etc.)
		const validMessages = messages.filter(
			(msg) =>
				msg &&
				typeof msg === 'object' &&
				msg.content &&
				typeof msg.content === 'string' &&
				msg.content.trim() !== '',
		);

		if (validMessages.length === 0) {
			this.logger.warn('Save chat skipped: no valid messages after filtering', {
				userId: req.user.id,
				chatId,
				originalMessageCount: messages.length,
			});
			// Soft success - nothing to save, but not an error for the user
			return {
				id: chatId ?? '',
				title: title || 'Untitled Chat',
			};
		}

		// Serialize messages for storage
		const serializedMessages = validMessages.map((msg) => ({
			...msg,
			timestamp: msg.timestamp instanceof Date ? msg.timestamp.toISOString() : msg.timestamp,
		}));

		if (chatId) {
			// Update existing chat
			const existingChat = await this.orchestratorChatRepository.findOne({
				where: { id: chatId, userId: req.user.id },
			});

			if (!existingChat) {
				this.logger.warn('Chat not found for update', {
					userId: req.user.id,
					chatId,
				});
				throw new NotFoundError(`Chat with ID "${chatId}" not found`);
			}

			existingChat.messages = serializedMessages;
			if (title) {
				existingChat.title = title;
			}

			await this.orchestratorChatRepository.save(existingChat);
			this.logger.info('Chat updated successfully', {
				userId: req.user.id,
				chatId: existingChat.id,
				messageCount: serializedMessages.length,
			});
			return { id: existingChat.id, title: existingChat.title };
		} else {
			// Create new chat
			const newChat = this.orchestratorChatRepository.create({
				userId: req.user.id,
				title: title || null,
				messages: serializedMessages,
			});

			const savedChat = await this.orchestratorChatRepository.save(newChat);
			this.logger.info('New chat created successfully', {
				userId: req.user.id,
				chatId: savedChat.id,
				messageCount: serializedMessages.length,
			});
			return { id: savedChat.id, title: savedChat.title };
		}
	}

	@Post('/chats/list')
	async listChats(req: AuthenticatedRequest) {
		const chats = await this.orchestratorChatRepository.find({
			where: { userId: req.user.id },
			order: { updatedAt: 'DESC' },
			select: ['id', 'title', 'createdAt', 'updatedAt'],
		});

		return chats.map((chat) => ({
			id: chat.id,
			title: chat.title || 'New Chat',
			createdAt: chat.createdAt,
			updatedAt: chat.updatedAt,
		}));
	}

	@Post('/chats/:chatId')
	async getChat(req: AuthenticatedRequest, @Param('chatId') chatId: string) {
		const chat = await this.orchestratorChatRepository.findOne({
			where: { id: chatId, userId: req.user.id },
		});

		if (!chat) {
			throw new NotFoundError(`Chat with ID "${chatId}" not found`);
		}

		// Deserialize messages
		const messages = chat.messages.map((msg) => ({
			...msg,
			timestamp: new Date(msg.timestamp),
		}));

		return {
			id: chat.id,
			title: chat.title,
			messages,
		};
	}

	@Post('/chats/:chatId/delete')
	async deleteChat(req: AuthenticatedRequest, @Param('chatId') chatId: string) {
		const chat = await this.orchestratorChatRepository.findOne({
			where: { id: chatId, userId: req.user.id },
		});

		if (!chat) {
			throw new NotFoundError(`Chat with ID "${chatId}" not found`);
		}

		await this.orchestratorChatRepository.remove(chat);
		return { success: true };
	}

	@Post('/synthesize')
	async synthesizeToolResults(
		req: AuthenticatedRequest,
		@Body body: SynthesizeRequest,
	): Promise<SynthesizeResponse> {
		let { userPrompt, toolResults, conversationHistory } = body;

		// Provide a default user prompt if none was provided (safety net)
		if (!userPrompt || typeof userPrompt !== 'string' || userPrompt.trim() === '') {
			userPrompt =
				'What is the output of this workflow? Please provide a clear summary of the results.';
			this.logger.warn('No userPrompt provided, using default', { userId: req.user.id });
		}

		this.logger.debug('Synthesize request received', {
			userId: req.user.id,
			userPrompt,
			userPromptLength: userPrompt.length,
			toolResultsCount: toolResults?.length || 0,
			toolSources: toolResults?.map((r) => r.source) || [],
			conversationHistoryLength: conversationHistory?.length || 0,
		});

		if (!toolResults || !Array.isArray(toolResults) || toolResults.length === 0) {
			throw new BadRequestError('toolResults is required and must be a non-empty array');
		}

		// Normalize tool results: flatten if nested arrays
		const normalizedResults: ToolResult[] = [];
		for (const result of toolResults) {
			if (Array.isArray(result)) {
				// If a workflow returned an array, flatten it
				for (const item of result) {
					if (item && typeof item === 'object' && 'source' in item && 'reply' in item) {
						normalizedResults.push(item as ToolResult);
					}
				}
			} else if (result && typeof result === 'object' && 'source' in result && 'reply' in result) {
				// Single ToolResult object
				normalizedResults.push(result as ToolResult);
			}
		}

		if (normalizedResults.length === 0) {
			throw new BadRequestError('No valid tool results found in the provided data');
		}

		this.logger.debug('Normalized tool results', {
			count: normalizedResults.length,
			sources: normalizedResults.map((r) => r.source),
		});

		// Build messages array for LLM with conversation context
		const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];

		// Add system message
		messages.push({
			role: 'system',
			content: [
				'You are an orchestrator assistant helping users with their questions.',
				'You have access to conversation history and tool results from various sources (polymarket, weather, news, etc.).',
				"Your job is to synthesize the tool results into a concise, helpful answer that addresses the user's question.",
				'Use the conversation history to understand context and provide coherent responses.',
				'Format your response in a clear, readable way using markdown when appropriate.',
				'If the tool results contain lists or structured data, present them in an organized manner.',
			].join(' '),
		});

		// Add conversation history (if provided)
		if (conversationHistory && conversationHistory.length > 0) {
			this.logger.debug('Including conversation history in synthesis', {
				historyLength: conversationHistory.length,
			});

			// Add previous conversation messages (limit to last 10 to avoid token limits)
			const recentHistory = conversationHistory.slice(-10);
			for (const msg of recentHistory) {
				messages.push({
					role: msg.role,
					content: msg.content,
				});
			}
		}

		// Add current user question
		messages.push({
			role: 'user',
			content: userPrompt,
		});

		// Add tool results as assistant message
		messages.push({
			role: 'assistant',
			content:
				'Here are the tool results I retrieved:\n\n' +
				JSON.stringify(normalizedResults, null, 2) +
				'\n\nLet me synthesize this information to answer your question.',
		});

		// Call OpenRouter to synthesize
		const apiKey = process.env.OPENROUTER_API_KEY;
		if (!apiKey) {
			throw new Error('OPENROUTER_API_KEY environment variable is not set');
		}

		const modelId = process.env.OPENROUTER_MODEL_ID || 'google/gemini-2.5-flash';
		const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

		try {
			this.logger.debug('Calling OpenRouter for synthesis', {
				model: modelId,
				messageCount: messages.length,
			});

			const response = await fetch(OPENROUTER_URL, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${apiKey}`,
				},
				body: JSON.stringify({
					model: modelId,
					messages,
				}),
			});

			if (!response.ok) {
				const errorText = await response.text();
				this.logger.error('OpenRouter API call failed', {
					status: response.status,
					statusText: response.statusText,
					errorText,
				});
				throw new Error(
					`OpenRouter API failed: ${response.status} ${response.statusText}: ${errorText}`,
				);
			}

			const data = await response.json();
			const content = data?.choices?.[0]?.message?.content;

			if (!content) {
				this.logger.error('OpenRouter returned no content', { data });
				throw new Error('OpenRouter returned no content in response');
			}

			this.logger.info('Successfully synthesized tool results', {
				userId: req.user.id,
				contentLength: content.length,
			});

			return { content };
		} catch (error) {
			this.logger.error('Failed to synthesize tool results', {
				error: error instanceof Error ? error.message : 'Unknown error',
				stack: error instanceof Error ? error.stack : undefined,
			});
			throw error;
		}
	}
}
