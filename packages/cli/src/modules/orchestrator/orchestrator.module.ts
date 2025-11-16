import type { ModuleInterface } from '@n8n/decorators';
import { BackendModule } from '@n8n/decorators';

@BackendModule({ name: 'orchestrator' })
export class OrchestratorModule implements ModuleInterface {
	async entities() {
		const { OrchestratorChat } = await import('../../controllers/orchestrator-chat.entity');
		return [OrchestratorChat];
	}
}
