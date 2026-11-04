// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@bootstrap/container`
 * Purpose: Dependency injection container for application composition root with environment-based adapter selection.
 * Scope: Wire adapters to ports for runtime dependency injection. Provides webhookRegistrations for ingestion route, Temporal WorkflowClient singleton. Does not handle request-scoped lifecycle.
 * Invariants: All ports wired; single container instance per process; config.unhandledErrorPolicy set by env; webhookRegistrations lazy-initialized; Temporal connection singleton with race-safe init.
 * Side-effects: IO (initializes logger and emits startup log on first access)
 * Notes: LLM always uses LiteLlmAdapter; stack tests route to mock-openai-api. ContainerConfig controls wrapper behavior.
 * Links: Used by API routes and other entry points; configure adapters here for DI.
 * @public
 */

import type { ToolSourcePort } from "@cogni/ai-core";
import type {
	EdoCapability,
	KnowledgeCapability,
	MetricsCapability,
	RepoCapability,
	WebSearchCapability,
} from "@cogni/ai-tools";
import { CORE_TOOL_BUNDLE } from "@cogni/ai-tools";
import type { AttributionStore } from "@cogni/attribution-ledger";
import {
	createDefaultRegistries,
	type DefaultRegistries,
	type FinalizeEpochInput,
	type FinalizeEpochOutput,
	type FinalizeLogger,
	type RunFinalizeEpochDeps,
	runFinalizeEpoch,
} from "@cogni/attribution-pipeline-plugins";
import {
	DrizzleAttributionAdapter,
	DrizzleClaimantWalletResolver,
} from "@cogni/db-client";
import type { FinancialLedgerPort } from "@cogni/financial-ledger";
import { createTigerBeetleAdapter } from "@cogni/financial-ledger/adapters";
import type { UserId } from "@cogni/ids";
import { toUserId, userActor } from "@cogni/ids";
import {
	type ContributionService,
	createContributionService,
	createEdoCapability,
	createKnowledgeCapability,
	defaultCanMergeKnowledge,
	type KnowledgeStorePort,
	type NodeAdminAuthority,
	shapeGate,
} from "@cogni/knowledge-store";
import {
	buildDoltgresClient,
	createDoltgresPusher,
	DoltBranchSessionRunner,
	DoltgresEdoResolverAdapter,
	DoltgresKnowledgeContributionAdapter,
	DoltgresKnowledgeStoreAdapter,
	wrapPushSafe,
} from "@cogni/knowledge-store/adapters/doltgres";
import { parseMcpConfigFromEnv } from "@cogni/langgraph-graphs";
import {
	COGNI_SYSTEM_PRINCIPAL_USER_ID,
	initAnalytics,
	shutdownAnalytics,
} from "@cogni/node-shared";
import {
	type NodeStreamPort,
	RedisNodeStreamAdapter,
} from "@cogni/node-streams";
import { numberToPpm } from "@cogni/operator-wallet";
import { PrivyOperatorWalletAdapter } from "@cogni/operator-wallet/adapters/privy";
import type { ScheduleControlPort } from "@cogni/scheduler-core";
import { type WorkItemQueryPort, withWorkItemLeases } from "@cogni/work-items";
import { PostgresWorkItemLeaseAdapter } from "@cogni/work-items/adapters/postgres";
import { DoltgresWorkItemAdapter } from "@cogni/work-items/adapters/doltgres";
import { MarkdownWorkItemAdapter } from "@cogni/work-items/markdown";
import {
	Client as TemporalClient,
	Connection as TemporalConnection,
	type WorkflowClient,
} from "@temporalio/client";
import Redis from "ioredis";
import type { Logger } from "pino";
import {
	ALCHEMY_ADAPTER_VERSION,
	AlchemyWebhookNormalizer,
	type Database,
	DrizzleAiTelemetryAdapter,
	DrizzleConnectionBrokerAdapter,
	DrizzleExecutionGrantUserAdapter,
	DrizzleExecutionGrantWorkerAdapter,
	DrizzleExecutionRequestAdapter,
	DrizzleGovernanceStatusAdapter,
	DrizzleGraphRunAdapter,
	DrizzleScheduleRunReader,
	DrizzleScheduleUserAdapter,
	DrizzleThreadPersistenceAdapter,
	EvmRpcOnChainVerifierAdapter,
	GITHUB_ADAPTER_VERSION,
	GitHubWebhookNormalizer,
	getAppDb,
	getExecutionScope,
	LangfuseAdapter,
	LiteLlmAdapter,
	type MimirAdapterConfig,
	MimirMetricsAdapter,
	RedisRunStreamAdapter,
	SystemClock,
	TemporalScheduleControlAdapter,
	UserDrizzleAccountService,
	UserDrizzlePaymentAttemptRepository,
	ViemEvmOnchainClient,
	ViemTreasuryAdapter,
} from "@/adapters/server";
import { ServiceDrizzleAccountService } from "@/adapters/server/accounts/drizzle.adapter";
import {
	AggregatingModelCatalog,
	ProviderResolver,
} from "@/adapters/server/ai/catalog";
import { mcpServersToCodexConfig } from "@/adapters/server/ai/codex/codex-mcp-config";
import {
	CodexModelProvider,
	OpenAiCompatibleModelProvider,
	PlatformModelProvider,
} from "@/adapters/server/ai/providers";
import { getServiceDb } from "@/adapters/server/db/drizzle.service-client";
import { ServiceDrizzlePaymentAttemptRepository } from "@/adapters/server/payments/drizzle-payment-attempt.adapter";
import { SplitTreasurySettlementAdapter } from "@/adapters/server/treasury/split-treasury-settlement.adapter";
import {
	FakeMetricsAdapter,
	getTestEvmOnchainClient,
	getTestOnChainVerifier,
	getTestOperatorWallet,
} from "@/adapters/test";
import { createToolBindings } from "@/bootstrap/ai/tool-bindings";
import { createBoundToolSource } from "@/bootstrap/ai/tool-source.factory";
import {
	createMetricsCapability,
	derivePrometheusQueryUrl,
} from "@/bootstrap/capabilities/metrics";
import { createRepoCapability } from "@/bootstrap/capabilities/repo";
import { createScheduleCapability } from "@/bootstrap/capabilities/schedule";
import { stubVcsCapability } from "@/bootstrap/capabilities/vcs";
import { createWebSearchCapability } from "@/bootstrap/capabilities/web-search";
import { createWorkItemCapability } from "@/bootstrap/capabilities/work-item";
import { createApproversNodeAdminAuthority } from "@/bootstrap/node-admin-gate";
import type { RateLimitBypassConfig } from "@/bootstrap/http/wrapPublicRoute";
import { startProcessHealthPublisher } from "@/bootstrap/publishers";
import { startGovernanceSyncOnBoot } from "@/bootstrap/startup-reconcile";
import type {
	AccountService,
	AiTelemetryPort,
	Clock,
	ConnectionBrokerPort,
	DataSourceRegistration,
	GovernanceStatusPort,
	LangfusePort,
	LlmService,
	MetricsQueryPort,
	ModelCatalogPort,
	ModelProviderResolverPort,
	OnChainVerifier,
	OperatorWalletPort,
	PaymentAttemptServiceRepository,
	PaymentAttemptUserRepository,
	RunStreamPort,
	ServiceAccountService,
	ThreadPersistencePort,
	TreasuryReadPort,
	TreasurySettlementPort,
} from "@/ports";
import type {
	ExecutionGrantUserPort,
	ExecutionGrantWorkerPort,
	ExecutionRequestPort,
	GraphRunRepository,
	ScheduleUserPort,
	WorkItemsDoltgresPort,
} from "@/ports/server";
import {
	getDaoTreasuryAddress,
	getEmissionsHolderAddress,
	getLedgerConfig,
	getNodeId,
	getNodeTokenomicsConfig,
	getOperatorWalletConfig,
	getPaymentConfig,
	getScopeId,
	getStewardWalletConfig,
} from "@/shared/config";
import { serverEnv } from "@/shared/env/server-env";
import { makeLogger } from "@/shared/observability";
import { USDC_TOKEN_ADDRESS } from "@/shared/web3";
import type { EvmOnchainClient } from "@/shared/web3/onchain/evm-onchain-client.interface";

