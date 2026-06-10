/**
 * ============================================================================
 * INTERFACE DE GERENCIAMENTO DE SALAS (UI MODAL)
 * ============================================================================
 * 
 * Cria e gerencia a interface modal para:
 * - Criar novas salas
 * - Entrar em salas existentes
 * - Listar salas públicas
 * 
 * Atalhos:
 * - Tecla R: Abrir/Fechar gerenciador de salas
 * - Tecla T: Entrar em sala de teste
 * 
 * @module roomUI
 */

/**
 * Cria o sistema de UI para gerenciamento de salas
 * 
 * @param {Object} config - Configurações
 * @param {Object} config.socket - Socket.IO instance
 * @returns {Object} API da UI
 */
export function criarUIRooms(config) {
    const { socket } = config;

    // Estado local
    let modalAberto = false;
    let salaAtual = null;
    let carregandoSalas = false;

    /**
     * Cria o HTML do modal
     */
    function criarHTML() {
        const html = `
            <div id="roomsModal" class="rooms-modal">
                <!-- Overlay para fechar -->
                <div class="rooms-overlay" id="roomsOverlay"></div>

                <!-- Janela Modal -->
                <div class="rooms-window">
                    <!-- Header -->
                    <div class="rooms-header">
                        <h2>Gerenciador de Salas</h2>
                        <button class="rooms-close-btn" id="roomsCloseBtn" aria-label="Fechar">✕</button>
                    </div>

                    <!-- Conteúdo -->
                    <div class="rooms-content">
                        <!-- Abas de navegação -->
                        <div class="rooms-tabs">
                            <button class="rooms-tab-btn active" data-tab="entrar">
                                Entrar em Sala
                            </button>
                            <button class="rooms-tab-btn" data-tab="criar">
                                Criar Sala
                            </button>
                            <button class="rooms-tab-btn" data-tab="minhas">
                                Minha Sala
                            </button>
                        </div>

                        <!-- Aba: Entrar em Sala -->
                        <div class="rooms-tab-content active" data-content="entrar">
                            <div class="rooms-section">
                                <h3>Encontrar Sala</h3>
                                
                                <!-- Buscar por código -->
                                <div class="rooms-form-group">
                                    <label for="codigoSala">Código da Sala:</label>
                                    <input 
                                        type="text" 
                                        id="codigoSala" 
                                        placeholder="ex: ABCD12"
                                        maxlength="6"
                                        style="text-transform: uppercase;"
                                    >
                                    <input 
                                        type="password" 
                                        id="senhaSala" 
                                        placeholder="Senha (se privada)"
                                    >
                                    <button id="entrarPorCodigoBtn" class="rooms-btn rooms-btn-primary">
                                        Entrar
                                    </button>
                                </div>

                                <div class="rooms-divider">OU</div>

                                <!-- Listar salas públicas -->
                                <div class="rooms-form-group">
                                    <h4>Salas Públicas Disponíveis</h4>
                                    <button id="atualizarSalasBtn" class="rooms-btn rooms-btn-secondary">
                                        Atualizar Lista
                                    </button>
                                    <div id="salasPublicasList" class="rooms-list">
                                        <p class="rooms-empty">Carregando salas...</p>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <!-- Aba: Criar Sala -->
                        <div class="rooms-tab-content" data-content="criar">
                            <div class="rooms-section">
                                <h3>Criar Nova Sala</h3>

                                <div class="rooms-form-group">
                                    <label for="nomeSala">Nome da Sala:</label>
                                    <input 
                                        type="text" 
                                        id="nomeSala" 
                                        placeholder="ex: Sala de Testes"
                                        maxlength="50"
                                    >
                                </div>

                                <div class="rooms-form-group">
                                    <label for="tipoSala">Tipo de Sala:</label>
                                    <select id="tipoSala">
                                        <option value="publica">Pública</option>
                                        <option value="privada">Privada</option>
                                    </select>
                                </div>

                                <div class="rooms-form-group" id="senhaGroupCriar" style="display: none;">
                                    <label for="senhaSalaCriar">Senha:</label>
                                    <input 
                                        type="password" 
                                        id="senhaSalaCriar" 
                                        placeholder="Digite uma senha"
                                        maxlength="50"
                                    >
                                </div>

                                <div class="rooms-form-group">
                                    <label for="raioMapa">Raio do Mapa (px):</label>
                                    <input 
                                        type="range" 
                                        id="raioMapa" 
                                        min="500" 
                                        max="5000" 
                                        value="1500"
                                        step="100"
                                    >
                                    <span id="raioMapaValue">1500</span>
                                </div>

                                <div class="rooms-form-group">
                                    <label for="raioBase">Raio da Base (px):</label>
                                    <input 
                                        type="range" 
                                        id="raioBase" 
                                        min="50" 
                                        max="500" 
                                        value="200"
                                        step="10"
                                    >
                                    <span id="raioBaseValue">200</span>
                                </div>

                                <div class="rooms-form-group">
                                    <label for="velocidade">Velocidade dos Jogadores (px/s):</label>
                                    <input 
                                        type="range" 
                                        id="velocidade" 
                                        min="100" 
                                        max="1000" 
                                        value="600"
                                        step="50"
                                    >
                                    <span id="velocidadeValue">600</span>
                                </div>

                                <div class="rooms-form-group">
                                    <label for="maxJogadores">Máximo de Jogadores:</label>
                                    <input 
                                        type="number" 
                                        id="maxJogadores" 
                                        min="2" 
                                        max="50" 
                                        value="10"
                                    >
                                </div>

                                <button id="criarSalaBtn" class="rooms-btn rooms-btn-primary">
                                    Criar Sala
                                </button>
                            </div>
                        </div>

                        <!-- Aba: Minha Sala -->
                        <div class="rooms-tab-content" data-content="minhas">
                            <div class="rooms-section">
                                <h3>Informações da Sala</h3>
                                <div id="minhasSalasContent">
                                    <p class="rooms-empty">Você não está em nenhuma sala</p>
                                </div>
                            </div>
                        </div>

                        <!-- Mensagens de status -->
                        <div id="roomsMessage" class="rooms-message" style="display: none;"></div>
                    </div>
                </div>
            </div>
        `;

        const container = document.createElement('div');
        container.innerHTML = html;
        document.body.appendChild(container.firstElementChild);
    }

    /**
     * Inicializa event listeners do modal
     */
    function inicializarEventos() {
        const modal = document.getElementById('roomsModal');
        const overlay = document.getElementById('roomsOverlay');
        const closeBtn = document.getElementById('roomsCloseBtn');

        // Fechar modal
        overlay.addEventListener('click', fecharModal);
        closeBtn.addEventListener('click', fecharModal);

        // Abas
        document.querySelectorAll('.rooms-tab-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const tabName = e.target.dataset.tab;
                alterarAba(tabName);
            });
        });

        // Criar sala
        document.getElementById('tipoSala').addEventListener('change', (e) => {
            const senhaGroup = document.getElementById('senhaGroupCriar');
            senhaGroup.style.display = e.target.value === 'privada' ? 'block' : 'none';
        });

        // Atualizar valores de range
        document.getElementById('raioMapa').addEventListener('input', (e) => {
            document.getElementById('raioMapaValue').textContent = e.target.value;
        });

        document.getElementById('raioBase').addEventListener('input', (e) => {
            document.getElementById('raioBaseValue').textContent = e.target.value;
        });

        document.getElementById('velocidade').addEventListener('input', (e) => {
            document.getElementById('velocidadeValue').textContent = e.target.value;
        });

        // Botões de ação
        document.getElementById('criarSalaBtn').addEventListener('click', executarCriarSala);
        document.getElementById('entrarPorCodigoBtn').addEventListener('click', executarEntrarPorCodigo);
        document.getElementById('atualizarSalasBtn').addEventListener('click', atualizarListaSalasPublicas);

        // Entrar em sala da lista
        document.addEventListener('click', (e) => {
            if (e.target.closest('.rooms-sala-btn')) {
                const btn = e.target.closest('.rooms-sala-btn');
                const codigo = btn.dataset.codigo;
                executarEntrarSala(codigo);
            }
        });
    }

    /**
     * Abre o modal
     */
    function abrirModal() {
        if (modalAberto) return;

        const modal = document.getElementById('roomsModal');
        modal.classList.add('active');
        modalAberto = true;

        // Atualizar lista de salas quando abrir
        atualizarListaSalasPublicas();
        atualizarMinhasSalas();

        console.log('[ROOMSUI] Modal aberto');
    }

    /**
     * Fecha o modal
     */
    function fecharModal() {
        if (!modalAberto) return;

        const modal = document.getElementById('roomsModal');
        modal.classList.remove('active');
        modalAberto = false;

        console.log('[ROOMSUI] Modal fechado');
    }

    /**
     * Alterna entre abas
     */
    function alterarAba(nomAba) {
        // Desativar todas as abas
        document.querySelectorAll('.rooms-tab-btn').forEach(btn => {
            btn.classList.remove('active');
        });
        document.querySelectorAll('.rooms-tab-content').forEach(content => {
            content.classList.remove('active');
        });

        // Ativar aba selecionada
        document.querySelector(`[data-tab="${nomAba}"]`).classList.add('active');
        document.querySelector(`[data-content="${nomAba}"]`).classList.add('active');

        // Atualizar dados se necessário
        if (nomAba === 'minhas') {
            atualizarMinhasSalas();
        }
    }

    /**
     * Executa criação de sala
     */
    function executarCriarSala() {
        const nomeSala = document.getElementById('nomeSala').value.trim();
        const tipoSala = document.getElementById('tipoSala').value;
        const senhaSala = document.getElementById('senhaSalaCriar').value;
        const raioMapa = parseInt(document.getElementById('raioMapa').value);
        const raioBase = parseInt(document.getElementById('raioBase').value);
        const velocidade = parseInt(document.getElementById('velocidade').value);
        const maxJogadores = parseInt(document.getElementById('maxJogadores').value);

        // Validações
        if (!nomeSala) {
            mostrarMensagem('Nome da sala é obrigatório', 'erro');
            return;
        }

        if (tipoSala === 'privada' && !senhaSala) {
            mostrarMensagem('Senha é obrigatória para salas privadas', 'erro');
            return;
        }

        // Enviar para servidor
        socket.emit('criar_sala', {
            nome: nomeSala,
            tipo: tipoSala,
            senha: tipoSala === 'privada' ? senhaSala : null,
            configuracoes: {
                raioMapa,
                raioBase,
                velocidade,
                maxJogadores
            }
        }, (resposta) => {
            if (resposta.sucesso) {
                mostrarMensagem(`Sala criada! Código: ${resposta.codigo}`, 'sucesso');
                salaAtual = resposta.sala;
                
                // Limpar formulário
                document.getElementById('nomeSala').value = '';
                document.getElementById('senhaSalaCriar').value = '';
                
                // Mudar para aba de minha sala
                setTimeout(() => alterarAba('minhas'), 1000);
            } else {
                mostrarMensagem(`Erro: ${resposta.erro}`, 'erro');
            }
        });
    }

    /**
     * Executa entrada por código
     */
    function executarEntrarPorCodigo() {
        const codigo = document.getElementById('codigoSala').value.trim().toUpperCase();
        const senha = document.getElementById('senhaSala').value;

        if (!codigo) {
            mostrarMensagem('Digite o código da sala', 'erro');
            return;
        }

        executarEntrarSala(codigo, senha);
    }

    /**
     * Executa entrada em sala
     */
    function executarEntrarSala(codigo, senha = '') {
        socket.emit('entrar_sala', {
            codigo,
            senha: senha || null
        }, (resposta) => {
            if (resposta.sucesso) {
                salaAtual = resposta.sala;
                mostrarMensagem(`Entrou na sala ${codigo}`, 'sucesso');
                
                // Limpar inputs
                document.getElementById('codigoSala').value = '';
                document.getElementById('senhaSala').value = '';
                
                // Atualizar aba minhas salas
                setTimeout(() => {
                    alterarAba('minhas');
                }, 500);
            } else {
                mostrarMensagem(`Erro: ${resposta.erro}`, 'erro');
            }
        });
    }

    /**
     * Atualiza lista de salas públicas
     */
    function atualizarListaSalasPublicas() {
        if (carregandoSalas) return;

        carregandoSalas = true;
        const listDiv = document.getElementById('salasPublicasList');
        listDiv.innerHTML = '<p class="rooms-empty">Carregando salas...</p>';

        socket.emit('listar_salas_publicas', (resposta) => {
            carregandoSalas = false;

            if (!resposta.sucesso) {
                listDiv.innerHTML = '<p class="rooms-empty">Erro ao carregar salas</p>';
                return;
            }

            const salas = resposta.salas;

            if (salas.length === 0) {
                listDiv.innerHTML = '<p class="rooms-empty">Nenhuma sala pública disponível</p>';
                return;
            }

            // Gerar HTML das salas
            const html = salas.map(sala => `
                <div class="rooms-sala-item">
                    <div class="rooms-sala-info">
                        <h4>${sala.nome}</h4>
                        <p>Código: <strong>${sala.codigo}</strong></p>
                        <p>Jogadores: ${sala.jogadoresConectados}/${sala.configuracoes.maxJogadores}</p>
                        <p>Criada: ${new Date(sala.dataCriacao).toLocaleTimeString('pt-BR')}</p>
                    </div>
                    <button class="rooms-sala-btn rooms-btn rooms-btn-primary" data-codigo="${sala.codigo}">
                        Entrar
                    </button>
                </div>
            `).join('');

            listDiv.innerHTML = html;
        });
    }

    /**
     * Atualiza informações de minhas salas
     */
    function atualizarMinhasSalas() {
        const content = document.getElementById('minhasSalasContent');

        if (!salaAtual) {
            content.innerHTML = '<p class="rooms-empty">Você não está em nenhuma sala</p>';
            return;
        }

        const sala = salaAtual;
        const html = `
            <div class="rooms-sala-detalhes">
                <div class="rooms-info-grid">
                    <div>
                        <strong>Nome:</strong> ${sala.nome}
                    </div>
                    <div>
                        <strong>Código:</strong> 
                        <span class="rooms-code">${sala.codigo}</span>
                        <button id="copiarCodigoBtn" class="rooms-btn-copy" title="Copiar código">📋</button>
                    </div>
                    <div>
                        <strong>Tipo:</strong> ${sala.tipo === 'publica' ? '🌐 Pública' : '🔒 Privada'}
                    </div>
                    <div>
                        <strong>Jogadores:</strong> ${sala.jogadoresConectados}/${sala.configuracoes.maxJogadores}
                    </div>
                    <div>
                        <strong>Criador:</strong> ${sala.criador === socket.id ? 'Você' : 'Outro jogador'}
                    </div>
                </div>

                <div class="rooms-config-grid">
                    <div>
                        <strong>Raio do Mapa:</strong> ${sala.configuracoes.raioMapa}px
                    </div>
                    <div>
                        <strong>Raio da Base:</strong> ${sala.configuracoes.raioBase}px
                    </div>
                    <div>
                        <strong>Velocidade:</strong> ${sala.configuracoes.velocidade}px/s
                    </div>
                </div>

                <div class="rooms-actions">
                    <button id="sairSalaBtn" class="rooms-btn rooms-btn-danger">Sair da Sala</button>
                    ${sala.criador === socket.id ? 
                        `<button id="fecharSalaBtn" class="rooms-btn rooms-btn-danger">Fechar Sala</button>` 
                        : ''}
                </div>
            </div>
        `;

        content.innerHTML = html;

        // Event listeners
        document.getElementById('copiarCodigoBtn')?.addEventListener('click', () => {
            navigator.clipboard.writeText(sala.codigo);
            mostrarMensagem('Código copiado!', 'sucesso');
        });

        document.getElementById('sairSalaBtn').addEventListener('click', () => {
            socket.emit('sair_sala', (resposta) => {
                if (resposta.sucesso) {
                    salaAtual = null;
                    mostrarMensagem('Saiu da sala', 'sucesso');
                    atualizarMinhasSalas();
                }
            });
        });

        document.getElementById('fecharSalaBtn')?.addEventListener('click', () => {
            if (confirm('Tem certeza que deseja fechar a sala? Todos os jogadores serão desconectados.')) {
                socket.emit('fechar_sala', sala.codigo, (resposta) => {
                    if (resposta.sucesso) {
                        salaAtual = null;
                        mostrarMensagem('Sala fechada', 'sucesso');
                        atualizarMinhasSalas();
                    } else {
                        mostrarMensagem(`Erro: ${resposta.erro}`, 'erro');
                    }
                });
            }
        });
    }

    /**
     * Mostra mensagem temporária
     */
    function mostrarMensagem(texto, tipo = 'info') {
        const msgDiv = document.getElementById('roomsMessage');
        msgDiv.textContent = texto;
        msgDiv.className = `rooms-message rooms-message-${tipo}`;
        msgDiv.style.display = 'block';

        setTimeout(() => {
            msgDiv.style.display = 'none';
        }, 3000);
    }

    /**
     * Registra atalhos de teclado
     */
    function registrarAtalhos() {
        document.addEventListener('keydown', (e) => {
            // Tecla R: Abrir/Fechar gerenciador
            if (e.key.toLowerCase() === 'r' && !e.ctrlKey && !e.altKey) {
                if (!modalAberto) {
                    abrirModal();
                } else {
                    fecharModal();
                }
            }
        });
    }

    /**
     * Registra listeners de Socket.IO
     */
    function registrarSocketListeners() {
        // Quando salas são atualizadas
        socket.on('salas_atualizadas', (dados) => {
            // Atualizar lista se modal está aberto na aba de entrar
            if (modalAberto) {
                const contentAberto = document.querySelector('.rooms-tab-content.active');
                if (contentAberto?.dataset.content === 'entrar') {
                    // Não recarregar automaticamente para não atrapalhar o usuário
                    // atualizarListaSalasPublicas();
                }
            }
        });

        // Quando uma sala é deletada
        socket.on('sala_deletada', (dados) => {
            if (salaAtual?.codigo === dados.codigo) {
                salaAtual = null;
                mostrarMensagem('A sala foi fechada', 'info');
            }
        });

        // Quando um jogador entra na sala
        socket.on('jogador_entrou', (dados) => {
            if (salaAtual?.codigo === dados.codigo) {
                salaAtual.jogadoresConectados = dados.jogadoresConectados;
                atualizarMinhasSalas();
            }
        });
    }

    /**
     * Inicializa o sistema
     */
    function inicializar() {
        criarHTML();
        inicializarEventos();
        registrarAtalhos();
        registrarSocketListeners();

        console.log('[ROOMSUI] Sistema de UI de salas inicializado');
        console.log('[ROOMSUI] Atalhos: R = Abrir modal, T = Sala de teste (implemente no gameClient.js)');
    }

    // Inicializar ao criar
    inicializar();

    // API pública
    return {
        abrirModal,
        fecharModal,
        obterSalaAtual: () => salaAtual,
        obterModalAberto: () => modalAberto
    };
}
