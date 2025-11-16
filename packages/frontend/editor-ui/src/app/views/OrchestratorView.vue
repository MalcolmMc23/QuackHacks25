<script lang="ts" setup>
import { ref, computed, watch, onBeforeUnmount } from 'vue';
import { onClickOutside } from '@vueuse/core';
import { N8nIcon } from '@n8n/design-system';
import { makeRestApiRequest, streamRequest } from '@n8n/rest-api-client';
import { useRootStore } from '@n8n/stores/useRootStore';
import { useToast } from '@/app/composables/useToast';
import VueMarkdown from 'vue-markdown-render';

const PLACEHOLDERS = [
	'Generate website with HextaUI',
	'Create a new project with Next.js',
	'What is the meaning of life?',
	'What is the best way to learn React?',
	'How to cook a delicious meal?',
	'Summarize this article',
];

type OrchestratorChatResponse = {
	content: string;
	isTaskList?: boolean;
	tasks?: Array<{ workflowId: string; task: string }>;
};

const placeholderIndex = ref(0);
const showPlaceholder = ref(true);
const isActive = ref(false);
const inputValue = ref('');
const wrapperRef = ref<HTMLDivElement | null>(null);
const isSending = ref(false);
const messages = ref<
	Array<{
		id: string;
		type: 'user' | 'assistant';
		content: string;
		timestamp: Date;
		isTaskList?: boolean;
		tasks?: Array<{ workflowId: string; task: string }>;
	}>
>([]);

const rootStore = useRootStore();
const toast = useToast();

// Cycle placeholder text when input is inactive
let placeholderInterval: ReturnType<typeof setInterval> | null = null;

watch(
	[isActive, inputValue],
	() => {
		if (isActive.value || inputValue.value) {
			if (placeholderInterval) {
				clearInterval(placeholderInterval);
				placeholderInterval = null;
			}
			return;
		}

		placeholderInterval = setInterval(() => {
			showPlaceholder.value = false;
			setTimeout(() => {
				placeholderIndex.value = (placeholderIndex.value + 1) % PLACEHOLDERS.length;
				showPlaceholder.value = true;
			}, 400);
		}, 3000);
	},
	{ immediate: true },
);

// Close input when clicking outside (only if no input value)
onClickOutside(wrapperRef, () => {
	if (!inputValue.value) {
		isActive.value = false;
	}
});

const handleActivate = () => {
	isActive.value = true;
};

const sendMessage = async () => {
	if (isSending.value || !inputValue.value.trim()) return;

	const userMessage = {
		id: Date.now().toString(),
		type: 'user' as const,
		content: inputValue.value.trim(),
		timestamp: new Date(),
	};

	messages.value.push(userMessage);
	const currentInput = inputValue.value.trim();
	inputValue.value = '';
	isActive.value = false;

	try {
		isSending.value = true;

		// Build conversation history from existing messages
		const conversationHistory = messages.value
			.slice(0, -1) // Exclude the message we just added
			.map((msg) => ({
				role: msg.type === 'user' ? ('user' as const) : ('assistant' as const),
				content: msg.content,
			}));

		// Create assistant message placeholder for streaming
		const assistantMessageId = (Date.now() + 1).toString();
		const assistantMessage = {
			id: assistantMessageId,
			type: 'assistant' as const,
			content: '',
			timestamp: new Date(),
			isTaskList: false,
			tasks: [] as Array<{ workflowId: string; task: string }>,
		};
		messages.value.push(assistantMessage);

		// Stream the response
		await streamRequest<{
			content?: string;
			chunk?: string;
			isTaskList?: boolean;
			tasks?: Array<{ workflowId: string; task: string }>;
		}>(
			rootStore.restApiContext,
			'/orchestration/chat/stream',
			{
				userInput: currentInput,
				messages: conversationHistory,
			},
			(chunk) => {
				// Update the assistant message with streaming content
				const messageIndex = messages.value.findIndex((m) => m.id === assistantMessageId);
				if (messageIndex !== -1) {
					if (chunk.chunk) {
						// Streaming chunk
						messages.value[messageIndex].content += chunk.chunk;
					} else if (chunk.content) {
						// Full content update
						messages.value[messageIndex].content = chunk.content;
					}
					if (chunk.isTaskList !== undefined) {
						messages.value[messageIndex].isTaskList = chunk.isTaskList;
					}
					if (chunk.tasks) {
						messages.value[messageIndex].tasks = chunk.tasks;
					}
				}
			},
			() => {
				// Stream done
				isSending.value = false;
			},
			(error) => {
				// Stream error
				isSending.value = false;
				toast.showError(error, 'Orchestrator error', 'Failed to contact the orchestrator.');
				const messageIndex = messages.value.findIndex((m) => m.id === assistantMessageId);
				if (messageIndex !== -1) {
					messages.value[messageIndex].content =
						'Something went wrong while contacting the orchestrator.';
				}
			},
		);
	} catch (error) {
		isSending.value = false;
		toast.showError(error, 'Orchestrator error', 'Failed to contact the orchestrator.');
		const errorMessage = {
			id: (Date.now() + 2).toString(),
			type: 'assistant' as const,
			content: 'Something went wrong while contacting the orchestrator.',
			timestamp: new Date(),
			isTaskList: false,
			tasks: [],
		};
		messages.value.push(errorMessage);
	}
};