export type UnhandledErrorPolicy = "rethrow" | "respond_500";

class DoltgresNotConfiguredError extends Error {
	constructor() {
		super("Doltgres is not configured for this node. Set DOLTGRES_URL to enable the work-items API.");
		this.name = "DoltgresNotConfiguredError";
	}
}

export interface ContainerConfig {
	/** How to handle unhandled errors in route wrappers: rethrow for dev/test, respond_500 for production safety */
	unhandledErrorPolicy: UnhandledErrorPolicy;
	/** Rate limit bypass config for stack tests; only enabled when APP_ENV=test */
	rateLimitBypass: RateLimitBypassConfig;
	/** Deploy environment for metrics/logging (e.g., "local", "preview", "production") */
	DEPLOY_ENVIRONMENT: string;
}

export interface Container {
	log: Logger;
	config: ContainerConfig;
	llmService: LlmService;
	accountsForUser(userId: UserId): AccountService;
	serviceAccountService: ServiceAccountService;
	clock: Clock;
	paymentAttemptsForUser(userId: UserId): PaymentAttemptUserRepository;
	paymentAttemptServiceRepository: PaymentAttemptServiceRepository;
	onChainVerifier: OnChainVerifier;
	evmOnchainClient: EvmOnchainClient;
	/** True when repo-spec has payments_in config (receiving address + chain). False for nodes pending activation. */
	paymentRailsActive: boolean;
	metricsQuery: MetricsQueryPort;
	treasuryReadPort: TreasuryReadPort;
	/** AI telemetry DB writer - always wired */
	aiTelemetry: AiTelemetryPort;
	/** Langfuse tracer - undefined when LANGFUSE_SECRET_KEY not set */
	langfuse: LangfusePort | undefined;
	nodeId: string;
	// Scheduling ports (split by trust boundary)
	scheduleControl: ScheduleControlPort;
	executionGrantPort: ExecutionGrantUserPort;
	executionGrantWorkerPort: ExecutionGrantWorkerPort;
	executionRequestPort: ExecutionRequestPort;
	graphRunRepository: GraphRunRepository;
	scheduleRunReader: import("@cogni/scheduler-core").ScheduleRunReader;
	scheduleManager: ScheduleUserPort;
	/** Metrics capability for AI tools - requires PROMETHEUS_URL to be configured */
	metricsCapability: MetricsCapability;
	/** Web search capability for AI tools - requires TAVILY_API_KEY to be configured */
	webSearchCapability: WebSearchCapability;
	/** Repo capability for AI tools - requires COGNI_REPO_PATH */
	repoCapability: RepoCapability;
	/** Tool source with real implementations for AI tool execution */
	toolSource: ToolSourcePort;
	/** External-agent knowledge contribution service — undefined when DOLTGRES_URL is unset */
	knowledgeContributionService: ContributionService | undefined;
	/** GOAL_CHANGE_IS_NODE_ADMIN / P0P1_IS_NODE_ADMIN: this node's one node-admin authority (repo-spec admin wallets). */
	nodeAdmin: NodeAdminAuthority;
	/** Direct knowledge store port — exposed for the cookie-only browse endpoint. Undefined when DOLTGRES_URL is unset. */
	knowledgeStorePort: KnowledgeStorePort | undefined;
	/** EDO hypothesis-loop capability for the langgraph tool bindings AND the bearer-auth REST routes under /api/v1/edo. Always present (stubs throw when DOLTGRES_URL is unset). */
	edoCapability: EdoCapability;
	/** Thread persistence scoped to a user (RLS enforced) */
	threadPersistenceForUser(userId: UserId): ThreadPersistencePort;
	/** Governance status queries (system tenant scope) */
	governanceStatus: GovernanceStatusPort;
	/** Epoch ledger store — shared by app and scheduler-worker */
	attributionStore: AttributionStore;
	/** Work item queries — reads from markdown files via WorkItemQueryPort */
	workItemQuery: WorkItemQueryPort;
	/** Node-local Doltgres work-item query/create/patch/delete surface. */
	doltgresWorkItems: WorkItemsDoltgresPort;
	/** Run event streaming — publish/subscribe via Redis Streams */
	runStream: RunStreamPort;
	/** Node-level event streaming — undefined when REDIS_URL not set */
	nodeStream: NodeStreamPort | undefined;
	/** Webhook source registrations — normalizers for webhook ingestion */
	webhookRegistrations: ReadonlyMap<string, DataSourceRegistration>;
	/**
	 * Attribution pipeline registries (selection policies, enrichers, allocators,
	 * profiles) built from repo-spec excludedLogins/sourceRefs. Consumed by the
	 * in-process collect pass (attribution.collect.internal route).
	 */
	registries: DefaultRegistries;
	/**
	 * Source registrations usable by the in-process collect pass. On a node this is
	 * the webhook-only set (no poll adapter) — collect skips polling and runs over
	 * receipts already delivered via the Phase-1 receipt seam.
	 */
	sourceRegistrations: ReadonlyMap<string, DataSourceRegistration>;
	/** Financial ledger — undefined when TIGERBEETLE_ADDRESS not set */
	financialLedger: FinancialLedgerPort | undefined;
	/** Operator wallet — undefined when PRIVY_APP_ID not set */
	operatorWallet: OperatorWalletPort | undefined;
	/** Treasury settlement — undefined when operator wallet not configured */
	treasurySettlement: TreasurySettlementPort | undefined;
	/** Connection broker — undefined when CONNECTIONS_ENCRYPTION_KEY not set */
	connectionBroker: ConnectionBrokerPort | undefined;
	/** Model catalog — aggregates all providers for model listing */
	modelCatalog: ModelCatalogPort;
	/** Provider resolver — resolves providerKey to ModelProviderPort for runtime dispatch */
	providerResolver: ModelProviderResolverPort;
}

