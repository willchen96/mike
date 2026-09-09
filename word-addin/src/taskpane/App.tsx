import React, { useCallback, useEffect, useState } from "react";
import { useAuth } from "./auth/useAuth";
import { LoginPage } from "./auth/LoginPage";
import { ApiKeyBanner } from "./components/shell/ApiKeyBanner";
import { ChatPanel } from "./components/assistant/ChatPanel";
import { DocumentActions } from "./components/quick-actions/DocumentActions";
import { ChatHistoryPage } from "./components/history/ChatHistoryPage";
import { WorkflowPicker } from "./components/workflows/WorkflowPicker";
import { Spinner } from "../shared/ui/spinner";
import type { Message, Workflow } from "./types";
import {
  FloatingHeader,
  type AddinSection,
} from "./components/shell/FloatingHeader";
import { WorkflowDetailsModal } from "./components/workflows/WorkflowDetailsModal";
import { NewWorkflowModal } from "./components/workflows/NewWorkflowModal";
import { SettingsPage } from "./components/settings/SettingsPage";
import {
  useWordChatStoragePreference,
  useWordEditApplyMode,
} from "./lib/wordChatSettings";
import { useWordDocumentIdentity } from "./lib/wordDocumentIdentity";
import { clearLocalWordChats } from "./lib/localWordChats";
import type { ReasoningLevel } from "./lib/wordChatTypes";
import { setReportingUser } from "./lib/errorReporting";

