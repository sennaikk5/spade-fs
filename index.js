/*
 * spade-fs — plugin de SERVIDOR do SillyTavern (não é a extensão, é a
 * ponte que faz "editar a extensão" ser de verdade em vez de teatro).
 *
 * JS rodando no navegador não escreve no .js que o SillyTavern carregou do
 * disco — não existe "self-edit" sem ALGUMA ponte com o sistema de
 * arquivos. Isso aqui é essa ponte, com o mínimo de superfície de risco
 * que dá pra ter e ainda ser útil:
 *
 *   - ALLOWLIST FIXA — só index.js/style.css/manifest.json, comparação
 *     exata de nome, dentro de UMA pasta só (a da extensão). Não aceita
 *     caminho vindo do cliente, não interpreta "..", não sai da pasta.
 *   - BACKUP AUTOMÁTICO antes de qualquer escrita, timestampado, guarda os
 *     últimos 20 por arquivo.
 *   - VALIDAÇÃO DE SINTAXE antes de aceitar — .js roda por vm.Script (só
 *     compila, nunca executa) e rejeita se der SyntaxError; .json valida
 *     com JSON.parse. .css não tem validador de verdade sem dependência
 *     externa — fica só um sanity check bem fraco (chave balanceada),
 *     documentado como fraco de propósito, não escondido.
 *   - NUNCA EXECUTA o conteúdo recebido — só lê/escreve texto. O código
 *     novo só passa a valer depois que a página recarregar (fora do
 *     alcance desse plugin) — checkpoint manual antes de qualquer mudança
 *     pegar de verdade.
 *   - Roda dentro do mesmo processo Express do SillyTavern — herda
 *     qualquer autenticação/whitelist que o servidor já tiver configurada,
 *     não é uma porta nova exposta separada.
 *
 * ============================================================
 * INSTALAÇÃO
 * ============================================================
 * 1. Copia essa pasta inteira (spade-fs/) pra dentro de `plugins/` na raiz
 *    do SillyTavern (cria a pasta `plugins/` se não existir).
 * 2. No `config.yaml` do SillyTavern, confirma que plugins de servidor
 *    estão ligados: `enableServerPlugins: true`.
 * 3. Reinicia o SillyTavern (plugin de servidor só carrega no boot).
 * 4. Confere `SPADE_EXTENSAO_DIR` abaixo — por padrão assume
 *    `public/scripts/extensions/third-party/spade` a partir da raiz do
 *    SillyTavern. Se sua pasta tiver outro nome/local, seta a variável de
 *    ambiente `SPADE_EXTENSAO_DIR` com o caminho absoluto certo antes de
 *    subir o servidor, ou edita a linha do `path.join` abaixo direto.
 * ============================================================
 */

const fs = require('fs/promises');
const path = require('path');
const vm = require('vm');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const RAIZ_ST = process.cwd();
const EXTENSAO_DIR = process.env.SPADE_EXTENSAO_DIR
    ? path.resolve(process.env.SPADE_EXTENSAO_DIR)
    : path.join(RAIZ_ST, 'public', 'scripts', 'extensions', 'third-party', 'spade');
const BACKUPS_DIR = path.join(EXTENSAO_DIR, '_spade_backups');

const ARQUIVOS_PERMITIDOS = ['index.js', 'style.css', 'manifest.json'];
const TAMANHO_MAX_BYTES = 2 * 1024 * 1024; // 2MB — bem acima do que qualquer um desses arquivos deveria pesar, só um teto de sanidade
const MAX_BACKUPS_POR_ARQUIVO = 20;

// ====================================
// DOCUMENTOS — qualquer conteúdo curado (referência de tom, lore, regra de
// mundo, o que for), um .md por documento, fora da pasta pública da
// extensão (essa aqui, __dirname, é a pasta do PLUGIN, que não é servida
// como estático pelo ST — diferente de EXTENSAO_DIR, que é). Guardar dado
// privado num caminho estático seria expor por URL direta pra quem
// soubesse o nome do arquivo; aqui não tem esse risco.
// Generalizado a partir do que era só "folha de tom" — mesma engenharia
// (slug seguro, backup automático, frontmatter), agora pra qualquer
// categoria de documento, não só uma.
// ====================================
const DADOS_DIR = path.join(__dirname, '_dados');
const DOCUMENTOS_DIR = path.join(DADOS_DIR, 'documentos');

