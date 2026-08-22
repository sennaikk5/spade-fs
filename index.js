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

const RAIZ_ST = process.cwd();
const EXTENSAO_DIR = process.env.SPADE_EXTENSAO_DIR
    ? path.resolve(process.env.SPADE_EXTENSAO_DIR)
    : path.join(RAIZ_ST, 'public', 'scripts', 'extensions', 'third-party', 'spade');
const BACKUPS_DIR = path.join(EXTENSAO_DIR, '_spade_backups');

const ARQUIVOS_PERMITIDOS = ['index.js', 'style.css', 'manifest.json'];
const TAMANHO_MAX_BYTES = 2 * 1024 * 1024; // 2MB — bem acima do que qualquer um desses arquivos deveria pesar, só um teto de sanidade
const MAX_BACKUPS_POR_ARQUIVO = 20;

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
}

async function fazerBackup(nomeArquivo, caminhoReal) {
    let conteudoAtual;
    try { conteudoAtual = await fs.readFile(caminhoReal, 'utf8'); }
    catch (e) { if (e.code === 'ENOENT') return null; throw e; } // arquivo não existe ainda — primeira escrita, sem o que fazer backup
    const carimbo = new Date().toISOString().replace(/[:.]/g, '-');
    const nomeBackup = nomeArquivo + '.bak.' + carimbo;
    await fs.writeFile(path.join(BACKUPS_DIR, nomeBackup), conteudoAtual, 'utf8');
    await podarBackupsAntigos(nomeArquivo);
    return nomeBackup;
}

async function listarBackups(nomeArquivo) {
    const todos = await fs.readdir(BACKUPS_DIR).catch(() => []);
    return todos
        .filter((f) => f.startsWith(nomeArquivo + '.bak.'))
        .sort() // timestamp ISO-safe ordena certo como string
        .reverse(); // mais recente primeiro
}

async function podarBackupsAntigos(nomeArquivo) {
    const existentes = await listarBackups(nomeArquivo);
    const excedentes = existentes.slice(MAX_BACKUPS_POR_ARQUIVO);
    for (const nome of excedentes) {
        await fs.unlink(path.join(BACKUPS_DIR, nome)).catch(() => {});
    }
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

        console.log('[spade-fs] plugin carregado — pasta da extensão: ' + EXTENSAO_DIR);
    },
    exit: async () => {},
};
