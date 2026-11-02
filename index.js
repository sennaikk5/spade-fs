/*
 * spade-fs v2.1.0 — plugin de SERVIDOR do SillyTavern, feito pro Spade v8.
 *
 * O navegador não escreve no disco sozinho. Este plugin é a ponte: guarda a
 * Biblioteca (arquivos inteiros, metadados, notas), a memória em gavetas, a
 * Descrição da personagem e os backups. Na v1 ele também deixava a IA editar
 * o código da extensão — isso SAIU de propósito (SPEC v8, seção 16.1).
 *
 * O que continua valendo da v1 (porque estava certo):
 *   - slug seguro em todo nome que vem do navegador + trava de caminho: o
 *     caminho final TEM que cair dentro de _dados/. Nunca aceita "..".
 *   - backup automático antes de sobrescrever ou apagar (últimos 20).
 *   - nunca executa o conteúdo recebido — só lê e grava texto.
 *   - roda no mesmo Express do SillyTavern, então herda a autenticação dele.
 *
 * O que é novo na v2:
 *   - escrita ATÔMICA (grava num temporário e renomeia) — queda de energia ou
 *     fechar o Termux no meio não deixa arquivo pela metade.
 *   - controle de versão otimista (ifVersion): se outra aba mudou o arquivo
 *     depois que você leu, a escrita é recusada e o conteúdo atual volta na
 *     resposta (409). Duas abas não se atropelam.
 *   - backups ficam DENTRO da pasta deste plugin (_spade_backups/), que o
 *     SillyTavern NÃO serve pela web. Na v1 ficavam na pasta da extensão, que
 *     é pública (ver LEIA-spade-fs.md e GET /saude → alertas).
 *   - mensagens de erro nunca carregam conteúdo de arquivo (é RP privado).
 *
 * INSTALAÇÃO / ATUALIZAÇÃO — leia o LEIA-spade-fs.md. Resumo: SUBSTITUA os
 * arquivos desta pasta no lugar. NUNCA apague e recrie a pasta spade-fs:
 * ela guarda _dados/ (seus documentos) e .git/.
 */
'use strict';

const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const VERSAO = '2.1.0';

// Variáveis de ambiente existem só pra teste automatizado (rodar em pasta
// temporária sem encostar nos dados reais). No uso normal ficam vazias.
const DADOS_DIR = process.env.SPADE_DADOS_DIR ? path.resolve(process.env.SPADE_DADOS_DIR) : path.join(__dirname, '_dados');
const BACKUPS_DIR = process.env.SPADE_BACKUPS_DIR ? path.resolve(process.env.SPADE_BACKUPS_DIR) : path.join(__dirname, '_spade_backups');
const TETO_BYTES = Math.round(Number(process.env.SPADE_TAMANHO_MAX_MB || 5) * 1024 * 1024); // por arquivo; o maior arquivo real hoje tem ~70 KB
const MAX_BACKUPS_POR_CHAVE = 20;
const NOMES_MEMORIA = ['rp', 'espaco', 'conexoes', 'relogio'];

// ====================================
// ERROS — mensagem sempre curta e SEM conteúdo de arquivo.
// ====================================
class ErroApp extends Error {
    constructor(mensagem, status = 400, extra = {}) { super(mensagem); this.status = status; this.extra = extra; }
}