const handleKeyPress = (e: KeyboardEvent) => {
	if (e.key === 'Enter' && !e.shiftKey) {
		e.preventDefault();
		sendMessage();
	}
};

const handleRunTasks = async (tasks: Array<{ workflowId: string; task: string }>) => {
	// Validate tasks array
	if (!tasks || !Array.isArray(tasks) || tasks.length === 0) {
		toast.showError(
			new Error('No tasks available to execute'),
			'Task execution error',
			'Please ensure tasks are available before running.',
		);
		return;
	}

	// Filter out any invalid tasks
	const validTasks = tasks.filter(
		(task) =>
			task &&
			task.workflowId &&
			typeof task.workflowId === 'string' &&
			task.workflowId.trim() !== '',
	);

	if (validTasks.length === 0) {
		toast.showError(
			new Error('No valid tasks found'),
			'Task execution error',
			'All tasks are invalid or missing workflow IDs.',
		);
		return;
	}

	try {
		const response = await makeRestApiRequest<{
			success: boolean;
			executed: number;
			failed: number;
			errors?: Array<{ workflowId: string; error: string }>;
		}>(rootStore.restApiContext, 'POST', '/orchestration/execute-tasks', { tasks: validTasks });

		if (response.success && response.executed > 0) {
			toast.showMessage({
				title: 'Tasks executed',
				message: `Successfully executed ${response.executed} task(s)${response.failed > 0 ? `. ${response.failed} failed.` : '.'}`,
				type: 'success',
			});
		} else if (response.failed > 0) {
			const errorMessages =
				response.errors?.map((e) => `${e.workflowId}: ${e.error}`).join(', ') || 'Unknown error';
			toast.showError(
				new Error(`Failed to execute tasks: ${errorMessages}`),
				'Task execution failed',
				`Failed to execute ${response.failed} task(s).`,
			);
		}
	} catch (error) {
		toast.showError(error, 'Task execution error', 'Failed to execute tasks.');
	}
};

const handleCancelTasks = () => {
	// Just acknowledge - no action needed for cancel
	toast.showMessage({
		title: 'Cancelled',
		message: 'Task execution cancelled.',
		type: 'info',
	});
};

const hasMessages = computed(() => messages.value.length > 0);

const containerHeight = computed(() => {
	if (hasMessages.value) {
		return 'auto';
	}
	return isActive.value || inputValue.value ? 128 : 68;
});

const containerShadow = computed(() => {
	return isActive.value || inputValue.value
		? '0 8px 32px 0 rgba(0,0,0,0.16)'
		: '0 2px 8px 0 rgba(0,0,0,0.08)';
});

