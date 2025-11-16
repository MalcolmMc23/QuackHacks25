import type { MigrationContext, ReversibleMigration } from '../migration-types';

export class AddWorkflowDescriptionJsonColumn1763252200000 implements ReversibleMigration {
	async up({ schemaBuilder: { addColumns, column } }: MigrationContext) {
		await addColumns('workflow_entity', [column('workflowDescription').json]);
	}

	async down({ schemaBuilder: { dropColumns } }: MigrationContext) {
		await dropColumns('workflow_entity', ['workflowDescription']);
	}
}
