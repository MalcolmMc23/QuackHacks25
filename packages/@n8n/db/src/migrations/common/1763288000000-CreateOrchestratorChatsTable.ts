import type { MigrationContext, ReversibleMigration } from '../migration-types';

const TABLE_NAME = 'orchestrator_chats';

export class CreateOrchestratorChatsTable1763288000000 implements ReversibleMigration {
	async up({ schemaBuilder: { createTable, column } }: MigrationContext) {
		await createTable(TABLE_NAME)
			.withColumns(
				column('id').uuid.primary,
				column('userId').uuid.notNull,
				column('title').varchar(256),
				column('messages').json.notNull,
			)
			.withForeignKey('userId', {
				tableName: 'user',
				columnName: 'id',
				onDelete: 'CASCADE',
			}).withTimestamps;
	}

	async down({ schemaBuilder: { dropTable } }: MigrationContext) {
		await dropTable(TABLE_NAME);
	}
}
