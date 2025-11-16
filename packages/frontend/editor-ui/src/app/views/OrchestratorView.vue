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
	tasks?: Array<{
		workflowId: string;
		task: string;
		input?: string;
		output?: string;
	}>;
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
		tasks?: Array<{
			workflowId: string;
			task: string;
			input?: string;
			output?: string;
		}>;
	}>
>([]);

const rootStore = useRootStore();
const toast = useToast();
const currentChatId = ref<string | null>(null);

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
			tasks?: Array<{
				workflowId: string;
				task: string;
				input?: string;
				output?: string;
			}>;
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
			async () => {
				// Stream done - save chat
				isSending.value = false;
				// Only save if we have valid messages (don't save empty chats)
				if (messages.value.length > 0) {
					await saveCurrentChat();
				}
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

const handleRunTasks = async (
	tasks: Array<{ workflowId: string; task: string; input?: string; output?: string }>,
) => {
	console.log('handleRunTasks called with tasks:', tasks);

	// Validate tasks array
	if (!tasks || !Array.isArray(tasks) || tasks.length === 0) {
		toast.showError(
			new Error('No tasks available to execute'),
			'Task execution error',
			'Please ensure tasks are available before running.',
		);
		return;
	}

	// Filter out any invalid tasks and add default input/output if missing
	const validTasks = tasks
		.filter(
			(task) =>
				task &&
				task.workflowId &&
				typeof task.workflowId === 'string' &&
				task.workflowId.trim() !== '',
		)
		.map((task) => ({
			...task,
			// Add default input/output if not provided by AI
			input: task.input || 'JSON',
			output: task.output || 'JSON',
		}));

	console.log('Valid tasks prepared for execution:', validTasks);

	if (validTasks.length === 0) {
		toast.showError(
			new Error('No valid tasks found'),
			'Task execution error',
			'All tasks are invalid or missing workflow IDs.',
		);
		return;
	}

	try {
		// Add a progress message
		const progressMessageId = Date.now().toString();
		messages.value.push({
			id: progressMessageId,
			type: 'assistant',
			content: 'Starting task execution...',
			timestamp: new Date(),
		});

		// Get the last user message to use as userPrompt
		const lastUserMessage = messages.value.filter((m) => m.type === 'user').pop();
		const userPrompt = lastUserMessage?.content || '';

		// Use streaming to get progress updates
		let progressContent = 'Starting task execution...\n\n';
		let finalResult: any = null;

		await streamRequest<any>(
			rootStore.restApiContext,
			'/orchestration/execute-tasks',
			{ tasks: validTasks, userPrompt },
			(data) => {
				try {
					// Check if this is a progress update or final result
					if (data.isFinal) {
						finalResult = data;
					} else if (data.status) {
						// This is a progress update
						const statusEmoji =
							{
								starting: '🔄',
								executing: '⚙️',
								completed: '✅',
								error: '❌',
							}[data.status] || '•';

						progressContent += `${statusEmoji} Task ${data.currentTask}/${data.totalTasks}: ${data.message}\n`;

						// Update the progress message
						const progressMsg = messages.value.find((m) => m.id === progressMessageId);
						if (progressMsg) {
							progressMsg.content = progressContent;
						}
					}
				} catch (e) {
					console.error('Failed to process progress update:', e, data);
				}
			},
		);

		// Handle final result
		if (finalResult) {
			if (finalResult.success) {
				// Show a temporary processing message (will be replaced with synthesized response)
				const processingMessageId = (Date.now() + 1).toString();
				const baseSuccessContent = '✅ Processing results...';

				messages.value.push({
					id: processingMessageId,
					type: 'assistant',
					content: baseSuccessContent,
					timestamp: new Date(),
				});

				toast.showMessage({
					title: 'Tasks executed',
					message: `Successfully executed ${finalResult.executedTasks} task(s)`,
					type: 'success',
				});

				// Extract and normalize tool results for LLM synthesis
				try {
					// Extract tool results from the output
					const rawToolResults = finalResult.output
						? Array.isArray(finalResult.output)
							? finalResult.output
							: [finalResult.output]
						: [];

					const toolResults = rawToolResults
						.flatMap((item: unknown) => {
							if (!item) return [];
							return Array.isArray(item) ? item : [item];
						})
						.map((item: any) => {
							// Ensure tool result has the proper shape
							const source =
								typeof item?.source === 'string' && item.source.trim().length > 0
									? item.source
									: 'workflow';
							const reply =
								typeof item?.reply === 'string' && item.reply.trim().length > 0
									? item.reply
									: 'Tool returned data.';
							const data =
								item && typeof item === 'object' && 'data' in item
									? (item as { data?: unknown }).data
									: item;

							return { source, reply, data };
						})
						.filter((tr) => !!tr && typeof tr.source === 'string' && !!tr.reply);

					// Ensure we have a valid user prompt
					// If the user didn't provide a prompt, use a generic one asking for the workflow output
					const normalizedUserPrompt =
						userPrompt && userPrompt.trim().length > 0
							? userPrompt.trim()
							: 'What is the output of this workflow? Please provide a clear summary of the results.';

					// Build conversation history (exclude progress and processing messages)
					const conversationHistory = messages.value
						.filter(
							(m) =>
								m.id !== progressMessageId &&
								m.id !== processingMessageId &&
								!m.content.includes('Processing results'),
						)
						.slice(0, -1) // Exclude the processing message we just added
						.map((m) => ({
							role: m.type === 'user' ? ('user' as const) : ('assistant' as const),
							content: m.content,
						}));

					// Call the orchestrator to synthesize tool results with conversation context
					if (toolResults.length > 0) {
						console.log('Calling /orchestration/synthesize with:', {
							userPrompt: normalizedUserPrompt,
							userPromptLength: normalizedUserPrompt.length,
							toolResultsCount: toolResults.length,
							conversationHistoryLength: conversationHistory.length,
							toolResults: toolResults.map((tr) => ({
								source: tr.source,
								replyLength: tr.reply?.length || 0,
							})),
						});

						const synthesizeResponse = await makeRestApiRequest<{ content: string }>(
							rootStore.restApiContext,
							'POST',
							'/orchestration/synthesize',
							{
								userPrompt: normalizedUserPrompt,
								toolResults,
								conversationHistory,
							},
						);

						if (synthesizeResponse?.content) {
							// Replace the processing message with the synthesized response
							const processingMsgIndex = messages.value.findIndex(
								(m) => m.id === processingMessageId,
							);
							if (processingMsgIndex !== -1) {
								messages.value[processingMsgIndex].content = synthesizeResponse.content;
							} else {
								// Fallback: add as new message
								messages.value.push({
									id: (Date.now() + 2).toString(),
									type: 'assistant',
									content: synthesizeResponse.content,
									timestamp: new Date(),
								});
							}
						} else {
							// No content from synthesis, show fallback message
							const processingMsgIndex = messages.value.findIndex(
								(m) => m.id === processingMessageId,
							);
							if (processingMsgIndex !== -1) {
								messages.value[processingMsgIndex].content =
									'✅ Tasks completed successfully, but no response was generated.';
							}
						}
					} else if (finalResult.summary) {
						// Use summary if no tool results
						const processingMsgIndex = messages.value.findIndex(
							(m) => m.id === processingMessageId,
						);
						if (processingMsgIndex !== -1) {
							messages.value[processingMsgIndex].content = finalResult.summary;
						}
					} else {
						// No tool results and no summary - generic success
						const processingMsgIndex = messages.value.findIndex(
							(m) => m.id === processingMessageId,
						);
						if (processingMsgIndex !== -1) {
							messages.value[processingMsgIndex].content = '✅ All tasks completed successfully!';
						}
					}
				} catch (summaryError) {
					console.error('Failed to synthesize tool results via orchestrator LLM:', summaryError);

					// Replace processing message with fallback
					const processingMsgIndex = messages.value.findIndex((m) => m.id === processingMessageId);
					if (processingMsgIndex !== -1) {
						messages.value[processingMsgIndex].content =
							'✅ Tasks completed successfully, but I encountered an error generating a response. Please try again.';
					}

					toast.showError(
						summaryError,
						'Synthesis error',
						'Tasks ran successfully, but synthesizing results failed.',
					);
				}
			} else {
				// Add error message
				const errorContent = `❌ Task execution failed\n\nError: ${finalResult.error}\n\nExecuted ${finalResult.executedTasks} task(s) before failure.`;

				messages.value.push({
					id: (Date.now() + 1).toString(),
					type: 'assistant',
					content: errorContent,
					timestamp: new Date(),
				});

				toast.showError(
					new Error(finalResult.error || 'Unknown error'),
					'Task execution failed',
					`Failed at task: ${finalResult.failedTask || 'unknown'}`,
				);
			}
		}

		// Remove the progress message as we've added a final message
		const progressIndex = messages.value.findIndex((m) => m.id === progressMessageId);
		if (progressIndex !== -1) {
			messages.value.splice(progressIndex, 1);
		}

		// Save the updated chat after a brief delay to ensure all messages are added
		// Capture messages array snapshot to avoid race conditions
		setTimeout(async () => {
			// Create a snapshot of the current messages array
			const messagesSnapshot = Array.isArray(messages.value) ? [...messages.value] : [];

			const hasValidMessages = messagesSnapshot.some(
				(m) =>
					m &&
					typeof m === 'object' &&
					m.content &&
					typeof m.content === 'string' &&
					m.content.trim() !== '',
			);

			if (hasValidMessages && messagesSnapshot.length > 0) {
				// Temporarily replace messages.value with snapshot for save
				const originalMessages = messages.value;
				try {
					messages.value = messagesSnapshot;
					await saveCurrentChat();
				} catch (error) {
					console.error('Error saving chat after task execution:', error);
				} finally {
					// Restore original messages
					messages.value = originalMessages;
				}
			} else {
				console.debug('Skipping chat save after task execution: no valid messages', {
					messageCount: messagesSnapshot.length,
					hasValidMessages,
				});
			}
		}, 100);
	} catch (error) {
		toast.showError(error, 'Task execution error', 'Failed to execute tasks.');

		// Remove progress message on error
		const progressIndex = messages.value.findIndex((m) => m.id === progressMessageId);
		if (progressIndex !== -1) {
			messages.value.splice(progressIndex, 1);
		}
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

const saveCurrentChat = async () => {
	// Early return if messages array is empty or invalid
	if (!messages.value || !Array.isArray(messages.value) || messages.value.length === 0) {
		console.debug('Skipping chat save: messages array is empty or invalid', {
			isArray: Array.isArray(messages.value),
			length: messages.value?.length || 0,
			type: typeof messages.value,
		});
		return;
	}

	// Create a defensive copy to avoid mutations during processing
	const messagesCopy = [...messages.value];

	// Filter out empty, invalid, or malformed messages
	const validMessages = messagesCopy
		.filter((m) => {
			// Must be an object
			if (!m || typeof m !== 'object' || Array.isArray(m)) {
				return false;
			}
			// Must have required fields
			if (!m.id || !m.type || !m.timestamp) {
				return false;
			}
			// Must have valid content
			if (!m.content || typeof m.content !== 'string' || m.content.trim() === '') {
				return false;
			}
			// Type must be valid
			if (m.type !== 'user' && m.type !== 'assistant') {
				return false;
			}
			return true;
		})
		.map((m) => ({
			id: String(m.id),
			type: m.type,
			content: String(m.content).trim(),
			timestamp: m.timestamp instanceof Date ? m.timestamp : new Date(m.timestamp),
			...(m.isTaskList !== undefined && { isTaskList: m.isTaskList }),
			...(m.tasks && Array.isArray(m.tasks) && { tasks: m.tasks }),
		}));

	// Don't save if there are no valid messages
	if (!validMessages || validMessages.length === 0) {
		console.debug('Skipping chat save: no valid messages after filtering', {
			originalMessageCount: messagesCopy.length,
			originalMessages: messagesCopy.map((m) => ({
				hasId: !!m?.id,
				hasType: !!m?.type,
				hasContent: !!m?.content,
				contentType: typeof m?.content,
				contentLength: m?.content?.length || 0,
				isObject: typeof m === 'object' && !Array.isArray(m),
			})),
		});
		return;
	}

	// Ensure validMessages is a proper array before sending
	if (!Array.isArray(validMessages)) {
		console.error('validMessages is not an array!', {
			type: typeof validMessages,
			validMessages,
		});
		return;
	}

	try {
		const firstUserMessage = validMessages.find((m) => m.type === 'user');
		const title = firstUserMessage?.content?.substring(0, 50) || 'New Chat';

		console.debug('Saving chat', {
			messageCount: validMessages.length,
			userMessages: validMessages.filter((m) => m.type === 'user').length,
			assistantMessages: validMessages.filter((m) => m.type === 'assistant').length,
			chatId: currentChatId.value,
			isArray: Array.isArray(validMessages),
		});

		const response = await makeRestApiRequest<{ id: string; title: string }>(
			rootStore.restApiContext,
			'POST',
			'/orchestration/chats',
			{
				chatId: currentChatId.value || undefined,
				title,
				messages: validMessages,
			},
		);
		currentChatId.value = response.id;
		console.debug('Chat saved successfully', { chatId: response.id, title: response.title });
	} catch (error) {
		// Log but don't show error to user - chat saving is not critical
		const errorMessage = error instanceof Error ? error.message : String(error);
		console.error('Failed to save chat', {
			error: errorMessage,
			validMessageCount: validMessages?.length || 0,
			originalMessageCount: messagesCopy.length,
			isValidMessagesArray: Array.isArray(validMessages),
		});
		// Only show toast if it's a critical error (not a 400 validation error)
		if (
			!errorMessage.includes('Messages array is required') &&
			!errorMessage.includes('400') &&
			!errorMessage.includes('Bad Request')
		) {
			toast.showError(error, 'Failed to save chat');
		}
	}
};

const handleNewChat = async () => {
	// Save current chat before starting new one (only if we have valid messages)
	const hasValidMessages = messages.value.some(
		(m) => m.content && typeof m.content === 'string' && m.content.trim() !== '',
	);
	if (hasValidMessages) {
		await saveCurrentChat();
	}

	// Clear messages and reset chat ID
	messages.value = [];
	currentChatId.value = null;
	inputValue.value = '';
	isActive.value = false;
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
		<!-- New Chat Button (only when messages exist) -->
		<button v-if="hasMessages" :class="$style.newChatButton" @click="handleNewChat">
			<N8nIcon icon="plus" :size="16" />
			New Chat
		</button>

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

.newChatButton {
	position: fixed;
	top: var(--spacing--md);
	right: var(--spacing--md);
	display: flex;
	align-items: center;
	gap: var(--spacing--2xs);
	padding: var(--spacing--sm) var(--spacing--md);
	border-radius: var(--radius--small);
	border: 1px solid rgba(255, 255, 255, 0.15);
	background: rgba(0, 0, 0, 0.4);
	backdrop-filter: blur(12px);
	-webkit-backdrop-filter: blur(12px);
	color: rgba(255, 255, 255, 0.9);
	font-weight: var(--font-weight--medium);
	font-size: var(--font-size--sm);
	cursor: pointer;
	transition: all 0.2s;
	z-index: 100;

	&:hover {
		background: rgba(0, 0, 0, 0.6);
		border-color: rgba(255, 255, 255, 0.25);
	}

	&:active {
		background: rgba(0, 0, 0, 0.5);
	}
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
	left: 0;
	right: 0;
	width: 100vw;
	height: 50vh;
	background: radial-gradient(
		ellipse 100% 60% at center bottom,
		rgba(139, 92, 246, 0.8) 0%,
		rgba(99, 102, 241, 0.6) 10%,
		rgba(59, 130, 246, 0.5) 20%,
		rgba(139, 92, 246, 0.35) 35%,
		rgba(99, 102, 241, 0.2) 50%,
		rgba(59, 130, 246, 0.1) 65%,
		transparent 85%
	);
	pointer-events: none;
	z-index: 0;
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
