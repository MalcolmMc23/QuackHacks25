<script lang="ts" setup>
import { computed } from 'vue';
import { N8nIcon } from '@n8n/design-system';
import VueMarkdown from 'vue-markdown-render';

type Message = {
	id: string;
	type: 'user' | 'assistant';
	content: string;
	timestamp: Date;
	isTaskList?: boolean;
	tasks?: Array<{ workflowId: string; task: string }>;
};

type Props = {
	messages: Message[];
	isSending?: boolean;
};

type Emits = {
	(e: 'run-tasks', tasks: Array<{ workflowId: string; task: string }>): void;
	(e: 'cancel-tasks'): void;
	(e: 'new-chat'): void;
};

const props = withDefaults(defineProps<Props>(), {
	isSending: false,
});

const emit = defineEmits<Emits>();

const hasMessages = computed(() => props.messages.length > 0);

const handleRunTasks = (tasks: Array<{ workflowId: string; task: string }>) => {
	emit('run-tasks', tasks);
};

const handleCancelTasks = () => {
	emit('cancel-tasks');
};

const handleNewChat = () => {
	emit('new-chat');
};
</script>

<template>
	<div :class="$style.chatContainer">
		<!-- New Chat Button -->
		<button v-if="hasMessages" :class="$style.newChatButton" @click="handleNewChat">
			<N8nIcon icon="plus" :size="16" />
			<span>New Chat</span>
		</button>

		<!-- Title Section (only when no messages) -->
		<div v-if="!hasMessages" :class="$style.titleSection">
			<div :class="$style.titleWrapper">
				<h1 :class="$style.title">
					<span :class="$style.titleGradient">Agent Hive</span>
				</h1>
				<p :class="$style.subtitle">Create your own opportunities</p>
				<div :class="$style.decorativeDots">
					<span></span>
					<span></span>
					<span></span>
				</div>
			</div>
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
					<!-- Assistant Message -->
					<div v-if="message.type === 'assistant'" :class="$style.assistantMessageContent">
						<div :class="$style.messageAvatar">
							<N8nIcon icon="bot" :size="20" />
						</div>
						<div :class="$style.messageBubble">
							<div :class="$style.messageText">
								<VueMarkdown :source="message.content" />
							</div>
							<div
								v-if="message.isTaskList && message.tasks && message.tasks.length > 0"
								:class="$style.taskActions"
							>
								<button :class="$style.runButton" @click="handleRunTasks(message.tasks)">
									<N8nIcon icon="play" :size="16" />
									<span>Run</span>
								</button>
								<button :class="$style.cancelButton" @click="handleCancelTasks">Cancel</button>
							</div>
						</div>
					</div>

					<!-- User Message -->
					<div v-else :class="$style.userMessageContent">
						<div :class="$style.userAvatar">
							<N8nIcon icon="user" :size="18" />
						</div>
						<div :class="$style.userBubble">
							{{ message.content }}
						</div>
					</div>
				</div>

				<!-- Typing Indicator -->
				<div v-if="isSending" :class="$style.typingIndicator">
					<div :class="$style.typingDots">
						<span></span>
						<span></span>
						<span></span>
					</div>
				</div>
			</div>
		</div>
	</div>
</template>

<style lang="scss" module>
.chatContainer {
	width: 100%;
	min-height: 100vh;
	display: flex;
	flex-direction: column;
	position: relative;
	background: linear-gradient(135deg, #0a0a0f 0%, #1a1a2e 50%, #0f0f1e 100%);
	overflow: hidden;

	&::before {
		content: '';
		position: absolute;
		top: 0;
		left: 0;
		right: 0;
		bottom: 0;
		background: radial-gradient(
			ellipse 80% 50% at 50% 0%,
			rgba(139, 92, 246, 0.15) 0%,
			rgba(99, 102, 241, 0.1) 30%,
			transparent 70%
		);
		pointer-events: none;
		z-index: 0;
	}

	&::after {
		content: '';
		position: fixed;
		bottom: 0;
		left: 0;
		right: 0;
		width: 100vw;
		height: 50vh;
		background: radial-gradient(
			ellipse 100% 60% at center bottom,
			rgba(139, 92, 246, 0.4) 0%,
			rgba(99, 102, 241, 0.3) 15%,
			rgba(59, 130, 246, 0.2) 30%,
			transparent 70%
		);
		pointer-events: none;
		z-index: 0;
	}
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
	border: 1px solid rgba(255, 255, 255, 0.1);
	background: rgba(0, 0, 0, 0.5);
	backdrop-filter: blur(16px);
	-webkit-backdrop-filter: blur(16px);
	color: rgba(255, 255, 255, 0.95);
	font-weight: var(--font-weight--medium);
	font-size: var(--font-size--sm);
	cursor: pointer;
	transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
	z-index: 100;
	box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);

	&:hover {
		background: rgba(0, 0, 0, 0.7);
		border-color: rgba(255, 255, 255, 0.2);
		transform: translateY(-2px);
		box-shadow: 0 6px 20px rgba(0, 0, 0, 0.3);
	}

	&:active {
		transform: translateY(0);
	}
}