function slugSeguro(valor, rotulo) {
    if (typeof valor !== 'string' || !valor.trim()) throw new Error((rotulo || 'nome') + ' vazio/inválido.');
    const limpo = valor.trim().toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // tira acento
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (!limpo) throw new Error((rotulo || 'nome') + ' fica vazio depois de limpar — usa letras/números.');
    return limpo;
}
function pastaPersonagemDocumentos(personagem) {
    return path.join(DOCUMENTOS_DIR, slugSeguro(personagem, 'personagem'));
}
function caminhoDocumento(personagem, slug) {
    const dirPersonagem = pastaPersonagemDocumentos(personagem);
    const resolvido = path.join(dirPersonagem, slugSeguro(slug, 'slug') + '.md');
    // Mesma trava redundante do caminhoSeguro() de extensão: confirma que
    // o caminho final não escapou da pasta esperada antes de tocar disco.
    if (path.dirname(resolvido) !== dirPersonagem) throw new Error('caminho do documento caiu fora da pasta esperada — recusado.');
    return resolvido;
}
function montarFrontmatter({ titulo, categoria, tags, criadoEm, atualizadoEm }) {
    const linhas = [
        '---',
        'titulo: ' + JSON.stringify(titulo || ''),
        'categoria: ' + JSON.stringify(categoria || 'geral'),
        'tags: ' + JSON.stringify(Array.isArray(tags) ? tags : []),
        'criadoEm: ' + JSON.stringify(criadoEm || new Date().toISOString()),
        'atualizadoEm: ' + JSON.stringify(atualizadoEm || new Date().toISOString()),
        '---',
        '',
    ];
    return linhas.join('\n');
}
function separarFrontmatter(bruto) {
    const m = /^---\n([\s\S]*?)\n---\n?/.exec(bruto);
    if (!m) return { meta: {}, corpo: bruto };
    const meta = {};
    for (const linha of m[1].split('\n')) {
        const idx = linha.indexOf(':');
        if (idx === -1) continue;
        const chave = linha.slice(0, idx).trim();
        const valorBruto = linha.slice(idx + 1).trim();
        try { meta[chave] = JSON.parse(valorBruto); } catch (_) { meta[chave] = valorBruto; }
    }
    return { meta, corpo: bruto.slice(m[0].length) };
}

function caminhoSeguro(nomeArquivo) {
    if (!ARQUIVOS_PERMITIDOS.includes(nomeArquivo)) {
        throw new Error('arquivo não permitido: "' + nomeArquivo + '" — só ' + ARQUIVOS_PERMITIDOS.join(', ') + '.');
    }
    const resolvido = path.resolve(EXTENSAO_DIR, nomeArquivo);
    // Segunda trava, redundante de propósito: mesmo que a allowlist acima
    // já impeça isso na prática (comparação exata de string, não aceita
    // "../etc/passwd"), confirma que o caminho final realmente cai DENTRO
    // da pasta esperada antes de tocar no disco.
    if (path.dirname(resolvido) !== EXTENSAO_DIR) {
        throw new Error('caminho resolvido caiu fora da pasta da extensão — recusado.');
    }
    return resolvido;
}

function validarSintaxe(nomeArquivo, conteudo) {
    if (nomeArquivo.endsWith('.js')) {
        try { new vm.Script(conteudo, { filename: nomeArquivo }); }
        catch (e) { throw new Error('sintaxe JS inválida — nada foi escrito: ' + e.message); }
        return;
    }
    if (nomeArquivo.endsWith('.json')) {
        try { JSON.parse(conteudo); }
        catch (e) { throw new Error('JSON inválido — nada foi escrito: ' + e.message); }
        return;
    }
    if (nomeArquivo.endsWith('.css')) {
        // Sanity check FRACO de propósito — não existe parser de CSS na
        // stdlib do Node e não vamos puxar dependência externa só pra
        // isso. Pega o erro mais comum (chave sem fechar) e para por aí.
        const abre = (conteudo.match(/\{/g) || []).length;
        const fecha = (conteudo.match(/\}/g) || []).length;
        if (abre !== fecha) throw new Error('CSS com chave { } desbalanceada (' + abre + ' abrindo, ' + fecha + ' fechando) — nada foi escrito. Isso é só um sanity check fraco, não valida CSS de verdade.');
        return;
    }
}

