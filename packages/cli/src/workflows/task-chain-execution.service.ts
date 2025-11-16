import { Logger } from '@n8n/backend-common';
import type { User, WorkflowEntity } from '@n8n/db';
import { Service } from '@n8n/di';
import type {
	ExecuteWorkflowOptions,
	IDataObject,
	IExecuteWorkflowInfo,
	INode,
	INodeExecutionData,
	IRun,
	IWorkflowBase,
	ITaskData,
} from 'n8n-workflow';

import { ActiveExecutions } from '@/active-executions';
import { BadRequestError } from '@/errors/response-errors/bad-request.error';
import { InternalServerError } from '@/errors/response-errors/internal-server.error';
import { NotFoundError } from '@/errors/response-errors/not-found.error';
import * as WorkflowExecuteAdditionalData from '@/workflow-execute-additional-data';
import * as WorkflowHelpers from '@/workflow-helpers';

import { WorkflowFinderService } from './workflow-finder.service';
import { WorkflowService } from './workflow.service';
import { WorkflowExecutionService } from './workflow-execution.service';

export type TaskIoType = 'JSON' | 'png' | 'noInput' | 'noOutput';

export interface TaskPlanItem {
	workflowId: string;
	task: string;
	input?: string;
	output?: string;
}

export type TaskExecutionStatus = 'pending' | 'running' | 'succeeded' | 'failed';

export interface TaskExecutionResult {
	index: number;
	workflowId: string;
	workflowName?: string;
	taskSummary: string;
	status: TaskExecutionStatus;
	inputType: TaskIoType;
	outputType: TaskIoType;
	startedAt?: Date;
	finishedAt?: Date;
	executionId?: string;
	inputPayload?: IDataObject;
	outputPayload?: IDataObject;
	rawOutput?: INodeExecutionData[];
	error?: string;
}

export interface TaskChainResult {
	success: boolean;
	tasks: TaskExecutionResult[];
	progress: {
		currentTaskIndex: number;
		totalTasks: number;
		currentWorkflowId?: string;
	};
	failedTask?: TaskExecutionResult;
	error?: string;
	finalOutput?: IDataObject;
}

type WorkflowDescriptionMetadata = {
	inputType?: TaskIoType;
	outputType?: TaskIoType;
	workflowName?: string;
};

@Service()
export class TaskChainExecutionService {
	constructor(
		private readonly logger: Logger,
		private readonly workflowFinderService: WorkflowFinderService,
		private readonly workflowService: WorkflowService,
		private readonly workflowExecutionService: WorkflowExecutionService,
		private readonly activeExecutions: ActiveExecutions,
	) {}