.titleSection {
	position: absolute;
	top: 50%;
	left: 50%;
	transform: translate(-50%, -50%);
	text-align: center;
	z-index: 1;
	pointer-events: none;
	width: 100%;
	padding: 0 var(--spacing--lg);
}

.titleWrapper {
	position: relative;
	display: inline-block;
}

.title {
	font-size: clamp(2.5rem, 5vw, 4rem);
	font-weight: 700;
	margin: 0;
	letter-spacing: -0.02em;
}

.titleGradient {
	background: linear-gradient(135deg, #fff 0%, #a78bfa 50%, #60a5fa 100%);
	-webkit-background-clip: text;
	-webkit-text-fill-color: transparent;
	background-clip: text;
	display: inline-block;
	animation: gradientShift 3s ease infinite;
	background-size: 200% 200%;
}

@keyframes gradientShift {
	0%,
	100% {
		background-position: 0% 50%;
	}
	50% {
		background-position: 100% 50%;
	}
}

.subtitle {
	font-size: clamp(1rem, 2vw, 1.25rem);
	color: rgba(255, 255, 255, 0.6);
	margin-top: var(--spacing--md);
	margin-bottom: 0;
	font-weight: var(--font-weight--regular);
	letter-spacing: 0.01em;
}

.decorativeDots {
	display: flex;
	justify-content: center;
	gap: var(--spacing--sm);
	margin-top: var(--spacing--xl);

	span {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: rgba(139, 92, 246, 0.5);
		animation: pulse 2s ease-in-out infinite;

		&:nth-child(2) {
			animation-delay: 0.2s;
		}

		&:nth-child(3) {
			animation-delay: 0.4s;
		}
	}
}

@keyframes pulse {
	0%,
	100% {
		opacity: 0.5;
		transform: scale(1);
	}
	50% {
		opacity: 1;
		transform: scale(1.2);
	}
}

.messagesArea {
	flex: 1;
	overflow-y: auto;
	overflow-x: hidden;
	padding: var(--spacing--2xl) var(--spacing--lg);
	padding-bottom: 200px;
	display: flex;
	flex-direction: column;
	max-width: 900px;
	width: 100%;
	margin: 0 auto;
	min-height: 0;
	position: relative;
	z-index: 1;
}

.messagesContent {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--lg);
	min-height: min-content;
}

.messageWrapper {
	display: flex;
	width: 100%;
	animation: messageSlideIn 0.4s cubic-bezier(0.4, 0, 0.2, 1) forwards;
}

@keyframes messageSlideIn {
	from {
		opacity: 0;
		transform: translateY(20px);
	}
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
	gap: var(--spacing--sm);
	max-width: 85%;
	align-items: flex-start;
}

.messageAvatar {
	width: 36px;
	height: 36px;
	border-radius: 50%;
	background: linear-gradient(135deg, rgba(139, 92, 246, 0.3) 0%, rgba(99, 102, 241, 0.3) 100%);
	display: flex;
	align-items: center;
	justify-content: center;
	flex-shrink: 0;
	border: 1px solid rgba(255, 255, 255, 0.1);
	backdrop-filter: blur(10px);
}

.messageBubble {
	flex: 1;
	background: rgba(255, 255, 255, 0.05);
	backdrop-filter: blur(20px);
	-webkit-backdrop-filter: blur(20px);
	border: 1px solid rgba(255, 255, 255, 0.1);
	border-radius: var(--radius--large);
	padding: var(--spacing--md) var(--spacing--lg);
	box-shadow: 0 4px 16px rgba(0, 0, 0, 0.2);
}

