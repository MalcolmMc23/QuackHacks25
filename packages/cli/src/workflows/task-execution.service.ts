import { Logger } from '@n8n/backend-common';
import { Service } from '@n8n/di';
import type { User } from '@n8n/db';
import type { IDataObject, IRun, INodeExecutionData, ITaskData } from 'n8n-workflow';

import { WorkflowFinderService } from './workflow-finder.service';
import { WorkflowExecutionService } from './workflow-execution.service';
import { ActiveExecutions } from '@/active-executions';
import { NotFoundError } from '@/errors/response-errors/not-found.error';
import { InternalServerError } from '@/errors/response-errors/internal-server.error';
import * as WorkflowHelpers from '@/workflow-helpers';

export interface TaskProgress {
	status: 'starting' | 'executing' | 'completed' | 'error';
	currentTask: number;
	totalTasks: number;
	workflowId: string;
	workflowName: string;
	message: string;
	error?: string;
}

export interface Task {
	workflowId: string;
	task: string;
	input: string; // "JSON" | "png" | "noInput"
	output: string; // "JSON" | "png" | "noOutput"
}

export interface TaskChainResult {
	success: boolean;
	output?: any;
	error?: string;
	executedTasks: number;
	failedTask?: string;
}

type ProgressCallback = (progress: TaskProgress) => void;

@Service()
export class TaskExecutionService {
	constructor(
		private readonly logger: Logger,
		private readonly workflowFinderService: WorkflowFinderService,
		private readonly workflowExecutionService: WorkflowExecutionService,
		private readonly activeExecutions: ActiveExecutions,
	) {}

	async executeTaskChain(
		user: User,
		tasks: Task[],
		userPrompt: string,
		progressCallback: ProgressCallback,
	): Promise<TaskChainResult> {
		const totalTasks = tasks.length;
		let currentOutput: any = null;
		let executedTasks = 0;

		this.logger.info('Starting task chain execution', {
			totalTasks,
			userPrompt,
		});

		try {
			for (let i = 0; i < tasks.length; i++) {
				const task = tasks[i];
				const isFirstTask = i === 0;

				// Send starting progress
				progressCallback({
					status: 'starting',
					currentTask: i + 1,
					totalTasks,
					workflowId: task.workflowId,
					workflowName: task.workflowId,
					message: `Starting task ${i + 1} of ${totalTasks}: ${task.task}`,
				});

				this.logger.info(`Executing task ${i + 1}/${totalTasks}`, {
					workflowId: task.workflowId,
					inputType: task.input,
					outputType: task.output,
				});

				// Send executing progress
				progressCallback({
					status: 'executing',
					currentTask: i + 1,
					totalTasks,
					workflowId: task.workflowId,
					workflowName: task.workflowId,
					message: `Executing workflow: ${task.task}`,
				});

				// Determine input data
				const inputData = this.prepareInputData(task, currentOutput, isFirstTask, userPrompt);

				// Execute the workflow
				const executionResult = await this.executeWorkflowTask(user, task, inputData);

				// Extract output for next task
				currentOutput = this.extractWorkflowOutput(executionResult);

				executedTasks++;

				// Send completed progress
				progressCallback({
					status: 'completed',
					currentTask: i + 1,
					totalTasks,
					workflowId: task.workflowId,
					workflowName: task.workflowId,
					message: `Completed task ${i + 1} of ${totalTasks}`,
				});

				this.logger.info(`Task ${i + 1}/${totalTasks} completed successfully`, {
					workflowId: task.workflowId,
					hasOutput: !!currentOutput,
				});
			}

			return {
				success: true,
				output: currentOutput,
				executedTasks,
			};
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';

			this.logger.error('Task chain execution failed', {
				error: errorMessage,
				executedTasks,
				totalTasks,
			});

			return {
				success: false,
				error: errorMessage,
				executedTasks,
				failedTask: executedTasks < totalTasks ? tasks[executedTasks].workflowId : undefined,
			};
		}
	}

	private prepareInputData(
		task: Task,
		previousOutput: any,
		isFirstTask: boolean,
		userPrompt: string,
	): any {
		// If the workflow doesn't expect input, return null
		if (task.input === 'noInput') {
			this.logger.debug('Workflow expects no input', { workflowId: task.workflowId });
			return null;
		}

		// For the first task, use the user prompt if it expects input
		if (isFirstTask && task.input !== 'noInput') {
			this.logger.debug('Using user prompt as input for first task', {
				workflowId: task.workflowId,
			});
			return { prompt: userPrompt };
		}

		// For subsequent tasks, use the previous output
		if (previousOutput) {
			this.logger.debug('Using previous task output as input', {
				workflowId: task.workflowId,
				inputType: task.input,
			});
			return previousOutput;
		}

		// If we're here, something is wrong - we expected input but don't have it
		this.logger.warn('Workflow expects input but none is available', {
			workflowId: task.workflowId,
			inputType: task.input,
			isFirstTask,
		});
		return null;
	}

