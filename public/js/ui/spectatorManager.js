/**
 * ============================================================================
 * GERENCIADOR DE ESPECTADOR E SALAS ESPECIAIS
 * ============================================================================
 * 
 * Módulo responsável por:
 * - Gerenciar modo espectador (assistir partidas ao fundo)
 * - Gerenciar sala de teste automática
 * - Integrar com o sistema de salas
 * 
 * @module spectatorManager
 */

/**
 * Cria o gerenciador de espectador
 * 
 * @param {Object} config - Configuração
 * @param {Object} config.socket - Socket.IO instance
 * @returns {Object} API do gerenciador
 */
export function criarGerenciadorEspectador(config) {
    const { socket } = config;

    // Estado
    let emodoEspectador = false;
    let salaTesteCriada = false;
    const CODIGO_SALA_TESTE = 'TESTE123';
    const INTERVALO_TROCA_JOGADOR = 15000; // 15 segundos
    let intervaloTroca = null;

    /**
     * Inicia modo espectador automático
     * Seleciona uma sala pública aleatória e um jogador para observar
     */
    function iniciarModoEspectador() {
        if (emodoEspectador) {
            console.log('[SPECTATOR] Já está em modo espectador');
            return;
        }

        console.log('[SPECTATOR] Iniciando modo espectador...');

        socket.emit('entrar_como_espectador', (resposta) => {
            if (resposta.sucesso) {
                emodoEspectador = true;
                console.log(`[SPECTATOR] Observando sala: ${resposta.salaObservada}`);

                // Iniciar rotação de jogadores
                iniciarRotacaoJogadores();
            } else {
                console.error('[SPECTATOR] Erro:', resposta.erro);
            }
        });
    }

    /**
     * Para modo espectador
     */
    function pararModoEspectador() {
        if (!emodoEspectador) return;

        console.log('[SPECTATOR] Parando modo espectador...');

        emodoEspectador = false;

        // Limpar intervalo de troca
        if (intervaloTroca) {
            clearInterval(intervaloTroca);
            intervaloTroca = null;
        }

        socket.emit('parar_espectador', (resposta) => {
            if (resposta?.sucesso) {
                console.log('[SPECTATOR] Modo espectador parado');
            }
        });
    }

    /**
     * Inicia rotação automática de jogadores a cada 15 segundos
     * @private
     */
    function iniciarRotacaoJogadores() {
        if (intervaloTroca) clearInterval(intervaloTroca);

        intervaloTroca = setInterval(() => {
            if (!emodoEspectador) {
                clearInterval(intervaloTroca);
                intervaloTroca = null;
                return;
            }

            console.log('[SPECTATOR] Trocando jogador observado...');

            // Solicitar ao servidor para trocar jogador
            socket.emit('trocar_espectador_observado', (resposta) => {
                if (resposta?.sucesso) {
                    console.log('[SPECTATOR] Novo jogador:', resposta.novoJogador);
                }
            });
        }, INTERVALO_TROCA_JOGADOR);
    }

    /**
     * Verifica se está em modo espectador
     */
    function estaEmModoEspectador() {
        return emodoEspectador;
    }

    /**
     * ========================================================================
     * SALA DE TESTE
     * ========================================================================
     */

    /**
     * Cria ou entra na sala de teste automaticamente
     */
    function entrarEmSalaTestse() {
        console.log('[TESTROOM] Entrando em sala de teste...');

        // Primeiro, tentar entrar na sala
        socket.emit('buscar_sala', CODIGO_SALA_TESTE, (resposta) => {
            if (resposta.sucesso) {
                // Sala existe, entrar nela
                console.log('[TESTROOM] Sala encontrada, entrando...');
                entrarEmSalaExistente();
            } else {
                // Sala não existe, criar
                console.log('[TESTROOM] Sala não existe, criando...');
                criarSalaTestse();
            }
        });
    }

    /**
     * Cria a sala de teste
     * @private
     */
    function criarSalaTestse() {
        socket.emit('criar_sala', {
            nome: 'Sala de Teste',
            tipo: 'privada',
            senha: 'teste',
            configuracoes: {
                raioMapa: 1500,
                raioBase: 200,
                velocidade: 600,
                maxJogadores: 10
            }
        }, (resposta) => {
            if (resposta.sucesso) {
                console.log('[TESTROOM] Sala de teste criada:', resposta.codigo);
                salaTesteCriada = true;
            } else {
                console.error('[TESTROOM] Erro ao criar sala:', resposta.erro);
            }
        });
    }

    /**
     * Entra na sala de teste existente
     * @private
     */
    function entrarEmSalaExistente() {
        socket.emit('entrar_sala', {
            codigo: CODIGO_SALA_TESTE,
            senha: 'teste'
        }, (resposta) => {
            if (resposta.sucesso) {
                console.log('[TESTROOM] Entrou na sala de teste com sucesso');
            } else {
                console.error('[TESTROOM] Erro ao entrar:', resposta.erro);
            }
        });
    }

    /**
     * Registra atalhos de teclado especiais
     */
    function registrarAtalhos() {
        document.addEventListener('keydown', (e) => {
            // Tecla T: Sala de teste
            if (e.key.toLowerCase() === 't' && !e.ctrlKey && !e.altKey) {
                e.preventDefault();
                entrarEmSalaTestse();
            }

            // Tecla E: Modo espectador (comentado - remover se não quiser)
            // if (e.key.toLowerCase() === 'e' && !e.ctrlKey && !e.altKey) {
            //     e.preventDefault();
            //     if (emodoEspectador) {
            //         pararModoEspectador();
            //     } else {
            //         iniciarModoEspectador();
            //     }
            // }
        });
    }

    /**
     * Inicializa o gerenciador
     */
    function inicializar() {
        registrarAtalhos();

        // Ao desconectar, parar espectador
        socket.on('disconnect', () => {
            if (emodoEspectador) {
                pararModoEspectador();
            }
        });

        console.log('[SPECTATOR] Gerenciador de espectador inicializado');
        console.log('[SPECTATOR] Atalho: T = Entrar em sala de teste');
    }

    inicializar();

    // API pública
    return {
        iniciarModoEspectador,
        pararModoEspectador,
        estaEmModoEspectador,
        entrarEmSalaTestse
    };
}
