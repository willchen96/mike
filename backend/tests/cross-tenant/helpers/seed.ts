import supertest from "supertest";
import { createClient } from "@supabase/supabase-js";
import { app } from "../../../src/app";

export interface SeededResources {
  projectId: string;
  documentId: string;
  chatId: string;
  reviewId: string;
  workflowId: string;
}

function assertSeed(
  label: string,
  status: number,
  body: unknown,
): void {
  if (status < 200 || status > 299) {
    throw new Error(
      `seed: ${label} failed: status=${status} body=${JSON.stringify(body)}`,
    );
  }
}

function userIdFromJwt(jwt: string): string {
  const payload = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"));
  if (!payload.sub) throw new Error("JWT has no sub claim");
  return payload.sub as string;
}

export async function seedAsUserA(jwtA: string): Promise<SeededResources> {
  const userId = userIdFromJwt(jwtA);

  // Service client for direct DB inserts that would otherwise require R2
  const svc = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { persistSession: false } },
  );

  // 1. Create a project as user-A
  const projectRes = await supertest(app)
    .post("/projects")
    .set("Authorization", `Bearer ${jwtA}`)
    .send({ name: "Cross-Tenant Test Project A" });
  assertSeed("POST /projects", projectRes.status, projectRes.body);
  const projectId: string = (projectRes.body as { id: string }).id;

  // 2. Insert a document record directly — bypasses the R2 upload that the route
  //    requires, which is unavailable in the test environment.  The cross-tenant
  //    tests only need a valid document ID to verify that user-B is denied access
  //    to the document's detail/url/versions routes.
  const { data: docRow, error: docErr } = await svc
    .from("documents")
    .insert({ user_id: userId, project_id: projectId, filename: "test.docx", file_type: "docx" })
    .select("id")
    .single();
  if (docErr || !docRow) throw new Error(`seed document: ${docErr?.message}`);
  const documentId: string = (docRow as { id: string }).id;

  // 3. Create a chat as user-A
  // Route: POST /chat/create (see backend/src/routes/chat.ts)
  const chatRes = await supertest(app)
    .post("/chat/create")
    .set("Authorization", `Bearer ${jwtA}`)
    .send({});
  assertSeed("POST /chat/create", chatRes.status, chatRes.body);
  const chatId: string = (chatRes.body as { id: string }).id;

  // 4. Create a tabular review as user-A, referencing the seeded document
  // POST /tabular-review requires: document_ids (array), columns_config (array)
  const reviewRes = await supertest(app)
    .post("/tabular-review")
    .set("Authorization", `Bearer ${jwtA}`)
    .send({
      title: "Cross-Tenant Test Review",
      document_ids: [documentId],
      columns_config: [
        { index: 0, name: "Summary", prompt: "Summarize the document" },
      ],
    });
  assertSeed("POST /tabular-review", reviewRes.status, reviewRes.body);
  const reviewId: string = (reviewRes.body as { id: string }).id;

  // 5. Create a workflow as user-A
  // POST /workflows requires: title (string), type ("assistant" | "tabular")
  const workflowRes = await supertest(app)
    .post("/workflows")
    .set("Authorization", `Bearer ${jwtA}`)
    .send({
      title: "Cross-Tenant Test Workflow",
      type: "assistant",
      prompt_md: "Test workflow prompt",
    });
  assertSeed("POST /workflows", workflowRes.status, workflowRes.body);
  const workflowId: string = (workflowRes.body as { id: string }).id;

  return { projectId, documentId, chatId, reviewId, workflowId };
}
