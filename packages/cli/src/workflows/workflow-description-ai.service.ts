import { Logger } from '@n8n/backend-common';
import { Service } from '@n8n/di';
import type { User } from '@n8n/db';
import type { IDataObject, INode } from 'n8n-workflow';
import axios, { type AxiosError } from 'axios';

import { BadRequestError } from '@/errors/response-errors/bad-request.error';
import { InternalServerError } from '@/errors/response-errors/internal-server.error';
import { WorkflowService } from './workflow.service';

interface OpenRouterMessage {
	role: 'system' | 'user' | 'assistant';
	content: string;
}

interface OpenRouterRequest {
	model: string;
	messages: OpenRouterMessage[];
	response_format?: { type: 'json_object' };
}

interface OpenRouterResponse {
	choices: Array<{
		message: {
			content: string;
		};
	}>;
	error?: {
		message: string;
	};
}

@Service()
export class WorkflowDescriptionAiService {
	private readonly openRouterApiKey: string;
	private readonly openRouterUrl = 'https://openrouter.ai/api/v1/chat/completions';
	private readonly geminiModel = 'google/gemini-2.5-flash';

	constructor(
		private readonly logger: Logger,
		private readonly workflowService: WorkflowService,
	) {
		this.openRouterApiKey = process.env.OPENROUTER_API_KEY || '';
		if (!this.openRouterApiKey) {
			this.logger.warn('OPENROUTER_API_KEY environment variable is not set');
		}
	}

	async generateDescription(nodesJson: INode[], userInput: string): Promise<IDataObject> {
		if (!this.openRouterApiKey) {
			throw new BadRequestError('OpenRouter API key is not configured');
		}

		const systemPrompt = `You are a helpful assistant that responds with JSON only. Analyze workflow nodes and user input, then return a JSON object describing the workflow. The JSON should be a valid object that provides insights about the workflow based on the nodes and user's request.
		

		THE FOLLOWING IS AN EXAMPLE.

{
  "outputType": "json",
  "workflowName": "Automated HVAC Lead Processing and Notification",
  "description": "This workflow monitors a dedicated Gmail inbox for HVAC-related lead emails, extracts key information, classifies leads as Residential or Commercial, assesses lead quality (cold, warm, hot), and then sends a notification with enriched lead details to a Slack channel.",
  "trigger": {
    "type": "Gmail Trigger",
    "description": "Monitors 'leads@hvacvendor.com' for emails with HVAC-related keywords in the subject line, running every minute."
  },
  "steps": [
    {
      "stepName": "Lead Parser & Classifier",
      "type": "Function",
      "description": "Parses email subject and body to extract sender information, phone, and zip code. Classifies lead type as 'Residential' or 'Commercial' based on domain, keywords, and job titles within the email body. This step also prepares data for further AI processing."
    },
    {
      "stepName": "AI Agent",
      "type": "AI Agent (LLM Chain)",
      "description": "Leverages an Anthropic Chat Model to analyze the parsed lead data. It extracts the lead's name and assigns a quality rating ('cold', 'warm', or 'hot') along with a brief description based on urgency and specificity of the inquiry. Ensures output is in a strictly defined JSON format."
    },
    {
      "stepName": "Structured Output Parser",
      "type": "Output Parser",
      "description": "Enforces a structured schema for the AI Agent's output, ensuring that the extracted 'name', 'quality', and 'description' fields are correctly formatted and present."
    },
    {
      "stepName": "Send a message",
      "type": "Slack",
      "description": "Posts a message to a designated Slack channel ('#leads') containing the enriched lead information, including the lead's name, quality rating, and a description provided by the AI."
    }
  ],
  "integrations": [
    "Gmail",
    "Anthropic (AI)",
    "Slack"
  ],
  "keyFeatures": [
    "Automated lead capture from email",
    "Keyword-based email filtering for HVAC leads",
    "Data extraction and parsing from email content",
    "Automated classification of leads (Residential/Commercial)",
    "AI-powered lead scoring (cold, warm, hot)",
    "Real-time lead notification to Slack"
  ]

}

the outputType can only be, "JSON", "png", or "noOutput"
		
		`;

		const userPrompt = `Workflow nodes: ${JSON.stringify(nodesJson, null, 2)}\n\nUser request: ${userInput}\n\nRespond with JSON only. Do not include any markdown formatting or code blocks. Return only valid JSON.`;

		const requestBody: OpenRouterRequest = {
			model: this.geminiModel,
			messages: [
				{
					role: 'system',
					content: systemPrompt,
				},
				{
					role: 'user',
					content: userPrompt,
				},
			],
			response_format: { type: 'json_object' },
		};

		try {
			this.logger.debug('Calling OpenRouter API for workflow description generation', {
				model: this.geminiModel,
				nodesCount: nodesJson.length,
			});

			const response = await axios.post<OpenRouterResponse>(this.openRouterUrl, requestBody, {
				headers: {
					Authorization: `Bearer ${this.openRouterApiKey}`,
					'Content-Type': 'application/json',
					'HTTP-Referer': 'https://n8n.io',
					'X-Title': 'n8n',
				},
				timeout: 60000, // 60 second timeout
			});

			if (response.data.error) {
				throw new InternalServerError(`OpenRouter API error: ${response.data.error.message}`);
			}

			if (!response.data.choices || response.data.choices.length === 0) {
				throw new InternalServerError('OpenRouter API returned no choices');
			}

			const content = response.data.choices[0].message.content;

			// Parse the JSON response
			let parsedResponse: IDataObject;
			try {
				// Remove any markdown code blocks if present
				const cleanedContent = content
					.replace(/```json\n?/g, '')
					.replace(/```\n?/g, '')
					.trim();
				parsedResponse = JSON.parse(cleanedContent) as IDataObject;
			} catch (parseError) {
				this.logger.error('Failed to parse OpenRouter response as JSON', {
					content,
					error: parseError,
				});
				throw new InternalServerError(
					'Failed to parse AI response as JSON. The AI may not have returned valid JSON.',
				);
			}

			return parsedResponse;
		} catch (error) {
			if (axios.isAxiosError(error)) {
				const axiosError = error as AxiosError<OpenRouterResponse>;
				const errorMessage =
					axiosError.response?.data?.error?.message ||
					axiosError.message ||
					'Unknown error from OpenRouter API';

				this.logger.error('OpenRouter API request failed', {
					status: axiosError.response?.status,
					statusText: axiosError.response?.statusText,
					error: errorMessage,
				});

				throw new InternalServerError(`OpenRouter API error: ${errorMessage}`);
			}

			// Re-throw if it's already a known error type
			if (error instanceof BadRequestError || error instanceof InternalServerError) {
				throw error;
			}

			this.logger.error('Unexpected error in workflow description generation', {
				error,
			});

			throw new InternalServerError(
				`Unexpected error during workflow description generation: ${error instanceof Error ? error.message : 'Unknown error'}`,
			);
		}
	}