async function garantirPastas() {
    await fs.mkdir(EXTENSAO_DIR, { recursive: true });
    await fs.mkdir(BACKUPS_DIR, { recursive: true });
    await fs.mkdir(DOCUMENTOS_DIR, { recursive: true });
}
async function rodarGit(args, cwd) {
    try {
        const { stdout, stderr } = await execFileAsync('git', args, { cwd, timeout: 20000 });
        return { ok: true, stdout, stderr };
    } catch (e) {
        return { ok: false, erro: (e.stderr || e.message || '').toString().trim() };
    }
}

async function fazerBackup(chave, caminhoReal) {
    let conteudoAtual;
    try { conteudoAtual = await fs.readFile(caminhoReal, 'utf8'); }
    catch (e) { if (e.code === 'ENOENT') return null; throw e; } // arquivo não existe ainda — primeira escrita, sem o que fazer backup
    const carimbo = new Date().toISOString().replace(/[:.]/g, '-');
    const nomeBackup = chave + '.bak.' + carimbo;
    await fs.writeFile(path.join(BACKUPS_DIR, nomeBackup), conteudoAtual, 'utf8');
    await podarBackupsAntigos(chave);
    return nomeBackup;
}

async function listarBackups(chave) {
    const todos = await fs.readdir(BACKUPS_DIR).catch(() => []);
    return todos
        .filter((f) => f.startsWith(chave + '.bak.'))
        .sort() // timestamp ISO-safe ordena certo como string
        .reverse(); // mais recente primeiro
}

async function podarBackupsAntigos(chave) {
    const existentes = await listarBackups(chave);
    const excedentes = existentes.slice(MAX_BACKUPS_POR_ARQUIVO);
    for (const nome of excedentes) {
        await fs.unlink(path.join(BACKUPS_DIR, nome)).catch(() => {});
    }
}
// Chave de backup pra um documento — namespaced, nunca colide com os
// 3 nomes fixos da extensão (esses não têm "__" no nome).
function chaveDocumento(personagem, slug) {
    return 'documento__' + slugSeguro(personagem, 'personagem') + '__' + slugSeguro(slug, 'slug') + '.md';
}