.messageText {
	color: rgba(255, 255, 255, 0.95);
	font-size: var(--font-size--base);
	line-height: 1.7;
	word-wrap: break-word;

	:global(p) {
		margin: var(--spacing--xs) 0;
	}

	:global(strong) {
		font-weight: var(--font-weight--bold);
		color: rgba(255, 255, 255, 1);
	}

	:global(code) {
		background: rgba(0, 0, 0, 0.3);
		padding: 2px 6px;
		border-radius: 4px;
		font-family: 'Monaco', 'Courier New', monospace;
		font-size: 0.9em;
	}

	:global(pre) {
		background: rgba(0, 0, 0, 0.4);
		padding: var(--spacing--md);
		border-radius: var(--radius--small);
		overflow-x: auto;
		margin: var(--spacing--sm) 0;
		border: 1px solid rgba(255, 255, 255, 0.1);
	}

	:global(ul),
	:global(ol) {
		margin: var(--spacing--sm) 0;
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
	padding: var(--spacing--sm) var(--spacing--lg);
	border-radius: var(--radius--small);
	border: none;
	background: linear-gradient(135deg, rgba(139, 92, 246, 0.8) 0%, rgba(99, 102, 241, 0.8) 100%);
	backdrop-filter: blur(10px);
	color: rgba(255, 255, 255, 1);
	font-weight: var(--font-weight--medium);
	font-size: var(--font-size--sm);
	cursor: pointer;
	transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
	box-shadow: 0 4px 12px rgba(139, 92, 246, 0.3);

	&:hover {
		background: linear-gradient(135deg, rgba(139, 92, 246, 1) 0%, rgba(99, 102, 241, 1) 100%);
		transform: translateY(-2px);
		box-shadow: 0 6px 20px rgba(139, 92, 246, 0.4);
	}

	&:active {
		transform: translateY(0);
	}
}

.cancelButton {
	padding: var(--spacing--sm) var(--spacing--lg);
	border-radius: var(--radius--small);
	border: 1px solid rgba(255, 255, 255, 0.2);
	background: rgba(255, 255, 255, 0.05);
	backdrop-filter: blur(10px);
	color: rgba(255, 255, 255, 0.8);
	font-weight: var(--font-weight--medium);
	font-size: var(--font-size--sm);
	cursor: pointer;
	transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);

	&:hover {
		background: rgba(255, 255, 255, 0.1);
		border-color: rgba(255, 255, 255, 0.3);
		color: rgba(255, 255, 255, 1);
		transform: translateY(-1px);
	}
}

.userMessageContent {
	display: flex;
	gap: var(--spacing--sm);
	max-width: 85%;
	align-items: flex-start;
	flex-direction: row-reverse;
}

.userAvatar {
	width: 32px;
	height: 32px;
	border-radius: 50%;
	background: linear-gradient(135deg, rgba(59, 130, 246, 0.3) 0%, rgba(99, 102, 241, 0.3) 100%);
	display: flex;
	align-items: center;
	justify-content: center;
	flex-shrink: 0;
	border: 1px solid rgba(255, 255, 255, 0.1);
	backdrop-filter: blur(10px);
}

.userBubble {
	background: linear-gradient(135deg, rgba(59, 130, 246, 0.2) 0%, rgba(99, 102, 241, 0.2) 100%);
	backdrop-filter: blur(20px);
	-webkit-backdrop-filter: blur(20px);
	color: rgba(255, 255, 255, 0.95);
	padding: var(--spacing--sm) var(--spacing--md);
	border-radius: var(--radius--large);
	font-size: var(--font-size--base);
	line-height: 1.5;
	word-wrap: break-word;
	white-space: pre-wrap;
	border: 1px solid rgba(255, 255, 255, 0.15);
	box-shadow: 0 4px 16px rgba(0, 0, 0, 0.2);
}

.typingIndicator {
	display: flex;
	justify-content: flex-start;
	padding: var(--spacing--md) 0;
}

.typingDots {
	display: flex;
	gap: 6px;
	padding: var(--spacing--md) var(--spacing--lg);
	background: rgba(255, 255, 255, 0.05);
	backdrop-filter: blur(20px);
	border: 1px solid rgba(255, 255, 255, 0.1);
	border-radius: var(--radius--large);

	span {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: rgba(255, 255, 255, 0.6);
		animation: typingDot 1.4s ease-in-out infinite;

		&:nth-child(2) {
			animation-delay: 0.2s;
		}

		&:nth-child(3) {
			animation-delay: 0.4s;
		}
	}
}

@keyframes typingDot {
	0%,
	60%,
	100% {
		transform: translateY(0);
		opacity: 0.6;
	}
	30% {
		transform: translateY(-10px);
		opacity: 1;
	}
}
</style>
