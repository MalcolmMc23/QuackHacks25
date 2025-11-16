<script lang="ts" setup>
import { ref, computed, watch, onBeforeUnmount, nextTick } from 'vue';
import { onClickOutside } from '@vueuse/core';
import { N8nIcon } from '@n8n/design-system';
import { makeRestApiRequest } from '@n8n/rest-api-client';
import { useRootStore } from '@n8n/stores/useRootStore';
import { useToast } from '@/app/composables/useToast';

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
};

interface Message {
	id: string;
	type: 'user' | 'assistant';
	content: string;
	timestamp: Date;
}

const placeholderIndex = ref(0);
const showPlaceholder = ref(true);
const isActive = ref(false);
const inputValue = ref('');
const wrapperRef = ref<HTMLDivElement | null>(null);
const messagesRef = ref<HTMLDivElement | null>(null);
const messages = ref<Message[]>([]);
const isSending = ref(false);

const rootStore = useRootStore();
const toast = useToast();

// Cycle placeholder text when input is inactive
let placeholderInterval: ReturnType<typeof setInterval> | null = null;

watch(
	[isActive, inputValue],
	() => {
		if (isActive.value || inputValue.value || messages.value.length > 0) {
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

// Close input when clicking outside (only if no messages)
onClickOutside(wrapperRef, () => {
	if (!inputValue.value && messages.value.length === 0) {
		isActive.value = false;
	}
});

const handleActivate = () => {
	isActive.value = true;
};

const hasMessages = computed(() => messages.value.length > 0);

const containerHeight = computed(() => {
	if (hasMessages.value) {
		return 'auto';
	}
	return isActive.value || inputValue.value ? 128 : 68;
});

const containerShadow = computed(() => {
	if (hasMessages.value) {
		return '0 2px 8px 0 rgba(0,0,0,0.08)';
	}
	return isActive.value || inputValue.value
		? '0 8px 32px 0 rgba(0,0,0,0.16)'
		: '0 2px 8px 0 rgba(0,0,0,0.08)';
});

const containerStyle = computed(() => {
	const height = containerHeight.value;
	return {
		height: typeof height === 'string' ? height : `${height}px`,
		boxShadow: containerShadow.value,
	};
});

const sendButtonDisabled = computed(() => isSending.value || !inputValue.value.trim());

const sendMessage = async () => {
	if (sendButtonDisabled.value) return;

	const userMessage: Message = {
		id: Date.now().toString(),
		type: 'user',
		content: inputValue.value.trim(),
		timestamp: new Date(),
	};

	messages.value.push(userMessage);
	const currentInput = inputValue.value.trim();
	inputValue.value = '';
	isActive.value = false;

	// Scroll to bottom
	await nextTick();
	scrollToBottom();

	try {
		isSending.value = true;

		// Build conversation history from existing messages
		const conversationHistory = messages.value
			.slice(0, -1) // Exclude the message we just added
			.map((msg) => ({
				role: msg.type === 'user' ? ('user' as const) : ('assistant' as const),
				content: msg.content,
			}));

		// Debug: Log what we're sending
		const requestPayload = {
			userInput: currentInput,
			messages: conversationHistory,
		};
		// eslint-disable-next-line no-console
		console.log('Sending request payload:', JSON.stringify(requestPayload, null, 2));

		const response = await makeRestApiRequest<OrchestratorChatResponse>(
			rootStore.restApiContext,
			'POST',
			'/orchestration/chat',
			requestPayload,
		);

		// eslint-disable-next-line no-console
		console.log('Received response:', response);

		const assistantMessage: Message = {
			id: (Date.now() + 1).toString(),
			type: 'assistant',
			content: response.content || 'No response received.',
			timestamp: new Date(),
		};

		messages.value.push(assistantMessage);
		await nextTick();
		scrollToBottom();
	} catch (error) {
		toast.showError(error, 'Orchestrator error', 'Failed to contact the orchestrator.');
		const errorMessage: Message = {
			id: (Date.now() + 2).toString(),
			type: 'assistant',
			content: 'Something went wrong while contacting the orchestrator.',
			timestamp: new Date(),
		};
		messages.value.push(errorMessage);
		await nextTick();
		scrollToBottom();
	} finally {
		isSending.value = false;
	}
};

const scrollToBottom = () => {
	if (messagesRef.value) {
		messagesRef.value.scrollTop = messagesRef.value.scrollHeight;
	}
};

const handleKeyPress = (e: KeyboardEvent) => {
	if (e.key === 'Enter' && !e.shiftKey) {
		e.preventDefault();
		sendMessage();
	}
};

onBeforeUnmount(() => {
	if (placeholderInterval) {
		clearInterval(placeholderInterval);
	}
});
</script>

<template>
	<div :class="[$style.pageContainer, { [$style.chatMode]: hasMessages }]">
		<!-- Messages Area -->
		<div v-if="hasMessages" ref="messagesRef" :class="$style.messagesArea">
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
						<div :class="$style.messageText">{{ message.content }}</div>
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
	align-items: center;
	color: var(--color--foreground--shade-1);
	background-color: var(--color--background--light-2);
	padding: var(--spacing--2xl);
	transition: padding 0.3s ease;
}

.pageContainer.chatMode {
	flex-direction: column;
	justify-content: flex-start;
	align-items: stretch;
	padding: 0;
	background-color: var(--color--background--light-2);
	height: 100vh;
	overflow: hidden;
}

.messagesArea {
	flex: 1;
	overflow-y: auto;
	overflow-x: hidden;
	padding: var(--spacing--xl) var(--spacing--lg);
	display: flex;
	flex-direction: column;
	max-width: 768px;
	width: 100%;
	margin: 0 auto;
	min-height: 0;
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
	color: var(--color--text);
	font-size: var(--font-size--base);
	line-height: 1.6;
	word-wrap: break-word;
	white-space: pre-wrap;
}

.userMessageContent {
	background-color: var(--color--primary);
	color: var(--color--foreground--tint-2);
	padding: var(--spacing--sm) var(--spacing--md);
	border-radius: 9999px;
	font-size: var(--font-size--base);
	line-height: 1.5;
	max-width: 85%;
	word-wrap: break-word;
	white-space: pre-wrap;
}

.container {
	width: 100%;
	max-width: 768px;
	border-radius: 32px;
	background: var(--color--foreground--tint-2);
	overflow: hidden;
	display: flex;
	flex-direction: column;
	transition:
		height 0.3s cubic-bezier(0.16, 1, 0.3, 1),
		box-shadow 0.3s cubic-bezier(0.16, 1, 0.3, 1),
		max-width 0.3s cubic-bezier(0.16, 1, 0.3, 1),
		border-radius 0.3s cubic-bezier(0.16, 1, 0.3, 1);
}

.container.chatInputContainer {
	max-width: 100%;
	border-radius: 0;
	margin: 0 auto;
	border-top: 1px solid var(--color--foreground--tint-1);
	background: transparent;
	box-shadow: none;
	padding: var(--spacing--md);
	padding-bottom: var(--spacing--sm);
}

.inputRow {
	display: flex;
	align-items: center;
	gap: var(--spacing--2xs);
	padding: var(--spacing--sm) var(--spacing--md);
	border-radius: 9999px;
	background: var(--color--foreground--tint-2);
	max-width: 768px;
	width: 100%;
	margin: 0 auto;
}

.container.chatInputContainer .inputRow {
	background: var(--color--background--light-1);
	border: 1px solid var(--color--foreground--tint-1);
	border-radius: 24px;
	padding: var(--spacing--xs) var(--spacing--sm);
	max-width: 768px;
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
	transition: background-color 0.2s;
	display: flex;
	align-items: center;
	justify-content: center;
	color: var(--color--text);

	&:hover {
		background-color: var(--color--background--light-1);
	}
}

.sendButton {
	background-color: var(--color--foreground--shade-1);
	color: var(--color--foreground--tint-2);
	font-weight: var(--font-weight--medium);
	justify-content: center;

	&:hover:not(:disabled) {
		background-color: var(--color--foreground--shade-2);
	}

	&:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
}

.container.chatInputContainer .sendButton {
	background-color: var(--color--primary);
	color: var(--color--foreground--tint-2);

	&:hover:not(:disabled) {
		background-color: var(--color--primary--shade-1);
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
	color: var(--color--text);

	&::placeholder {
		color: var(--color--text--tint-1);
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
	color: var(--color--text--tint-1);
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
