<script lang="ts" setup>
import { ref, computed, watch, onBeforeUnmount } from 'vue';
import { N8nIcon } from '@n8n/design-system';

const PLACEHOLDERS = [
	'Generate website with HextaUI',
	'Create a new project with Next.js',
	'What is the meaning of life?',
	'What is the best way to learn React?',
	'How to cook a delicious meal?',
	'Summarize this article',
];

type Props = {
	hasMessages?: boolean;
	isSending?: boolean;
};

type Emits = {
	(e: 'send', message: string): void;
	(e: 'activate'): void;
};

const props = withDefaults(defineProps<Props>(), {
	hasMessages: false,
	isSending: false,
});

const emit = defineEmits<Emits>();

const placeholderIndex = ref(0);
const showPlaceholder = ref(true);
const isActive = ref(false);
const inputValue = ref('');

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

const handleActivate = () => {
	isActive.value = true;
	emit('activate');
};

const handleSend = () => {
	if (props.isSending || !inputValue.value.trim()) return;
	emit('send', inputValue.value.trim());
	inputValue.value = '';
	isActive.value = false;
};

const handleKeyPress = (e: KeyboardEvent) => {
	if (e.key === 'Enter' && !e.shiftKey) {
		e.preventDefault();
		handleSend();
	}
};

const sendButtonDisabled = computed(() => props.isSending || !inputValue.value.trim());

const containerHeight = computed(() => {
	if (props.hasMessages) {
		return 'auto';
	}
	return isActive.value || inputValue.value ? 128 : 68;
});

const containerShadow = computed(() => {
	return isActive.value || inputValue.value
		? '0 8px 32px 0 rgba(0,0,0,0.24)'
		: '0 2px 8px 0 rgba(0,0,0,0.12)';
});

const containerStyle = computed(() => {
	const height = containerHeight.value;
	const isChatMode = props.hasMessages;
	return {
		height: typeof height === 'string' ? height : `${height}px`,
		boxShadow: containerShadow.value,
		transform: isChatMode ? 'translateY(0)' : 'none',
		transition: 'all 0.5s cubic-bezier(0.4, 0, 0.2, 1)',
		position: 'relative',
		zIndex: 10,
	};
});

onBeforeUnmount(() => {
	if (placeholderInterval) {
		clearInterval(placeholderInterval);
	}
});
</script>

<template>
	<div
		:class="[$style.container, { [$style.chatInputContainer]: hasMessages }]"
		:style="containerStyle"
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
				@click="handleSend"
			>
				<N8nIcon icon="send" :size="18" />
			</button>
		</div>
	</div>
</template>

<style lang="scss" module>
.container {
	width: 100%;
	max-width: 900px;
	border-radius: 32px;
	background: transparent;
	backdrop-filter: none;
	-webkit-backdrop-filter: none;
	border: none;
	overflow: visible;
	display: flex;
	flex-direction: column;
	position: relative;
	margin: 0 auto;
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
}

.inputRow {
	display: flex;
	align-items: center;
	gap: var(--spacing--xs);
	padding: var(--spacing--sm) var(--spacing--md);
	border-radius: 9999px;
	background: rgba(0, 0, 0, 0.5);
	backdrop-filter: blur(20px);
	-webkit-backdrop-filter: blur(20px);
	border: 1px solid rgba(255, 255, 255, 0.1);
	max-width: 900px;
	width: 100%;
	margin: 0 auto;
	position: relative;
	z-index: 10;
	box-shadow: 0 4px 16px rgba(0, 0, 0, 0.2);
	transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);

	&:focus-within {
		border-color: rgba(139, 92, 246, 0.5);
		box-shadow: 0 4px 24px rgba(139, 92, 246, 0.2);
	}
}

.container.chatInputContainer .inputRow {
	background: rgba(0, 0, 0, 0.4);
	backdrop-filter: blur(20px);
	-webkit-backdrop-filter: blur(20px);
	border: 1px solid rgba(255, 255, 255, 0.1);
	border-radius: 24px;
	padding: var(--spacing--xs) var(--spacing--sm);
	max-width: 900px;
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
		color: rgba(255, 255, 255, 0.95);
		transform: scale(1.05);
	}

	&:active {
		transform: scale(0.95);
	}
}

.sendButton {
	background: linear-gradient(135deg, rgba(139, 92, 246, 0.6) 0%, rgba(99, 102, 241, 0.6) 100%);
	color: rgba(255, 255, 255, 0.95);
	font-weight: var(--font-weight--medium);
	justify-content: center;
	border: 1px solid rgba(255, 255, 255, 0.2);
	transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);

	&:hover:not(:disabled) {
		background: linear-gradient(135deg, rgba(139, 92, 246, 0.8) 0%, rgba(99, 102, 241, 0.8) 100%);
		transform: scale(1.05);
		box-shadow: 0 4px 12px rgba(139, 92, 246, 0.3);
	}

	&:disabled {
		opacity: 0.5;
		cursor: not-allowed;
		background: rgba(255, 255, 255, 0.05);
		transform: none;
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
	color: rgba(255, 255, 255, 0.95);

	&::placeholder {
		color: rgba(255, 255, 255, 0.4);
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
	color: rgba(255, 255, 255, 0.4);
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