// Feature-specific dependency types
// AI adapter deps: used internally by createGraphExecutor
export type AiAdapterDeps = {
	llmService: LlmService;
	accountService: AccountService;
	clock: Clock;
	aiTelemetry: AiTelemetryPort;
	langfuse: LangfusePort | undefined;
	nodeId: string;
};

/**
 * Activity dashboard dependencies.
 * Per CHARGE_RECEIPTS_IS_LEDGER_TRUTH: charge_receipts is primary data source.
 * LLM detail (model/tokens) fetched via listLlmChargeDetails, merged in facade.
 */
export type ActivityDeps = {
	accountService: AccountService;
};

// Module-level singleton
let _container: Container | null = null;
let _temporalConnection: TemporalConnection | null = null;
let _workflowClient: WorkflowClient | null = null;
let _workflowClientPromise: Promise<{
	client: WorkflowClient;
	taskQueue: string;
}> | null = null;

/**
 * Get the singleton container instance.
 * Lazily initializes on first access.
 */
export function getContainer(): Container {
	if (!_container) {
		_container = createContainer();
		startGovernanceSyncOnBoot();
	}
	return _container;
}

/**
 * Reset the singleton container.
 * For tests only - allows fresh container between test runs.
 */
export function resetContainer(): void {
	_container = null;
	_webhookRegistrations = null;
	if (_temporalConnection) {
		void _temporalConnection.close();
	}
	_temporalConnection = null;
	_workflowClient = null;
	_workflowClientPromise = null;
}

/**
 * Get a process-wide Temporal WorkflowClient singleton + task queue.
 * Avoids per-request Connection.connect() overhead on hot paths.
 * Returns both client and taskQueue so callers never need serverEnv() directly.
 */
export async function getTemporalWorkflowClient(): Promise<{
	client: WorkflowClient;
	taskQueue: string;
}> {
	// Per QUEUE_PER_NODE_ISOLATION (task.0280): submit to a per-node task queue
	// keyed on this node's UUID. The worker runs one Temporal Worker per node,
	// so one node's queue backlog does not starve the others.
	const perNodeTaskQueue = `${serverEnv().TEMPORAL_TASK_QUEUE}-${getNodeId()}`;
	if (_workflowClient) {
		return {
			client: _workflowClient,
			taskQueue: perNodeTaskQueue,
		};
	}
	if (!_workflowClientPromise) {
		_workflowClientPromise = (async () => {
			const env = serverEnv();
			const connection = await TemporalConnection.connect({
				address: env.TEMPORAL_ADDRESS,
			});
			const temporalClient = new TemporalClient({
				connection,
				namespace: env.TEMPORAL_NAMESPACE,
			});
			_temporalConnection = connection;
			_workflowClient = temporalClient.workflow;
			return { client: _workflowClient, taskQueue: perNodeTaskQueue };
		})();
	}
	return _workflowClientPromise;
}

/** Lazy singleton for webhook registrations (avoids import cost at container init). */
let _webhookRegistrations: ReadonlyMap<string, DataSourceRegistration> | null =
	null;

function getWebhookRegistrations(): ReadonlyMap<
	string,
	DataSourceRegistration
> {
	if (!_webhookRegistrations) {
		const registrations = new Map<string, DataSourceRegistration>();
		registrations.set("github", {
			source: "github",
			version: GITHUB_ADAPTER_VERSION,
			webhook: new GitHubWebhookNormalizer(),
		});
		registrations.set("alchemy", {
			source: "alchemy",
			version: ALCHEMY_ADAPTER_VERSION,
			webhook: new AlchemyWebhookNormalizer(),
		});
		_webhookRegistrations = registrations;
	}
	return _webhookRegistrations;
}

