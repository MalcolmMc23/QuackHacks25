<script setup lang="ts">
import { computed, nextTick, ref, useTemplateRef, watch } from 'vue';
import {
	N8nButton,
	N8nIconButton,
	N8nInput,
	N8nInputLabel,
	N8nPopoverReka,
	N8nTooltip,
	N8nText,
} from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { useWorkflowsStore } from '@/app/stores/workflows.store';
import { useUIStore } from '@/app/stores/ui.store';
import { useToast } from '@/app/composables/useToast';
import { useTelemetry } from '@/app/composables/useTelemetry';
import type { IDataObject } from 'n8n-workflow';

type Props = {
	workflowId: string;
	workflowDescription?: IDataObject | null;
};

const props = withDefaults(defineProps<Props>(), {
	workflowDescription: null,
});

const i18n = useI18n();
const toast = useToast();
const telemetry = useTelemetry();

const workflowStore = useWorkflowsStore();
const uiStore = useUIStore();

// User input text (plain text, not JSON)
const userInput = ref('');
const popoverOpen = ref(false);
const textInput = useTemplateRef<HTMLTextAreaElement>('textInput');
const isGenerating = ref(false);
const aiResponse = ref<IDataObject | null>(props.workflowDescription);

// Convert IDataObject to JSON string for display
const getJsonString = (obj: IDataObject | null | undefined): string => {
	if (!obj) return '';
	try {
		return JSON.stringify(obj, null, 2);
	} catch {
		return '';
	}
};

const normalizedUserInput = computed(() => userInput.value.trim());
const canGenerate = computed(() => normalizedUserInput.value.length > 0 && !isGenerating.value);

const generateDescription = async () => {
	if (!canGenerate.value) return;

	isGenerating.value = true;
	uiStore.addActiveAction('workflowSaving');

	try {
		const response = await workflowStore.generateWorkflowDescription(
			props.workflowId,
			normalizedUserInput.value,
		);
		aiResponse.value = response;
		userInput.value = ''; // Clear user input after successful generation
		uiStore.stateIsDirty = false;
		telemetry.track('User generated workflow description with AI', {
			workflow_id: props.workflowId,
			has_response: response !== null,
		});
	} catch (error) {
		toast.showError(error, i18n.baseText('workflow.description.error.title'));
	} finally {
		isGenerating.value = false;
		uiStore.removeActiveAction('workflowSaving');
	}
};

const handlePopoverOpenChange = async (open: boolean) => {
	popoverOpen.value = open;
	if (open) {
		await nextTick();
		textInput.value?.focus();
	} else {
		// Clear user input on close (we don't store it)
		userInput.value = '';
	}
};

const handleKeyDown = async (event: KeyboardEvent) => {
	// Escape - cancel editing
	if (event.key === 'Escape') {
		event.preventDefault();
		event.stopPropagation();
		await cancel();
	}

	// Ctrl/Cmd + Enter - generate and close
	if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
		if (!canGenerate.value) {
			return;
		}

		event.preventDefault();
		event.stopPropagation();
		await generate();
	}
};

const cancel = async () => {
	userInput.value = '';
	uiStore.stateIsDirty = false;
	popoverOpen.value = false;
};

const generate = async () => {
	await generateDescription();
	// Keep popover open to show the result, or close it
	// For now, let's close it after successful generation
	if (aiResponse.value) {
		popoverOpen.value = false;
	}
};