const containerStyle = computed(() => {
	const height = containerHeight.value;
	const isChatMode = hasMessages.value;
	return {
		height: typeof height === 'string' ? height : `${height}px`,
		boxShadow: containerShadow.value,
		transform: isChatMode ? 'translateY(0)' : 'none',
		transition: 'all 0.5s cubic-bezier(0.4, 0, 0.2, 1)',
		position: 'relative',
		zIndex: 10,
	};
});

const sendButtonDisabled = computed(() => isSending.value || !inputValue.value.trim());

onBeforeUnmount(() => {
	if (placeholderInterval) {
		clearInterval(placeholderInterval);
	}
});
</script>

<template>
	<div :class="[$style.pageContainer, { [$style.chatMode]: hasMessages }]">
		<!-- Title and Subtitle (only when no messages) -->
		<div v-if="!hasMessages" :class="$style.titleSection">
			<h1 :class="$style.title">Agent Hive</h1>
			<p :class="$style.subtitle">Create your own opportunities</p>
		</div>

		<!-- Messages Area -->
		<div v-if="hasMessages" :class="$style.messagesArea">
			<div :class="$style.messagesContent">
				<div
					v-for="message in messages"
					:key="message.id"
					:class="[
						$style.messageWrapper,
						message.type === 'user' ? $style.userMessage : $style.assistantMessage,
					]"
				>
					<div v-if="message.type === 'assistant'" :class="$style.assistantMessageContent">
						<div :class="$style.messageText">
							<VueMarkdown :source="message.content" />
						</div>
						<div
							v-if="message.isTaskList && message.tasks && message.tasks.length > 0"
							:class="$style.taskActions"
						>
							<button :class="$style.runButton" @click="handleRunTasks(message.tasks)">
								<N8nIcon icon="play" :size="16" />
								Run
							</button>
							<button :class="$style.cancelButton" @click="handleCancelTasks">Cancel</button>
						</div>
					</div>
					<div v-else :class="$style.userMessageContent">
						{{ message.content }}
					</div>
				</div>
			</div>
		</div>

		<!-- Input Container -->
		<div
			ref="wrapperRef"
			:class="[$style.container, { [$style.chatInputContainer]: hasMessages }]"
			:style="containerStyle"
			@click="handleActivate"
		>
			<div :class="$style.inputRow">
				<button
					v-if="!hasMessages"
					:class="$style.iconButton"
					title="Attach file"
					type="button"
					tabindex="-1"
				>
					<N8nIcon icon="paperclip" :size="20" />
				</button>
				<button
					v-if="hasMessages"
					:class="$style.iconButton"
					title="Attach file"
					type="button"
					tabindex="-1"
				>
					<N8nIcon icon="plus" :size="20" />
				</button>

				<!-- Text Input & Placeholder -->
				<div :class="$style.inputWrapper">
					<input
						v-model="inputValue"
						type="text"
						:class="$style.input"
						:placeholder="hasMessages ? 'Ask anything' : ''"
						@focus="handleActivate"
						@keydown="handleKeyPress"
					/>
					<div v-if="!hasMessages" :class="$style.placeholderContainer">
						<Transition name="placeholder" mode="out-in">
							<span
								v-if="showPlaceholder && !isActive && !inputValue"
								:key="placeholderIndex"
								:class="$style.placeholder"
							>
								<TransitionGroup name="letter" tag="span">
									<span
										v-for="(char, i) in PLACEHOLDERS[placeholderIndex].split('')"
										:key="`${placeholderIndex}-${i}`"
										:class="$style.letter"
									>
										{{ char === ' ' ? '\u00A0' : char }}
									</span>
								</TransitionGroup>
							</span>
						</Transition>
					</div>
				</div>

				<button :class="$style.iconButton" title="Voice input" type="button" tabindex="-1">
					<N8nIcon icon="mic" :size="20" />
				</button>
				<button
					:class="[$style.sendButton, $style.iconButton]"
					title="Send"
					type="button"
					:disabled="sendButtonDisabled"
					@click="sendMessage"
				>
					<N8nIcon icon="send" :size="18" />
				</button>
			</div>
		</div>
	</div>
