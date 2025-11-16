![Banner image](https://user-images.githubusercontent.com/10284570/173569848-c624317f-42b1-45a6-ab09-f0ea3c247648.png)

# n8n - AI-Powered Workflow Orchestration Platform

n8n is a workflow automation platform that gives technical teams the flexibility of code with the speed of no-code. This enhanced version includes an **AI Orchestrator** that intelligently breaks down user requests into executable workflow chains, enabling natural language interaction with complex automation systems.

![n8n.io - Screenshot](https://raw.githubusercontent.com/n8n-io/n8n/master/assets/n8n-screenshot-readme.png)

## 🎯 Project Overview

This project extends n8n with advanced AI orchestration capabilities, allowing users to interact with workflows through natural language. The system can:

- **Understand user intent** and break down complex requests into workflow tasks
- **Chain workflows together** automatically based on input/output compatibility
- **Execute workflows sequentially** with data flowing between them
- **Provide real-time progress updates** during execution
- **Synthesize results** from multiple workflows into coherent responses

### Key Features

- **AI Orchestrator**: Natural language interface for workflow execution
- **Task Chain Execution**: Automatically chains compatible workflows
- **Streaming Responses**: Real-time progress updates via Server-Sent Events
- **Workflow Intelligence**: AI-powered task planning using Google Gemini
- **Polymarket Integration**: Built-in support for prediction market data
- **Modern UI**: Dark-themed, glassmorphism design with gradient backgrounds

## 🏗️ Architecture & Technology Stack

### Backend

- **Runtime**: Node.js 22.16+
- **Framework**: n8n (workflow automation platform)
- **Language**: TypeScript
- **API Framework**: Express.js with custom decorators (`@RestController`)
- **Database**: TypeORM with SQLite/PostgreSQL
- **AI Integration**: 
  - **Google Gemini** (via OpenRouter API) for task planning and chat responses
  - **OpenRouter** as the API gateway for multiple AI models
- **Streaming**: Server-Sent Events (SSE) for real-time updates
- **Task Execution**: Custom task chain execution service

### Frontend

- **Framework**: Vue.js 3 with Composition API
- **UI Library**: Custom n8n Design System
- **Styling**: SCSS with CSS modules
- **State Management**: Pinia
- **Build Tool**: Vite
- **TypeScript**: Full type safety

### Key Packages

- `@n8n/nodes-langchain`: LangChain integration for AI workflows
- `@n8n/ai-workflow-builder.ee`: AI-powered workflow creation
- `n8n-workflow`: Core workflow execution engine
- `@n8n/db`: Database abstraction layer
- `@n8n/decorators`: REST controller decorators

## 🔄 Workflow System

### Workflow Structure

Workflows in n8n are composed of **nodes** connected in a graph structure:

1. **Trigger Nodes**: Start workflows (webhooks, schedules, manual triggers)
2. **Processing Nodes**: Transform, filter, or process data
3. **Action Nodes**: Perform operations (HTTP requests, database operations, AI calls)
4. **Output Nodes**: Return results

### Workflow Execution Flow

```
User Request → AI Orchestrator → Task Breakdown → Workflow Chain → Execution → Results
```

1. **User Input**: Natural language request via chat interface
2. **Task Planning**: Gemini AI analyzes available workflows and breaks down the request
3. **Task Validation**: System validates input/output compatibility between workflows
4. **Sequential Execution**: Workflows execute in order, passing data between them
5. **Result Synthesis**: Final results are formatted and returned to the user

### Workflow Chaining

The orchestrator intelligently chains workflows based on:

- **Input/Output Types**: JSON, PNG, binary, or no input
- **Workflow Descriptions**: AI-generated metadata describing each workflow's purpose
- **Data Flow**: Output from one workflow becomes input to the next

Example chain:
```
Polymarket Data Fetch → Data Transformation → AI Analysis → Result Formatting
```

## 🤖 AI Orchestrator

### Components

#### 1. **Orchestration Controller** (`orchestration.controller.ts`)
- Handles chat streaming and task execution
- Manages conversation history
- Streams real-time progress updates

#### 2. **Task Chain Execution Service** (`task-chain-execution.service.ts`)
- Executes workflows sequentially
- Manages data flow between workflows
- Handles errors and retries
- Provides progress callbacks

#### 3. **Workflow Description AI Service** (`workflow-description-ai.service.ts`)
- Generates workflow descriptions using AI
- Creates task breakdowns from user prompts
- Uses Gemini via OpenRouter for planning

### API Endpoints

- `POST /orchestration/chat/stream`: Stream chat responses with task suggestions
- `POST /orchestration/execute-tasks`: Execute a chain of workflow tasks
- `POST /orchestration/chats`: Save chat history
- `POST /orchestration/synthesize`: Synthesize results from multiple workflows

## 📊 Polymarket API Integration

The platform includes integration with **Polymarket**, a prediction market platform:

### Use Cases

- Fetching market data and predictions
- Analyzing prediction market trends
- Processing market outcomes
- Integrating prediction data into workflows

### Implementation

Polymarket workflows are treated as standard n8n workflows that:
- Accept JSON input (market queries, filters)
- Return JSON output (market data, predictions)
- Can be chained with other workflows for data processing

The orchestrator can automatically identify when a Polymarket workflow is needed based on user requests mentioning prediction markets or market data.

## 🧠 Google Gemini API Integration

### Usage

Gemini is integrated via **OpenRouter** for:

1. **Task Planning** (`taskmaster` function):
   - Analyzes user prompts
   - Breaks down requests into workflow tasks
   - Validates workflow compatibility
   - Returns structured task lists

2. **Chat Responses**:
   - Generates natural language responses
   - Synthesizes results from multiple workflows
   - Provides context-aware answers

### Configuration

```typescript
// Environment variables required:
OPENROUTER_API_KEY=your_api_key
OPENROUTER_MODEL_ID=google/gemini-2.5-flash  // Default model
```

### Model Selection

The system uses `google/gemini-2.5-flash` by default, but supports any model available through OpenRouter:
- `google/gemini-2.0-flash-exp`
- `google/gemini-pro`
- Other Gemini variants

## 🚀 Quick Start

### Prerequisites

- Node.js >= 22.16
- pnpm >= 10.18.3
- OpenRouter API key (for AI features)

### Installation

```bash
# Clone the repository
git clone <repository-url>
cd QuackHacks25

# Install dependencies
pnpm install

# Set up environment variables
cp .env.example .env
# Edit .env and add:
# OPENROUTER_API_KEY=your_key_here
# OPENROUTER_MODEL_ID=google/gemini-2.5-flash
```

### Development

```bash
# Start development server (backend + frontend)
pnpm dev

# Start backend only
pnpm dev:be

# Start frontend only
pnpm dev:fe

# Start with AI features
pnpm dev:ai
```

### Production Build

```bash
# Build all packages
pnpm build

# Build and create Docker image
pnpm build:docker
```

### Running

```bash
# Start n8n
pnpm start

# Or directly
cd packages/cli/bin && ./n8n
```

Access the editor at `http://localhost:5678`

## 📁 Project Structure

```
QuackHacks25/
├── packages/
│   ├── cli/                    # Main CLI application
│   │   └── src/
│   │       ├── controllers/
│   │       │   └── orchestration.controller.ts  # Orchestrator API
│   │       ├── workflows/
│   │       │   ├── task-chain-execution.service.ts
│   │       │   └── workflow-description-ai.service.ts
│   │       └── ...
│   ├── frontend/
│   │   └── editor-ui/          # Vue.js frontend
│   │       └── src/
│   │           ├── app/
│   │           │   ├── views/
│   │           │   │   └── OrchestratorView.vue  # Chat interface
│   │           │   └── components/
│   │           │       └── orchestrator/         # Orchestrator UI components
│   │           └── ...
│   ├── nodes-base/             # Built-in n8n nodes
│   ├── @n8n/
│   │   ├── nodes-langchain/    # LangChain AI nodes
│   │   └── ai-workflow-builder.ee/  # AI workflow builder
│   └── ...
└── ...
```

## 🎨 UI Design

The platform features a modern, dark-themed interface:

- **Glassmorphism**: Translucent cards with backdrop blur
- **Gradient Backgrounds**: Dark purple/blue gradients with radial overlays
- **Real-time Updates**: Streaming progress indicators
- **Task Visualization**: Interactive task lists with execution status
- **Chat Interface**: Clean, modern chat UI with message history

## 🔧 Configuration

### Environment Variables

```bash
# AI Configuration
OPENROUTER_API_KEY=your_openrouter_api_key
OPENROUTER_MODEL_ID=google/gemini-2.5-flash

# Database
DB_TYPE=postgresdb  # or sqlite
DB_POSTGRESDB_HOST=localhost
DB_POSTGRESDB_PORT=5432
DB_POSTGRESDB_DATABASE=n8n
DB_POSTGRESDB_USER=n8n
DB_POSTGRESDB_PASSWORD=password

# Server
N8N_PORT=5678
N8N_HOST=0.0.0.0
```

## 📚 Key Concepts

### Workflow Descriptions

Each workflow can have AI-generated metadata describing:
- **Purpose**: What the workflow does
- **Input Type**: JSON, PNG, binary, or no input
- **Output Type**: JSON, PNG, binary, or no output
- **Workflow Name**: Human-readable name

### Task Breakdown

The AI orchestrator breaks user requests into tasks:
```json
{
  "tasks": [
    {
      "workflowId": "workflow-123",
      "workflowName": "Polymarket Data Fetch",
      "task": "Fetch current prediction market data",
      "input": "JSON",
      "output": "JSON"
    }
  ]
}
```

### Execution Flow

1. User sends message → Chat interface
2. AI analyzes request → Task breakdown
3. System validates tasks → Compatibility check
4. User approves → Task execution starts
5. Workflows execute → Sequential with data flow
6. Results synthesized → AI generates response

## 🧪 Testing

```bash
# Run all tests
pnpm test

# Run backend tests
pnpm test:ci:backend

# Run frontend tests
pnpm test:ci:frontend

# Run with Docker
pnpm test:with:docker
```

## 📖 Resources

- 📚 [n8n Documentation](https://docs.n8n.io)
- 🔧 [400+ Integrations](https://n8n.io/integrations)
- 💡 [Example Workflows](https://n8n.io/workflows)
- 🤖 [AI & LangChain Guide](https://docs.n8n.io/advanced-ai/)
- 👥 [Community Forum](https://community.n8n.io)
- 📖 [Community Tutorials](https://community.n8n.io/c/tutorials/28)

## 🤝 Contributing

Found a bug 🐛 or have a feature idea ✨? Check our [Contributing Guide](https://github.com/n8n-io/n8n/blob/master/CONTRIBUTING.md) to get started.

## 📄 License

n8n is [fair-code](https://faircode.io) distributed under the [Sustainable Use License](https://github.com/n8n-io/n8n/blob/master/LICENSE.md) and [n8n Enterprise License](https://github.com/n8n-io/n8n/blob/master/LICENSE_EE.md).

- **Source Available**: Always visible source code
- **Self-Hostable**: Deploy anywhere
- **Extensible**: Add your own nodes and functionality

[Enterprise licenses](mailto:license@n8n.io) available for additional features and support.

## 🙏 Acknowledgments

Built on top of [n8n](https://n8n.io), an open-source workflow automation platform. Enhanced with AI orchestration capabilities for natural language workflow interaction.

## 📝 What does n8n mean?

**Short answer:** It means "nodemation" and is pronounced as n-eight-n.

**Long answer:** "I get that question quite often (more often than I expected) so I decided it is probably best to answer it here. While looking for a good name for the project with a free domain I realized very quickly that all the good ones I could think of were already taken. So, in the end, I chose nodemation. 'node-' in the sense that it uses a Node-View and that it uses Node.js and '-mation' for 'automation' which is what the project is supposed to help with. However, I did not like how long the name was and I could not imagine writing something that long every time in the CLI. That is when I then ended up on 'n8n'." - **Jan Oberhauser, Founder and CEO, n8n.io**
