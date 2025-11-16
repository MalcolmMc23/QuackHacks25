import { z } from 'zod';
import { Z } from 'zod-class';

export class GenerateWorkflowDescriptionRequestDto extends Z.class({
	userInput: z.string().min(1, 'User input is required'),
}) {}