/** Lazy singleton for attribution pipeline registries (built from repo-spec). */
let _collectRegistries: DefaultRegistries | null = null;

/**
 * Build the attribution pipeline registries for the in-process collect pass.
 * excludedLogins + sourceRefs are read from repo-spec activity_sources the same
 * way the scheduler-worker does (fail-open: absent ledger config → empty filters).
 */
function getCollectRegistries(): DefaultRegistries {
	if (!_collectRegistries) {
		const ledgerConfig = getLedgerConfig();
		const excludedLogins = ledgerConfig
			? Object.values(ledgerConfig.activitySources).flatMap(
					(s) => s.excludedLogins ?? [],
				)
			: [];
		const sourceRefs = ledgerConfig
			? Object.values(ledgerConfig.activitySources).flatMap(
					(s) => s.sourceRefs ?? [],
				)
			: [];
		_collectRegistries = createDefaultRegistries({
			excludedLogins,
			sourceRefs,
		});
	}
	return _collectRegistries;
}

/**
 * Assemble deps for IN-PROCESS epoch finalization (story.5007 — finalize-in-process).
 * The node runs `runFinalizeEpoch` synchronously in its own finalize route on its OWN
 * service DB + repo-spec, retiring the Temporal FinalizeEpochWorkflow round-trip (no
 * ledger-tasks queue, no cross-scope theft). All adapter/registry wiring lives here —
 * the route boundary forbids adapter imports.
 *
 * - `attributionStore` = service DB (BYPASSRLS) scoped adapter.
 * - `walletResolver` built only when a token is configured; else the R3 fold no-ops.
 * - `distributionConfigClient` = null. A node finalizes only its OWN epochs, so the
 *   baked tokenomics from its OWN repo-spec are already authoritative (no per-node
 *   gateway — that is an operator-only concept). The bug.5020 execute-guard still
 *   fires on the baked emissions-holder / non-production runtime.
 */
function buildFinalizeEpochDeps(logger: FinalizeLogger): RunFinalizeEpochDeps {
	const serviceDb = getServiceDb();
	const tokenomics = getNodeTokenomicsConfig();
	return {
		attributionStore: new DrizzleAttributionAdapter(serviceDb, getScopeId()),
		registries: getCollectRegistries(),
		nodeId: getNodeId(),
		scopeId: getScopeId(),
		chainId: tokenomics.chainId,
		tokenAddress: tokenomics.tokenAddress,
		distributorAddress: tokenomics.distributorAddress,
		emissionsHolderAddress: getEmissionsHolderAddress(),
		walletResolver: tokenomics.tokenAddress
			? new DrizzleClaimantWalletResolver(serviceDb)
			: null,
		distributionConfigClient: null,
		deploymentEnvironment: serverEnv().DEPLOY_ENVIRONMENT,
		logger,
	};
}

/**
 * Run epoch finalization IN-PROCESS (story.5007). Thin composition-root wrapper the
 * finalize route calls instead of dispatching a Temporal FinalizeEpochWorkflow — keeps
 * the route free of adapter/package wiring (route boundary). Idempotent: a re-POST
 * repairs; the fold FREEZE (bug.5022) preserves a published manifest.
 */
export async function finalizeEpochInProcess(
	input: FinalizeEpochInput,
	logger: FinalizeLogger,
): Promise<FinalizeEpochOutput> {
	return runFinalizeEpoch(buildFinalizeEpochDeps(logger), input);
}

