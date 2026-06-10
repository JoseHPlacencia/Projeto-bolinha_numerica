/**
 * ============================================================================
 * SISTEMA DE GERENCIAMENTO DE SALAS
 * ============================================================================
 * 
 * Gerencia o ciclo de vida completo das salas multiplayer.
 * Responsabilidades:
 * - Criar salas com configurações personalizadas
 * - Validar entrada de jogadores
 * - Manter estado das salas
 * - Limpar salas vazias automaticamente
 * 
 * @module roomSystem
 */

/**
 * Estrutura de dados de uma sala
 * @typedef {Object} Sala
 * @property {string} codigo - Identificador único da sala
 * @property {string} nome - Nome exibido da sala
 * @property {string} tipo - 'publica' ou 'privada'
 * @property {string|null} senha - Senha (null se pública)
 * @property {string} criador - ID do socket do criador
 * @property {Set<string>} jogadores - IDs dos sockets dos jogadores
 * @property {Object} configuracoes - Configurações do jogo
 * @property {number} configuracoes.raioMapa - Raio do mapa em pixels
 * @property {number} configuracoes.raioBase - Raio inicial da base
 * @property {number} configuracoes.velocidade - Velocidade dos jogadores
 * @property {number} configuracoes.maxJogadores - Quantidade máxima de jogadores
 * @property {Date} dataCriacao - Data/hora de criação
 */

/**
 * Cria o sistema de gerenciamento de salas
 * @param {Object} config - Configurações do sistema
 * @param {number} config.maxSalas - Máximo de salas simultâneas
 * @param {Object} config.configPadrao - Configurações padrão para salas
 * @returns {Object} API do sistema de salas
 */
