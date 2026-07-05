# Vision Spike — suporte a imagem por transporte (2026-07-05)

**Trilha:** S6 — decide a viabilidade da Fase A do visual reviewer.
**Script:** `scripts/_spike_vision.mjs` (reproduzível, sem dependências novas).
**Execução:** `node --import tsx scripts/_spike_vision.mjs` (importa `src/utils/provider-routes.ts` e
`src/executors/cli/{bin-resolver,spawn-common}.ts` diretamente da fonte via o loader `tsx`, já
devDependency do projeto — assim o spike sempre exercita o código atual, independente do estado de
`dist/`).

## Método

1. Um PNG determinístico 64x64 é construído byte-a-byte (chunks `IHDR`/`IDAT`/`IEND`, CRC32 manual,
   compressão via `zlib.deflateSync` nativo do Node — sem `canvas` nem dependência nova) e salvo em
   `os.tmpdir()`: metade superior vermelha pura (255,0,0), metade inferior azul pura (0,0,255).
2. Uma segunda variante **invertida** (topo azul, base vermelha) é gerada como imagem de controle,
   usada apenas nos transportes de CLI (ver "Por que a imagem de controle" abaixo).
3. **HTTP direto (kimi/minimax/glm):** uma chamada `chat/completions` com `content` em formato
   OpenAI (`[{type:'text',...}, {type:'image_url', image_url:{url:'data:image/png;base64,...'}}]`).
   Custo: 1 chamada por provider, exatamente como autorizado no escopo da trilha.
4. **claude-cli:** `claude --print` com o prompt entregue via stdin, mencionando o PATH absoluto do
   PNG e pedindo a cor da metade superior. Sem `--dangerously-skip-permissions` (o spike não precisa
   de ferramentas, só resposta de texto).
5. **codex-cli:** `codex exec --ignore-user-config` via stdin, mesma pergunta/path. **Sem** o bypass
   de sandbox (`--dangerously-bypass-approvals-and-sandbox`), conforme exigido pelo escopo da trilha.

### Por que a imagem de controle (apenas CLIs)

Para os transportes HTTP, uma resposta certa OU um erro estruturado do servidor já são evidência
suficiente (o formato do payload é aceito/rejeitado explicitamente). Para as CLIs não existe upload
de imagem conhecido — o prompt só *menciona* um path em texto. Isso significa que uma resposta certa
("vermelha") tem **50% de chance de ser coincidência/alucinação**, já que só há duas cores possíveis.
Para descartar isso, cada CLI que respondeu uma cor plausível na imagem normal foi testada de novo
contra a imagem invertida. Se a resposta **acompanha a inversão** (vermelha → azul), é evidência forte
de leitura real; se a resposta não muda, é alucinação.

## Resultados