	async runTaskChain(params: {
		user: User;
		tasks: TaskPlanItem[];
		userPrompt?: string;
	}): Promise<TaskChainResult> {
		const { user, tasks, userPrompt } = params;
		const startTime = Date.now();

		this.logger.info('🚀 Starting task chain execution', {
			userId: user.id,
			userEmail: user.email,
			totalTasks: tasks.length,
			hasUserPrompt: !!userPrompt,
			tasks: tasks.map((t, idx) => ({
				index: idx,
				workflowId: t.workflowId,
				task: t.task,
				input: t.input,
				output: t.output,
			})),
		});

		if (!tasks.length) {
			this.logger.error('❌ Task chain failed: No tasks provided');
			throw new BadRequestError('Tasks array is required and must not be empty');
		}

		this.logger.debug('Loading workflow descriptions for user', { userId: user.id });
		const workflowDescriptions = await this.workflowService.getWorkflowDescriptions(user);
		this.logger.debug('✅ Loaded workflow descriptions', {
			count: workflowDescriptions.length,
		});

		const descriptionMap = new Map<string, WorkflowDescriptionMetadata>();
		for (const description of workflowDescriptions) {
			const { workflowId, workflowDescription } = description;
			if (workflowDescription) {
				descriptionMap.set(workflowId, {
					inputType: this.normalizeIoType(workflowDescription.inputType as string | undefined),
					outputType: this.normalizeIoType(workflowDescription.outputType as string | undefined),
					workflowName: (workflowDescription.workflowName as string | undefined) ?? undefined,
				});
			}
		}

		const results: TaskExecutionResult[] = tasks.map((task, index) => {
			const description = descriptionMap.get(task.workflowId);
			return {
				index,
				workflowId: task.workflowId,
				workflowName: description?.workflowName,
				taskSummary: task.task,
				status: 'pending',
				inputType: this.resolveIoType(task.input, description?.inputType, 'noInput'),
				outputType: this.resolveIoType(task.output, description?.outputType, 'JSON'),
			};
		});

		let previousOutputData: INodeExecutionData[] | undefined;
		let finalOutput: IDataObject | undefined;
		let currentTaskIndex = -1;
		let currentWorkflowId: string | undefined;

		for (const result of results) {
			currentTaskIndex = result.index;
			currentWorkflowId = result.workflowId;
			result.status = 'running';
			result.startedAt = new Date();
			const taskStartTime = Date.now();

			this.logger.info(`📋 Executing task ${result.index + 1}/${tasks.length}`, {
				taskIndex: result.index,
				workflowId: result.workflowId,
				workflowName: result.workflowName,
				taskSummary: result.taskSummary,
				inputType: result.inputType,
				outputType: result.outputType,
			});

			try {
				this.logger.debug('Loading workflow', {
					workflowId: result.workflowId,
					taskIndex: result.index,
				});
				const workflow = await this.loadWorkflow(result.workflowId, user);
				this.logger.debug('✅ Workflow loaded successfully', {
					workflowId: workflow.id,
					workflowName: workflow.name,
					nodeCount: workflow.nodes?.length || 0,
				});

				// Check if this is a webhook-triggered workflow
				const webhookInfo = this.getWebhookInfo(workflow);

				if (webhookInfo) {
					// Check if workflow is active
					if (!workflow.active) {
						this.logger.warn('⚠️ Webhook workflow is not active, cannot execute via webhook', {
							workflowId: workflow.id,
							workflowName: workflow.name,
							webhookPath: webhookInfo.path,
						});
						throw new Error(
							`Workflow "${workflow.name}" must be active to execute via webhook. Please activate the workflow and try again.`,
						);
					}

					// Execute via webhook
					this.logger.info('🔗 Workflow is webhook-triggered, calling webhook URL', {
						workflowId: workflow.id,
						workflowName: workflow.name,
						webhookPath: webhookInfo.path,
						webhookMethod: webhookInfo.method,
						isActive: workflow.active,
					});

					const webhookResult = await this.executeViaWebhook(workflow, webhookInfo);

					result.executionId = 'webhook-execution';
					result.outputPayload = webhookResult || undefined;

					this.logger.info('✅ Webhook execution completed', {
						workflowId: workflow.id,
						hasResult: !!webhookResult,
						resultKeys: webhookResult ? Object.keys(webhookResult) : [],
					});

					finalOutput = result.outputType === 'noOutput' ? undefined : result.outputPayload;
					previousOutputData =
						result.outputType === 'noOutput'
							? undefined
							: webhookResult
								? [{ json: webhookResult }]
								: undefined;

					result.status = 'succeeded';
					result.finishedAt = new Date();
					const taskDuration = Date.now() - taskStartTime;

					this.logger.info(
						`✅ Task ${result.index + 1}/${tasks.length} completed successfully (webhook)`,
						{
							taskIndex: result.index,
							workflowId: result.workflowId,
							workflowName: result.workflowName,
							durationMs: taskDuration,
							hasOutput: !!finalOutput,
						},
					);

					continue;
				}

				this.logger.debug('Preparing input data', {
					inputType: result.inputType,
					isFirstTask: result.index === 0,
					hasPreviousOutput: !!previousOutputData,
				});
				const { inputData, inputPresentation } = this.prepareInputData({
					inputType: result.inputType,
					isFirstTask: result.index === 0,
					userPrompt,
					previousOutput: previousOutputData,
				});
				result.inputPayload = inputPresentation;
				this.logger.debug('✅ Input data prepared', {
					hasInputData: !!inputData,
					inputDataLength: inputData?.length || 0,
					inputPreviewKeys: inputPresentation ? Object.keys(inputPresentation) : [],
				});

				this.logger.info('▶️ Starting workflow execution', {
					workflowId: workflow.id,
					workflowName: workflow.name,
					taskIndex: result.index,
				});
				const executionOutcome = await this.executeWorkflowAndWait({
					workflow,
					user,
					inputData,
				});
				result.executionId = executionOutcome.executionId;
				this.logger.info('✅ Workflow execution completed', {
					executionId: executionOutcome.executionId,
					workflowId: workflow.id,
					taskIndex: result.index,
					executionStatus: executionOutcome.runData.status,
				});

				this.logger.debug('Extracting output data', {
					workflowId: workflow.id,
					executionId: executionOutcome.executionId,
				});

				// Log full execution structure for debugging
				this.logger.debug('Execution runData structure', {
					hasRunData: !!executionOutcome.runData,
					hasResultData: !!executionOutcome.runData?.data?.resultData,
					lastNodeExecuted: executionOutcome.runData?.data?.resultData?.lastNodeExecuted,
					runDataNodeNames: executionOutcome.runData?.data?.resultData?.runData
						? Object.keys(executionOutcome.runData.data.resultData.runData)
						: [],
					workflowNodeNames: workflow.nodes?.map((n) => n.name) || [],
					workflowNodeTypes: workflow.nodes?.map((n) => `${n.name}:${n.type}`) || [],
				});

				const taskOutputData = this.extractRespondNodeOutput(executionOutcome.runData, workflow);
				result.rawOutput = taskOutputData;
				result.outputPayload = this.extractPrimaryJson(taskOutputData);

				this.logger.info('📤 Output extraction result', {
					hasRawOutput: !!taskOutputData,
					rawOutputLength: taskOutputData?.length || 0,
					outputPayloadKeys: result.outputPayload ? Object.keys(result.outputPayload) : [],
					outputPayloadPreview: result.outputPayload
						? JSON.stringify(result.outputPayload).substring(0, 200)
						: null,
				});

				finalOutput = result.outputType === 'noOutput' ? undefined : result.outputPayload;
				previousOutputData =
					result.outputType === 'noOutput' ? undefined : (taskOutputData ?? previousOutputData);

				result.status = 'succeeded';
				result.finishedAt = new Date();
				const taskDuration = Date.now() - taskStartTime;

				this.logger.info(`✅ Task ${result.index + 1}/${tasks.length} completed successfully`, {
					taskIndex: result.index,
					workflowId: result.workflowId,
					workflowName: result.workflowName,
					executionId: result.executionId,
					durationMs: taskDuration,
					hasOutput: !!finalOutput,
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : 'Unknown error';
				const stack = error instanceof Error ? error.stack : undefined;
				result.status = 'failed';
				result.finishedAt = new Date();
				result.error = message;
				const taskDuration = Date.now() - taskStartTime;

				this.logger.error(`❌ Task ${result.index + 1}/${tasks.length} failed`, {
					taskIndex: result.index,
					workflowId: result.workflowId,
					workflowName: result.workflowName,
					taskSummary: result.taskSummary,
					error: message,
					errorStack: stack,
					errorType: error instanceof Error ? error.constructor.name : 'Unknown',
					durationMs: taskDuration,
					executedTasks: result.index,
					remainingTasks: tasks.length - result.index - 1,
				});

				const totalDuration = Date.now() - startTime;
				this.logger.error('❌ Task chain execution aborted', {
					totalTasks: tasks.length,
					executedTasks: result.index,
					failedTask: result.index,
					totalDurationMs: totalDuration,
					error: message,
				});

				return {
					success: false,
					tasks: results,
					progress: {
						currentTaskIndex,
						totalTasks: tasks.length,
						currentWorkflowId,
					},
					failedTask: result,
					error: message,
					finalOutput,
				};
			}
		}

		const totalDuration = Date.now() - startTime;
		this.logger.info('🎉 Task chain execution completed successfully', {
			totalTasks: tasks.length,
			successfulTasks: results.filter((r) => r.status === 'succeeded').length,
			totalDurationMs: totalDuration,
			averageDurationPerTask: Math.round(totalDuration / tasks.length),
			hasFinalOutput: !!finalOutput,
			finalOutputKeys: finalOutput ? Object.keys(finalOutput) : [],
		});

		return {
			success: true,
			tasks: results,
			progress: {
				currentTaskIndex: tasks.length,
				totalTasks: tasks.length,
				currentWorkflowId: undefined,
			},
			finalOutput,
		};
	}

	private normalizeIoType(value?: string | null): TaskIoType | undefined {
		if (!value) {
			return undefined;
		}

		const normalized = value.toString().trim().toLowerCase();
		switch (normalized) {
			case 'json':
				return 'JSON';
			case 'png':
				return 'png';
			case 'noinput':
			case 'no-input':
				return 'noInput';
			case 'nooutput':
			case 'no-output':
				return 'noOutput';
			default:
				return undefined;
		}
	}

	private resolveIoType(
		taskValue?: string,
		descriptionValue?: TaskIoType,
		fallback: TaskIoType = 'noInput',
	) {
		return this.normalizeIoType(taskValue) ?? descriptionValue ?? fallback;
	}

	private async loadWorkflow(workflowId: string, user: User): Promise<WorkflowEntity> {
		try {
			const workflow = await this.workflowFinderService.findWorkflowForUser(workflowId, user, [
				'workflow:execute',
			]);

			if (!workflow) {
				this.logger.error('Workflow not found or user lacks permission', {
					workflowId,
					userId: user.id,
					userEmail: user.email,
				});
				throw new NotFoundError(`Workflow with ID "${workflowId}" not found`);
			}

			return workflow;
		} catch (error) {
			this.logger.error('Failed to load workflow', {
				workflowId,
				userId: user.id,
				error: error instanceof Error ? error.message : 'Unknown error',
				errorStack: error instanceof Error ? error.stack : undefined,
			});
			throw error;
		}
	}

	private prepareInputData(args: {
		inputType: TaskIoType;
		isFirstTask: boolean;
		userPrompt?: string;
		previousOutput?: INodeExecutionData[];
	}): { inputData?: INodeExecutionData[]; inputPresentation?: IDataObject } {
		const { inputType, isFirstTask, userPrompt, previousOutput } = args;

		this.logger.debug('Preparing input data', {
			inputType,
			isFirstTask,
			hasUserPrompt: !!userPrompt,
			hasPreviousOutput: !!previousOutput,
		});

		if (inputType === 'noInput') {
			this.logger.debug('No input required for this task');
			return {};
		}

		if (inputType === 'JSON') {
			if (previousOutput?.length) {
				this.logger.debug('Using previous task output as JSON input', {
					previousOutputLength: previousOutput.length,
				});
				const payload = this.extractPrimaryJson(previousOutput);
				if (!payload) {
					this.logger.error('Previous task did not return JSON data', {
						previousOutputLength: previousOutput.length,
						previousOutput: previousOutput.map((item) => ({
							hasJson: !!item.json,
							hasBinary: !!item.binary,
						})),
					});
					throw new BadRequestError('Previous task did not return JSON data to pass forward');
				}
				this.logger.debug('✅ JSON payload extracted from previous output', {
					payloadKeys: Object.keys(payload),
				});
				return { inputData: [{ json: payload }], inputPresentation: payload };
			}

			if (isFirstTask) {
				if (!userPrompt?.trim()) {
					this.logger.error('User prompt required but not provided for first task');
					throw new BadRequestError('User prompt is required for the first JSON-input workflow');
				}
				const payload: IDataObject = { prompt: userPrompt };
				this.logger.debug('✅ Using user prompt as JSON input', {
					promptLength: userPrompt.length,
				});
				return { inputData: [{ json: payload }], inputPresentation: payload };
			}

			this.logger.error('Unable to resolve JSON input', {
				inputType,
				isFirstTask,
				hasUserPrompt: !!userPrompt,
				hasPreviousOutput: !!previousOutput,
			});
			throw new BadRequestError('Unable to resolve JSON input payload for task');
		}

		if (inputType === 'png') {
			this.logger.debug('Looking for PNG/binary data in previous output');
			const binarySource = previousOutput?.find((item) => item.binary);
			if (!binarySource?.binary) {
				this.logger.error('Previous task did not return PNG/binary data', {
					previousOutputLength: previousOutput?.length || 0,
					itemsWithBinary: previousOutput?.filter((item) => item.binary).length || 0,
				});
				throw new BadRequestError('Previous task did not return PNG/binary data');
			}
			this.logger.debug('✅ Binary data found', {
				binaryKeys: Object.keys(binarySource.binary),
			});
			return {
				inputData: [
					{
						json: binarySource.json ?? {},
						binary: binarySource.binary,
					},
				],
				inputPresentation: binarySource.json ?? {},
			};
		}

		this.logger.debug('Returning empty input data (unhandled input type)', { inputType });
		return {};
	}

	private extractPrimaryJson(data?: INodeExecutionData[]): IDataObject | undefined {
		if (!data || data.length === 0) {
			return undefined;
		}

		// Find the first item with JSON data
		const first = data.find((item) => item.json);
		if (!first?.json) {
			this.logger.debug('No JSON data found in output', {
				dataLength: data.length,
				items: data.map((item) => ({
					hasJson: !!item.json,
					hasBinary: !!item.binary,
					jsonKeys: item.json ? Object.keys(item.json) : [],
				})),
			});
			return undefined;
		}

		const json = first.json as IDataObject;

		// Log what we're extracting
		this.logger.debug('Extracted JSON from output', {
			jsonKeys: Object.keys(json),
			jsonPreview: JSON.stringify(json).substring(0, 200),
		});

		// If the output only contains the input prompt, that's suspicious
		if (Object.keys(json).length === 1 && json.prompt && typeof json.prompt === 'string') {
			this.logger.warn(
				'⚠️ Output appears to be just the input prompt - workflow may not have processed the data',
				{
					prompt: json.prompt.substring(0, 100),
				},
			);
		}

		return json;
	}

	private async executeWorkflowAndWait(args: {
		workflow: WorkflowEntity;
		user: User;
		inputData?: INodeExecutionData[];
	}) {
		const { workflow, user, inputData } = args;

		this.logger.debug('Executing workflow using manual execution path', {
			workflowId: workflow.id,
			workflowName: workflow.name,
			hasInputData: !!inputData,
		});

		// Find the trigger node to pass data to
		const triggerNode = this.findTriggerNode(workflow);

		// Prepare execution payload for manual execution (same as frontend run button)
		const executionPayload: any = {
			workflowData: workflow,
			runData: undefined,
			startNodes: undefined,
			triggerToStartFrom: undefined,
			destinationNode: undefined,
		};

		// If we have input data and a trigger node, format it for manual execution
		if (inputData && triggerNode) {
			this.logger.debug('Preparing input data for trigger node', {
				workflowId: workflow.id,
				triggerNodeName: triggerNode.name,
			});

			// Format input data as n8n expects for manual execution
			const formattedData: ITaskData = {
				startTime: Date.now(),
				executionTime: 0,
				executionIndex: 0,
				source: [null],
				executionStatus: 'success',
				data: {
					main: [inputData],
				},
			};

			// Set the trigger to start from with the data
			executionPayload.triggerToStartFrom = {
				name: triggerNode.name,
				data: formattedData,
			};

			// Set startNodes to tell n8n which node to begin execution from
			executionPayload.startNodes = [
				{
					name: triggerNode.name,
					sourceData: null,
				},
			];

			// Ensure manual execution starts immediately without waiting for webhooks
			executionPayload.runData = {};
			executionPayload.destinationNode = triggerNode.name;
		} else if (triggerNode) {
			// No input data, but we still need to tell it which trigger to start from
			executionPayload.startNodes = [
				{
					name: triggerNode.name,
					sourceData: null,
				},
			];

			this.logger.debug('Executing workflow without input data', {
				workflowId: workflow.id,
				triggerNodeName: triggerNode.name,
			});

			// Still set destination/runData so executeManually won't wait for a webhook
			executionPayload.runData = {};
			executionPayload.destinationNode = triggerNode.name;
		}

		// Execute the workflow using manual execution path (same as frontend run button)
		this.logger.debug('Calling executeManually', {
			workflowId: workflow.id,
			userId: user.id,
			hasStartNodes: !!executionPayload.startNodes,
			hasTriggerToStartFrom: !!executionPayload.triggerToStartFrom,
		});

		let executionResponse;
		try {
			executionResponse = await this.workflowExecutionService.executeManually(
				executionPayload,
				user,
				undefined, // pushRef
			);
		} catch (error) {
			this.logger.error('Failed to start workflow execution', {
				workflowId: workflow.id,
				workflowName: workflow.name,
				userId: user.id,
				error: error instanceof Error ? error.message : 'Unknown error',
				errorStack: error instanceof Error ? error.stack : undefined,
				errorType: error instanceof Error ? error.constructor.name : 'Unknown',
			});
			throw error;
		}

		if (!executionResponse || !executionResponse.executionId) {
			this.logger.error('Execution response missing executionId', {
				workflowId: workflow.id,
				hasExecutionResponse: !!executionResponse,
				executionResponse,
			});
			throw new InternalServerError(`Failed to start execution for workflow "${workflow.id}"`);
		}

		this.logger.info('⏳ Workflow execution started, waiting for completion', {
			executionId: executionResponse.executionId,
			workflowId: workflow.id,
			workflowName: workflow.name,
		});

		// Wait for the execution to complete
		let runData;
		try {
			runData = await this.activeExecutions.getPostExecutePromise(executionResponse.executionId);
		} catch (error) {
			this.logger.error('Error while waiting for execution to complete', {
				executionId: executionResponse.executionId,
				workflowId: workflow.id,
				error: error instanceof Error ? error.message : 'Unknown error',
				errorStack: error instanceof Error ? error.stack : undefined,
			});
			throw error;
		}

		if (!runData) {
			this.logger.error('Execution completed but returned no data', {
				executionId: executionResponse.executionId,
				workflowId: workflow.id,
			});
			throw new InternalServerError(
				`Execution "${executionResponse.executionId}" did not return any data`,
			);
		}

		// Check if execution was successful
		if (runData.data.resultData.error) {
			const error = runData.data.resultData.error;
			const errorNode = 'node' in error && error.node ? error.node : undefined;
			this.logger.error('Workflow execution failed with error', {
				executionId: executionResponse.executionId,
				workflowId: workflow.id,
				workflowName: workflow.name,
				errorMessage: error.message,
				errorStack: error.stack,
				errorNode: errorNode?.name,
				errorNodeType: errorNode?.type,
				executionStatus: runData.status,
			});
			throw new InternalServerError(
				`Workflow execution failed: ${error.message || 'Unknown error'}`,
			);
		}

		this.logger.info('✅ Workflow execution completed successfully', {
			executionId: executionResponse.executionId,
			workflowId: workflow.id,
			workflowName: workflow.name,
			finished: runData.finished,
			status: runData.status,
			executedNodes: Object.keys(runData.data?.resultData?.runData || {}).length,
		});

		return { executionId: executionResponse.executionId, runData };
	}

	private findTriggerNode(workflow: WorkflowEntity): INode | null {
		if (!workflow.nodes || !Array.isArray(workflow.nodes)) {
			return null;
		}

		// Look for common trigger node types
		const triggerTypes = [
			'n8n-nodes-base.manualTrigger',
			'n8n-nodes-base.webhook',
			'n8n-nodes-base.webhookTrigger',
			'@n8n/n8n-nodes-langchain.manualChatTrigger',
		];

		// Find the first trigger node
		const triggerNode = workflow.nodes.find(
			(node: INode) =>
				triggerTypes.includes(node.type) || node.type?.toLowerCase().includes('trigger'),
		);

		if (triggerNode) {
			this.logger.debug('Found trigger node', {
				workflowId: workflow.id,
				nodeName: triggerNode.name,
				nodeType: triggerNode.type,
			});
		} else {
			this.logger.warn('No trigger node found in workflow', {
				workflowId: workflow.id,
				nodeTypes: workflow.nodes.map((n: INode) => n.type),
			});
		}

		return triggerNode || null;
	}

	private extractRespondNodeOutput(
		run: IRun,
		workflow: WorkflowEntity,
	): INodeExecutionData[] | undefined {
		this.logger.debug('Extracting output from workflow execution', {
			workflowId: workflow.id,
			lastNodeExecuted: run.data?.resultData?.lastNodeExecuted,
			allExecutedNodes: run.data?.resultData?.runData
				? Object.keys(run.data.resultData.runData)
				: [],
		});

		// First, try to find "Return to Task Manager" or respond nodes
		const respondNodes = this.getRespondNodes(workflow);
		this.logger.debug('Checking respond nodes for output', {
			respondNodeCount: respondNodes.length,
			respondNodeNames: respondNodes.map((n) => n.name),
		});

		for (const node of respondNodes) {
			const data = this.getNodeRunOutput(run, node.name);
			if (data?.length) {
				this.logger.info('✅ Found output from respond node', {
					nodeName: node.name,
					nodeType: node.type,
					outputLength: data.length,
					firstItemKeys: data[0]?.json ? Object.keys(data[0].json) : [],
				});
				return data;
			}
		}

		// Try to find any node with "task" or "return" in the name (case-insensitive)
		const taskManagerNodes = (workflow.nodes ?? []).filter(
			(node) =>
				node.name.toLowerCase().includes('task') ||
				node.name.toLowerCase().includes('return') ||
				node.type.toLowerCase().includes('task'),
		);
		this.logger.debug('Checking task manager related nodes', {
			taskManagerNodeCount: taskManagerNodes.length,
			taskManagerNodeNames: taskManagerNodes.map((n) => `${n.name}:${n.type}`),
		});

		for (const node of taskManagerNodes) {
			const data = this.getNodeRunOutput(run, node.name);
			if (data?.length) {
				this.logger.info('✅ Found output from task manager node', {
					nodeName: node.name,
					nodeType: node.type,
					outputLength: data.length,
					firstItemKeys: data[0]?.json ? Object.keys(data[0].json) : [],
				});
				return data;
			}
		}

		// Check last executed node
		const lastNodeName = run.data?.resultData?.lastNodeExecuted;
		if (lastNodeName) {
			this.logger.debug('Checking last executed node for output', {
				lastNodeName,
			});
			const fallback = this.getNodeRunOutput(run, lastNodeName);
			if (fallback?.length) {
				this.logger.info('✅ Found output from last executed node', {
					nodeName: lastNodeName,
					outputLength: fallback.length,
					firstItemKeys: fallback[0]?.json ? Object.keys(fallback[0].json) : [],
				});
				return fallback;
			}
		}

		// Try all nodes that executed (in reverse order to get the most recent)
		// Skip trigger nodes as they typically just pass through input
		const triggerNodeNames = new Set(
			(workflow.nodes ?? [])
				.filter((n) => {
					const triggerTypes = [
						'n8n-nodes-base.manualTrigger',
						'n8n-nodes-base.webhook',
						'n8n-nodes-base.webhookTrigger',
						'@n8n/n8n-nodes-langchain.manualChatTrigger',
					];
					return triggerTypes.includes(n.type) || n.type?.toLowerCase().includes('trigger');
				})
				.map((n) => n.name),
		);

		const executedNodeNames = run.data?.resultData?.runData
			? Object.keys(run.data.resultData.runData)
					.filter((name) => !triggerNodeNames.has(name))
					.reverse()
			: [];
		this.logger.debug('Checking all executed nodes for output (excluding triggers)', {
			executedNodeCount: executedNodeNames.length,
			executedNodeNames,
			excludedTriggerNodes: Array.from(triggerNodeNames),
		});

		for (const nodeName of executedNodeNames) {
			const data = this.getNodeRunOutput(run, nodeName);
			if (data?.length) {
				const node = workflow.nodes?.find((n) => n.name === nodeName);
				this.logger.info('✅ Found output from executed node', {
					nodeName,
					nodeType: node?.type,
					outputLength: data.length,
					firstItemKeys: data[0]?.json ? Object.keys(data[0].json) : [],
				});
				return data;
			}
		}

		// Fallback to WorkflowHelpers
		this.logger.debug('Using WorkflowHelpers to get last executed node data');
		const lastExecuted = WorkflowHelpers.getDataLastExecutedNodeData(run);
		const mainOutput = lastExecuted?.data?.main;
		if (!mainOutput?.length) {
			this.logger.warn('❌ No output data found in workflow execution', {
				workflowId: workflow.id,
				lastNodeExecuted: lastNodeName,
				hasLastExecutedData: !!lastExecuted,
				executedNodeNames,
				workflowNodeNames: workflow.nodes?.map((n) => n.name) || [],
			});
			return undefined;
		}
		this.logger.info('✅ Found output from last executed node data (WorkflowHelpers)', {
			outputBranchCount: mainOutput.length,
			firstBranchLength: mainOutput[0]?.length || 0,
			firstItemKeys: mainOutput[0]?.[0]?.json ? Object.keys(mainOutput[0][0].json) : [],
		});
		return mainOutput[0] ?? undefined;
	}

	private getRespondNodes(workflow: WorkflowEntity): INode[] {
		return (workflow.nodes ?? []).filter((node) => node.type === 'n8n-nodes-base.respondToWebhook');
	}

	private getNodeRunOutput(run: IRun, nodeName: string): INodeExecutionData[] | undefined {
		const nodeRuns = run.data?.resultData?.runData?.[nodeName];
		if (!nodeRuns?.length) {
			this.logger.debug('No run data for node', { nodeName });
			return undefined;
		}
		const latestRun = nodeRuns[nodeRuns.length - 1];
		const mainOutput = latestRun?.data?.main;
		if (!mainOutput?.length) {
			this.logger.debug('No main output for node', {
				nodeName,
				hasLatestRun: !!latestRun,
				hasData: !!latestRun?.data,
			});
			return undefined;
		}
		const output = mainOutput[0];
		this.logger.debug('Found node output', {
			nodeName,
			outputLength: output?.length || 0,
			hasJson: output?.[0]?.json ? true : false,
			hasBinary: output?.[0]?.binary ? true : false,
		});
		return output ?? undefined;
	}

	private getWebhookInfo(workflow: WorkflowEntity): { path: string; method: string } | null {
		const webhookNode = workflow.nodes?.find((node) => node.type === 'n8n-nodes-base.webhook');

		if (!webhookNode || !webhookNode.parameters) {
			return null;
		}

		const path = webhookNode.parameters.path as string;
		const method = (webhookNode.parameters.httpMethod as string) || 'GET';

		if (!path) {
			this.logger.warn('Webhook node found but no path configured', {
				workflowId: workflow.id,
				nodeName: webhookNode.name,
			});
			return null;
		}

		return { path, method: method.toUpperCase() };
	}

	private async executeViaWebhook(
		workflow: WorkflowEntity,
		webhookInfo: { path: string; method: string },
	): Promise<IDataObject | null> {
		// Get the base URL for webhooks (localhost in development, real URL in production)
		const baseUrl = process.env.WEBHOOK_URL || 'http://localhost:5678';

		// Use production webhook path (requires workflow to be active)
		// If workflow is not active, we need to activate it first or use test webhook
		const webhookUrl = `${baseUrl}/webhook/${webhookInfo.path}`;

		this.logger.info('Calling production webhook', {
			workflowId: workflow.id,
			workflowActive: workflow.active,
			webhookUrl,
			method: webhookInfo.method,
		});

		try {
			const response = await fetch(webhookUrl, {
				method: webhookInfo.method,
				headers: {
					'Content-Type': 'application/json',
				},
			});

			if (!response.ok) {
				this.logger.error('Webhook call failed', {
					workflowId: workflow.id,
					webhookUrl,
					status: response.status,
					statusText: response.statusText,
				});
				throw new Error(`Webhook returned ${response.status}: ${response.statusText}`);
			}

			const contentType = response.headers.get('content-type');
			if (contentType && contentType.includes('application/json')) {
				const result = await response.json();
				this.logger.info('Webhook returned JSON', {
					workflowId: workflow.id,
					resultKeys: result ? Object.keys(result) : [],
					resultPreview: JSON.stringify(result).substring(0, 200),
				});
				return result as IDataObject;
			} else {
				const text = await response.text();
				this.logger.info('Webhook returned non-JSON', {
					workflowId: workflow.id,
					contentType,
					textLength: text.length,
					textPreview: text.substring(0, 200),
				});
				return { response: text } as IDataObject;
			}
		} catch (error) {
			this.logger.error('Failed to execute workflow via webhook', {
				workflowId: workflow.id,
				webhookUrl,
				error: error instanceof Error ? error.message : 'Unknown error',
				stack: error instanceof Error ? error.stack : undefined,
			});
			throw error;
		}
	}
}
