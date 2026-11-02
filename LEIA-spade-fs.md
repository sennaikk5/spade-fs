# spade-fs v2.1.0 — plugin de servidor do Spade v8

## Instalar / atualizar
Em `SillyTavern/plugins/spade-fs/`: **substitua** `index.js` e `package.json`. **NUNCA apague e recrie a pasta**: nela ficam `_dados/` (seus documentos) e `.git/`.
Precisa de `enableServerPlugins: true` no `config.yaml`. Reinicie o SillyTavern. Deve aparecer no console: `[spade-fs] v2.1.0 carregado`.

## O que mudou da v1
- **Saiu** tudo que deixava a IA editar o código da extensão (`/listar`, `/ler`, `/escrever`, `/escrever-lote`, `/criar`, `/apagar` de arquivos da extensão). Nada mais escreve fora de `_dados/`.
- **Entrou** o disco do Spade v8: Biblioteca, memória, descrição, backups e leitura dos documentos antigos (para migrar).
- Escrita atômica (temporário + renomear), controle de versão (`ifVersion`; conflito = HTTP 409 com o conteúdo atual), teto de 5 MB por arquivo (`SPADE_TAMANHO_MAX_MB`),
  trava contra duas gravações simultâneas no mesmo arquivo, backup automático antes de sobrescrever/apagar (últimos 20 por arquivo).
- Backups agora em `plugins/spade-fs/_spade_backups/` (a v1 gravava na pasta pública da extensão — `GET /saude` avisa se sobrou uma).
- Erros nunca carregam conteúdo de arquivo (é RP privado).

## Rotas (todas POST JSON, exceto `GET /saude`) — base `/api/plugins/spade-fs`
`/biblioteca/indice/{ler,escrever}` · `/biblioteca/arquivo/{listar,criar,ler,meta,nota,original,mover,apagar}` · `/memoria/{ler,escrever}` (nomes: rp, espaco, conexoes, **relogio** — novo na 2.1.0, um por chat) ·
`/descricao/{ler,escrever}` · `/backup/{criar,listar,restaurar}` (restaurar exige `confirmar:true` e guarda o estado atual antes) · `/documento/{listar,ler}` (só leitura, para a migração).
Nomes de personagem/chat/arquivo com `/`, `\`, byte nulo, `.` ou `..` são RECUSADOS; o resto vira slug seguro e o caminho final precisa cair dentro de `_dados/`.

## Onde ficam os dados
`_dados/biblioteca/<personagem>/{indice.json, arquivos/<id>/{original.<ext>, meta.json, nota.json}}` · `_dados/memoria/<personagem>/<chat>/{rp,espaco,relogio}.json` · `_dados/memoria/<personagem>/conexoes.json` · `_dados/descricao/<personagem>.json`.
`_dados/documentos/` (da v7) continua intocado.