function criarSistemaRooms(config) {
    // Mapa interno: codigo -> Sala
    const salas = new Map();

    // Mapa para rastreamento rápido: socketId -> codigo da sala
    const jogadorParaSala = new Map();

    // Configurações padrão para novas salas
    const configPadrao = config.configPadrao || {
        raioMapa: 1500,
        raioBase: 200,
        velocidade: 600,
        maxJogadores: 10
    };

    /**
     * Gera um código de sala único
     * @returns {string} Código no formato "XXXX99" (4 letras + 2 números)
     */
    function gerarCodigoUnico() {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
        let codigo;
        let tentativas = 0;
        const maxTentativas = 100;

        do {
            const letras = Array.from({ length: 4 }, () => 
                chars.charAt(Math.floor(Math.random() * chars.length))
            ).join('');
            
            const numeros = String(Math.floor(Math.random() * 100)).padStart(2, '0');
            codigo = letras + numeros;
            
            tentativas++;
        } while (salas.has(codigo) && tentativas < maxTentativas);

        if (tentativas >= maxTentativas) {
            throw new Error('Impossível gerar código único após 100 tentativas');
        }

        return codigo;
    }

    /**
     * Cria uma nova sala com as configurações especificadas
     * 
     * @param {Object} dados - Dados da sala
     * @param {string} dados.nome - Nome da sala (1-50 caracteres)
     * @param {string} dados.tipo - 'publica' ou 'privada'
     * @param {string} dados.senha - Senha (apenas se privada)
     * @param {string} socketId - ID do socket do criador
     * @param {Object} [dados.configuracoes] - Configurações do jogo
     * @returns {Object} {sucesso: boolean, codigo: string, erro: string|null}
     */
    function criarSala(dados, socketId) {
        // Validações
        if (!dados.nome || dados.nome.length < 1 || dados.nome.length > 50) {
            return { 
                sucesso: false, 
                erro: 'Nome da sala deve ter entre 1 e 50 caracteres' 
            };
        }

        if (!['publica', 'privada'].includes(dados.tipo)) {
            return { 
                sucesso: false, 
                erro: 'Tipo deve ser "publica" ou "privada"' 
            };
        }

        if (dados.tipo === 'privada' && !dados.senha) {
            return { 
                sucesso: false, 
                erro: 'Salas privadas exigem senha' 
            };
        }

        if (dados.tipo === 'privada' && dados.senha.length < 1) {
            return { 
                sucesso: false, 
                erro: 'Senha não pode estar vazia' 
            };
        }

        // Verificar limite de salas
        if (salas.size >= (config.maxSalas || 100)) {
            return { 
                sucesso: false, 
                erro: 'Limite máximo de salas atingido' 
            };
        }

        try {
            // Gerar código único
            const codigo = gerarCodigoUnico();

            // Validar e preparar configurações
            const configuracoes = validarConfiguracoes(dados.configuracoes);

            // Criar sala
            const sala = {
                codigo,
                nome: dados.nome.trim(),
                tipo: dados.tipo,
                senha: dados.tipo === 'privada' ? dados.senha : null,
                criador: socketId,
                jogadores: new Set([socketId]),
                configuracoes,
                dataCriacao: new Date()
            };

            // Armazenar sala
            salas.set(codigo, sala);
            jogadorParaSala.set(socketId, codigo);

            console.log(`[ROOMS] Sala criada: ${codigo} por ${socketId}`);

            return {
                sucesso: true,
                codigo,
                sala: converterSalaParaJSON(sala)
            };
        } catch (erro) {
            console.error('[ROOMS] Erro ao criar sala:', erro);
            return {
                sucesso: false,
                erro: 'Erro interno ao criar sala'
            };
        }
    }

    /**
     * Permite um jogador entrar em uma sala existente
     * 
     * @param {string} codigo - Código da sala
     * @param {string} socketId - ID do socket do jogador
     * @param {Object} [opcoes] - Opções de entrada
     * @param {string} [opcoes.senha] - Senha (se privada)
     * @returns {Object} {sucesso: boolean, sala: Object|null, erro: string|null}
     */
    function entrarSala(codigo, socketId, opcoes = {}) {
        const sala = salas.get(codigo);

        // Validações
        if (!sala) {
            return { 
                sucesso: false, 
                erro: 'Sala não encontrada' 
            };
        }

        if (sala.jogadores.has(socketId)) {
            return { 
                sucesso: false, 
                erro: 'Você já está nesta sala' 
            };
        }

        if (sala.jogadores.size >= sala.configuracoes.maxJogadores) {
            return { 
                sucesso: false, 
                erro: 'Sala cheia' 
            };
        }

        if (sala.tipo === 'privada' && sala.senha !== opcoes.senha) {
            return { 
                sucesso: false, 
                erro: 'Senha incorreta' 
            };
        }

        // Adicionar jogador
        sala.jogadores.add(socketId);
        jogadorParaSala.set(socketId, codigo);

        console.log(`[ROOMS] Jogador ${socketId} entrou na sala ${codigo}`);

        return {
            sucesso: true,
            sala: converterSalaParaJSON(sala)
        };
    }

    /**
     * Remove um jogador de uma sala
     * 
     * @param {string} socketId - ID do socket do jogador
     * @returns {Object} {sucesso: boolean, codigoSala: string|null, deleted: boolean}
     */
    function sairSala(socketId) {
        const codigoSala = jogadorParaSala.get(socketId);

        if (!codigoSala) {
            return { sucesso: false };
        }

        const sala = salas.get(codigoSala);

        if (!sala) {
            jogadorParaSala.delete(socketId);
            return { sucesso: false };
        }

        // Remover jogador
        sala.jogadores.delete(socketId);
        jogadorParaSala.delete(socketId);

        console.log(`[ROOMS] Jogador ${socketId} saiu da sala ${codigoSala}`);

        // Se sala ficou vazia, deletar
        let foiDeletada = false;
        if (sala.jogadores.size === 0) {
            salas.delete(codigoSala);
            foiDeletada = true;
            console.log(`[ROOMS] Sala ${codigoSala} deletada (vazia)`);
        }

        return {
            sucesso: true,
            codigoSala,
            deleted: foiDeletada
        };
    }

    /**
     * Fecha uma sala manualmente (apenas criador)
     * 
     * @param {string} codigoSala - Código da sala
     * @param {string} socketId - ID do socket do solicitante
     * @returns {Object} {sucesso: boolean, erro: string|null}
     */
    function fecharSala(codigoSala, socketId) {
        const sala = salas.get(codigoSala);

        if (!sala) {
            return { sucesso: false, erro: 'Sala não encontrada' };
        }

        if (sala.criador !== socketId) {
            return { sucesso: false, erro: 'Apenas o criador pode fechar a sala' };
        }

        salas.delete(codigoSala);

        // Remover todos os jogadores do mapa
        sala.jogadores.forEach(id => jogadorParaSala.delete(id));

        console.log(`[ROOMS] Sala ${codigoSala} fechada pelo criador`);

        return { sucesso: true };
    }

    /**
     * Busca uma sala pelo código
     * 
     * @param {string} codigo - Código da sala
     * @returns {Object|null} Dados da sala (sem senha)
     */
    function buscarSala(codigo) {
        const sala = salas.get(codigo);
        return sala ? converterSalaParaJSON(sala) : null;
    }

    /**
     * Obtém a sala de um jogador
     * 
     * @param {string} socketId - ID do socket do jogador
     * @returns {Object|null} Dados da sala ou null
     */
    function obterSalaDoJogador(socketId) {
        const codigo = jogadorParaSala.get(socketId);
        return codigo ? buscarSala(codigo) : null;
    }

    /**
     * Lista todas as salas públicas com vagas
     * 
     * @returns {Array<Object>} Array de salas públicas
     */
    function listarSalasPublicas() {
        return Array.from(salas.values())
            .filter(sala => sala.tipo === 'publica' && 
                           sala.jogadores.size < sala.configuracoes.maxJogadores)
            .map(converterSalaParaJSON);
    }

    /**
     * Obtém estatísticas do sistema de salas
     * 
     * @returns {Object} Estatísticas
     */
    function obterEstatisticas() {
        let totalJogadores = 0;
        salas.forEach(sala => {
            totalJogadores += sala.jogadores.size;
        });

        return {
            totalSalas: salas.size,
            totalJogadores,
            salasPublicas: Array.from(salas.values()).filter(s => s.tipo === 'publica').length,
            salasPrivadas: Array.from(salas.values()).filter(s => s.tipo === 'privada').length
        };
    }

    /**
     * Valida e normaliza configurações
     * @private
     */
    function validarConfiguracoes(config = {}) {
        return {
            raioMapa: Math.max(500, Math.min(5000, config.raioMapa || configPadrao.raioMapa)),
            raioBase: Math.max(50, Math.min(500, config.raioBase || configPadrao.raioBase)),
            velocidade: Math.max(100, Math.min(1000, config.velocidade || configPadrao.velocidade)),
            maxJogadores: Math.max(2, Math.min(50, config.maxJogadores || configPadrao.maxJogadores))
        };
    }

    /**
     * Converte uma sala para JSON (sem dados sensíveis)
     * @private
     */
    function converterSalaParaJSON(sala) {
        return {
            codigo: sala.codigo,
            nome: sala.nome,
            tipo: sala.tipo,
            criador: sala.criador,
            jogadoresConectados: sala.jogadores.size,
            configuracoes: sala.configuracoes,
            dataCriacao: sala.dataCriacao.toISOString()
        };
    }

    // API pública
    return {
        criarSala,
        entrarSala,
        sairSala,
        fecharSala,
        buscarSala,
        obterSalaDoJogador,
        listarSalasPublicas,
        obterEstatisticas
    };
}

module.exports = { criarSistemaRooms };