function createContainer(): Container {
	const env = serverEnv();
	const nodeId = getNodeId();
	const db = getAppDb();
	const log = makeLogger({ service: "cogni-template", nodeId });

	// Startup log - confirm config in Loki (no URLs/secrets)
	log.info(
		{
			env: env.APP_ENV,
			logLevel: env.PINO_LOG_LEVEL,
			pretty: env.NODE_ENV === "development",
		},
		"container initialized",
	);

	// Initialize PostHog product analytics (required — env validated at boot)
	if (env.POSTHOG_API_KEY && env.POSTHOG_HOST) {
		initAnalytics({
			apiKey: env.POSTHOG_API_KEY,
			host: env.POSTHOG_HOST,
			appVersion: env.COGNI_REPO_SHA ?? "unknown",
			environment: env.DEPLOY_ENVIRONMENT ?? "local",
		});
		log.info("PostHog analytics initialized");
	} else {
		log.info("PostHog not configured — analytics disabled");
	}

	// Flush analytics events on graceful shutdown
	const flushOnExit = () => {
		shutdownAnalytics().catch(() => {});
	};
	process.on("SIGTERM", flushOnExit);
	process.on("SIGINT", flushOnExit);

	// LLM adapter: always LiteLlmAdapter (test stacks use mock-openai-api via litellm.test.config.yaml)
	const llmService = new LiteLlmAdapter();

	// EvmOnchainClient: test uses singleton fake (configurable from tests), production uses viem RPC
	const evmOnchainClient = env.isTestMode
		? getTestEvmOnchainClient()
		: new ViemEvmOnchainClient();

	// OnChainVerifier: test uses singleton fake (configurable from tests), production uses EVM RPC verifier
	const onChainVerifier = env.isTestMode
		? getTestOnChainVerifier()
		: new EvmRpcOnChainVerifierAdapter(evmOnchainClient);

	// MetricsQuery: test uses fake adapter, production uses Prometheus HTTP API
	// Not configured: stub that throws on use (deferred error, doesn't block startup)
	const metricsQuery: MetricsQueryPort = env.isTestMode
		? new FakeMetricsAdapter()
		: (() => {
				const queryUrl = derivePrometheusQueryUrl(env);
				if (
					!queryUrl ||
					!env.PROMETHEUS_READ_USERNAME ||
					!env.PROMETHEUS_READ_PASSWORD
				) {
					// Return stub that throws on use - allows app to start without metrics config
					const notConfiguredError = new Error(
						"MetricsQueryPort not configured. Set PROMETHEUS_QUERY_URL (or PROMETHEUS_REMOTE_WRITE_URL " +
							"ending in /api/prom/push) + PROMETHEUS_READ_USERNAME + PROMETHEUS_READ_PASSWORD.",
					);
					return {
						queryRange: async () => {
							throw notConfiguredError;
						},
						queryInstant: async () => {
							throw notConfiguredError;
						},
						queryTemplate: async () => {
							throw notConfiguredError;
						},
					} satisfies MetricsQueryPort;
				}

				const mimirConfig: MimirAdapterConfig = {
					url: queryUrl,
					username: env.PROMETHEUS_READ_USERNAME,
					password: env.PROMETHEUS_READ_PASSWORD,
					timeoutMs: env.ANALYTICS_QUERY_TIMEOUT_MS,
				};
				return new MimirMetricsAdapter(mimirConfig);
			})();

	// FinancialLedger: optional — only when TIGERBEETLE_ADDRESS is configured
	// @cogni/financial-ledger/adapters is in serverExternalPackages (N-API addon, not bundleable)
	const financialLedger: FinancialLedgerPort | undefined = (() => {
		if (!env.TIGERBEETLE_ADDRESS) return undefined;
		try {
			const adapter = createTigerBeetleAdapter(env.TIGERBEETLE_ADDRESS);
			log.info(
				{ address: env.TIGERBEETLE_ADDRESS },
				"TigerBeetle financial ledger connected",
			);
			return adapter;
		} catch (err) {
			log.warn(
				{ err },
				"TigerBeetle client failed to initialize — financial ledger disabled",
			);
			return undefined;
		}
	})();

	// Always use real database adapters
	// Testing strategy: unit tests mock the port, integration tests use real DB
	const serviceAccountService = new ServiceDrizzleAccountService(
		getServiceDb(),
		financialLedger,
	);
	// TreasuryReadPort: always uses ViemTreasuryAdapter (no test fake needed - mocked at port level in tests)
	const treasuryReadPort = new ViemTreasuryAdapter(evmOnchainClient);

	// AI Telemetry: DrizzleAiTelemetryAdapter always wired (per AI_SETUP_SPEC.md)
	const aiTelemetry = new DrizzleAiTelemetryAdapter(db);

	// Langfuse: only wired when LANGFUSE_SECRET_KEY is set (optional)
	// Environment read by SDK from LANGFUSE_TRACING_ENVIRONMENT env var
	const langfuse: Container["langfuse"] =
		env.LANGFUSE_SECRET_KEY && env.LANGFUSE_PUBLIC_KEY
			? new LangfuseAdapter({
					publicKey: env.LANGFUSE_PUBLIC_KEY,
					secretKey: env.LANGFUSE_SECRET_KEY,
					...(env.LANGFUSE_BASE_URL ? { baseUrl: env.LANGFUSE_BASE_URL } : {}),
				})
			: undefined;

	const clock = new SystemClock();

	// Scheduling adapters (from @cogni/db-client)
	// Per architecture rule: composition root injects loggers via child()

	// ScheduleControlPort: Temporal is required infrastructure
	// Per SCHEDULER_SPEC.md: TEMPORAL_ADDRESS + TEMPORAL_NAMESPACE must be configured
	if (!env.TEMPORAL_ADDRESS || !env.TEMPORAL_NAMESPACE) {
		throw new Error(
			"TEMPORAL_ADDRESS and TEMPORAL_NAMESPACE are required. " +
				"Start Temporal with: pnpm dev:infra",
		);
	}
	// Per QUEUE_PER_NODE_ISOLATION: Schedules submit to this node's per-node
	// queue. Existing schedules on the legacy queue keep firing until their
	// next update (drain Worker in scheduler-worker still polls the base name).
	const scheduleControl: ScheduleControlPort =
		new TemporalScheduleControlAdapter({
			address: env.TEMPORAL_ADDRESS,
			namespace: env.TEMPORAL_NAMESPACE,
			taskQueue: `${env.TEMPORAL_TASK_QUEUE}-${getNodeId()}`,
		});

	// Service DB (BYPASSRLS) for worker adapters
	const serviceDb = getServiceDb();
	const paymentAttemptServiceRepository =
		new ServiceDrizzlePaymentAttemptRepository(serviceDb);

	// User-facing scheduling (appDb, RLS enforced)
	const executionGrantPort = new DrizzleExecutionGrantUserAdapter(
		db,
		log.child({ component: "DrizzleExecutionGrantUserAdapter" }),
	);
	const scheduleManager = new DrizzleScheduleUserAdapter(
		db,
		scheduleControl,
		executionGrantPort,
		log.child({ component: "DrizzleScheduleUserAdapter" }),
	);

	// Worker scheduling (serviceDb, BYPASSRLS)
	const executionGrantWorkerPort = new DrizzleExecutionGrantWorkerAdapter(
		serviceDb,
		log.child({ component: "DrizzleExecutionGrantWorkerAdapter" }),
	);
	const graphRunRepository = new DrizzleGraphRunAdapter(
		serviceDb,
		log.child({ component: "DrizzleGraphRunAdapter" }),
	);

	// Execution request port (not user-scoped — exempt from RLS)
	const executionRequestPort = new DrizzleExecutionRequestAdapter(
		db,
		log.child({ component: "DrizzleExecutionRequestAdapter" }),
	);

	// MetricsCapability for AI tools (requires PROMETHEUS_URL)
	const metricsCapability = createMetricsCapability(env);

	// WebSearchCapability for AI tools (requires TAVILY_API_KEY)
	const webSearchCapability = createWebSearchCapability(env);

	// RepoCapability for AI tools (requires COGNI_REPO_PATH)
	const repoCapability = createRepoCapability(env);

	// WorkItemCapability: query and metadata patches use the live Doltgres backlog.
	// The authenticated run actor is resolved per invocation, preserving interactive/scheduled attribution.
	const workItemAdapter = new MarkdownWorkItemAdapter(
		env.COGNI_REPO_ROOT ?? "/nonexistent",
	);
	const workItemCapability = createWorkItemCapability({
		workItemQuery: workItemAdapter,
		workItemCommand: workItemAdapter,
		// QUERY_READS_THE_LIVE_BACKLOG: the AI query tool (and the prioritizer) reads
		// this node's Doltgres work items; `doltgresWorkItems` is assigned below and
		// read only at call time.
		backlogReader: { list: (query) => doltgresWorkItems.list(query) },
		backlogWriter: {
			store: {
				patch: (input, principal) => doltgresWorkItems.patch(input, principal),
			},
			principalId: () => {
				const actor = getExecutionScope().actorUserId;
				if (!actor) {
					throw new Error(
						"WorkItemCapability: authenticated run actorUserId is required",
					);
				}
				return actor;
			},
		},
	});

	// ScheduleCapability for AI tools (reads actorUserId from ALS at invocation time)
	const scheduleCapability = createScheduleCapability({
		scheduleManager,
		getOrCreateBillingAccountId: async (userId) => {
			const accountService = new UserDrizzleAccountService(
				db,
				userId,
				financialLedger,
			);
			const account = await accountService.getOrCreateBillingAccountForUser({
				userId: userId as string,
			});
			return account.id;
		},
	});

	// KnowledgeCapability + EdoCapability for AI tools (require DOLTGRES_URL)
	let knowledgeCapability: KnowledgeCapability;
	let edoCapability: EdoCapability;
	let knowledgeContributionService: ContributionService | undefined;
	const nodeAdmin = createApproversNodeAdminAuthority();
	let knowledgeStorePort: KnowledgeStorePort | undefined;
	let doltgresWorkItems: WorkItemsDoltgresPort;
	if (env.DOLTGRES_URL) {
		const doltClient = buildDoltgresClient({
			connectionString: env.DOLTGRES_URL,
			applicationName: `cogni_knowledge_${env.SERVICE_NAME ?? "app"}`,
		});
		const createWorkItemsClient = () =>
			buildDoltgresClient({
				connectionString: env.DOLTGRES_URL as string,
				applicationName: `cogni_work_items_${env.SERVICE_NAME ?? "app"}`,
				max: 1,
			});
		// One live and one draining generation: at most two reader connections.
		const createWorkItemsReadClient = () =>
			buildDoltgresClient({
				connectionString: env.DOLTGRES_URL as string,
				applicationName: `cogni_work_items_read_${env.SERVICE_NAME ?? "app"}`,
				max: 1,
			});
		const workItemsClient = createWorkItemsClient();
		// Node stores start their allocator at 1; operator alone reserves the
		// imported legacy range below 5000.
		doltgresWorkItems = withWorkItemLeases(
			new DoltgresWorkItemAdapter(workItemsClient, {
				// First write follows the coordinated per-database legacy-producer drain.
				writerLockProtocol: "database",
				logger: log,
				recreateClient: createWorkItemsClient,
				readClient: createWorkItemsReadClient(),
				recreateReadClient: createWorkItemsReadClient,
				readConnectionBudget: 2,
			}),
			new PostgresWorkItemLeaseAdapter(serviceDb.$client, { logger: log })
		);
		const createKnowledgeBranchClient = () =>
			buildDoltgresClient({
				connectionString: env.DOLTGRES_URL as string,
				applicationName: `cogni_knowledge_branch_${env.SERVICE_NAME ?? "app"}`,
				max: 1,
			});
		const knowledgeWriter = new DoltBranchSessionRunner(
			createKnowledgeBranchClient(),
			{
				writerProtocol: "database",
				logger: log,
				recreateClient: createKnowledgeBranchClient,
			}
		);
		const knowledgePort = new DoltgresKnowledgeStoreAdapter({
			sql: doltClient,
			writerSession: knowledgeWriter,
		});
		knowledgeStorePort = knowledgePort;
		knowledgeCapability = createKnowledgeCapability(knowledgePort);
		const edoResolver = new DoltgresEdoResolverAdapter({
			sql: doltClient,
			store: knowledgePort,
		});
		edoCapability = createEdoCapability(knowledgePort, edoResolver);
		// Branch work gets its own `max: 1` client, deliberately NOT the pool that
		// serves reads. Dolt branch ops need a session-pinned connection; bounding
		// them above the pool (FIFO + advisory lock, see `DoltBranchSessionRunner`)
		// is what keeps a burst of admin rejects from burning every slot — and
		// keeping them off the read pool is what keeps knowledge reads alive while
		// a write is degraded (bug.5391, bug.5358).
		const contributionPort = new DoltgresKnowledgeContributionAdapter({
			sql: doltClient,
			writerSession: knowledgeWriter,
			logger: log,
		});
		// Optional post-merge mirror to DoltHub (task.5069). Disabled when
		// DOLTHUB_REMOTE_URL is unset. Gate-by-secret-presence follows the
		// established pattern (Langfuse, Privy, PostHog) — DOLTHUB_REMOTE_URL
		// is only granted to the production GitHub Environment Secret scope, so
		// candidate-a/preview boot with the hook undefined and never push. v0
		// invariant: prod is the only writer. Bootstrap: see
		// docs/runbooks/dolthub-remote-bootstrap.md.
		const remoteUrl = env.DOLTHUB_REMOTE_URL;
		const pushMainOnMerge = remoteUrl
			? wrapPushSafe(
					createDoltgresPusher({
						sql: doltClient,
						remoteName: "origin",
						remoteUrl,
					}),
					{
						onSuccess: () => log.info({ remote: remoteUrl }, "dolthub_push_ok"),
						onFailure: (err) =>
							log.warn({ err, remote: remoteUrl }, "dolthub_push_failed"),
					},
				)
			: undefined;
		knowledgeContributionService = createContributionService({
			port: contributionPort,
			canMergeKnowledge: defaultCanMergeKnowledge,
			rateLimit: { maxOpenPerPrincipal: 10 },
			// v0 write-pipeline: shape gate only on the contribution path.
			// Provenance is stamped by the adapter (`source_type='external'`,
			// `source_ref='contribution:<id>:<seq>'`), so the provenance gate is
			// reserved for internal `core__knowledge_write` where the caller
			// controls those fields. See work/projects/proj.knowledge-syntropy.md.
			gates: [shapeGate],
			nodeAdmin,
			...(pushMainOnMerge ? { pushMainOnMerge } : {}),
		});
		log.info(
			{ dolthubMirror: Boolean(env.DOLTHUB_REMOTE_URL) },
			"Knowledge store + EDO capability configured (Doltgres)",
		);
	} else {
		const notConfigured = () => {
			throw new Error("KnowledgeCapability not configured. Set DOLTGRES_URL.");
		};
		knowledgeCapability = {
			search: notConfigured,
			list: notConfigured,
			get: notConfigured,
			write: notConfigured,
		};
		edoCapability = {
			hypothesize: notConfigured,
			decide: notConfigured,
			recordOutcome: notConfigured,
			getChain: notConfigured,
		};
		knowledgeContributionService = undefined;
		knowledgeStorePort = undefined;
		const notConfiguredWorkItems = () => {
			throw new DoltgresNotConfiguredError();
		};
		doltgresWorkItems = {
			get: notConfiguredWorkItems,
			list: notConfiguredWorkItems,
			create: notConfiguredWorkItems,
			patch: notConfiguredWorkItems,
			delete: notConfiguredWorkItems,
			claim: notConfiguredWorkItems,
			heartbeat: notConfiguredWorkItems,
			release: notConfiguredWorkItems,
		};
		log.warn("Knowledge store not configured (DOLTGRES_URL not set)");
	}

	// ToolSource with real implementations (per CAPABILITY_INJECTION)
	const toolBindings = createToolBindings({
		nodePublicOrigin: env.APP_BASE_URL,
		knowledgeCapability,
		edoCapability,
		metricsCapability,
		webSearchCapability,
		repoCapability,
		scheduleCapability,
		vcsCapability: stubVcsCapability,
		workItemCapability,
	});
	const toolSource = createBoundToolSource([...CORE_TOOL_BUNDLE], toolBindings);

	// Config: rethrow in dev/test for diagnosis, respond_500 in production for safety
	const config: ContainerConfig = {
		unhandledErrorPolicy: env.isProd ? "respond_500" : "rethrow",
		// Rate limit bypass: only enabled in test mode (APP_ENV=test)
		// Security: Production builds will never enable bypass regardless of header
		rateLimitBypass: {
			enabled: env.isTestMode,
			headerName: "x-stack-test",
			headerValue: "1",
		},
		// Deploy environment for metrics/logging
		DEPLOY_ENVIRONMENT: env.DEPLOY_ENVIRONMENT ?? "local",
	};

	// OperatorWallet: test uses fake, production uses Privy (optional — only when configured)
	const operatorWalletConfig = getOperatorWalletConfig();
	const operatorWallet: OperatorWalletPort | undefined = env.isTestMode
		? getTestOperatorWallet()
		: (() => {
				if (
					!env.PRIVY_APP_ID ||
					!env.PRIVY_APP_SECRET ||
					!env.PRIVY_SIGNING_KEY
				) {
					return undefined;
				}
				if (!operatorWalletConfig) {
					log.warn(
						"PRIVY_APP_ID set but operator_wallet missing from repo-spec — skipping operator wallet",
					);
					return undefined;
				}
				const treasuryAddress = getDaoTreasuryAddress();
				if (!treasuryAddress) {
					log.warn(
						"operator_wallet configured but governance.dao_contract missing — skipping operator wallet",
					);
					return undefined;
				}
				const paymentConfig = getPaymentConfig();
				if (!paymentConfig) {
					log.warn(
						"PRIVY_APP_ID set but payments_in missing from repo-spec — run `pnpm node:activate-payments`",
					);
					return undefined;
				}
				if (!env.EVM_RPC_URL) {
					log.warn(
						"PRIVY_APP_ID set but EVM_RPC_URL missing — operator wallet requires RPC for tx confirmation",
					);
					return undefined;
				}
				// Steward wallet is optional — when payments_out is absent the adapter
				// fails closed on withdrawToSteward but inbound/distribute still work.
				const stewardWalletConfig = getStewardWalletConfig();
				return new PrivyOperatorWalletAdapter({
					appId: env.PRIVY_APP_ID,
					appSecret: env.PRIVY_APP_SECRET,
					signingKey: env.PRIVY_SIGNING_KEY,
					expectedAddress: operatorWalletConfig.address,
					splitAddress: paymentConfig.receivingAddress,
					treasuryAddress,
					markupPpm: numberToPpm(env.USER_PRICE_MARKUP_FACTOR),
					revenueSharePpm: numberToPpm(env.SYSTEM_TENANT_REVENUE_SHARE),
					maxTopUpUsd: env.OPERATOR_MAX_TOPUP_USD,
					rpcUrl: env.EVM_RPC_URL,
					...(stewardWalletConfig
						? { stewardAddress: stewardWalletConfig.address }
						: {}),
				});
			})();

	// ProviderFunding (OpenRouter/Coinbase top-up) was retired — OpenRouter 410'd
	// programmatic crypto top-up. Outbound vendor funding now flows through the
	// operator wallet's withdrawToSteward + a manual human checkout. The post-credit
	// chain here is now just inbound credit + Split distribute (treasurySettlement below).

	// Connection broker — BYO-AI credential resolution
	// Undefined when CONNECTIONS_ENCRYPTION_KEY not set
	const connectionBroker: ConnectionBrokerPort | undefined = (() => {
		if (!env.CONNECTIONS_ENCRYPTION_KEY) return undefined;
		const keyBuf = Buffer.from(env.CONNECTIONS_ENCRYPTION_KEY, "hex");
		if (keyBuf.length !== 32) {
			log.warn(
				"CONNECTIONS_ENCRYPTION_KEY must be 64 hex chars (32 bytes). BYO-AI disabled.",
			);
			return undefined;
		}
		return new DrizzleConnectionBrokerAdapter({
			db: db as unknown as import("drizzle-orm/node-postgres").NodePgDatabase,
			encryptionKey: keyBuf,
			encryptionKeyId: "v1",
			log,
		});
	})();

	// Redis client for run event streaming (ephemeral stream plane)
	// Per REDIS_IS_STREAM_PLANE: only transient data, no durable state
	const redisClient = new Redis(env.REDIS_URL, {
		lazyConnect: true,
		maxRetriesPerRequest: 3,
	});
	const runStream = new RedisRunStreamAdapter(redisClient);
	const nodeStream = new RedisNodeStreamAdapter(redisClient);

	// Process health publisher (node-local metrics only — external sources use Temporal)
	const publisherAbort = new AbortController();
	process.on("SIGTERM", () => publisherAbort.abort());
	process.on("SIGINT", () => publisherAbort.abort());
	startProcessHealthPublisher({
		port: nodeStream,
		streamKey: `node:${nodeId}:events`,
		signal: publisherAbort.signal,
		logger: log,
		environment: env.DEPLOY_ENVIRONMENT ?? "local",
	});

	return {
		log,
		config,
		llmService,
		accountsForUser: (userId: UserId) =>
			new UserDrizzleAccountService(db, userId, financialLedger),
		serviceAccountService,
		clock,
		paymentAttemptsForUser: (userId: UserId) =>
			new UserDrizzlePaymentAttemptRepository(db, userId),
		paymentAttemptServiceRepository,
		onChainVerifier,
		evmOnchainClient,
		paymentRailsActive: !!getPaymentConfig(),
		metricsQuery,
		treasuryReadPort,
		aiTelemetry,
		langfuse,
		nodeId,
		scheduleControl,
		executionGrantPort,
		executionGrantWorkerPort,
		executionRequestPort,
		graphRunRepository,
		scheduleRunReader: new DrizzleScheduleRunReader(db),
		scheduleManager,
		metricsCapability,
		webSearchCapability,
		repoCapability,
		toolSource,
		knowledgeContributionService,
		nodeAdmin,
		knowledgeStorePort,
		edoCapability,
		threadPersistenceForUser: (userId: UserId) =>
			new DrizzleThreadPersistenceAdapter(db, userActor(userId)),
		governanceStatus: new DrizzleGovernanceStatusAdapter(
			db,
			userActor(toUserId(COGNI_SYSTEM_PRINCIPAL_USER_ID)),
		),
		attributionStore: new DrizzleAttributionAdapter(serviceDb, getScopeId()),
		workItemQuery: workItemAdapter,
		doltgresWorkItems,
		runStream,
		nodeStream,
		get webhookRegistrations() {
			return getWebhookRegistrations();
		},
		get registries() {
			return getCollectRegistries();
		},
		// Collect over webhook-delivered receipts: reuse the webhook-only registrations.
		// No poll adapter → runCollectPass skips polling and selects delivered receipts.
		get sourceRegistrations() {
			return getWebhookRegistrations();
		},
		financialLedger,
		operatorWallet,
		treasurySettlement: operatorWallet
			? new SplitTreasurySettlementAdapter(operatorWallet, USDC_TOKEN_ADDRESS)
			: undefined,
		connectionBroker,
		// Multi-provider model ports
		...(() => {
			const platformProvider = new PlatformModelProvider(llmService);
			// Parse MCP server config for Codex native MCP support (bug.0232).
			// parseMcpConfigFromEnv is synchronous (reads file + env vars).
			const codexMcpConfig = mcpServersToCodexConfig(parseMcpConfigFromEnv());
			const codexProvider = new CodexModelProvider(codexMcpConfig);
			const openAiCompatibleProvider = new OpenAiCompatibleModelProvider(
				connectionBroker,
				resolveAppDb,
			);
			const providers = [
				platformProvider,
				codexProvider,
				openAiCompatibleProvider,
			];
			return {
				modelCatalog: new AggregatingModelCatalog(providers),
				providerResolver: new ProviderResolver(providers),
			};
		})(),
	};
}

