<script lang="ts" setup>
import { ref } from 'vue';

const inputValue = ref('');
</script>

<template>
	<div :class="$style.pageContainer">
		<input v-model="inputValue" type="text" :class="$style.textInput" placeholder="Enter text..." />
	</div>
</template>

<style lang="scss" module>
.pageContainer {
	width: 100%;
	min-height: 100vh;
	display: flex;
	justify-content: center;
	align-items: center;
	padding: var(--spacing--2xl);
}

.textInput {
	width: 100%;
	max-width: 500px;
	padding: var(--spacing--md);
	border: 1px solid var(--color--foreground--tint-1);
	border-radius: var(--radius--small);
	font-size: var(--font-size--base);
	background: var(--color--foreground--tint-2);
	color: var(--color--text);

	&:focus {
		outline: none;
		border-color: var(--color--primary);
	}

	&::placeholder {
		color: var(--color--text--tint-1);
	}
}
</style>
