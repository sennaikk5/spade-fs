# spade-fs — plugin de servidor (parte 2 da auto-edição)

Isso NÃO é a extensão — é a peça que roda no servidor (Termux/Node) que
faz a extensão conseguir editar o próprio código de verdade. Sem isso, as
tools `extensao_ler_arquivo`/`extensao_editar_arquivo` na Construtora
ficam sem efeito nenhum (o `fetch` delas não acha ninguém do outro lado).

## Aviso — não é meu, é do próprio SillyTavern

> Server Plugins are not sandboxed. This means they can potentially gain
> access to your entire file system, or introduce a wide range of
> security vulnerabilities in a way that normal UI extensions cannot.
> Only install server plugins from developers you trust!

Isso é real pra QUALQUER plugin de servidor, não só esse. Esse aqui em
específico só expõe 3 rotas, todas limitadas por allowlist fixa a 3
arquivos dentro de uma pasta só — mas o motivo de existir a allowlist é
justamente porque plugin de servidor, por natureza, não tem sandbox
nenhuma imposta pelo SillyTavern. A proteção é toda deste código.

## Instalação

1. Copia a pasta `spade-fs/` (esse `index.js` + `package.json`) pra dentro
   de `plugins/` na raiz do SillyTavern (não é a mesma pasta da extensão —
   é uma pasta irmã de `public/`, direto na raiz).
   ```
   SillyTavern/
     plugins/
       spade-fs/       <- essa pasta
         index.js
         package.json
     public/
       scripts/extensions/third-party/spade/   <- a extensão em si
   ```
2. No `config.yaml` da raiz do SillyTavern, confirma/seta:
   ```yaml
   enableServerPlugins: true
   ```
3. Reinicia o SillyTavern por completo (plugin de servidor só carrega no
   boot — diferente da extensão, que só precisa de F5).
4. Confere no log de boot se aparece `[spade-fs] plugin carregado —
   pasta da extensão: ...` — se o caminho mostrado ali estiver errado
   (sua pasta da extensão tem outro nome/local), seta a variável de
   ambiente `SPADE_EXTENSAO_DIR` com o caminho absoluto certo antes de
   iniciar o SillyTavern, ex (Termux):
   ```
   export SPADE_EXTENSAO_DIR=/data/data/com.termux/files/home/SillyTavern/public/scripts/extensions/third-party/spade
   ```

## O que ele expõe (`/api/plugins/spade-fs/...`)

- `POST /ler` `{ arquivo }` → `{ conteudo, bytes }`
- `POST /escrever` `{ arquivo, conteudo }` → valida sintaxe, faz backup,
  escreve → `{ ok, backup, aviso }`. Rejeita (400, nada é escrito) se a
  sintaxe não fechar, se o conteúdo vier vazio, ou se passar de 2MB.
- `POST /restaurar` `{ arquivo, backup? }` → sem `backup` explícito,
  restaura o mais recente → `{ ok, restauradoDe, aviso }`
- `GET /backups?arquivo=index.js` → `{ arquivo, backups: [...] }`

`arquivo` só aceita exatamente `index.js`, `style.css` ou `manifest.json`
— qualquer outro nome (incluindo tentativa de `../`) é recusado antes de
tocar no disco.

## Artefatos do RP (`/documento/...`) — essa seção nunca tinha sido
## escrita, embora as rotas já existissem antes dessa atualização

- `POST /documento/listar` `{ personagem, chatId? }` → `{ documentos }`,
  cada um com `escopo: 'chat'|'personagem'`. Sem `chatId`, só traz o que é
  do personagem inteiro (comportamento de sempre). Com `chatId`, traz os
  dois juntos — nunca só um dos dois.
- `POST /documento/ler` `{ personagem, slug, chatId? }` → tenta achar no
  escopo do chat primeiro (se veio `chatId`), cai pro personagem inteiro
  se não achar lá.
- `POST /documento/escrever` `{ personagem, slug, titulo, categoria, tags,
  conteudo, chatId?, sempreIncluir? }` — grava no escopo do `chatId` se
  vier, senão no personagem inteiro (mesmo teto de 2MB e backup
  automático do `/escrever` de código). `sempreIncluir` (bool, vai pro
  frontmatter) marca um artefato como "entra inteiro sempre no RP, não é
  buscado por similaridade" — ortogonal à categoria, `/documento/listar`
  devolve esse campo por documento.
- `POST /documento/apagar` `{ personagem, slug, chatId? }` — mesma
  resolução de escopo do `ler`, também vira backup antes de apagar.

Cada personagem tem sua própria pasta em disco; quando `chatId` existe,
ganha uma subpasta `_chats/<chatId>/` dentro dela. Documento nenhum
anterior a essa mudança precisou mudar de lugar — todos continuam
valendo pra qualquer chat desse personagem, exatamente como sempre foi.

## Testado de verdade, não só lido

Rodei o plugin isolado (fs real, sem mock) com 6 casos: ler, escrever
válido, escrever com sintaxe quebrada (rejeitado, arquivo original
intacto), path traversal (`../../../etc/passwd`, recusado), listar
backups, restaurar (voltou pro conteúdo original). Todos passaram — saída
completa disponível se quiser conferir.

As rotas de `/documento/*` (sem o escopo por chat) já passaram por
SillyTavern de verdade numa sessão anterior — foi testando assim, não só
lendo código, que apareceu o bug de header de CSRF causando 403 silencioso
em toda chamada.

**Não testado**: o escopo por chat (`chatId` em `/documento/*`) é novo
nessa versão — só validação de sintaxe, nenhuma chamada de verdade ainda.
É a prioridade zero antes de confiar nisso.

## Backups

Ficam em `<pasta-da-extensão>/_spade_backups/`, nomeados
`<arquivo>.bak.<timestamp-ISO>`. Guarda os últimos 20 por arquivo, poda
sozinho os mais antigos a cada escrita nova.
