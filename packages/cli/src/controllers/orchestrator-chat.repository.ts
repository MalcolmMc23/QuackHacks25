import { Service } from '@n8n/di';
import { DataSource, Repository } from '@n8n/typeorm';

import { OrchestratorChat } from './orchestrator-chat.entity';

@Service()
export class OrchestratorChatRepository extends Repository<OrchestratorChat> {
	constructor(dataSource: DataSource) {
		super(OrchestratorChat, dataSource.manager);
	}
}
