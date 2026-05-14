/**
 * Seed fixture: creates a full user data set for Phase 12 integration tests.
 *
 * Inserts rows in FK order:
 *   projects → documents → document_versions → chats → chat_messages
 *   → tabular_reviews → tabular_cells → workflows → document_edits
 *
 * Also uploads placeholder buffers to R2 so the account-deletion worker has
 * objects to enumerate and delete.
 *
 * Returns IDs of all inserted rows and the R2 keys that were written.
 */

import { createClient } from "@supabase/supabase-js";
import { uploadFile } from "../../src/lib/storage";

export async function seedUserData(
  supabase: ReturnType<typeof createClient>,
  userId: string,
): Promise<{
  projectId: string;
  documentId: string;
  versionId: string;
  chatId: string;
  messageId: string;
  reviewId: string;
  cellId: string;
  workflowId: string;
  r2Keys: string[];
}> {
  const placeholder = Buffer.from("seed");

  // 1. Project
  const { data: project, error: projectErr } = await supabase
    .from("projects")
    .insert({ user_id: userId, name: "Seed Project" })
    .select("id")
    .single();
  if (projectErr || !project) {
    throw new Error(`[seedUserData] insert project failed: ${projectErr?.message}`);
  }
  const projectId: string = project.id;

  // 2. Document (no version yet — add current_version_id after version insert)
  const { data: doc, error: docErr } = await supabase
    .from("documents")
    .insert({
      user_id: userId,
      project_id: projectId,
      filename: "seed.docx",
      file_type: "docx",
      size_bytes: placeholder.length,
      status: "ready",
    })
    .select("id")
    .single();
  if (docErr || !doc) {
    throw new Error(`[seedUserData] insert document failed: ${docErr?.message}`);
  }
  const documentId: string = doc.id;

  // 3. Document version
  const docStorageKey = `documents/${userId}/${documentId}/source.docx`;
  const docPdfKey = `documents/${userId}/${documentId}/seed.pdf`;
  await uploadFile(docStorageKey, placeholder.buffer as ArrayBuffer, "application/octet-stream");
  await uploadFile(docPdfKey, placeholder.buffer as ArrayBuffer, "application/pdf");

  const { data: version, error: versionErr } = await supabase
    .from("document_versions")
    .insert({
      document_id: documentId,
      storage_path: docStorageKey,
      pdf_storage_path: docPdfKey,
      source: "upload",
      version_number: 1,
    })
    .select("id")
    .single();
  if (versionErr || !version) {
    throw new Error(`[seedUserData] insert document_version failed: ${versionErr?.message}`);
  }
  const versionId: string = version.id;

  // Backfill current_version_id on the document
  await supabase
    .from("documents")
    .update({ current_version_id: versionId })
    .eq("id", documentId);

  // 4. Chat
  const { data: chat, error: chatErr } = await supabase
    .from("chats")
    .insert({ user_id: userId, project_id: projectId, title: "Seed Chat" })
    .select("id")
    .single();
  if (chatErr || !chat) {
    throw new Error(`[seedUserData] insert chat failed: ${chatErr?.message}`);
  }
  const chatId: string = chat.id;

  // 5. Chat message
  const { data: message, error: messageErr } = await supabase
    .from("chat_messages")
    .insert({ chat_id: chatId, role: "user", content: [{ type: "text", text: "seed" }] })
    .select("id")
    .single();
  if (messageErr || !message) {
    throw new Error(`[seedUserData] insert chat_message failed: ${messageErr?.message}`);
  }
  const messageId: string = message.id;

  // 6. Tabular review
  const { data: review, error: reviewErr } = await supabase
    .from("tabular_reviews")
    .insert({
      user_id: userId,
      project_id: projectId,
      title: "Seed Review",
      columns_config: [{ index: 0, name: "Col", prompt: "seed" }],
    })
    .select("id")
    .single();
  if (reviewErr || !review) {
    throw new Error(`[seedUserData] insert tabular_review failed: ${reviewErr?.message}`);
  }
  const reviewId: string = review.id;

  // 7. Tabular cell
  const { data: cell, error: cellErr } = await supabase
    .from("tabular_cells")
    .insert({
      review_id: reviewId,
      document_id: documentId,
      column_index: 0,
      status: "pending",
    })
    .select("id")
    .single();
  if (cellErr || !cell) {
    throw new Error(`[seedUserData] insert tabular_cell failed: ${cellErr?.message}`);
  }
  const cellId: string = cell.id;

  // 8. Workflow
  const { data: workflow, error: workflowErr } = await supabase
    .from("workflows")
    .insert({ user_id: userId, title: "Seed Workflow", type: "assistant", prompt_md: "seed" })
    .select("id")
    .single();
  if (workflowErr || !workflow) {
    throw new Error(`[seedUserData] insert workflow failed: ${workflowErr?.message}`);
  }
  const workflowId: string = workflow.id;

  // 9. Document edit (references version + message)
  await supabase.from("document_edits").insert({
    document_id: documentId,
    chat_message_id: messageId,
    version_id: versionId,
    change_id: "seed-change-1",
    deleted_text: "old",
    inserted_text: "new",
    status: "pending",
  });

  // 10. Upload R2 objects under all three user prefixes so the worker has
  //     objects to enumerate and delete.
  const generatedKey = `generated/${userId}/${documentId}/generated.docx`;
  await uploadFile(generatedKey, placeholder.buffer as ArrayBuffer, "application/octet-stream");

  const r2Keys = [docStorageKey, docPdfKey, generatedKey];

  return {
    projectId,
    documentId,
    versionId,
    chatId,
    messageId,
    reviewId,
    cellId,
    workflowId,
    r2Keys,
  };
}