| Transporte | Suporta imagem? | Mecanismo | Evidência (verbatim curta) | Recomendação para Fase A |
|---|---|---|---|---|
| **kimi/** (`kimi-for-coding`) | **SIM** | content-part base64 (`image_url` com data URI), estilo OpenAI | HTTP 200 em 2.1s \| `content="Vermelho."` | Viável: reusar o mesmo path HTTP em `provider-routes.ts`, adicionando suporte a content-parts na chamada (hoje `omniroute-call.ts` monta `content` como string simples). |
| **minimax/** (`MiniMax-M3`) | **SIM** | content-part base64 (`image_url` com data URI), estilo OpenAI | HTTP 200 em 2.9s \| `content="Vermelha"` | Viável, mesmo caminho de kimi. Observação: em rodadas anteriores do spike com `max_tokens` baixo (20), o modelo devolveu `content=""` com o reasoning ainda "pensando" a pergunta dentro de `<think>...</think>` — **`max_tokens` precisa ser generoso o bastante para o modelo terminar o reasoning antes de emitir a resposta visível**, senão a resposta chega vazia e parece falsamente "sem suporte". |
| **glm/** (`glm-5.2`) | **NÃO** (neste endpoint, com este formato) | tentado: content-part `image_url` — rejeitado pelo servidor | HTTP 400: `{"error":{"code":"1210","message":"messages.content.type is invalid, allowed values: ['text']"}}` | O endpoint `/api/coding/paas/v4/chat/completions` usado hoje (rota "coding") só aceita `content` do tipo `text` — não é o endpoint de visão da GLM. Se a Fase A precisar de GLM, checar se existe um endpoint/modelo GLM diferente com suporte a `image_url` (fora do escopo deste spike) antes de descartar o provider inteiro. |
| **claude-cli/** (`claude --print`) | **NÃO confirmado** (bloqueado por sandbox, não por falta de capacidade) | tentado: path absoluto mencionado em texto no prompt | `"I can't complete this without your approval to read the file. Every path to it is blocked: Read on .../Temp/... → waiting on a permission grant... Copy into the working dir → blocked because .../AppData/Local/Temp is outside the allowed working directories."` | A CLI recusa por estar o arquivo **fora do diretório de trabalho permitido da sessão** (`os.tmpdir()`, conforme exigido pelo escopo da trilha) — não sabemos se ela leria a imagem normalmente se o path estivesse dentro do working dir. **Não temos evidência de que `claude --print` sequer processa conteúdo de imagem via texto** (não há upload real neste transporte); a recusa por sandbox impediu até testar isso. Recomendação: repetir com o PNG dentro do diretório do projeto/working-dir antes de decidir — mas mesmo lendo o arquivo, texto puro não carrega bytes de imagem para o modelo, então este transporte provavelmente exigiria um mecanismo de anexo real (não confirmado existir) para viabilizar Fase A. |
| **codex-cli/** (`codex exec --ignore-user-config`) | **SIM** (evidência forte, não apenas coincidência) | path absoluto mencionado em texto no prompt — a CLI claramente abriu/leu o arquivo do disco | normal (topo vermelho): `exit=0, 15.4s, stdout="vermelha"`. Controle invertido (topo azul): `exit=0, 34.2s, stdout="Azul"`. **A resposta acompanhou a inversão da imagem**, descartando coincidência. | Viável para Fase A **se** o diretório onde os screenshots do reviewer forem salvos estiver dentro do que `codex exec` (sandbox read-only default, sem bypass) tem permissão de ler. Precisa de validação adicional: (a) confirmar que a leitura é robusta para PNGs maiores/mais complexos que o padrão sintético 64x64 de 2 cores; (b) medir a variância de latência (15s vs 34s na mesma sessão) para orçar timeout na Fase A. |

## Recomendação consolidada para a Fase A do visual reviewer

1. **HTTP direto (kimi/minimax) é o caminho mais direto e barato**: ambos aceitam `image_url`
   content-parts sem mudança de endpoint, contanto que `omniroute-call.ts`/`provider-routes.ts` ganhem
   suporte a montar `content` como array de partes (hoje presumem string) e que `max_tokens` seja
   dimensionado para acomodar reasoning antes da resposta visível.
2. **GLM não suporta imagem no endpoint atual** — não incluir no escopo da Fase A a menos que se
   descubra um endpoint GLM de visão separado (fora deste spike).
3. **codex-cli mostrou evidência real de leitura de arquivo local via path em texto**, mas isso só
   funciona dentro do sandbox read-only padrão do `codex exec` — a Fase A precisaria garantir que os
   screenshots do reviewer sejam salvos num diretório acessível a esse sandbox (não `os.tmpdir()` fora
   do projeto, necessariamente — validar caso a caso).
4. **claude-cli permanece uma incógnita**: a recusa observada foi por causa do sandbox de permissões
   (path fora do working dir), não uma resposta definitiva sobre capacidade de visão via texto. Não
   assumir nem suporte nem não-suporte para este transporte sem um teste de follow-up com o arquivo
   dentro do working dir permitido.
5. Para qualquer transporte adotado na Fase A, **repetir o teste de controle (imagem invertida)** como
   parte da suíte de regressão — a diferença entre "leu a imagem" e "chutou uma cor plausível" só fica
   visível quando o ground truth muda entre duas chamadas.

## Custo do spike

3 chamadas HTTP mínimas (kimi, minimax, glm — 1 cada) + 3 invocações de CLI local (1x claude-cli,
2x codex-cli para o par normal/controle). Nenhuma chave de API foi impressa; a existência das env vars
foi checada via `getDirectProviderApiKey`/`resolveDirectProviderRoute` (mesmo helper de produção), nunca
via `console.log` do valor.