// ====================================
// CAMINHOS SEGUROS
// ====================================
// Tudo que vira nome de pasta/arquivo passa por aqui. Troca qualquer coisa
// fora de [a-z0-9] por "-", então "../x", "/etc/passwd" e "a\\b" viram nomes
// inofensivos — e vazio (ou só símbolos) é RECUSADO em vez de virar "".
function slugSeguro(valor, rotulo) {
    if (typeof valor !== 'string' || !valor.trim()) throw new ErroApp((rotulo || 'nome') + ' vazio ou inválido.');
    // Nome nenhum legítimo (personagem, chat, id) tem barra, contrabarra ou byte nulo, e "." / ".." são
    // tentativa de caminho. Em vez de só "limpar" isso pra um nome inofensivo, RECUSA — assim uma tentativa
    // de escapar da pasta aparece como erro e não passa em silêncio.
    if (/[\\/\0]/.test(valor) || valor.trim() === '.' || valor.trim() === '..') throw new ErroApp((rotulo || 'nome') + ' com caminho ou ".." — recusado.');
    const limpo = valor.trim().toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (!limpo) throw new ErroApp((rotulo || 'nome') + ' fica vazio depois de limpar — use letras ou números.');
    if (limpo.length > 160) throw new ErroApp((rotulo || 'nome') + ' é comprido demais (máx. 160 caracteres).');
    return limpo;
}
function extensaoSegura(valor) {
    const limpa = String(valor || 'txt').toLowerCase().replace(/^\./, '').replace(/[^a-z0-9]/g, '');
    return limpa && limpa.length <= 8 ? limpa : 'txt';
}
// Segunda trava, independente do slug: o caminho final precisa estar DENTRO
// da base esperada. path.relative não se engana com "a/../../b" nem com
// caminho absoluto no meio.
function dentroDe(base, alvo) {
    const rel = path.relative(base, alvo);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new ErroApp('caminho fora da pasta de dados — recusado.');
    return alvo;
}
function caminhoDados(...partes) {
    return dentroDe(DADOS_DIR, path.join(DADOS_DIR, ...partes));
}
const dirBiblioteca = (personagem) => caminhoDados('biblioteca', slugSeguro(personagem, 'personagem'));
const dirArquivo = (personagem, id) => path.join(dirBiblioteca(personagem), 'arquivos', slugSeguro(id, 'id do arquivo'));
function caminhoMemoria(personagem, chatId, nome) {
    if (!NOMES_MEMORIA.includes(nome)) throw new ErroApp('nome de memória inválido (use rp, espaco, conexoes ou relogio).');
    const base = ['memoria', slugSeguro(personagem, 'personagem')];
    // conexões valem pro personagem inteiro (ligam conversas), não pra um chat só
    if (nome !== 'conexoes') base.push(slugSeguro(chatId, 'chatId'));
    return caminhoDados(...base, nome + '.json');
}
const caminhoDescricao = (personagem) => caminhoDados('descricao', slugSeguro(personagem, 'personagem') + '.json');

// ====================================
// LEITURA / ESCRITA — atômica, com versão e backup
// ====================================
const hashDe = (texto) => crypto.createHash('sha1').update(texto).digest('hex').slice(0, 16);

async function lerTexto(caminho) {
    try {
        const texto = await fs.readFile(caminho, 'utf8');
        const st = await fs.stat(caminho);
        return { texto, versao: hashDe(texto), atualizadoEm: st.mtime.toISOString() };
    } catch (e) {
        if (e.code === 'ENOENT') return null;
        throw e;
    }
}
async function lerJson(caminho) {
    const lido = await lerTexto(caminho);
    if (!lido) return null;
    let valor;
    try { valor = JSON.parse(lido.texto); } catch (_) { throw new ErroApp('arquivo guardado não é um JSON válido (não vou mexer nele).', 500); }
    return { valor, versao: lido.versao, atualizadoEm: lido.atualizadoEm };
}

// Trava por caminho: duas requisições na MESMA chave esperam uma à outra, senão
// "checa a versão → grava" vira corrida entre duas abas.
const _travas = new Map(); // caminho → fila (promessa) da última operação pendente nele
async function comTrava(chave, fn) {
    const anterior = _travas.get(chave) || Promise.resolve();
    let liberar;
    const minha = new Promise((r) => { liberar = r; }); // só resolve, nunca rejeita
    const fila = anterior.then(() => minha);
    _travas.set(chave, fila);
    await anterior;
    try { return await fn(); }
    finally {
        liberar();
        if (_travas.get(chave) === fila) _travas.delete(chave); // ninguém entrou depois: limpa a entrada
    }
}

async function garantirDir(dir) { await fs.mkdir(dir, { recursive: true }); }

async function fazerBackup(chave, caminhoReal) {
    const atual = await fs.readFile(caminhoReal).catch((e) => { if (e.code === 'ENOENT') return null; throw e; });
    if (atual == null) return null; // primeira escrita: não há o que guardar
    await garantirDir(BACKUPS_DIR);
    const carimbo = new Date().toISOString().replace(/[:.]/g, '-');
    const nome = chave + '.bak.' + carimbo;
    await fs.writeFile(path.join(BACKUPS_DIR, nome), atual);
    await podarBackups(chave);
    return nome;
}
async function podarBackups(chave) {
    const todos = (await fs.readdir(BACKUPS_DIR).catch(() => [])).filter((f) => f.startsWith(chave + '.bak.')).sort().reverse();
    for (const nome of todos.slice(MAX_BACKUPS_POR_CHAVE)) await fs.unlink(path.join(BACKUPS_DIR, nome)).catch(() => {});
}