export default function App(): React.ReactElement {
  const { user, loading, error, logout } = useAuth();
  const pendingOwnerId = user?.id ?? null;
  // Error reports carry the user id (never the email); cleared on sign-out.
  useEffect(() => {
    setReportingUser(pendingOwnerId ? { id: pendingOwnerId } : null);
  }, [pendingOwnerId]);
  const wordChatStorage = useWordChatStoragePreference(pendingOwnerId);
  const editApply = useWordEditApplyMode();
  const wordDocument = useWordDocumentIdentity();
  const [selectedSection, setSelectedSection] = useState<AddinSection>("chat");
  const [chatSessionKey, setChatSessionKey] = useState(0);
  const [chatId, setChatId] = useState<string | null>(null);
  const [chatModel, setChatModel] = useState<string | null>(null);
  const [lastSelectedChatModel, setLastSelectedChatModel] = useState<
    string | null
  >(null);
  const [chatReasoningLevel, setChatReasoningLevel] =
    useState<ReasoningLevel | null>(null);
  const [lastSelectedReasoningLevel, setLastSelectedReasoningLevel] =
    useState<ReasoningLevel>("high");
  const [chatInSession, setChatInSession] = useState(false);
  const [initialMessages, setInitialMessages] = useState<Message[]>([]);
  const [workflowPageSelection, setWorkflowPageSelection] =
    useState<Workflow | null>(null);
  const [workflowDetailsOpen, setWorkflowDetailsOpen] = useState(false);
  const [workflowDeleteConfirmOpen, setWorkflowDeleteConfirmOpen] =
    useState(false);
  const [newWorkflowOpen, setNewWorkflowOpen] = useState(false);
  const [workflowListRevision, setWorkflowListRevision] = useState(0);
  const [newQuickActionOpen, setNewQuickActionOpen] = useState(false);
  const [chatWorkflow, setChatWorkflow] = useState<{
    id: string;
    title: string;
  } | null>(null);
  const handleChatIdChange = useCallback((nextChatId: string) => {
    setChatId(nextChatId);
    setChatInSession(true);
  }, []);
  const markChatStarted = useCallback(() => setChatInSession(true), []);

  // Show a minimal spinner while the token is being read from storage
  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner label="Loading…" />
      </div>
    );
  }

  if (!user) {
    return <LoginPage />;
  }

  if (wordChatStorage.loading || wordDocument.loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner label="Opening document chats…" />
      </div>
    );
  }

  if (!wordDocument.documentId) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-red-600">
        {wordDocument.error ?? "Could not identify this Word document."}
      </div>
    );
  }

  const wordDocumentId = wordDocument.documentId;
  const wordChatOwnerId = pendingOwnerId as string;

  const renderSection = (): React.ReactElement => {
    switch (selectedSection) {
      case "chat":
        return <></>;
      case "actions":
        return (
          <DocumentActions
            createOpen={newQuickActionOpen}
            onCreateClose={() => setNewQuickActionOpen(false)}
          />
        );
      case "workflows":
        return (
          <WorkflowPicker
            key={workflowListRevision}
            selectedWorkflow={workflowPageSelection}
            onSelectedWorkflowChange={setWorkflowPageSelection}
          />
        );
      case "history":
        return (
          <ChatHistoryPage
            onSelect={openSelectedChat}
            documentId={wordDocumentId}
            storageMode={wordChatStorage.mode}
            ownerId={wordChatOwnerId}
          />
        );
      case "settings":
        return (
          <SettingsPage
            storageMode={wordChatStorage.mode}
            onStorageModeChange={async (mode) => {
              await wordChatStorage.setMode(mode);
              setChatId(null);
              setChatModel(null);
              setChatReasoningLevel(null);
              setChatInSession(false);
              setInitialMessages([]);
              setChatSessionKey((current) => current + 1);
            }}
            onClearLocalChats={() => clearLocalWordChats(wordChatOwnerId)}
          />
        );
    }
  };

  function openSelectedChat(
    selectedChatId: string,
    messages: Message[],
    model: string | null,
    reasoningLevel: ReasoningLevel | null,
  ): void {
    setSelectedSection("chat");
    setWorkflowPageSelection(null);
    setWorkflowDetailsOpen(false);
    setWorkflowDeleteConfirmOpen(false);
    setChatWorkflow(null);
    setChatId(selectedChatId);
    setChatModel(model);
    setChatReasoningLevel(reasoningLevel);
    setChatInSession(true);
    setInitialMessages(messages);
    setChatSessionKey((current) => current + 1);
  }

  const changeSection = (section: AddinSection): void => {
    setSelectedSection(section);
    if (section !== "actions") setNewQuickActionOpen(false);
    if (section !== "workflows") {
      setWorkflowPageSelection(null);
      setWorkflowDetailsOpen(false);
      setWorkflowDeleteConfirmOpen(false);
    }
  };

  const startNewChat = (): void => {
    setSelectedSection("chat");
    setWorkflowPageSelection(null);
    setWorkflowDetailsOpen(false);
    setWorkflowDeleteConfirmOpen(false);
    setChatWorkflow(null);
    setChatId(null);
    setChatModel(null);
    setChatReasoningLevel(null);
    setChatInSession(false);
    setInitialMessages([]);
    setChatSessionKey((current) => current + 1);
  };

  const useSelectedWorkflow = (): void => {
    if (!workflowPageSelection) return;
    setChatWorkflow({
      id: workflowPageSelection.id,
      title: workflowPageSelection.metadata.title,
    });
    setWorkflowDetailsOpen(false);
    setWorkflowDeleteConfirmOpen(false);
    setWorkflowPageSelection(null);
    setSelectedSection("chat");
  };

  return (
    <div className="relative h-full overflow-hidden bg-background">
      <FloatingHeader
        section={selectedSection}
        onSectionChange={changeSection}
        onNewChat={startNewChat}
        hasActiveChat={chatInSession}
        onSelectHistoryChat={openSelectedChat}
        workflowDetailOpen={
          selectedSection === "workflows" && !!workflowPageSelection
        }
        onWorkflowBack={() => {
          setWorkflowDetailsOpen(false);
          setWorkflowDeleteConfirmOpen(false);
          setWorkflowPageSelection(null);
        }}
        onOpenWorkflowDetails={() => setWorkflowDetailsOpen(true)}
        onDeleteWorkflow={() => setWorkflowDeleteConfirmOpen(true)}
        canDeleteWorkflow={
          !!workflowPageSelection &&
          !workflowPageSelection.is_system &&
          workflowPageSelection.allow_edit !== false
        }
        onUseWorkflow={useSelectedWorkflow}
        onNewWorkflow={() => setNewWorkflowOpen(true)}
        onNewQuickAction={() => setNewQuickActionOpen(true)}
        onSignOut={() => void logout()}
        wordDocumentId={wordDocumentId}
        wordChatStorage={wordChatStorage.mode}
        wordChatOwnerId={wordChatOwnerId}
      />

      <div className="absolute inset-x-3 top-14 z-30">
        {error && (
          <div
            className="mb-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600 shadow-sm"
            role="alert"
          >
            {error}
          </div>
        )}
        <ApiKeyBanner />
      </div>

      <div className="flex h-full flex-col overflow-hidden">
        <div
          className={
            selectedSection === "chat"
              ? "flex min-h-0 flex-1 flex-col"
              : "hidden"
          }
          aria-hidden={selectedSection === "chat" ? undefined : true}
        >
          <ChatPanel
            sessionKey={chatSessionKey}
            chatId={chatId}
            chatModel={chatModel}
            lastSelectedModel={lastSelectedChatModel}
            chatReasoningLevel={chatReasoningLevel}
            lastSelectedReasoningLevel={lastSelectedReasoningLevel}
            initialMessages={initialMessages}
            selectedWorkflow={chatWorkflow}
            onSelectedWorkflowChange={setChatWorkflow}
            onChatIdChange={handleChatIdChange}
            onChatStarted={markChatStarted}
            onModelSelected={(model) => {
              setChatModel(model);
              setLastSelectedChatModel(model);
            }}
            onReasoningSelected={(level) => {
              setChatReasoningLevel(level);
              setLastSelectedReasoningLevel(level);
            }}
            wordDocumentId={wordDocumentId}
            editApplyMode={editApply.mode}
            onEditApplyModeChange={editApply.setMode}
            wordChatStorage={wordChatStorage.mode}
            wordChatOwnerId={wordChatOwnerId}
          />
        </div>
        {selectedSection !== "chat" && (
          <div className="flex min-h-0 flex-1 flex-col pt-14">
            {renderSection()}
          </div>
        )}
      </div>

      <WorkflowDetailsModal
        open={workflowDetailsOpen && !!workflowPageSelection}
        workflow={workflowPageSelection}
        onClose={() => setWorkflowDetailsOpen(false)}
        onUpdated={setWorkflowPageSelection}
        deleteConfirmOpen={workflowDeleteConfirmOpen}
        onDeleteConfirmOpenChange={setWorkflowDeleteConfirmOpen}
        onDeleted={(workflowId) => {
          setWorkflowDetailsOpen(false);
          setWorkflowDeleteConfirmOpen(false);
          setWorkflowPageSelection(null);
          setWorkflowListRevision((current) => current + 1);
          setChatWorkflow((current) =>
            current?.id === workflowId ? null : current
          );
        }}
      />
      <NewWorkflowModal
        open={newWorkflowOpen}
        onClose={() => setNewWorkflowOpen(false)}
        onCreated={(workflow) => {
          setWorkflowDetailsOpen(false);
          setWorkflowPageSelection(workflow);
        }}
      />
    </div>
  );
}
