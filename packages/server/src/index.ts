export { createServer } from "./http/server";
export {
  AFFORDABILITY_API_V1_PATH,
  registerAffordabilityRoutes,
} from "./http/affordability-routes";
export { registerLocalRoutes } from "./http/local-routes";
export { registerPlaidRoutes } from "./http/plaid-routes";
export {
  commitCsvStatementImport,
  getLocalSpendingState,
  previewCsvStatementImport,
} from "./local/statement-import";
export {
  createDefaultStatementImportStore,
  defaultStatementImportStorePath,
  FileStatementImportStore,
  InMemoryStatementImportStore,
} from "./local/store";
export {
  createLinkToken,
  exchangePublicToken,
  getAccountsAndBalances,
  getCanonicalSnapshot,
  getTransactions,
  syncTransactions,
} from "./plaid/adapter";
export { createPlaidClient } from "./plaid/client";
export { FieldCipher, FieldCipherKeyError, loadFieldCipher } from "./crypto/field-cipher";
export { loadPlaidConfig, PlaidConfigError } from "./plaid/config";
export { PlaidAdapterError } from "./plaid/errors";
export { FilePlaidTokenStore, InMemoryPlaidTokenStore } from "./plaid/token-store";
export {
  mapPlaidAccount,
  mapPlaidAccounts,
  mapPlaidDataToSnapshot,
  mapPlaidTransaction,
  mapPlaidTransactions,
} from "./plaid/mapper";
export type { CreateServerOptions } from "./http/server";
export type { AffordabilityApiInvalidRequestError } from "./http/affordability-routes";
export type { RegisterLocalRoutesOptions } from "./http/local-routes";
export type {
  CategoryMappingResult,
  CsvColumnMapping,
  CsvStatementImportCommit,
  CsvStatementImportInput,
  CsvStatementImportPreview,
  LocalAccountInput,
  StatementImportIssue,
} from "./local/statement-import";
export type {
  SaveStatementImportInput,
  SaveStatementImportResult,
  StatementImportBatch,
  StatementImportState,
  StatementImportStore,
} from "./local/store";
export type {
  PlaidAccountsResult,
  PlaidClientLike,
  PlaidConnectionResult,
  PlaidLinkTokenResult,
  PlaidSnapshotResult,
  PlaidSyncResult,
  PlaidTransactionsResult,
} from "./plaid/adapter";
export type { PlaidConfig } from "./plaid/config";
export type { SafePlaidError } from "./plaid/errors";
export type { PlaidSnapshotMappingOptions } from "./plaid/mapper";
export type { PlaidTokenStore, StoredPlaidConnection } from "./plaid/token-store";

export {
  registerSpendingRoutes,
  SPENDING_SUMMARY_PATH,
  SPENDING_SERIES_PATH,
  TRANSACTIONS_PATH,
  INSIGHTS_PATH,
  ACCOUNTS_PATH,
} from "./http/spending-routes";

export { registerAgentRoutes } from "./http/agent-routes";
export { loadAgentConfig } from "./agent/config";
export { runAgentChat } from "./agent/chat";
export {
  AgentConfigError,
  assertLoopbackUrl,
  createChatProvider,
  isLoopbackHost,
  LocalChatProvider,
  AnthropicChatProvider,
} from "./agent/provider";
export {
  FileAgentMemoryProvider,
  InMemoryAgentMemoryProvider,
} from "./agent/memory/provider";
export {
  FileAgentMemoryStore,
  InMemoryAgentMemoryStore,
} from "./agent/memory/store";
export type { AgentConfig, AgentProvider } from "./agent/config";
export type { ChatProvider } from "./agent/provider";
export type { AgentMemoryProvider } from "./agent/memory/provider";
export type {
  AgentMemoryStore,
  Conversation,
  ConversationTurn,
  MemoryFact,
  UploadedFile,
} from "./agent/memory/store";