	async taskmaster(user: User, prompt: string): Promise<IDataObject> {
		if (!this.openRouterApiKey) {
			throw new BadRequestError('OpenRouter API key is not configured');
		}

		// Get workflow descriptions for the user
		const workflowDescriptions = await this.workflowService.getWorkflowDescriptions(user);

		if (workflowDescriptions.length === 0) {
			throw new BadRequestError('No workflows available for task breakdown');
		}

		const systemPrompt = `You are a helpful assistant that responds with JSON only. Your task is to break down a user's prompt into tasks, with exactly one task per workflow provided.

The response must be a JSON object with a "tasks" array. The number of tasks in the array MUST match the number of workflows provided (${workflowDescriptions.length} workflows).

Each task should:
- Correspond to one workflow
- Outline what that workflow should accomplish based on the user's prompt
- Be specific and actionable

Example response format:
{
  "tasks": [
    {
      "workflowId": "workflow-id-1",
      "task": "Description of what this workflow should do"
    },
    {
      "workflowId": "workflow-id-2",
      "task": "Description of what this workflow should do"
    }
  ]
}

Respond with JSON only. Do not include any markdown formatting or code blocks. Return only valid JSON.`;

		const workflowsJson = JSON.stringify(workflowDescriptions, null, 2);
		const userPrompt = `User prompt: ${prompt}

Available workflows:
${workflowsJson}

Break down the user's prompt into exactly ${workflowDescriptions.length} tasks, one for each workflow. Each task should map to a workflow and describe what that workflow should accomplish.`;

		const requestBody: OpenRouterRequest = {
			model: this.geminiModel,
			messages: [
				{
					role: 'system',
					content: systemPrompt,
				},
				{
					role: 'user',
					content: userPrompt,
				},
			],
			response_format: { type: 'json_object' },
		};

		try {
			this.logger.debug('Calling OpenRouter API for taskmaster', {
				model: this.geminiModel,
				workflowsCount: workflowDescriptions.length,
			});

			const response = await axios.post<OpenRouterResponse>(this.openRouterUrl, requestBody, {
				headers: {
					Authorization: `Bearer ${this.openRouterApiKey}`,
					'Content-Type': 'application/json',
					'HTTP-Referer': 'https://n8n.io',
					'X-Title': 'n8n',
				},
				timeout: 60000, // 60 second timeout
			});

			if (response.data.error) {
				throw new InternalServerError(`OpenRouter API error: ${response.data.error.message}`);
			}

			if (!response.data.choices || response.data.choices.length === 0) {
				throw new InternalServerError('OpenRouter API returned no choices');
			}

			const content = response.data.choices[0].message.content;

			// Parse the JSON response
			let parsedResponse: IDataObject;
			try {
				// Remove any markdown code blocks if present
				const cleanedContent = content
					.replace(/```json\n?/g, '')
					.replace(/```\n?/g, '')
					.trim();
				parsedResponse = JSON.parse(cleanedContent) as IDataObject;
			} catch (parseError) {
				this.logger.error('Failed to parse OpenRouter response as JSON', {
					content,
					error: parseError,
				});
				throw new InternalServerError(
					'Failed to parse AI response as JSON. The AI may not have returned valid JSON.',
				);
			}

			return parsedResponse;
		} catch (error) {
			if (axios.isAxiosError(error)) {
				const axiosError = error as AxiosError<OpenRouterResponse>;
				const errorMessage =
					axiosError.response?.data?.error?.message ||
					axiosError.message ||
					'Unknown error from OpenRouter API';

				this.logger.error('OpenRouter API request failed', {
					status: axiosError.response?.status,
					statusText: axiosError.response?.statusText,
					error: errorMessage,
				});

				throw new InternalServerError(`OpenRouter API error: ${errorMessage}`);
			}

			// Re-throw if it's already a known error type
			if (error instanceof BadRequestError || error instanceof InternalServerError) {
				throw error;
			}

			this.logger.error('Unexpected error in taskmaster', {
				error,
			});

			throw new InternalServerError(
				`Unexpected error during taskmaster: ${error instanceof Error ? error.message : 'Unknown error'}`,
			);
		}
	}
}
