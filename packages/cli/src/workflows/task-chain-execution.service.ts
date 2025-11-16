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
} from 'n8n-workflow';

import { ActiveExecutions } from '@/active-executions';
import { BadRequestError } from '@/errors/response-errors/bad-request.error';
import { InternalServerError } from '@/errors/response-errors/internal-server.error';
import { NotFoundError } from '@/errors/response-errors/not-found.error';
import * as WorkflowExecuteAdditionalData from '@/workflow-execute-additional-data';
import * as WorkflowHelpers from '@/workflow-helpers';

import { WorkflowFinderService } from './workflow-finder.service';
import { WorkflowService } from './workflow.service';

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
		private readonly activeExecutions: ActiveExecutions,
	) {}

	async runTaskChain(params: {
		user: User;
		tasks: TaskPlanItem[];
		userPrompt?: string;
	}): Promise<TaskChainResult> {
		const { user, tasks, userPrompt } = params;

		if (!tasks.length) {
			throw new BadRequestError('Tasks array is required and must not be empty');
		}

		const workflowDescriptions = await this.workflowService.getWorkflowDescriptions(user);
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

			try {
				const workflow = await this.loadWorkflow(result.workflowId, user);

				const { inputData, inputPresentation } = this.prepareInputData({
					inputType: result.inputType,
					isFirstTask: result.index === 0,
					userPrompt,
					previousOutput: previousOutputData,
				});
				result.inputPayload = inputPresentation;

				const executionOutcome = await this.executeWorkflowAndWait({
					workflow,
					user,
					inputData,
				});
				result.executionId = executionOutcome.executionId;

				const taskOutputData = this.extractRespondNodeOutput(executionOutcome.runData, workflow);
				result.rawOutput = taskOutputData;
				result.outputPayload = this.extractPrimaryJson(taskOutputData);

				finalOutput = result.outputType === 'noOutput' ? undefined : result.outputPayload;
				previousOutputData =
					result.outputType === 'noOutput' ? undefined : (taskOutputData ?? previousOutputData);

				result.status = 'succeeded';
				result.finishedAt = new Date();
			} catch (error) {
				const message = error instanceof Error ? error.message : 'Unknown error';
				result.status = 'failed';
				result.finishedAt = new Date();
				result.error = message;
				this.logger.error('Task chain execution failed', {
					taskIndex: result.index,
					workflowId: result.workflowId,
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
		const workflow = await this.workflowFinderService.findWorkflowForUser(workflowId, user, [
			'workflow:execute',
		]);

		if (!workflow) {
			throw new NotFoundError(`Workflow with ID "${workflowId}" not found`);
		}

		return workflow;
	}

	private prepareInputData(args: {
		inputType: TaskIoType;
		isFirstTask: boolean;
		userPrompt?: string;
		previousOutput?: INodeExecutionData[];
	}): { inputData?: INodeExecutionData[]; inputPresentation?: IDataObject } {
		const { inputType, isFirstTask, userPrompt, previousOutput } = args;

		if (inputType === 'noInput') {
			return {};
		}

		if (inputType === 'JSON') {
			if (previousOutput?.length) {
				const payload = this.extractPrimaryJson(previousOutput);
				if (!payload) {
					throw new BadRequestError('Previous task did not return JSON data to pass forward');
				}
				return { inputData: [{ json: payload }], inputPresentation: payload };
			}

			if (isFirstTask) {
				if (!userPrompt?.trim()) {
					throw new BadRequestError('User prompt is required for the first JSON-input workflow');
				}
				const payload: IDataObject = { prompt: userPrompt };
				return { inputData: [{ json: payload }], inputPresentation: payload };
			}

			throw new BadRequestError('Unable to resolve JSON input payload for task');
		}

		if (inputType === 'png') {
			const binarySource = previousOutput?.find((item) => item.binary);
			if (!binarySource?.binary) {
				throw new BadRequestError('Previous task did not return PNG/binary data');
			}
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

		return {};
	}

	private extractPrimaryJson(data?: INodeExecutionData[]): IDataObject | undefined {
		const first = data?.find((item) => item.json);
		return (first?.json as IDataObject | undefined) ?? undefined;
	}

	private async executeWorkflowAndWait(args: {
		workflow: WorkflowEntity;
		user: User;
		inputData?: INodeExecutionData[];
	}) {
		const { workflow, user, inputData } = args;
		const workflowId = workflow.id;

		const workflowInfo: IExecuteWorkflowInfo = { id: workflowId };
		const additionalData = await WorkflowExecuteAdditionalData.getBase({
			userId: user.id,
			workflowId,
		});

		const options: ExecuteWorkflowOptions = {
			parentWorkflowId: workflowId,
			inputData,
			loadedWorkflowData: workflow as IWorkflowBase,
			parentWorkflowSettings: workflow.settings,
			doNotWaitToFinish: true,
		};

		const { executionId } = await WorkflowExecuteAdditionalData.executeWorkflow(
			workflowInfo,
			additionalData,
			options,
		);

		const runData = await this.activeExecutions.getPostExecutePromise(executionId);

		if (!runData) {
			throw new InternalServerError('Workflow execution returned no data');
		}

		if (runData.data?.resultData?.error) {
			const errorMessage = runData.data.resultData.error.message ?? 'Workflow execution failed';
			throw new InternalServerError(errorMessage);
		}

		return { executionId, runData };
	}

	private extractRespondNodeOutput(
		run: IRun,
		workflow: WorkflowEntity,
	): INodeExecutionData[] | undefined {
		const respondNodes = this.getRespondNodes(workflow);
		for (const node of respondNodes) {
			const data = this.getNodeRunOutput(run, node.name);
			if (data?.length) {
				return data;
			}
		}

		const lastNodeName = run.data?.resultData?.lastNodeExecuted;
		if (lastNodeName) {
			const fallback = this.getNodeRunOutput(run, lastNodeName);
			if (fallback?.length) {
				return fallback;
			}
		}

		const lastExecuted = WorkflowHelpers.getDataLastExecutedNodeData(run);
		const mainOutput = lastExecuted?.data?.main;
		if (!mainOutput?.length) {
			return undefined;
		}
		return mainOutput[0] ?? undefined;
	}

	private getRespondNodes(workflow: WorkflowEntity): INode[] {
		return (workflow.nodes ?? []).filter((node) => node.type === 'n8n-nodes-base.respondToWebhook');
	}

	private getNodeRunOutput(run: IRun, nodeName: string): INodeExecutionData[] | undefined {
		const nodeRuns = run.data?.resultData?.runData?.[nodeName];
		if (!nodeRuns?.length) {
			return undefined;
		}
		const latestRun = nodeRuns[nodeRuns.length - 1];
		const mainOutput = latestRun?.data?.main;
		if (!mainOutput?.length) {
			return undefined;
		}
		return mainOutput[0] ?? undefined;
	}
}