	private async executeWorkflowTask(
		user: User,
		task: Task,
		inputData: any,
	): Promise<IRun | undefined> {
		// Fetch the workflow
		const workflow = await this.workflowFinderService.findWorkflowForUser(task.workflowId, user, [
			'workflow:execute',
		]);

		if (!workflow) {
			throw new NotFoundError(`Workflow with ID "${task.workflowId}" not found`);
		}

		this.logger.debug('Workflow found, preparing execution', {
			workflowId: task.workflowId,
			workflowName: workflow.name,
			hasInputData: !!inputData,
		});

		// Find the trigger node to pass data to
		const triggerNode = this.findTriggerNode(workflow);

		// Prepare execution data
		const executionPayload: any = {
			workflowData: workflow,
			runData: undefined,
			startNodes: undefined,
			triggerToStartFrom: undefined,
			destinationNode: undefined,
		};

		// If we have input data and a trigger node, format it properly
		if (inputData && triggerNode && task.input !== 'noInput') {
			this.logger.debug('Preparing input data for trigger node', {
				workflowId: task.workflowId,
				triggerNodeName: triggerNode.name,
			});

			// Format input data as n8n expects it
			const formattedData: ITaskData = {
				startTime: Date.now(),
				executionTime: 0,
				executionIndex: 0,
				source: [null], // Required by ITaskStartedData
				executionStatus: 'success',
				data: {
					main: [
						[
							{
								json: inputData,
							},
						],
					],
				},
			};

			// Set the trigger to start from with the data
			executionPayload.triggerToStartFrom = {
				name: triggerNode.name,
				data: formattedData,
			};

			// Also set startNodes to tell n8n which node to begin execution from
			executionPayload.startNodes = [
				{
					name: triggerNode.name,
					sourceData: null,
				},
			];

			// Ensure manual execution knows it can start immediately without webhooks
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
				workflowId: task.workflowId,
				triggerNodeName: triggerNode.name,
			});

			// Still set destination/runData so executeManually won't wait for a webhook
			executionPayload.runData = {};
			executionPayload.destinationNode = triggerNode.name;
		}

		// Execute the workflow
		const executionResponse = await this.workflowExecutionService.executeManually(
			executionPayload,
			user,
			undefined, // pushRef
		);

		if (!executionResponse || !executionResponse.executionId) {
			throw new InternalServerError(`Failed to start execution for workflow "${task.workflowId}"`);
		}

		this.logger.debug('Workflow execution started, waiting for completion', {
			executionId: executionResponse.executionId,
			workflowId: task.workflowId,
		});

		// Wait for the execution to complete
		const runData = await this.activeExecutions.getPostExecutePromise(
			executionResponse.executionId,
		);

		if (!runData) {
			throw new InternalServerError(
				`Execution "${executionResponse.executionId}" did not return any data`,
			);
		}

		// Check if execution was successful
		if (runData.data.resultData.error) {
			const error = runData.data.resultData.error;
			throw new InternalServerError(
				`Workflow execution failed: ${error.message || 'Unknown error'}`,
			);
		}

		this.logger.debug('Workflow execution completed successfully', {
			executionId: executionResponse.executionId,
			workflowId: task.workflowId,
			finished: runData.finished,
		});

		return runData;
	}

	private findTriggerNode(workflow: any): any | null {
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
			(node: any) =>
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
				nodeTypes: workflow.nodes.map((n: any) => n.type),
			});
		}

		return triggerNode || null;
	}

	private extractWorkflowOutput(executionData: IRun | undefined): any {
		if (!executionData) {
			this.logger.debug('No execution data to extract output from');
			return null;
		}

		try {
			// Use WorkflowHelpers to get the last executed node's data
			const lastNodeData = WorkflowHelpers.getDataLastExecutedNodeData(executionData);

			if (!lastNodeData || !lastNodeData.data) {
				this.logger.debug('No data in last executed node');
				return null;
			}

			// Extract the main output data
			const mainOutput = lastNodeData.data.main;

			if (!mainOutput || mainOutput.length === 0) {
				this.logger.debug('No main output data');
				return null;
			}

			// Get the first output branch's data
			const outputData = mainOutput[0];

			if (!outputData || outputData.length === 0) {
				this.logger.debug('Output branch is empty');
				return null;
			}

			// Return the JSON data from the first item
			// This assumes the output is JSON-serializable
			const output = outputData[0]?.json;

			this.logger.debug('Successfully extracted workflow output', {
				hasOutput: !!output,
				outputKeys: output ? Object.keys(output as object).length : 0,
			});

			return output;
		} catch (error) {
			this.logger.error('Failed to extract workflow output', {
				error: error instanceof Error ? error.message : 'Unknown error',
			});
			return null;
		}
	}
}