</template>

<style lang="scss" module>
.pageContainer {
	width: 100%;
	min-height: 100vh;
	display: flex;
	justify-content: center;
	align-items: flex-end;
	color: var(--color--foreground--shade-1);
	background: linear-gradient(to bottom, #0a0a0f 0%, #1a1a2e 50%, #0f0f1e 100%);
	padding: var(--spacing--2xl);
	padding-bottom: 20vh;
	transition:
		padding 0.5s cubic-bezier(0.4, 0, 0.2, 1),
		flex-direction 0.5s cubic-bezier(0.4, 0, 0.2, 1),
		justify-content 0.5s cubic-bezier(0.4, 0, 0.2, 1),
		align-items 0.5s cubic-bezier(0.4, 0, 0.2, 1);
	position: relative;
	overflow: hidden;
}

.pageContainer.chatMode {
	flex-direction: column;
	justify-content: flex-start;
	align-items: stretch;
	padding: 0;
	background: linear-gradient(to bottom, #0a0a0f 0%, #1a1a2e 50%, #0f0f1e 100%);
	height: 100vh;
	overflow: hidden;
	position: relative;
}

.titleSection {
	position: absolute;
	top: 40%;
	left: 50%;
	transform: translate(-50%, -50%);
	text-align: center;
	z-index: 1;
	pointer-events: none;
	width: 100%;
	padding: 0 var(--spacing--lg);
}

.title {
	font-size: 2.5rem;
	font-weight: 600;
	color: rgba(255, 255, 255, 0.95);
	margin: 0;
	text-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
}

.subtitle {
	font-size: 1rem;
	color: rgba(255, 255, 255, 0.7);
	margin-top: var(--spacing--sm);
	margin-bottom: 0;
}

.messagesArea {
	flex: 1;
	overflow-y: auto;
	overflow-x: hidden;
	padding: var(--spacing--xl) var(--spacing--lg);
	padding-bottom: 200px;
	display: flex;
	flex-direction: column;
	max-width: 768px;
	width: 100%;
	margin: 0 auto;
	min-height: 0;
	opacity: 0;
	transform: translateY(20px);
	animation: fadeInUp 0.6s cubic-bezier(0.4, 0, 0.2, 1) forwards;
}

@keyframes fadeInUp {
	to {
		opacity: 1;
		transform: translateY(0);
	}
}

.messagesContent {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--md);
	min-height: min-content;
}

.messageWrapper {
	display: flex;
	width: 100%;
	opacity: 0;
	transform: translateY(10px);
	animation: messageFadeIn 0.4s cubic-bezier(0.4, 0, 0.2, 1) forwards;
}

@keyframes messageFadeIn {
	to {
		opacity: 1;
		transform: translateY(0);
	}
}

.assistantMessage {
	justify-content: flex-start;
}

.userMessage {
	justify-content: flex-end;
}

.assistantMessageContent {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--xs);
	max-width: 85%;
}

.messageText {
	color: rgba(255, 255, 255, 0.9);
	font-size: var(--font-size--base);
	line-height: 1.6;
	word-wrap: break-word;

	:global(p) {
		margin: var(--spacing--xs) 0;
	}

	:global(strong) {
		font-weight: var(--font-weight--bold);
	}

	:global(em) {
		font-style: italic;
		color: var(--color--text--tint-1);
	}

	:global(ul),
	:global(ol) {
		margin: var(--spacing--xs) 0;
		padding-left: var(--spacing--lg);
	}

	:global(li) {
		margin: var(--spacing--2xs) 0;
	}
}

.taskActions {
	display: flex;
	gap: var(--spacing--sm);
	margin-top: var(--spacing--md);
	padding-top: var(--spacing--md);
	border-top: 1px solid rgba(255, 255, 255, 0.1);
}