// Grava `texto` em `caminho`. ifVersion:
//   - undefined/null e o arquivo NÃO existe → cria.
//   - o arquivo existe → ifVersion é OBRIGATÓRIO e tem que bater, senão 409
//     com o conteúdo atual (o cliente decide o que fazer). forcar:true pula a
//     checagem (só o próprio plugin usa, nunca vem do navegador).
async function gravar({ chave, caminho, texto, ifVersion, forcar = false }) {
    if (Buffer.byteLength(texto, 'utf8') > TETO_BYTES) {
        throw new ErroApp('conteúdo maior que o teto de ' + (TETO_BYTES / 1024 / 1024) + ' MB — recusado.', 413);
    }
    return comTrava(caminho, async () => {
        const existente = await lerTexto(caminho);
        if (existente && !forcar) {
            if (ifVersion == null) throw new ErroApp('o arquivo já existe: envie ifVersion (a versão que você leu).', 409, { conflito: true, atual: { conteudo: tentarJson(existente.texto), versao: existente.versao, atualizadoEm: existente.atualizadoEm } });
            if (ifVersion !== existente.versao) throw new ErroApp('o arquivo mudou depois que você leu (outra aba?) — nada foi escrito.', 409, { conflito: true, atual: { conteudo: tentarJson(existente.texto), versao: existente.versao, atualizadoEm: existente.atualizadoEm } });
        }
        const backup = existente ? await fazerBackup(chave, caminho) : null;
        await garantirDir(path.dirname(caminho));
        const tmp = caminho + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 8);
        try {
            await fs.writeFile(tmp, texto, 'utf8');
            await fs.rename(tmp, caminho); // rename no mesmo disco é atômico
        } catch (e) {
            await fs.unlink(tmp).catch(() => {});
            throw e;
        }
        return { versao: hashDe(texto), atualizadoEm: new Date().toISOString(), backup };
    });
}
function tentarJson(texto) { try { return JSON.parse(texto); } catch (_) { return null; } }

async function gravarJson({ chave, caminho, valor, ifVersion, forcar }) {
    if (valor === undefined) throw new ErroApp('conteúdo ausente — recusado.');
    return gravar({ chave, caminho, texto: JSON.stringify(valor, null, 2), ifVersion, forcar });
}

async function copiarDir(origem, destino) {
    let arquivos = 0, bytes = 0;
    await garantirDir(destino);
    for (const ent of await fs.readdir(origem, { withFileTypes: true })) {
        const o = path.join(origem, ent.name), d = path.join(destino, ent.name);
        if (ent.isDirectory()) { const r = await copiarDir(o, d); arquivos += r.arquivos; bytes += r.bytes; }
        else if (ent.isFile()) { await fs.copyFile(o, d); arquivos++; bytes += (await fs.stat(o)).size; }
        // links simbólicos e outros tipos são ignorados de propósito
    }
    return { arquivos, bytes };
}
async function removerDir(dir) { await fs.rm(dir, { recursive: true, force: true }); }

// ====================================
// FRONTMATTER (só pra LER os documentos antigos da v7 na migração)
// ====================================
function separarFrontmatter(bruto) {
    const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(bruto);
    if (!m) return { meta: {}, corpo: bruto };
    const meta = {};
    for (const linha of m[1].split(/\r?\n/)) {
        const i = linha.indexOf(':');
        if (i === -1) continue;
        const chave = linha.slice(0, i).trim();
        const valorBruto = linha.slice(i + 1).trim();
        try { meta[chave] = JSON.parse(valorBruto); } catch (_) { meta[chave] = valorBruto; }
    }
    return { meta, corpo: bruto.slice(m[0].length) };
}

