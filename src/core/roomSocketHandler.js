/**
 * ============================================================================
 * GERENCIADOR DE EVENTOS SOCKET.IO - SISTEMA DE SALAS
 * ============================================================================
 * 
 * Registra e processa todos os eventos Socket.IO relacionados às salas.
 * Conecta o frontend com o backend através de eventos em tempo real.
 * 
 * @module roomSocketHandler
 */

/**
 * Registra todos os eventos de salas no Socket.IO
 * 
 * @param {Object} io - Instância do Socket.IO Server
 * @param {Object} sistemaRooms - Sistema de gerenciamento de salas
 * @param {Object} players - Mapa global de jogadores
 */
function registrarEventosSalas(io, sistemaRooms, players) {
    // Objeto para rastrear espectadores
    const espectadores = new Map(); // socketId -> {salaObservada, jogadorObservado}

    /**
     * Registra eventos de uma conexão de socket específica
     */
    io.on('connection', (socket) => {
        // =====================================================================
        // EVENTO: Criar Sala
        // =====================================================================
        socket.on('criar_sala', (dados, callback) => {
            if (!dados || typeof callback !== 'function') {
                return;
            }

            try {
                console.log(`[SOCKET] ${socket.id} solicitou criar sala: ${dados.nome}`);

                // Validações básicas no cliente (redundância)
                if (!dados.nome || !dados.tipo) {
                    return callback({
                        sucesso: false,
                        erro: 'Dados inválidos: nome e tipo são obrigatórios'
                    });
                }

                // Delegar ao sistema de salas
                const resultado = sistemaRooms.criarSala(dados, socket.id);

                if (!resultado.sucesso) {
                    console.log(`[SOCKET] Falha ao criar sala: ${resultado.erro}`);
                    return callback({
                        sucesso: false,
                        erro: resultado.erro
                    });
                }

                console.log(`[SOCKET] Sala criada com sucesso: ${resultado.codigo}`);

                // Notificar cliente
                callback({
                    sucesso: true,
                    codigo: resultado.codigo,
                    sala: resultado.sala
                });

                // Broadcast para listar salas atualizadas (exceto criador recebe via callback)
                socket.broadcast.emit('salas_atualizadas', {
                    salasPublicas: sistemaRooms.listarSalasPublicas()
                });

            } catch (erro) {
                console.error('[SOCKET] Erro ao criar sala:', erro);
                callback({
                    sucesso: false,
                    erro: 'Erro interno do servidor'
                });
            }
        });

        // =====================================================================
        // EVENTO: Entrar em Sala
        // =====================================================================
        socket.on('entrar_sala', (dados, callback) => {
            if (!dados || typeof callback !== 'function') {
                return;
            }

            try {
                const { codigo, senha } = dados;

                if (!codigo) {
                    return callback({
                        sucesso: false,
                        erro: 'Código da sala é obrigatório'
                    });
                }

                console.log(`[SOCKET] ${socket.id} solicitou entrar na sala: ${codigo}`);

                // Sair de sala anterior (se houver)
                const saidaAnterior = sistemaRooms.sairSala(socket.id);
                if (saidaAnterior.sucesso && saidaAnterior.deleted) {
                    io.emit('sala_deletada', { codigo: saidaAnterior.codigoSala });
                }

                // Entrar na nova sala
                const resultado = sistemaRooms.entrarSala(
                    codigo,
                    socket.id,
                    { senha: senha || null }
                );

                if (!resultado.sucesso) {
                    console.log(`[SOCKET] Falha ao entrar na sala: ${resultado.erro}`);
                    return callback({
                        sucesso: false,
                        erro: resultado.erro
                    });
                }

                console.log(`[SOCKET] ${socket.id} entrou na sala ${codigo}`);

                // Notificar cliente
                callback({
                    sucesso: true,
                    sala: resultado.sala
                });

                // Notificar outros jogadores na sala
                socket.emit('jogador_entrou', {
                    codigo: codigo,
                    jogadoresConectados: resultado.sala.jogadoresConectados
                });

                // Atualizar lista de salas públicas para todos
                io.emit('salas_atualizadas', {
                    salasPublicas: sistemaRooms.listarSalasPublicas()
                });

            } catch (erro) {
                console.error('[SOCKET] Erro ao entrar na sala:', erro);
                callback({
                    sucesso: false,
                    erro: 'Erro interno do servidor'
                });
            }
        });

        // =====================================================================
        // EVENTO: Sair de Sala
        // =====================================================================
        socket.on('sair_sala', (callback) => {
            if (typeof callback !== 'function') {
                return;
            }

            try {
                console.log(`[SOCKET] ${socket.id} solicitou sair de sala`);

                const resultado = sistemaRooms.sairSala(socket.id);

                if (!resultado.sucesso) {
                    return callback({ sucesso: false });
                }

                callback({ sucesso: true });

                // Se sala foi deletada, notificar todos
                if (resultado.deleted) {
                    io.emit('sala_deletada', { codigo: resultado.codigoSala });
                    console.log(`[SOCKET] Sala ${resultado.codigoSala} deletada (vazia)`);
                }

                // Atualizar lista de salas públicas
                io.emit('salas_atualizadas', {
                    salasPublicas: sistemaRooms.listarSalasPublicas()
                });

                // Parar espectador se estava observando
                if (espectadores.has(socket.id)) {
                    espectadores.delete(socket.id);
                }

            } catch (erro) {
                console.error('[SOCKET] Erro ao sair da sala:', erro);
                callback({ sucesso: false });
            }
        });

        // =====================================================================
        // EVENTO: Listar Salas Públicas
        // =====================================================================
        socket.on('listar_salas_publicas', (callback) => {
            if (typeof callback !== 'function') {
                return;
            }

            try {
                const salas = sistemaRooms.listarSalasPublicas();
                callback({
                    sucesso: true,
                    salas
                });
            } catch (erro) {
                console.error('[SOCKET] Erro ao listar salas:', erro);
                callback({
                    sucesso: false,
                    erro: 'Erro interno'
                });
            }
        });

        // =====================================================================
        // EVENTO: Buscar Sala por Código
        // =====================================================================
        socket.on('buscar_sala', (codigo, callback) => {
            if (!codigo || typeof callback !== 'function') {
                return;
            }

            try {
                const sala = sistemaRooms.buscarSala(codigo);

                if (!sala) {
                    return callback({
                        sucesso: false,
                        erro: 'Sala não encontrada'
                    });
                }

                callback({
                    sucesso: true,
                    sala
                });
            } catch (erro) {
                console.error('[SOCKET] Erro ao buscar sala:', erro);
                callback({
                    sucesso: false,
                    erro: 'Erro interno'
                });
            }
        });

        // =====================================================================
        // EVENTO: Fechar Sala (apenas criador)
        // =====================================================================
        socket.on('fechar_sala', (codigo, callback) => {
            if (!codigo || typeof callback !== 'function') {
                return;
            }

            try {
                const resultado = sistemaRooms.fecharSala(codigo, socket.id);

                if (!resultado.sucesso) {
                    return callback({
                        sucesso: false,
                        erro: resultado.erro
                    });
                }

                callback({ sucesso: true });

                // Notificar todos sobre sala fechada
                io.emit('sala_deletada', { codigo });

                // Atualizar lista
                io.emit('salas_atualizadas', {
                    salasPublicas: sistemaRooms.listarSalasPublicas()
                });

                console.log(`[SOCKET] Sala ${codigo} fechada pelo criador`);

            } catch (erro) {
                console.error('[SOCKET] Erro ao fechar sala:', erro);
                callback({
                    sucesso: false,
                    erro: 'Erro interno'
                });
            }
        });

        // =====================================================================
        // EVENTO: Entrar como Espectador
        // =====================================================================
        socket.on('entrar_como_espectador', (callback) => {
            if (typeof callback !== 'function') {
                return;
            }

            try {
                console.log(`[SOCKET] ${socket.id} solicitou modo espectador`);

                // Obter salas públicas
                const salasPublicas = sistemaRooms.listarSalasPublicas();

                if (salasPublicas.length === 0) {
                    return callback({
                        sucesso: false,
                        erro: 'Nenhuma sala pública disponível'
                    });
                }

                // Selecionar sala aleatória
                const salaEscolhida = salasPublicas[
                    Math.floor(Math.random() * salasPublicas.length)
                ];

                // Selecionar jogador aleatório da sala
                const salaCompleta = sistemaRooms.buscarSala(salaEscolhida.codigo);
                if (!salaCompleta) {
                    return callback({
                        sucesso: false,
                        erro: 'Erro ao carregar sala'
                    });
                }

                // Registrar espectador
                espectadores.set(socket.id, {
                    salaObservada: salaEscolhida.codigo,
                    jogadorObservado: null, // Será atualizado quando houver snapshot
                    ultimaTroca: Date.now()
                });

                callback({
                    sucesso: true,
                    salaObservada: salaEscolhida.codigo
                });

                console.log(`[SOCKET] ${socket.id} modo espectador iniciado para sala ${salaEscolhida.codigo}`);

            } catch (erro) {
                console.error('[SOCKET] Erro ao entrar em modo espectador:', erro);
                callback({
                    sucesso: false,
                    erro: 'Erro interno'
                });
            }
        });

        // =====================================================================
        // EVENTO: Parar Modo Espectador
        // =====================================================================
        socket.on('parar_espectador', (callback) => {
            if (espectadores.has(socket.id)) {
                espectadores.delete(socket.id);
                console.log(`[SOCKET] ${socket.id} parou modo espectador`);
            }

            if (typeof callback === 'function') {
                callback({ sucesso: true });
            }
        });

        // =====================================================================
        // EVENTO: Desconexão
        // =====================================================================
        socket.on('disconnect', () => {
            try {
                console.log(`[SOCKET] ${socket.id} desconectou`);

                // Sair de sala (se estiver em uma)
                sistemaRooms.sairSala(socket.id);

                // Parar espectador (se estiver)
                if (espectadores.has(socket.id)) {
                    espectadores.delete(socket.id);
                }

                // Remover jogador do mapa
                players.delete(socket.id);

                // Atualizar lista de salas
                io.emit('salas_atualizadas', {
                    salasPublicas: sistemaRooms.listarSalasPublicas()
                });

            } catch (erro) {
                console.error('[SOCKET] Erro ao desconectar:', erro);
            }
        });
    });

    /**
     * Obtém mapa de espectadores (para uso interno)
     */
    return {
        obterEspectadores: () => espectadores
    };
}

module.exports = { registrarEventosSalas };