// Sync with external prop changes
watch(
	() => props.workflowDescription,
	(newValue) => {
		aiResponse.value = newValue;
	},
);
</script>
<template>
	<N8nTooltip
		:disabled="popoverOpen"
		:content="i18n.baseText('workflow.descriptionJson.tooltip', 'Workflow Description (JSON)')"
	>
		<div
			:class="$style['description-json-popover-wrapper']"
			data-test-id="workflow-description-json-popover"
		>
			<N8nPopoverReka
				id="workflow-description-json-popover"
				:open="popoverOpen"
				@update:open="handlePopoverOpenChange"
			>
				<template #trigger>
					<N8nIconButton
						:class="{
							[$style['description-json-button']]: true,
							[$style.active]: popoverOpen,
						}"
						:square="true"
						data-test-id="workflow-description-json-button"
						icon="code"
						type="tertiary"
						size="small"
						:aria-label="
							i18n.baseText('workflow.descriptionJson.tooltip', 'Workflow Description (JSON)')
						"
					/>
				</template>
				<template #content>
					<div
						:class="$style['description-json-edit-content']"
						data-test-id="workflow-description-json-edit-content"
					>
						<N8nInputLabel
							:label="
								i18n.baseText('workflow.descriptionJson.label', 'Generate Workflow Description')
							"
							:tooltip-text="
								i18n.baseText(
									'workflow.descriptionJson.tooltip',
									'Enter a message describing what you want to know about this workflow. The AI will analyze the workflow nodes and generate a JSON description.',
								)
							"
						>
							<N8nInput
								ref="textInput"
								v-model="userInput"
								:placeholder="
									i18n.baseText(
										'workflow.descriptionJson.placeholder',
										'Describe what you want to know about this workflow...',
									)
								"
								:rows="6"
								data-test-id="workflow-description-json-input"
								type="textarea"
								:disabled="isGenerating"
								@keydown="handleKeyDown"
							/>
						</N8nInputLabel>
						<div v-if="aiResponse" :class="$style['ai-response-section']">
							<N8nText size="small" bold :class="$style['response-label']">
								{{ i18n.baseText('workflow.descriptionJson.aiResponse', 'AI Response:') }}
							</N8nText>
							<pre :class="$style['json-display']">{{ getJsonString(aiResponse) }}</pre>
						</div>
					</div>
					<footer :class="$style['popover-footer']">
						<N8nButton
							:label="i18n.baseText('generic.cancel')"
							:size="'small'"
							:disabled="isGenerating"
							type="tertiary"
							data-test-id="workflow-description-json-cancel-button"
							@click="cancel"
						/>
						<N8nButton
							:label="i18n.baseText('workflow.descriptionJson.generate', 'Generate')"
							:size="'small'"
							:loading="isGenerating"
							:disabled="!canGenerate"
							type="primary"
							data-test-id="workflow-description-json-generate-button"
							@click="generate"
						/>
					</footer>
				</template>
			</N8nPopoverReka>
		</div>
	</N8nTooltip>
</template>

<style module lang="scss">
.description-json-button {
	border: none;
	position: relative;

	&.active {
		color: var(--color--background--shade-2);
	}

	&:hover,
	&:focus,
	&:focus-visible,
	&:active {
		background: none;
		background-color: transparent !important;
		outline: none !important;
		color: var(--color--background--shade-2) !important;
	}
}

.description-json-edit-content {
	display: flex;
	flex-direction: column;
	padding: var(--spacing--xs);
	width: 400px;
}

.ai-response-section {
	margin-top: var(--spacing--xs);
	padding-top: var(--spacing--xs);
	border-top: 1px solid var(--color--border-base);
}

.response-label {
	margin-bottom: var(--spacing--2xs);
	display: block;
}

.json-display {
	background: var(--color--background--shade-1);
	border: 1px solid var(--color--border-base);
	border-radius: var(--radius);
	padding: var(--spacing--xs);
	font-size: var(--font-size--2xs);
	font-family: var(--font-family--monospace);
	overflow-x: auto;
	max-height: 200px;
	overflow-y: auto;
	margin: 0;
	white-space: pre-wrap;
	word-break: break-word;
}

.popover-footer {
	display: flex;
	justify-content: flex-end;
	gap: var(--spacing--2xs);
	padding: 0 var(--spacing--xs) var(--spacing--xs);
}
</style>