// ====================================
// ALERTA: backups da v1 dentro da pasta PÚBLICA da extensão (SPEC 16.3)
// ====================================
// O SillyTavern serve a pasta da extensão como arquivo estático. A v1 gravava
// cópias de documentos de RP em <extensão>/_spade_backups — alcançável por URL.
// Aqui só verificamos se a pasta existe (sem ler nada) pra avisar o usuário.
async function procurarBackupsPublicos() {
    const raiz = process.cwd();
    const candidatos = [];
    const bases = [path.join(raiz, 'public', 'scripts', 'extensions', 'third-party')];
    try { // ST >= 1.12: extensões por usuário em data/<usuario>/extensions
        for (const u of await fs.readdir(path.join(raiz, 'data'))) bases.push(path.join(raiz, 'data', u, 'extensions'));
    } catch (_) { /* sem pasta data/ */ }
    for (const base of bases) {
        let nomes = [];
        try { nomes = await fs.readdir(base); } catch (_) { continue; }
        for (const nome of nomes) {
            const alvo = path.join(base, nome, '_spade_backups');
            try { if ((await fs.stat(alvo)).isDirectory()) candidatos.push(path.relative(raiz, alvo).split(path.sep).join('/')); } catch (_) { /* não existe */ }
        }
    }
    return candidatos;
}

// ====================================
// ROTAS
// ====================================
function rota(fn) {
    return async (req, res) => {
        try {
            const corpo = req.body && typeof req.body === 'object' ? req.body : {};
            res.json(Object.assign({ ok: true }, await fn(corpo)));
        } catch (e) {
            const status = e instanceof ErroApp ? e.status : 500;
            if (!(e instanceof ErroApp)) console.error('[spade-fs] erro interno:', e.code || e.name); // sem mensagem: pode conter caminho/conteúdo
            res.status(status).json(Object.assign({ ok: false, erro: e instanceof ErroApp ? e.message : 'erro interno no plugin (veja o console do SillyTavern).' }, e instanceof ErroApp ? e.extra : {}));
        }
    };
}
const respostaLeitura = (lido) => lido ? { existe: true, conteudo: lido.valor, versao: lido.versao, atualizadoEm: lido.atualizadoEm } : { existe: false, conteudo: null, versao: null, atualizadoEm: null };

async function listarArquivosDaBiblioteca(personagem) {
    const raiz = path.join(dirBiblioteca(personagem), 'arquivos');
    const ids = (await fs.readdir(raiz, { withFileTypes: true }).catch(() => [])).filter((e) => e.isDirectory()).map((e) => e.name);
    const saida = [];
    for (const id of ids.sort()) {
        const dir = path.join(raiz, id);
        const meta = await lerJson(path.join(dir, 'meta.json')).catch(() => null);
        if (!meta) continue; // pasta sem meta.json (criação interrompida): ignora, não quebra a lista
        const nota = await lerJson(path.join(dir, 'nota.json')).catch(() => null);
        saida.push({ id, meta: meta.valor, versaoMeta: meta.versao, nota: nota ? nota.valor : null, versaoNota: nota ? nota.versao : null });
    }
    return saida;
}
async function acharOriginal(dir) {
    const nomes = await fs.readdir(dir).catch(() => []);
    return nomes.find((n) => /^original\.[a-z0-9]{1,8}$/.test(n)) || null;
}

async function listarDocumentosLegados(personagem, { todosOsChats, chatId }) {
    const base = path.join(caminhoDados('documentos'), slugSeguro(personagem, 'personagem'));
    async function lerPasta(dir, escopo, chat) {
        const itens = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
        const docs = [];
        for (const ent of itens.filter((e) => e.isFile() && e.name.endsWith('.md'))) {
            const bruto = await fs.readFile(path.join(dir, ent.name), 'utf8').catch(() => '');
            const { meta } = separarFrontmatter(bruto);
            docs.push({ slug: ent.name.replace(/\.md$/, ''), titulo: meta.titulo || ent.name, categoria: meta.categoria || 'geral', tags: meta.tags || [], sempreIncluir: !!meta.sempreIncluir, criadoEm: meta.criadoEm || null, atualizadoEm: meta.atualizadoEm || null, escopo, chatId: chat || null, bytes: Buffer.byteLength(bruto, 'utf8') });
        }
        return docs;
    }
    let docs = await lerPasta(base, 'personagem', null);
    const pastaChats = path.join(base, '_chats');
    let chats = [];
    if (todosOsChats) chats = (await fs.readdir(pastaChats, { withFileTypes: true }).catch(() => [])).filter((e) => e.isDirectory()).map((e) => e.name);
    else if (chatId) chats = [slugSeguro(chatId, 'chatId')];
    for (const c of chats) docs = docs.concat(await lerPasta(path.join(pastaChats, c), 'chat', c));
    return docs;
}