module.exports = {
    info: {
        id: 'spade-fs',
        name: 'Spade FS',
        description: 'Ponte de leitura/escrita pra Construtora do Spade editar os próprios arquivos da extensão, com backup e validação de sintaxe. Só serve o Spade — allowlist fixa em 3 arquivos.',
    },
    init: async (router) => {
        await garantirPastas();

        router.post('/ler', async (req, res) => {
            try {
                const { arquivo } = req.body || {};
                const caminho = caminhoSeguro(arquivo);
                const conteudo = await fs.readFile(caminho, 'utf8').catch((e) => {
                    if (e.code === 'ENOENT') throw new Error('arquivo "' + arquivo + '" ainda não existe em ' + EXTENSAO_DIR);
                    throw e;
                });
                res.json({ conteudo, arquivo, bytes: Buffer.byteLength(conteudo, 'utf8') });
            } catch (e) {
                res.status(400).json({ erro: e.message });
            }
        });

        router.post('/escrever', async (req, res) => {
            try {
                const { arquivo, conteudo } = req.body || {};
                if (typeof conteudo !== 'string' || !conteudo.trim()) throw new Error('conteúdo vazio — recusado (evita apagar o arquivo por engano com corpo vazio).');
                if (Buffer.byteLength(conteudo, 'utf8') > TAMANHO_MAX_BYTES) throw new Error('conteúdo maior que o teto de ' + (TAMANHO_MAX_BYTES / 1024 / 1024) + 'MB — recusado.');
                const caminho = caminhoSeguro(arquivo);
                validarSintaxe(arquivo, conteudo); // lança e recusa ANTES de qualquer escrita/backup se a sintaxe não fechar
                const backup = await fazerBackup(arquivo, caminho);
                await fs.writeFile(caminho, conteudo, 'utf8');
                res.json({ ok: true, arquivo, backup, aviso: 'escrito no disco — só vale depois que a página do SillyTavern recarregar.' });
            } catch (e) {
                res.status(400).json({ erro: e.message });
            }
        });

        router.post('/restaurar', async (req, res) => {
            try {
                const { arquivo, backup } = req.body || {};
                const caminho = caminhoSeguro(arquivo);
                const disponiveis = await listarBackups(arquivo);
                if (!disponiveis.length) throw new Error('nenhum backup de "' + arquivo + '" encontrado.');
                const escolhido = backup && disponiveis.includes(backup) ? backup : disponiveis[0]; // sem escolha explícita = o mais recente
                const conteudoBackup = await fs.readFile(path.join(BACKUPS_DIR, escolhido), 'utf8');
                validarSintaxe(arquivo, conteudoBackup); // defesa em profundidade — um backup não devia estar corrompido, mas confere igual
                await fazerBackup(arquivo, caminho); // o estado "ruim" atual também vira backup, nada se perde
                await fs.writeFile(caminho, conteudoBackup, 'utf8');
                res.json({ ok: true, arquivo, restauradoDe: escolhido, aviso: 'restaurado — só vale depois que a página recarregar.' });
            } catch (e) {
                res.status(400).json({ erro: e.message });
            }
        });

        router.get('/backups', async (req, res) => {
            try {
                const arquivo = req.query.arquivo;
                if (!ARQUIVOS_PERMITIDOS.includes(arquivo)) throw new Error('arquivo não permitido: "' + arquivo + '"');
                const disponiveis = await listarBackups(arquivo);
                res.json({ arquivo, backups: disponiveis });
            } catch (e) {
                res.status(400).json({ erro: e.message });
            }
        });

        // ====================================
        // FOLHAS DE TOM — CRUD simples de .md com frontmatter, mesma
        // filosofia de backup automático + validação antes de aceitar. Sem
        // vm.Script aqui (não é código), a "validação" é só garantir que
        // sobra corpo de verdade depois do frontmatter.
        // ====================================
        router.post('/documento/listar', async (req, res) => {
            try {
                const { personagem } = req.body || {};
                const dir = pastaPersonagemDocumentos(personagem);
                const arquivos = await fs.readdir(dir).catch((e) => { if (e.code === 'ENOENT') return []; throw e; });
                const documentos = [];
                for (const nome of arquivos.filter((n) => n.endsWith('.md'))) {
                    const bruto = await fs.readFile(path.join(dir, nome), 'utf8').catch(() => '');
                    const { meta } = separarFrontmatter(bruto);
                    documentos.push({ slug: nome.replace(/\.md$/, ''), titulo: meta.titulo || nome, categoria: meta.categoria || 'geral', tags: meta.tags || [], atualizadoEm: meta.atualizadoEm || null, bytes: Buffer.byteLength(bruto, 'utf8') });
                }
                documentos.sort((a, b) => String(b.atualizadoEm || '').localeCompare(String(a.atualizadoEm || '')));
                res.json({ personagem, documentos });
            } catch (e) {
                res.status(400).json({ erro: e.message });
            }
        });

        router.post('/documento/ler', async (req, res) => {
            try {
                const { personagem, slug } = req.body || {};
                const caminho = caminhoDocumento(personagem, slug);
                const bruto = await fs.readFile(caminho, 'utf8').catch((e) => {
                    if (e.code === 'ENOENT') throw new Error('documento "' + slug + '" não existe pra ' + personagem + '.');
                    throw e;
                });
                const { meta, corpo } = separarFrontmatter(bruto);
                res.json({ personagem, slug, titulo: meta.titulo || slug, categoria: meta.categoria || 'geral', tags: meta.tags || [], criadoEm: meta.criadoEm || null, atualizadoEm: meta.atualizadoEm || null, conteudo: corpo });
            } catch (e) {
                res.status(400).json({ erro: e.message });
            }
        });

        router.post('/documento/escrever', async (req, res) => {
            try {
                const { personagem, slug, titulo, categoria, tags, conteudo } = req.body || {};
                if (typeof conteudo !== 'string' || !conteudo.trim()) throw new Error('conteúdo vazio — recusado.');
                if (Buffer.byteLength(conteudo, 'utf8') > TAMANHO_MAX_BYTES) throw new Error('conteúdo maior que o teto de ' + (TAMANHO_MAX_BYTES / 1024 / 1024) + 'MB — recusado.');
                const dir = pastaPersonagemDocumentos(personagem);
                await fs.mkdir(dir, { recursive: true });
                const caminho = caminhoDocumento(personagem, slug);
                const chave = chaveDocumento(personagem, slug);
                const existente = await fs.readFile(caminho, 'utf8').catch(() => null);
                const metaExistente = existente ? separarFrontmatter(existente).meta : {};
                const backup = await fazerBackup(chave, caminho);
                const texto = montarFrontmatter({ titulo: titulo || metaExistente.titulo || slug, categoria: categoria || metaExistente.categoria || 'geral', tags: tags || metaExistente.tags || [], criadoEm: metaExistente.criadoEm, atualizadoEm: new Date().toISOString() }) + conteudo;
                await fs.writeFile(caminho, texto, 'utf8');
                res.json({ ok: true, personagem, slug, backup });
            } catch (e) {
                res.status(400).json({ erro: e.message });
            }
        });

        router.post('/documento/apagar', async (req, res) => {
            try {
                const { personagem, slug } = req.body || {};
                const caminho = caminhoDocumento(personagem, slug);
                const chave = chaveDocumento(personagem, slug);
                await fazerBackup(chave, caminho); // apagar também vira backup — nada se perde de vez
                await fs.unlink(caminho).catch((e) => { if (e.code !== 'ENOENT') throw e; });
                res.json({ ok: true, personagem, slug });
            } catch (e) {
                res.status(400).json({ erro: e.message });
            }
        });

        // ====================================
        // GIT — "aviso forte, botão de atualizar" pedido explicitamente:
        // depois que a Construtora edita o próprio código, commit+push pro
        // remote já configurado (NÃO cria repo, NÃO configura remote/
        // autenticação — isso tem que já existir na pasta, feito por você
        // uma vez). Falha aqui não é maquiada: cada etapa (é repo? / add /
        // commit / push) reporta erro específico, não um "deu erro" genérico.
        // ====================================
        router.get('/git/status', async (req, res) => {
            try {
                const ehRepo = await rodarGit(['rev-parse', '--is-inside-work-tree'], EXTENSAO_DIR);
                if (!ehRepo.ok) return res.json({ ehRepo: false });
                const remote = await rodarGit(['remote', '-v'], EXTENSAO_DIR);
                const status = await rodarGit(['status', '--short'], EXTENSAO_DIR);
                res.json({ ehRepo: true, temRemote: Boolean(remote.stdout?.trim()), mudancasPendentes: Boolean(status.stdout?.trim()) });
            } catch (e) {
                res.status(400).json({ erro: e.message });
            }
        });

        router.post('/git/publicar', async (req, res) => {
            try {
                const { mensagem } = req.body || {};
                const ehRepo = await rodarGit(['rev-parse', '--is-inside-work-tree'], EXTENSAO_DIR);
                if (!ehRepo.ok) throw new Error('a pasta da extensão não é um repositório git (ou o "git" não tá instalado/no PATH). Precisa configurar isso manualmente uma vez primeiro — esse endpoint não cria repo nem configura remote.');

                // git add com múltiplos arquivos falha por INTEIRO se
                // qualquer um deles não existir — testei e confirmei isso
                // na prática. Só manda pro git o que realmente existe agora.
                const existentes = [];
                for (const nome of ARQUIVOS_PERMITIDOS) {
                    const existe = await fs.access(path.join(EXTENSAO_DIR, nome)).then(() => true).catch(() => false);
                    if (existe) existentes.push(nome);
                }
                if (!existentes.length) throw new Error('nenhum dos arquivos da extensão existe em ' + EXTENSAO_DIR + ' — nada pra publicar.');

                const add = await rodarGit(['add', ...existentes], EXTENSAO_DIR);
                if (!add.ok) throw new Error('git add falhou: ' + add.erro);

                const commit = await rodarGit(['commit', '-m', mensagem || 'Atualização via Spade Construtora'], EXTENSAO_DIR);
                if (!commit.ok && !/nothing to commit/i.test(commit.erro || '')) throw new Error('git commit falhou: ' + commit.erro);

                const push = await rodarGit(['push'], EXTENSAO_DIR);
                if (!push.ok) throw new Error('git push falhou — confirma que o repo tem remote configurado e autenticação (SSH/token) já funcionando: ' + push.erro);

                res.json({ ok: true, aviso: 'commit + push feitos.' });
            } catch (e) {
                res.status(400).json({ erro: e.message });
            }
        });

        console.log('[spade-fs] plugin carregado — pasta da extensão: ' + EXTENSAO_DIR);
    },
    exit: async () => {},
};
