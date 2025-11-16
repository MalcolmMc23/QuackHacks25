import { Body, GlobalScope, Post, RestController } from '@n8n/decorators';
import type { AuthenticatedRequest } from '@n8n/db';
import type { Response } from 'express';

import { License } from '@/license';
import { WorkerStatusService } from '@/scaling/worker-status.service.ee';
import { BadRequestError } from '@/errors/response-errors/bad-request.error';

type OrchestratorChatRequest = {
	userInput?: string;
	userContext?: Record<string, unknown>;
	messages?: Array<{ role: 'user' | 'assistant'; content: string }>;
};

@RestController('/orchestration')
export class OrchestrationController {
	constructor(
		private readonly licenseService: License,
		private readonly workerStatusService: WorkerStatusService,
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

	@Post('/chat')
	async createChatPlan(
		req: AuthenticatedRequest,
		_res: Response,
		@Body body: OrchestratorChatRequest,
	) {
		// Debug logging
		// eslint-disable-next-line no-console
		console.log('=== Chat Request Debug ===');
		// eslint-disable-next-line no-console
		console.log('Body parameter:', JSON.stringify(body, null, 2));
		// eslint-disable-next-line no-console
		console.log('req.body:', JSON.stringify(req.body, null, 2));
		// eslint-disable-next-line no-console
		console.log('req.headers:', JSON.stringify(req.headers, null, 2));

		// Try to get data from body parameter first, then req.body
		const requestBody = (body && Object.keys(body).length > 0 ? body : req.body) as
			| OrchestratorChatRequest
			| undefined;

		// eslint-disable-next-line no-console
		console.log('Using requestBody:', JSON.stringify(requestBody, null, 2));

		const { userInput, messages } = requestBody ?? {};

		const trimmedInput = userInput?.trim() || '';
		const conversationHistory = messages || [];

		// eslint-disable-next-line no-console
		console.log(
			'Parsed - trimmedInput:',
			trimmedInput,
			'messages count:',
			conversationHistory.length,
		);

		if (!trimmedInput && conversationHistory.length === 0) {
			throw new BadRequestError(
				`userInput or messages is required. Received body: ${JSON.stringify(requestBody)}`,
			);
		}

		return await this.chatWithOpenRouter(trimmedInput, conversationHistory);
	}

	private async chatWithOpenRouter(
		userInput: string,
		conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }>,
	): Promise<{ content: string }> {
		const apiKey = process.env.OPENROUTER_API_KEY;
		if (!apiKey) {
			throw new Error('OPENROUTER_API_KEY env variable is not set');
		}

		const modelId = process.env.OPENROUTER_MODEL_ID || 'google/gemini-2.5-flash';
		const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

		const messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> = [
			{
				role: 'system',
				content: 'You are a helpful AI assistant.',
			},
		];

		conversationHistory.forEach((msg) => {
			if (msg.content?.trim()) {
				messages.push({
					role: msg.role,
					content: msg.content,
				});
			}
		});

		if (userInput && userInput.trim()) {
			messages.push({
				role: 'user',
				content: userInput,
			});
		}

		if (messages.length === 1) {
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
}