module.exports = {
    info: {
        id: 'spade-fs',
        name: 'Spade FS',
        description: 'Disco do Spade v8: Biblioteca, memória, Descrição e backups, com escrita atômica e controle de versão. Só serve o Spade.',
    },
    init: async (router) => {
        await garantirDir(DADOS_DIR);
        await garantirDir(BACKUPS_DIR);

        // ---- saúde ----
        router.get('/saude', async (_req, res) => {
            try {
                const alertas = [];
                const publicos = await procurarBackupsPublicos();
                for (const caminho of publicos) {
                    alertas.push({ codigo: 'backups-publicos', caminho, mensagem: 'Existe uma pasta _spade_backups dentro da pasta PÚBLICA da extensão (sobra da versão antiga). Ela pode conter cópias de documentos de RP e é alcançável por URL. Faça o backup do Spade (Exportar tudo) e depois mova ou apague essa pasta.' });
                }
                res.json({ ok: true, plugin: 'spade-fs', versao: VERSAO, pastaDados: DADOS_DIR, pastaBackups: BACKUPS_DIR, tetoBytes: TETO_BYTES, alertas });
            } catch (e) { res.status(500).json({ ok: false, erro: 'falha ao checar a saúde do plugin.' }); }
        });

        // ---- biblioteca: índice (pastas, grupos, ordem) ----
        router.post('/biblioteca/indice/ler', rota(async ({ personagem }) => respostaLeitura(await lerJson(path.join(dirBiblioteca(personagem), 'indice.json')))));
        router.post('/biblioteca/indice/escrever', rota(async ({ personagem, conteudo, ifVersion }) => {
            const caminho = path.join(dirBiblioteca(personagem), 'indice.json');
            return gravarJson({ chave: 'biblioteca__' + slugSeguro(personagem, 'personagem') + '__indice.json', caminho, valor: conteudo, ifVersion });
        }));

        // ---- biblioteca: arquivos ----
        router.post('/biblioteca/arquivo/listar', rota(async ({ personagem }) => ({ arquivos: await listarArquivosDaBiblioteca(personagem) })));

        router.post('/biblioteca/arquivo/criar', rota(async ({ personagem, id, original, extensao, meta }) => {
            if (typeof original !== 'string') throw new ErroApp('o arquivo original precisa ser texto.');
            if (!meta || typeof meta !== 'object') throw new ErroApp('faltam os metadados do arquivo.');
            const dir = dirArquivo(personagem, id);
            const existente = await lerTexto(path.join(dir, 'meta.json'));
            if (existente) throw new ErroApp('esse arquivo já existe.', 409, { jaExiste: true });
            const ext = extensaoSegura(extensao);
            const chaveBase = 'biblioteca__' + slugSeguro(personagem, 'personagem') + '__' + slugSeguro(id, 'id do arquivo');
            // original primeiro: se algo falhar no meio, sobra um original sem meta.json,
            // que a listagem ignora — nunca o contrário (meta apontando pra nada).
            await gravar({ chave: chaveBase + '__original', caminho: path.join(dir, 'original.' + ext), texto: original, forcar: true });
            const metaFinal = Object.assign({}, meta, { id: slugSeguro(id, 'id do arquivo'), extensao: ext, chars: original.length });
            const r = await gravarJson({ chave: chaveBase + '__meta.json', caminho: path.join(dir, 'meta.json'), valor: metaFinal });
            return { id: metaFinal.id, versaoMeta: r.versao, meta: metaFinal };
        }));

        router.post('/biblioteca/arquivo/ler', rota(async ({ personagem, id, partes }) => {
            const dir = dirArquivo(personagem, id);
            const quer = Array.isArray(partes) && partes.length ? partes : ['meta', 'nota'];
            const saida = { versoes: {} };
            if (quer.includes('meta')) { const m = await lerJson(path.join(dir, 'meta.json')); if (!m) throw new ErroApp('arquivo não encontrado.', 404); saida.meta = m.valor; saida.versoes.meta = m.versao; }
            if (quer.includes('nota')) { const n = await lerJson(path.join(dir, 'nota.json')); saida.nota = n ? n.valor : null; saida.versoes.nota = n ? n.versao : null; }
            if (quer.includes('original')) {
                const nome = await acharOriginal(dir);
                if (!nome) throw new ErroApp('o original deste arquivo não foi encontrado.', 404);
                const o = await lerTexto(path.join(dir, nome));
                saida.original = o.texto; saida.versoes.original = o.versao;
            }
            return saida;
        }));

        router.post('/biblioteca/arquivo/meta', rota(async ({ personagem, id, meta, ifVersion }) => {
            if (!meta || typeof meta !== 'object') throw new ErroApp('faltam os metadados.');
            const dir = dirArquivo(personagem, id);
            const chave = 'biblioteca__' + slugSeguro(personagem, 'personagem') + '__' + slugSeguro(id, 'id do arquivo') + '__meta.json';
            return gravarJson({ chave, caminho: path.join(dir, 'meta.json'), valor: Object.assign({}, meta, { id: slugSeguro(id, 'id do arquivo') }), ifVersion });
        }));

        router.post('/biblioteca/arquivo/nota', rota(async ({ personagem, id, nota, ifVersion }) => {
            const dir = dirArquivo(personagem, id);
            if (!(await lerTexto(path.join(dir, 'meta.json')))) throw new ErroApp('arquivo não encontrado.', 404);
            const chave = 'biblioteca__' + slugSeguro(personagem, 'personagem') + '__' + slugSeguro(id, 'id do arquivo') + '__nota.json';
            return gravarJson({ chave, caminho: path.join(dir, 'nota.json'), valor: nota, ifVersion });
        }));

        router.post('/biblioteca/arquivo/original', rota(async ({ personagem, id, original, extensao, ifVersion }) => {
            if (typeof original !== 'string') throw new ErroApp('o arquivo original precisa ser texto.');
            const dir = dirArquivo(personagem, id);
            const nome = await acharOriginal(dir);
            if (!nome) throw new ErroApp('arquivo não encontrado.', 404);
            const chave = 'biblioteca__' + slugSeguro(personagem, 'personagem') + '__' + slugSeguro(id, 'id do arquivo') + '__original';
            return gravar({ chave, caminho: path.join(dir, nome), texto: original, ifVersion });
        }));

        router.post('/biblioteca/arquivo/mover', rota(async ({ personagem, id, pastaId, ifVersion }) => {
            if (typeof pastaId !== 'string' || !pastaId) throw new ErroApp('faltou a pasta de destino.');
            const caminho = path.join(dirArquivo(personagem, id), 'meta.json');
            const atual = await lerJson(caminho);
            if (!atual) throw new ErroApp('arquivo não encontrado.', 404);
            const chave = 'biblioteca__' + slugSeguro(personagem, 'personagem') + '__' + slugSeguro(id, 'id do arquivo') + '__meta.json';
            return gravarJson({ chave, caminho, valor: Object.assign({}, atual.valor, { pastaId }), ifVersion: ifVersion == null ? atual.versao : ifVersion });
        }));

        router.post('/biblioteca/arquivo/apagar', rota(async ({ personagem, id }) => {
            const dir = dirArquivo(personagem, id);
            if (!(await lerTexto(path.join(dir, 'meta.json')))) throw new ErroApp('arquivo não encontrado.', 404);
            // apagar também vira backup: a pasta inteira (original + meta + nota) é copiada antes
            const carimbo = new Date().toISOString().replace(/[:.]/g, '-');
            const destino = path.join(BACKUPS_DIR, 'apagados', slugSeguro(personagem, 'personagem') + '__' + slugSeguro(id, 'id do arquivo') + '.' + carimbo);
            await copiarDir(dir, destino);
            await removerDir(dir);
            return { backup: path.basename(destino) };
        }));

        // ---- memória (gavetas RP e Espaço, e as conexões entre conversas) ----
        router.post('/memoria/ler', rota(async ({ personagem, chatId, nome }) => respostaLeitura(await lerJson(caminhoMemoria(personagem, chatId, nome)))));
        router.post('/memoria/escrever', rota(async ({ personagem, chatId, nome, conteudo, ifVersion }) => {
            const caminho = caminhoMemoria(personagem, chatId, nome);
            const chave = 'memoria__' + slugSeguro(personagem, 'personagem') + (nome === 'conexoes' ? '' : '__' + slugSeguro(chatId, 'chatId')) + '__' + nome + '.json';
            return gravarJson({ chave, caminho, valor: conteudo, ifVersion });
        }));

        // ---- descrição da personagem ----
        router.post('/descricao/ler', rota(async ({ personagem }) => respostaLeitura(await lerJson(caminhoDescricao(personagem)))));
        router.post('/descricao/escrever', rota(async ({ personagem, conteudo, ifVersion }) => gravarJson({ chave: 'descricao__' + slugSeguro(personagem, 'personagem') + '.json', caminho: caminhoDescricao(personagem), valor: conteudo, ifVersion })));

        // ---- backup de _dados/ inteiro ----
        router.post('/backup/criar', rota(async ({ rotulo }) => {
            const carimbo = new Date().toISOString().replace(/[:.]/g, '-');
            const nome = 'dados-' + carimbo + (rotulo ? '-' + slugSeguro(String(rotulo), 'rótulo').slice(0, 30) : '');
            const destino = path.join(BACKUPS_DIR, nome);
            const r = await copiarDir(DADOS_DIR, destino);
            return { nome, arquivos: r.arquivos, bytes: r.bytes };
        }));
        router.post('/backup/listar', rota(async () => {
            const itens = (await fs.readdir(BACKUPS_DIR, { withFileTypes: true }).catch(() => [])).filter((e) => e.isDirectory() && /^(dados|pre-restauracao)-/.test(e.name));
            const lista = [];
            for (const e of itens) { const st = await fs.stat(path.join(BACKUPS_DIR, e.name)); lista.push({ nome: e.name, criadoEm: st.mtime.toISOString() }); }
            lista.sort((a, b) => b.criadoEm.localeCompare(a.criadoEm));
            return { backups: lista };
        }));
        router.post('/backup/restaurar', rota(async ({ nome, confirmar }) => {
            if (confirmar !== true) throw new ErroApp('restaurar substitui os dados atuais: confirme explicitamente.');
            if (typeof nome !== 'string' || !/^(dados|pre-restauracao)-[A-Za-z0-9._-]+$/.test(nome)) throw new ErroApp('nome de backup inválido.');
            const origem = dentroDe(BACKUPS_DIR, path.join(BACKUPS_DIR, nome));
            if (!(await fs.stat(origem).catch(() => null))) throw new ErroApp('backup não encontrado.', 404);
            // rede de segurança: guarda o estado atual ANTES de substituir
            const carimbo = new Date().toISOString().replace(/[:.]/g, '-');
            const antes = 'pre-restauracao-' + carimbo;
            await copiarDir(DADOS_DIR, path.join(BACKUPS_DIR, antes));
            await removerDir(DADOS_DIR);
            const r = await copiarDir(origem, DADOS_DIR);
            return { restaurado: nome, backupDoEstadoAnterior: antes, arquivos: r.arquivos };
        }));

        // ---- documentos antigos (v7): SÓ LEITURA, só pra migração (SPEC 15.3) ----
        // Sai na versão seguinte, depois que a migração estiver conferida.
        router.post('/documento/listar', rota(async ({ personagem, todosOsChats, chatId }) => ({ documentos: await listarDocumentosLegados(personagem, { todosOsChats, chatId }) })));
        router.post('/documento/ler', rota(async ({ personagem, slug, chatId }) => {
            const base = path.join(caminhoDados('documentos'), slugSeguro(personagem, 'personagem'));
            const dir = chatId ? path.join(base, '_chats', slugSeguro(chatId, 'chatId')) : base;
            const caminho = dentroDe(DADOS_DIR, path.join(dir, slugSeguro(slug, 'slug') + '.md'));
            const lido = await lerTexto(caminho);
            if (!lido) throw new ErroApp('documento não encontrado.', 404);
            const { meta, corpo } = separarFrontmatter(lido.texto);
            return { slug: slugSeguro(slug, 'slug'), titulo: meta.titulo || slug, categoria: meta.categoria || 'geral', tags: meta.tags || [], sempreIncluir: !!meta.sempreIncluir, criadoEm: meta.criadoEm || null, atualizadoEm: meta.atualizadoEm || null, corpo, bytes: Buffer.byteLength(lido.texto, 'utf8'), escopo: chatId ? 'chat' : 'personagem', chatId: chatId ? slugSeguro(chatId, 'chatId') : null };
        }));

        console.log('[spade-fs] v' + VERSAO + ' carregado — dados em ' + DADOS_DIR);
    },
    exit: async () => {},
};
