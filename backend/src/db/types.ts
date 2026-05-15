import type { ColumnType, Generated, Insertable, Selectable, Updateable } from "kysely";

export type Json = JsonValue;
export type JsonArray = JsonValue[];
export type JsonObject = { [key: string]: JsonValue | undefined };
export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonArray | JsonObject | JsonPrimitive;
export type Timestamp = ColumnType<Date, Date | string, Date | string>;

export interface Account {
  id: string;
  accountId: string;
  providerId: string;
  userId: string;
  accessToken: string | null;
  refreshToken: string | null;
  idToken: string | null;
  accessTokenExpiresAt: Timestamp | null;
  refreshTokenExpiresAt: Timestamp | null;
  scope: string | null;
  password: string | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface ChatMessages {
  id: Generated<string>;
  chatId: string;
  role: string;
  content: Json | null;
  files: Json | null;
  workflow: Json | null;
  annotations: Json | null;
  createdAt: Timestamp;
}

export interface Chats {
  id: Generated<string>;
  userId: string;
  projectId: string | null;
  title: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface DocumentEdits {
  id: Generated<string>;
  documentId: string;
  chatMessageId: string | null;
  versionId: string;
  changeId: string;
  delWId: string | null;
  insWId: string | null;
  deletedText: string;
  insertedText: string;
  contextBefore: string | null;
  contextAfter: string | null;
  status: string;
  createdAt: Timestamp;
  resolvedAt: Timestamp | null;
}

export interface DocumentVersions {
  id: Generated<string>;
  documentId: string;
  storagePath: string;
  pdfStoragePath: string | null;
  source: string;
  versionNumber: number | null;
  displayName: string | null;
  createdAt: Timestamp;
}

export interface Documents {
  id: Generated<string>;
  projectId: string | null;
  userId: string;
  filename: string;
  fileType: string | null;
  sizeBytes: number;
  pageCount: number | null;
  structureTree: Json | null;
  status: string;
  folderId: string | null;
  currentVersionId: string | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface HiddenWorkflows {
  id: Generated<string>;
  userId: string;
  workflowId: string;
  createdAt: Timestamp;
}

export interface ProjectSubfolders {
  id: Generated<string>;
  projectId: string;
  userId: string;
  name: string;
  parentFolderId: string | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface Projects {
  id: Generated<string>;
  userId: string;
  name: string;
  cmNumber: string | null;
  visibility: string;
  sharedWith: Json;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface Session {
  id: string;
  expiresAt: Timestamp;
  token: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  ipAddress: string | null;
  userAgent: string | null;
  userId: string;
}

export interface TabularCells {
  id: Generated<string>;
  reviewId: string;
  documentId: string;
  columnIndex: number;
  content: Json | null;
  status: string;
  citations: Json | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface TabularReviewChatMessages {
  id: Generated<string>;
  chatId: string;
  role: string;
  content: Json | null;
  annotations: Json | null;
  createdAt: Timestamp;
}

export interface TabularReviewChats {
  id: Generated<string>;
  reviewId: string;
  userId: string;
  title: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface TabularReviews {
  id: Generated<string>;
  userId: string;
  projectId: string | null;
  title: string;
  columnsConfig: Json;
  tags: Json;
  sharedWith: Json;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface User {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image: string | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface UserApiKeys {
  id: Generated<string>;
  userId: string;
  provider: string;
  encryptedKey: string;
  iv: string;
  authTag: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface UserProfiles {
  id: Generated<string>;
  userId: string;
  displayName: string | null;
  organisation: string | null;
  tier: string;
  messageCreditsUsed: number;
  creditsResetDate: Timestamp;
  tabularModel: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface Verification {
  id: string;
  identifier: string;
  value: string;
  expiresAt: Timestamp;
  createdAt: Timestamp | null;
  updatedAt: Timestamp | null;
}

export interface WorkflowShares {
  id: Generated<string>;
  workflowId: string;
  sharedByUserId: string;
  sharedWithEmail: string;
  allowEdit: boolean;
  createdAt: Timestamp;
}

export interface Workflows {
  id: Generated<string>;
  userId: string | null;
  title: string;
  type: string;
  promptMd: string | null;
  columnsConfig: Json | null;
  practice: string | null;
  isSystem: boolean;
  createdAt: Timestamp;
}

export interface DB {
  account: Account;
  chatMessages: ChatMessages;
  chats: Chats;
  documentEdits: DocumentEdits;
  documentVersions: DocumentVersions;
  documents: Documents;
  hiddenWorkflows: HiddenWorkflows;
  projectSubfolders: ProjectSubfolders;
  projects: Projects;
  session: Session;
  tabularCells: TabularCells;
  tabularReviewChatMessages: TabularReviewChatMessages;
  tabularReviewChats: TabularReviewChats;
  tabularReviews: TabularReviews;
  user: User;
  userApiKeys: UserApiKeys;
  userProfiles: UserProfiles;
  verification: Verification;
  workflowShares: WorkflowShares;
  workflows: Workflows;
}

export type AccountSelect = Selectable<Account>;
export type AccountInsert = Insertable<Account>;
export type AccountUpdate = Updateable<Account>;