.runButton {
	display: flex;
	align-items: center;
	gap: var(--spacing--2xs);
	padding: var(--spacing--sm) var(--spacing--md);
	border-radius: var(--radius--small);
	border: 1px solid rgba(255, 255, 255, 0.2);
	background-color: rgba(255, 255, 255, 0.15);
	backdrop-filter: blur(10px);
	-webkit-backdrop-filter: blur(10px);
	color: rgba(255, 255, 255, 0.95);
	font-weight: var(--font-weight--medium);
	font-size: var(--font-size--sm);
	cursor: pointer;
	transition: all 0.2s;

	&:hover {
		background-color: rgba(255, 255, 255, 0.25);
		border-color: rgba(255, 255, 255, 0.3);
	}

	&:active {
		background-color: rgba(255, 255, 255, 0.2);
	}
}

.cancelButton {
	padding: var(--spacing--sm) var(--spacing--md);
	border-radius: var(--radius--small);
	border: 1px solid rgba(255, 255, 255, 0.15);
	background-color: transparent;
	color: rgba(255, 255, 255, 0.8);
	font-weight: var(--font-weight--medium);
	font-size: var(--font-size--sm);
	cursor: pointer;
	transition: all 0.2s;

	&:hover {
		background-color: rgba(255, 255, 255, 0.1);
		border-color: rgba(255, 255, 255, 0.25);
		color: rgba(255, 255, 255, 0.95);
	}

	&:active {
		background-color: rgba(255, 255, 255, 0.15);
	}
}

.userMessageContent {
	background-color: rgba(255, 255, 255, 0.15);
	backdrop-filter: blur(10px);
	-webkit-backdrop-filter: blur(10px);
	color: rgba(255, 255, 255, 0.95);
	padding: var(--spacing--sm) var(--spacing--md);
	border-radius: 9999px;
	font-size: var(--font-size--base);
	line-height: 1.5;
	max-width: 85%;
	word-wrap: break-word;
	white-space: pre-wrap;
	border: 1px solid rgba(255, 255, 255, 0.1);
}

.container {
	width: 100%;
	max-width: 768px;
	border-radius: 32px;
	background: transparent;
	backdrop-filter: none;
	-webkit-backdrop-filter: none;
	border: none;
	overflow: visible;
	display: flex;
	flex-direction: column;
	position: relative;
	transition:
		height 0.5s cubic-bezier(0.4, 0, 0.2, 1),
		box-shadow 0.5s cubic-bezier(0.4, 0, 0.2, 1),
		max-width 0.5s cubic-bezier(0.4, 0, 0.2, 1),
		border-radius 0.5s cubic-bezier(0.4, 0, 0.2, 1),
		transform 0.5s cubic-bezier(0.4, 0, 0.2, 1);
}

.container.chatInputContainer {
	max-width: 100%;
	border-radius: 0;
	margin: 0;
	border: none;
	background: transparent;
	box-shadow: none;
	padding: var(--spacing--md);
	padding-bottom: var(--spacing--lg);
	position: fixed;
	bottom: 0;
	left: 0;
	right: 0;
	transition: padding 0.5s cubic-bezier(0.4, 0, 0.2, 1);
}

.pageContainer::after {
	content: '';
	position: fixed;
	bottom: 0;
	left: 50%;
	transform: translateX(-50%);
	width: 100vw;
	max-width: 1200px;
	height: 400px;
	background: radial-gradient(
		ellipse 80% 40% at center bottom,
		rgba(139, 92, 246, 0.7) 0%,
		rgba(99, 102, 241, 0.5) 15%,
		rgba(59, 130, 246, 0.4) 30%,
		rgba(139, 92, 246, 0.2) 50%,
		transparent 75%
	);
	pointer-events: none;
	z-index: 0;
	border-radius: 50% 50% 0 0;
}

.inputRow {
	display: flex;
	align-items: center;
	gap: var(--spacing--2xs);
	padding: var(--spacing--sm) var(--spacing--md);
	border-radius: 9999px;
	background: rgba(0, 0, 0, 0.6);
	backdrop-filter: blur(12px);
	-webkit-backdrop-filter: blur(12px);
	border: 1px solid rgba(255, 255, 255, 0.1);
	max-width: 768px;
	width: 100%;
	margin: 0 auto;
	position: relative;
	z-index: 10;
}

