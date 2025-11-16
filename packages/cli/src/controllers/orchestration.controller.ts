import { Body, GlobalScope, Param, Post, RestController } from '@n8n/decorators';
import type { AuthenticatedRequest } from '@n8n/db';
import type { Response } from 'express';
import { Container } from '@n8n/di';

import { License } from '@/license';
import { WorkerStatusService } from '@/scaling/worker-status.service.ee';
import { BadRequestError } from '@/errors/response-errors/bad-request.error';
import { NotFoundError } from '@/errors/response-errors/not-found.error';
import { WorkflowDescriptionAiService } from '@/workflows/workflow-description-ai.service';
import { WorkflowFinderService } from '@/workflows/workflow-finder.service';
import { WorkflowExecutionService } from '@/workflows/workflow-execution.service';
import { STREAM_SEPARATOR } from '@/constants';
import { OrchestratorChatRepository } from './orchestrator-chat.repository';

export type FlushableResponse = Response & { flush: () => void };

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
	tasks: Array<{ workflowId: string; task: string }>;
};

type ExecuteTasksResponse = {
	success: boolean;
	executed: number;
	failed: number;
	errors?: Array<{ workflowId: string; error: string }>;
};

type SaveChatRequest = {
	chatId?: string;
	title?: string;
	messages: Array<{
		id: string;
		type: 'user' | 'assistant';
		content: string;
		timestamp: Date | string;
		isTaskList?: boolean;
		tasks?: Array<{ workflowId: string; task: string }>;
	}>;
};

@RestController('/orchestration')
export class OrchestrationController {
	constructor(
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

	@Post('/execute-tasks')
	async executeTasks(
		req: AuthenticatedRequest,
		@Body body: ExecuteTasksRequest,
	): Promise<ExecuteTasksResponse> {
		const { tasks } = body;

		if (!tasks || !Array.isArray(tasks) || tasks.length === 0) {
			throw new BadRequestError('Tasks array is required and must not be empty');
		}

		// Console log the task list being executed
		console.log('========================================');
		console.log('ORCHESTRATOR EXECUTING TASK LIST:');
		console.log('========================================');
		console.log(JSON.stringify(tasks, null, 2));
		console.log(`Total tasks to execute: ${tasks.length}`);
		console.log('========================================\n');

		const workflowFinderService = Container.get(WorkflowFinderService);
		const workflowExecutionService = Container.get(WorkflowExecutionService);

		const results: ExecuteTasksResponse = {
			success: true,
			executed: 0,
			failed: 0,
			errors: [],
		};

		// Execute each task
		for (const task of tasks) {
			try {
				// Fetch the workflow
				const workflow = await workflowFinderService.findWorkflowForUser(
					task.workflowId,
					req.user,
					['workflow:execute'],
				);

				if (!workflow) {
					throw new NotFoundError(`Workflow with ID "${task.workflowId}" not found`);
				}

				// Execute the workflow manually
				await workflowExecutionService.executeManually(
					{
						workflowData: workflow,
						runData: undefined,
					},
					req.user,
					req.headers['push-ref'],
				);

				results.executed++;
			} catch (error: any) {
				results.failed++;
				results.success = false;
				results.errors?.push({
					workflowId: task.workflowId,
					error: error.message || 'Unknown error occurred',
				});
			}
		}

		return results;
	}

	@Post('/chats')
	async saveChat(req: AuthenticatedRequest, @Body body: SaveChatRequest) {
		const { chatId, title, messages } = body;

		if (!messages || messages.length === 0) {
			throw new BadRequestError('Messages array is required and must not be empty');
		}

		// Serialize messages for storage
		const serializedMessages = messages.map((msg) => ({
			...msg,
			timestamp: msg.timestamp instanceof Date ? msg.timestamp.toISOString() : msg.timestamp,
		}));

		if (chatId) {
			// Update existing chat
			const existingChat = await this.orchestratorChatRepository.findOne({
				where: { id: chatId, userId: req.user.id },
			});

			if (!existingChat) {
				throw new NotFoundError(`Chat with ID "${chatId}" not found`);
			}

			existingChat.messages = serializedMessages;
			if (title) {
				existingChat.title = title;
			}

			await this.orchestratorChatRepository.save(existingChat);
			return { id: existingChat.id, title: existingChat.title };
		} else {
			// Create new chat
			const newChat = this.orchestratorChatRepository.create({
				userId: req.user.id,
				title: title || null,
				messages: serializedMessages,
			});

			const savedChat = await this.orchestratorChatRepository.save(newChat);
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
}
