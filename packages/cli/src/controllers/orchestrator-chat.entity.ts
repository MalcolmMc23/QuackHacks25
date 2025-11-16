import { WithTimestamps, User, JsonColumn } from '@n8n/db';
import {
	Column,
	Entity,
	ManyToOne,
	JoinColumn,
	type Relation,
	PrimaryGeneratedColumn,
} from '@n8n/typeorm';

@Entity({ name: 'orchestrator_chats' })
export class OrchestratorChat extends WithTimestamps {
	@PrimaryGeneratedColumn('uuid')
	id: string;

	@Column({ type: String })
	userId: string;

	@ManyToOne('User', { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'userId' })
	user?: Relation<User>;

	@Column({ type: 'varchar', length: 256, nullable: true })
	title: string | null;

	@JsonColumn()
	messages: Array<{
		id: string;
		type: 'user' | 'assistant';
		content: string;
		timestamp: string;
		isTaskList?: boolean;
		tasks?: Array<{ workflowId: string; task: string }>;
	}>;
}