.container.chatInputContainer .inputRow {
	background: rgba(0, 0, 0, 0.4);
	backdrop-filter: blur(12px);
	-webkit-backdrop-filter: blur(12px);
	border: 1px solid rgba(255, 255, 255, 0.1);
	border-radius: 24px;
	padding: var(--spacing--xs) var(--spacing--sm);
	max-width: 768px;
	position: relative;
	z-index: 10;
}

.container.chatInputContainer .input {
	font-size: var(--font-size--sm);
}

.iconButton {
	padding: var(--spacing--sm);
	border-radius: 9999px;
	border: none;
	background: transparent;
	cursor: pointer;
	transition: all 0.2s;
	display: flex;
	align-items: center;
	justify-content: center;
	color: rgba(255, 255, 255, 0.7);

	&:hover {
		background-color: rgba(255, 255, 255, 0.1);
		color: rgba(255, 255, 255, 0.9);
	}
}

.sendButton {
	background-color: rgba(255, 255, 255, 0.2);
	backdrop-filter: blur(10px);
	-webkit-backdrop-filter: blur(10px);
	color: rgba(255, 255, 255, 0.95);
	font-weight: var(--font-weight--medium);
	justify-content: center;
	border: 1px solid rgba(255, 255, 255, 0.2);

	&:hover:not(:disabled) {
		background-color: rgba(255, 255, 255, 0.3);
		border-color: rgba(255, 255, 255, 0.3);
	}

	&:disabled {
		opacity: 0.5;
		cursor: not-allowed;
		background-color: rgba(255, 255, 255, 0.1);
	}
}

.container.chatInputContainer .sendButton {
	background-color: rgba(255, 255, 255, 0.2);
	backdrop-filter: blur(10px);
	-webkit-backdrop-filter: blur(10px);
	color: rgba(255, 255, 255, 0.95);
	border: 1px solid rgba(255, 255, 255, 0.2);

	&:hover:not(:disabled) {
		background-color: rgba(255, 255, 255, 0.3);
		border-color: rgba(255, 255, 255, 0.3);
	}
}

.inputWrapper {
	position: relative;
	flex: 1;
}

.input {
	flex: 1;
	border: 0;
	outline: 0;
	border-radius: var(--radius--small);
	padding: var(--spacing--2xs) var(--spacing--sm);
	font-size: var(--font-size--base);
	background: transparent;
	width: 100%;
	font-weight: var(--font-weight--regular);
	position: relative;
	z-index: 1;
	color: rgba(255, 255, 255, 0.9);

	&::placeholder {
		color: rgba(255, 255, 255, 0.5);
	}
}

.placeholderContainer {
	position: absolute;
	left: 0;
	top: 0;
	width: 100%;
	height: 100%;
	pointer-events: none;
	display: flex;
	align-items: center;
	padding: var(--spacing--2xs) var(--spacing--sm);
}

.placeholder {
	position: absolute;
	left: 0;
	top: 50%;
	transform: translateY(-50%);
	color: rgba(255, 255, 255, 0.5);
	user-select: none;
	pointer-events: none;
	z-index: 0;
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}

.letter {
	display: inline-block;
}
</style>

<style lang="scss" scoped>
// Placeholder transition
.placeholder-enter-active {
	transition: opacity 0.25s;
}

.placeholder-leave-active {
	transition: opacity 0.2s;
}

.placeholder-enter-from,
.placeholder-leave-to {
	opacity: 0;
}

// Letter animation
.letter-enter-active {
	transition:
		opacity 0.25s,
		filter 0.4s,
		transform 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);
}

.letter-leave-active {
	transition:
		opacity 0.2s,
		filter 0.3s,
		transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
}

.letter-enter-from {
	opacity: 0;
	filter: blur(12px);
	transform: translateY(10px);
}

.letter-leave-to {
	opacity: 0;
	filter: blur(12px);
	transform: translateY(-10px);
}
</style>
