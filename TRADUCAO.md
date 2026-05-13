# Instruções de Tradução e Adaptação para pt-BR

## Contexto do Projeto

Este projeto é um fork do [mike](https://github.com/willchen96/mike), um assistente de documentos jurídicos com Next.js (frontend) e Express (backend). O objetivo é:

1. Traduzir toda a interface para português brasileiro (pt-BR)
2. Adaptar o conteúdo à realidade jurídica brasileira
3. Usar `next-intl` para internacionalização, mantendo os textos fora do código-fonte

A infraestrutura do `next-intl` já está instalada e configurada:
- Biblioteca instalada: `next-intl`
- Arquivo de configuração: `frontend/src/i18n/request.ts`
- Arquivo de traduções: `frontend/messages/pt-BR.json`
- Plugin configurado em: `frontend/next.config.ts`

---

## Modo de Trabalho: Interativo

**Trabalhe sempre um arquivo por vez, seguindo este fluxo para cada arquivo:**

1. Leia o arquivo original
2. Identifique todos os textos visíveis ao usuário em inglês
3. Proponha as traduções para português, considerando o glossário e as adaptações brasileiras abaixo
4. Aguarde a aprovação do usuário
5. Só após aprovação: aplique as mudanças no componente e atualize o `pt-BR.json`
6. Confirme que o frontend ainda compila antes de passar para o próximo arquivo

**Nunca modifique mais de um arquivo por vez sem aprovação.**

---

## Ordem de Implementação

Siga esta ordem, um arquivo por vez:

1. `frontend/src/app/login/page.tsx`
2. `frontend/src/app/signup/page.tsx`
3. `frontend/src/app/components/shared/ApiKeyMissingModal.tsx`
4. `frontend/src/app/components/shared/AddDocumentsModal.tsx`
5. `frontend/src/app/components/shared/AddProjectDocsModal.tsx`
6. `frontend/src/app/components/shared/DocView.tsx`
7. `frontend/src/app/components/shared/DocViewModal.tsx`
8. `frontend/src/app/components/shared/FileDirectory.tsx`
9. `frontend/src/app/components/shared/RowActions.tsx`
10. `frontend/src/app/components/shared/SidebarChatItem.tsx`
11. `frontend/src/app/components/shared/UploadNewVersionModal.tsx`
12. `frontend/src/app/components/projects/ProjectExplorer.tsx`
13. `frontend/src/app/components/projects/NewProjectModal.tsx`
14. `frontend/src/app/components/projects/ProjectPage.tsx`
15. `frontend/src/app/components/projects/ProjectsOverview.tsx`
16. `frontend/src/app/components/assistant/AssistantWorkflowModal.tsx`
17. `frontend/src/app/components/assistant/ChatView.tsx`
18. `frontend/src/app/components/assistant/ChatInput.tsx`
19. `frontend/src/app/components/assistant/InitialView.tsx`
20. `frontend/src/app/components/assistant/SelectAssistantProjectModal.tsx`
21. `frontend/src/app/components/tabular/AddColumnModal.tsx`
22. `frontend/src/app/components/tabular/AddNewTRModal.tsx`
23. `frontend/src/app/components/tabular/columnPresets.ts`
24. `frontend/src/app/components/tabular/TRChatPanel.tsx`
25. `frontend/src/app/components/tabular/TREditColumnMenu.tsx`
26. `frontend/src/app/components/tabular/TRTable.tsx`
27. `frontend/src/app/components/tabular/TabularReviewView.tsx`
28. `frontend/src/app/components/workflows/NewWorkflowModal.tsx`
29. `frontend/src/app/components/workflows/ShareWorkflowModal.tsx`
30. `frontend/src/app/components/workflows/WFEditColumnModal.tsx`
31. `frontend/src/app/components/workflows/WorkflowList.tsx`
32. `frontend/src/app/components/modals/delete-chats-modal.tsx`
33. `frontend/src/app/(pages)/assistant/page.tsx`
34. `frontend/src/app/(pages)/projects/[id]/assistant/chat/[chatId]/page.tsx`
35. `frontend/src/app/(pages)/workflows/[id]/page.tsx`
36. `frontend/src/app/(pages)/account/models/page.tsx`
37. `frontend/src/app/(pages)/account/page.tsx`
38. `frontend/src/app/(pages)/tabular-reviews/page.tsx`
39. `frontend/src/app/support/page.tsx`
40. `frontend/src/app/hooks/useAssistantChat.ts`
41. `frontend/src/lib/storage.ts`

---

## Como implementar next-intl em cada componente

### Em componentes client (`"use client"`)

```tsx
"use client";
import { useTranslations } from "next-intl";

export default function MeuComponente() {
  const t = useTranslations("nomeDoNamespace");

  return <button>{t("nomeDaChave")}</button>;
}
```

### Em componentes server (sem `"use client"`)

```tsx
import { getTranslations } from "next-intl/server";

export default async function MinhaPagina() {
  const t = await getTranslations("nomeDoNamespace");

  return <h1>{t("titulo")}</h1>;
}
```

### Para textos com variáveis

No JSON:
```json
"bemVindo": "Bem-vindo, {nome}!"
```

No componente:
```tsx
t("bemVindo", { nome: usuario.nome })
```

---

## Estrutura de Namespaces do pt-BR.json

Organize as chaves por funcionalidade:

```json
{
  "auth": {},        // login, signup, logout
  "common": {},      // botões e ações genéricas
  "projects": {},    // projetos
  "documents": {},   // documentos
  "assistant": {},   // assistente de IA
  "workflows": {},   // fluxos de trabalho
  "tabular": {},     // revisões tabulares
  "account": {},     // configurações de conta
  "support": {},     // suporte
  "errors": {},      // mensagens de erro
  "modals": {}       // modais compartilhados
}
```

---

## Glossário de Traduções Padrão

Use sempre estas traduções para manter consistência:

| Inglês | Português |
|--------|-----------|
| Sign in | Entrar |
| Sign up | Cadastrar |
| Sign out | Sair |
| Submit | Enviar |
| Cancel | Cancelar |
| Save | Salvar |
| Delete | Excluir |
| Edit | Editar |
| Create | Criar |
| Upload | Enviar arquivo |
| Download | Baixar |
| Search | Buscar |
| Filter | Filtrar |
| Loading | Carregando... |
| Error | Erro |
| Success | Sucesso |
| Warning | Atenção |
| Confirm | Confirmar |
| Back | Voltar |
| Next | Próximo |
| Previous | Anterior |
| Close | Fechar |
| Open | Abrir |
| New | Novo |
| Add | Adicionar |
| Remove | Remover |
| Update | Atualizar |
| Settings | Configurações |
| Account | Conta |
| Profile | Perfil |
| Password | Senha |
| Email | E-mail |
| Name | Nome |
| Project | Projeto |
| Document | Documento |
| File | Arquivo |
| Folder | Pasta |
| Chat | Conversa |
| Message | Mensagem |
| Assistant | Assistente |
| Workflow | Fluxo de trabalho |
| Review | Revisão |
| Column | Coluna |
| Row | Linha |
| Table | Tabela |
| Model | Modelo |
| API Key | Chave de API |
| Legal document | Documento jurídico |
| Contract | Contrato |
| Clause | Cláusula |

---

## Adaptações à Realidade Jurídica Brasileira

Além de traduzir, adapte os seguintes conceitos ao contexto brasileiro quando encontrá-los:

### Terminologia Jurídica
- "lawsuit" → "processo judicial" ou "ação judicial"
- "attorney" / "lawyer" → "advogado(a)"
- "court" → "tribunal" ou "vara"
- "judge" → "juiz(a)" ou "magistrado(a)"
- "plaintiff" → "autor(a)" ou "requerente"
- "defendant" → "réu/ré" ou "requerido(a)"
- "filing" → "petição" ou "protocolo"
- "case number" → "número do processo" (formato CNJ)
- "hearing" → "audiência"
- "motion" → "petição" ou "requerimento"
- "brief" → "peça processual" ou "memorial"
- "discovery" → "fase de instrução" ou "produção de provas"
- "settlement" → "acordo" ou "composição"
- "jurisdiction" → "competência" ou "jurisdição"
- "statute of limitations" → "prazo prescricional" ou "prescrição"

### Sugestões de Prompts do Assistente
Quando encontrar exemplos de prompts ou sugestões iniciais do assistente, proponha substituir por exemplos brasileiros como:
- "Analise este contrato de prestação de serviços e identifique cláusulas abusivas"
- "Resuma os principais pontos desta petição inicial"
- "Verifique se este contrato de trabalho está em conformidade com a CLT"
- "Identifique os prazos processuais neste documento"
- "Analise esta notificação extrajudicial e sugira uma resposta"
- "Verifique a regularidade desta procuração ad judicia"

---

## Regras Importantes

1. **Nunca altere lógica de negócio** — apenas textos visíveis ao usuário
2. **Mantenha todas as chaves no pt-BR.json** — nunca deixe texto hardcoded em inglês
3. **Use namespaces coerentes** — agrupe as chaves por funcionalidade
4. **Preserve interpolações** — se um texto tem variáveis como `{name}`, mantenha-as
5. **Não traduza** nomes de variáveis, props, funções, comentários ou valores técnicos
6. **Preserve** todos os imports existentes — apenas adicione o import do `next-intl`
7. **Confirme sempre com o usuário** antes de aplicar qualquer mudança
8. **Verifique a compilação** após cada arquivo com `npm run dev --prefix frontend`

---

## Commit ao Final de Cada Sessão

Ao encerrar uma sessão de trabalho, faça commit do progresso:

```bash
git add .
git commit -m "feat(i18n): traduz [nome dos arquivos trabalhados]"
git push origin adaptacao-pt-br
```

---

## Verificação Final (após todos os arquivos)

1. `npm run dev --prefix frontend` — sem erros no terminal
2. Acesse `http://localhost:3000` — toda a interface em português
3. `npm run build --prefix frontend` — build de produção funciona
4. `npm run lint --prefix frontend` — sem erros de lint
5. Commit final:

```bash
git add .
git commit -m "feat(i18n): implementa traducao completa pt-BR com next-intl"
git push origin adaptacao-pt-br
```