/**
 * Resolves dependencies for AI adapter construction.
 * Used by graph-executor.factory.ts.
 */
export function resolveAiAdapterDeps(userId: UserId): AiAdapterDeps {
	const container = getContainer();
	return {
		llmService: container.llmService,
		accountService: container.accountsForUser(userId),
		clock: container.clock,
		aiTelemetry: container.aiTelemetry,
		langfuse: container.langfuse,
		nodeId: container.nodeId,
	};
}

export function resolveActivityDeps(userId: UserId): ActivityDeps {
	const container = getContainer();
	return {
		accountService: container.accountsForUser(userId),
	};
}

/**
 * Scheduling dependencies for CRUD operations.
 * Used by schedule routes.
 */
export type SchedulingDeps = Pick<
	Container,
	| "scheduleControl"
	| "executionGrantPort"
	| "executionGrantWorkerPort"
	| "graphRunRepository"
	| "scheduleManager"
>;

export function resolveSchedulingDeps(): SchedulingDeps {
	const container = getContainer();
	return {
		scheduleControl: container.scheduleControl,
		executionGrantPort: container.executionGrantPort,
		executionGrantWorkerPort: container.executionGrantWorkerPort,
		graphRunRepository: container.graphRunRepository,
		scheduleManager: container.scheduleManager,
	};
}

/**
 * Resolve appDb for facade-level queries that don't need a full port abstraction.
 * Uses appDb (RLS-scoped) — caller must be authenticated.
 */
export function resolveAppDb(): Database {
	return getAppDb();
}

/**
 * Resolve serviceDb for pre-auth or system-level writes that must bypass RLS.
 */
export function resolveServiceDb(): Database {
	return getServiceDb();
}
