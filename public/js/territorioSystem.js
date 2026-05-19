// ============================================================
// territorioSystem.js — Sistema de Conquista de Território
// ============================================================
// Este módulo roda no NAVEGADOR (cliente) e cuida de toda a lógica
// de como o jogador conquista novas áreas do mapa.
//
// O mapa é dividido em uma GRADE de células quadradas.
// Cada célula tem um de três estados:
//
//   CELULA_VAZIA  (0) — ninguém controla esta área
//   CELULA_BASE   (1) — pertence ao jogador (território permanente)
//   CELULA_RASTRO (2) — o jogador passou por aqui mas ainda não fechou o loop
//
// Fluxo de jogo:
//   1. Jogador SAI da base → células visitadas viram CELULA_RASTRO
//   2. Jogador VOLTA à base com rastro ativo → Flood Fill descobre a área cercada
//   3. Tudo que estava cercado vira CELULA_BASE permanente

// ─── Constantes da Grade ─────────────────────────────────────────────────────

// Número de células em cada lado da grade (50 × 50 = 2.500 células no total)
// ATENÇÃO: quanto maior esse número, mais detalhes no minimapa, mas mais processamento
export const TAMANHO_GRADE = 50;

// === FIX 2: GRACE PERIOD NA AUTO-COLISÃO ===
// Número de células recentes do rastro que são IGNORADAS na detecção de auto-colisão.
// Sem isso, ao fazer uma curva fechada o jogador morre instantaneamente ao
// "roçar" a borda do próprio rastro — o grace period evita esse falso positivo.
// Valor 3 = as últimas 3 células marcadas não causam morte por colisão.
const CELULAS_IGNORADAS = 3;

// Identificadores numéricos para o estado de cada célula
// (devem ser números inteiros simples para facilitar a leitura e o debug)
export const CELULA_VAZIA  = 0; // célula sem dono — cor de fundo do minimapa
export const CELULA_BASE   = 1; // célula do território permanente do jogador
export const CELULA_RASTRO = 2; // célula do caminho temporário do jogador

// ─── Conversão de Coordenadas Mundo ↔ Grade ──────────────────────────────────

// Converte uma posição do MUNDO (x, y em unidades do jogo) para
// índices (linha, coluna) na GRADE.
//
// O mundo vai de -mapRadius até +mapRadius nos dois eixos.
// A grade começa em (0, 0) no canto superior esquerdo.
//
// Exemplo com mapRadius=1500 e TAMANHO_GRADE=50:
//   • Tamanho de cada célula: 3000 / 50 = 60 unidades do jogo
//   • Posição x=-1500 (borda esquerda) → coluna 0
//   • Posição x=0    (centro)          → coluna 25
//   • Posição x=+1500 (borda direita)  → coluna 49
function mundoParaGrade(x, y, configMundo) {
    // Tamanho de uma célula em unidades do mundo
    const tamanhoCelula = (configMundo.mapRadius * 2) / TAMANHO_GRADE;

    // Desloca a posição somando mapRadius para que o canto esquerdo vire o índice 0
    const col = Math.floor((x + configMundo.mapRadius) / tamanhoCelula);
    const lin = Math.floor((y + configMundo.mapRadius) / tamanhoCelula);

    // Garante que os índices nunca saiam dos limites da grade (0 a TAMANHO_GRADE-1)
    return {
        lin: Math.max(0, Math.min(TAMANHO_GRADE - 1, lin)),
        col: Math.max(0, Math.min(TAMANHO_GRADE - 1, col))
    };
}

// ─── Criação do Estado de Território ─────────────────────────────────────────

// Cria o objeto que guarda todas as informações de território de um jogador.
// Deve ser chamada UMA VEZ quando o jogador entra no jogo.
//
// Parâmetros:
//   jogador    — dados do jogador (precisa de territoryX, territoryY)
//   configMundo — configurações do mundo (mapRadius, initialTerritoryRadius)
export function criarEstadoTerritorio(jogador, configMundo) {
    // Cria uma grade bidimensional vazia: array de TAMANHO_GRADE linhas,
    // cada linha com TAMANHO_GRADE colunas, tudo preenchido com CELULA_VAZIA (0)
    const matrizTerritorio = Array.from({ length: TAMANHO_GRADE }, () =>
        new Array(TAMANHO_GRADE).fill(CELULA_VAZIA)
    );

    // Conjunto que guarda as chaves "lin,col" das células que formam o rastro atual.
    // Usar um Set garante que não haverá células duplicadas.
    const rastro = new Set();

    // Flag que indica se o jogador está atualmente fora da sua base.
    // Começa como false (jogador começa dentro da base).
    let estaForaDaBase = false;

    // === RASTRO ===
    // Última célula da grade onde o jogador esteve enquanto fora da base.
    // Usada pelo algoritmo de Bresenham para garantir rastro contínuo (sem vãos).
    // null enquanto o jogador estiver dentro da base ou antes de sair pela primeira vez.
    const posicaoAnterior = null;

    // === TERRITÓRIO INIMIGO ===
    // Map que registra, por ID de inimigo, quais células do rastro atual
    // estão dentro do domínio daquele inimigo.
    // Estrutura: Map<idInimigo: string, Set<"lin,col": string>>
    // Limpo quando o jogador retorna à base ou morre.
    const celulasInimigas = new Map();

    // === FIX 2: GRACE PERIOD ===
    // Array com as chaves "lin,col" das últimas CELULAS_IGNORADAS células marcadas.
    // Ao verificar auto-colisão, se a célula estiver neste array, ela é ignorada.
    // Isso permite que o jogador faça curvas fechadas sem morrer instantaneamente.
    const historicoCelulas = [];

    // Objeto que vai guardar todos os dados de território deste jogador
    const estado = {
        matrizTerritorio,
        rastro,
        estaForaDaBase,
        posicaoAnterior,   // para o algoritmo de Bresenham
        celulasInimigas,   // para interação com território inimigo
        historicoCelulas   // para o grace period na auto-colisão
    };

    // Preenche o círculo inicial do jogador na grade como CELULA_BASE
    _inicializarBase(estado, jogador, configMundo);

    return estado;
}

// ─── Inicialização da Base (função interna) ───────────────────────────────────

// Preenche as células dentro do círculo inicial do jogador como CELULA_BASE.
// Usa o Teorema de Pitágoras para descobrir quais células estão dentro do círculo.
function _inicializarBase(estadoTerritorio, jogador, configMundo) {
    const { matrizTerritorio } = estadoTerritorio;
    const tamanhoCelula = (configMundo.mapRadius * 2) / TAMANHO_GRADE;

    // Converte o raio da base (em unidades do mundo) para quantas células ele ocupa
    const raioEmCelulas = configMundo.initialTerritoryRadius / tamanhoCelula;

    // Descobre qual célula da grade corresponde ao centro da base do jogador
    const centro = mundoParaGrade(jogador.territoryX, jogador.territoryY, configMundo);

    // Percorre TODAS as células da grade para decidir quais fazem parte da base
    for (let lin = 0; lin < TAMANHO_GRADE; lin++) {
        for (let col = 0; col < TAMANHO_GRADE; col++) {
            // Diferença de posição entre esta célula e o centro da base
            const distLin = lin - centro.lin;
            const distCol = col - centro.col;

            // Distância euclidiana: sqrt(Δlin² + Δcol²) — Teorema de Pitágoras
            const distancia = Math.sqrt(distLin * distLin + distCol * distCol);

            // Se a célula estiver dentro ou na borda do círculo, ela é BASE
            if (distancia <= raioEmCelulas) {
                matrizTerritorio[lin][col] = CELULA_BASE;
            }
        }
    }
}

// ─── Verificação de Posição ───────────────────────────────────────────────────

// Verifica se a posição atual do jogador está dentro de uma célula de BASE.
function _jogadorEstaEmBase(estadoTerritorio, jogador, configMundo) {
    // Converte as coordenadas do mundo para índices na grade
    const { lin, col } = mundoParaGrade(jogador.x, jogador.y, configMundo);

    // Verifica se a célula correspondente está marcada como BASE (valor 1)
    return estadoTerritorio.matrizTerritorio[lin][col] === CELULA_BASE;
}

// ─── Algoritmo de Bresenham ────────────────────────────────────────────────────
//
// === RASTRO ===
// Gera TODAS as células que formam uma linha reta discreta entre dois pontos
// da grade. Isso garante que o rastro não tenha vãos (gaps) quando o jogador
// se move rápido ou há lag de rede.
//
// Funciona como um "traçado de pixel" em uma tela: dado ponto A e ponto B,
// quais células precisam ser coloridas para formar uma linha contínua?
//
// Exemplo: de (lin=2, col=2) para (lin=5, col=8):
//   Retorna [(2,2), (2,3), (3,4), (3,5), (4,6), (4,7), (5,8)]
//   — uma sequência conectada sem gaps.
function _bresenham(de, ate) {
    const celulas = [];
    let { lin: y0, col: x0 } = de;
    const { lin: y1, col: x1 } = ate;

    // Diferença absoluta em cada eixo
    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - y0);

    // Sentido de incremento em cada eixo (+1 ou -1)
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;

    // Variável de erro que decide quando avançar no eixo secundário
    let err = dx - dy;

    // Itera célula por célula até chegar no destino
    while (true) {
        celulas.push({ lin: y0, col: x0 });

        // Chegou ao destino — linha completa
        if (x0 === x1 && y0 === y1) break;

        const e2 = 2 * err;

        // Avança no eixo X se o erro acumulado justificar
        if (e2 > -dy) { err -= dy; x0 += sx; }

        // Avança no eixo Y se o erro acumulado justificar
        if (e2 < dx)  { err += dx; y0 += sy; }
    }

    return celulas; // array de {lin, col} formando a linha completa
}

// ─── Verificação de Célula no Território Inimigo ─────────────────────────────
//
// === TERRITÓRIO INIMIGO ===
// Verifica se a célula (lin, col) está dentro do círculo inicial de um inimigo.
// Usamos o círculo como aproximação do domínio inimigo, pois a grade real do
// inimigo existe apenas no cliente dele (arquitetura cliente-a-cliente).
//
// Funcionamento:
//   1. Converte a célula para coordenadas do mundo (centro da célula)
//   2. Calcula a distância até o centro do território inimigo
//   3. Compara com o raio inicial do território
function _celulaEstaNaBaseInimiga(lin, col, inimigo, configMundo) {
    const tamanhoCelula = (configMundo.mapRadius * 2) / TAMANHO_GRADE;

    // Posição do centro desta célula no mundo (não o canto, o centro)
    const celulaX = col * tamanhoCelula - configMundo.mapRadius + tamanhoCelula / 2;
    const celulaY = lin * tamanhoCelula - configMundo.mapRadius + tamanhoCelula / 2;

    // Distância euclidiana entre o centro da célula e o centro do território inimigo
    const dx = celulaX - inimigo.territoryX;
    const dy = celulaY - inimigo.territoryY;
    const distancia = Math.sqrt(dx * dx + dy * dy);

    // true se a célula está dentro ou na borda do círculo inimigo
    return distancia <= configMundo.initialTerritoryRadius;
}

// ─── Marcação de Célula Individual ────────────────────────────────────────────
//
// === RASTRO + AUTO-COLISÃO + TERRITÓRIO INIMIGO ===
// Processa uma única célula durante o registro do rastro.
// Esta função centraliza toda a lógica de o que fazer quando o jogador
// visita uma célula enquanto está fora da base.
//
// Retorna:
//   "autoColisao" — jogador cruzou o próprio rastro (deve morrer)
//   "ok"          — célula processada normalmente
//
// Parâmetros:
//   estado      — estado de território do jogador local
//   lin, col    — índices da célula na grade
//   inimigos    — objeto {id: dadosJogador} com todos os inimigos (pode ser null)
//   configMundo — configuração do mundo
function _marcarCelula(estado, lin, col, inimigos, configMundo) {
    const tipo = estado.matrizTerritorio[lin][col];

    // Chave da célula no formato "lin,col" — usada nos Sets e no historicoCelulas
    const chave = `${lin},${col}`;

    // === AUTO-COLISÃO com Grace Period (FIX 2) ===
    // Se a célula já é rastro, pode ser auto-colisão — mas só se NÃO for
    // uma das últimas CELULAS_IGNORADAS células marcadas.
    //
    // Por que o grace period?
    //   Ao fazer uma curva fechada, o jogador naturalmente "roza" as células
    //   imediatamente atrás de si. Sem o grace period, isso causaria morte
    //   instantânea mesmo em manobras válidas.
    //
    // Comportamento:
    //   • Célula RASTRO recente (em historicoCelulas) → sem colisão, ignora
    //   • Célula RASTRO antiga (fora do histórico)    → colisão real, morre
    if (tipo === CELULA_RASTRO) {
        if (estado.historicoCelulas.includes(chave)) {
            return "ok"; // grace period — célula recente, não é colisão
        }
        return "autoColisao"; // célula antiga — colisão real
    }

    // Só marca células VAZIAS — não sobrescreve BASE com RASTRO
    if (tipo === CELULA_VAZIA) {
        // Marca a célula como rastro na grade
        estado.matrizTerritorio[lin][col] = CELULA_RASTRO;
        estado.rastro.add(chave);

        // Atualiza o histórico de células recentes para o grace period.
        // Mantém apenas as últimas CELULAS_IGNORADAS células (janela deslizante).
        estado.historicoCelulas.push(chave);
        if (estado.historicoCelulas.length > CELULAS_IGNORADAS) {
            estado.historicoCelulas.shift(); // remove a mais antiga
        }

        // === TERRITÓRIO INIMIGO ===
        // Verifica se esta célula de rastro está dentro do domínio de algum inimigo.
        // Se estiver, registra para que ao retornar à base possamos subtrair o território.
        if (inimigos && configMundo) {
            for (const [id, dadosInimigo] of Object.entries(inimigos)) {
                if (_celulaEstaNaBaseInimiga(lin, col, dadosInimigo, configMundo)) {
                    // Cria o Set para este inimigo se ainda não existir
                    if (!estado.celulasInimigas.has(id)) {
                        estado.celulasInimigas.set(id, new Set());
                    }
                    // Registra a chave desta célula para subtração posterior
                    estado.celulasInimigas.get(id).add(chave);
                }
            }
        }
    }

    return "ok";
}

// ─── Registro do Rastro ───────────────────────────────────────────────────────
//
// === RASTRO (com Bresenham e detecção de colisão) ===
// Marca as células percorridas pelo jogador como CELULA_RASTRO.
// Usa o algoritmo de Bresenham para garantir que NENHUMA célula seja pulada
// entre a posição anterior e a atual — isso elimina os "vãos" no rastro.
//
// Chamada a cada frame enquanto o jogador está fora da base.
//
// Parâmetros:
//   estado      — estado de território do jogador local
//   jogador     — dados do jogador (x, y)
//   configMundo — configurações do mundo
//   inimigos    — objeto {id: dados} com inimigos (pode ser null)
//
// Retorna: true se houve auto-colisão, false caso contrário
function _registrarRastro(estado, jogador, configMundo, inimigos) {
    const posAtual = mundoParaGrade(jogador.x, jogador.y, configMundo);

    // Determina quais células percorrer neste frame:
    // • Primeiro frame fora da base: só a célula atual
    // • Frames seguintes: linha de Bresenham da posição anterior até a atual
    const celulas = estado.posicaoAnterior
        ? _bresenham(estado.posicaoAnterior, posAtual)
        : [posAtual];

    // Pula a primeira célula se vinda de Bresenham:
    // ela é a "posicaoAnterior" e já foi processada no frame anterior.
    // Sem isso, processaríamos a mesma célula duas vezes.
    const inicio = estado.posicaoAnterior ? 1 : 0;

    let autoColisao = false;

    for (let i = inicio; i < celulas.length; i++) {
        const { lin, col } = celulas[i];
        const resultado = _marcarCelula(estado, lin, col, inimigos, configMundo);

        if (resultado === "autoColisao") {
            autoColisao = true;
            break; // para de processar o restante da linha
        }
    }

    // Só atualiza posicaoAnterior se não houve colisão —
    // em caso de colisão, o estado será resetado de qualquer forma.
    if (!autoColisao) {
        estado.posicaoAnterior = posAtual;
    }

    return autoColisao;
}

// ─── Conquista de Território — Flood Fill ─────────────────────────────────────
//
// Flood Fill (preenchimento por inundação) é o algoritmo central deste jogo.
//
// ANALOGIA: Imagine que a grade é um terreno.
// O jogador construiu uma cerca (o rastro + base existente).
// Agora derramamos água pelas bordas do mapa.
// A água flui por todas as células VAZIAS que consegue alcançar.
// As células que ficam SECAS (água não chegou lá) estavam CERCADAS pela cerca.
// Essas células SECAS são conquistadas pelo jogador!
//
// Chamada quando o jogador retorna à base com um rastro ativo.
function _conquistarTerritorio(estadoTerritorio) {
    const { matrizTerritorio, rastro } = estadoTerritorio;

    // ── PASSO 1: Converte todas as células de RASTRO em CELULA_BASE ──────────
    // O rastro se torna parte permanente do território.
    // Isso também faz o rastro funcionar como "parede" para o Flood Fill.
    for (const chave of rastro) {
        // Cada chave está no formato "linha,coluna" — ex: "23,41"
        const [lin, col] = chave.split(",").map(Number);
        matrizTerritorio[lin][col] = CELULA_BASE;
    }

    // ── PASSO 2: Flood Fill — Inunda o exterior a partir das bordas ──────────
    // Vamos encontrar todas as células VAZIAS que se conectam com o exterior.
    // Qualquer célula VAZIA que NÃO for alcançada está CERCADA e será conquistada.

    // Grade auxiliar de booleanos: true = a inundação chegou aqui
    const foiAlcancada = Array.from({ length: TAMANHO_GRADE }, () =>
        new Array(TAMANHO_GRADE).fill(false)
    );

    // Fila para o BFS (Busca em Largura — Breadth-First Search)
    // No BFS, processamos as células em ordem de chegada (primeiro a chegar, primeiro a ser processado)
    const fila = [];

    // Coloca na fila todas as células VAZIAS nas 4 bordas da grade
    // As bordas representam o "exterior" — por onde a água entra
    for (let i = 0; i < TAMANHO_GRADE; i++) {
        _enfileirarSeVazia(matrizTerritorio, foiAlcancada, fila, 0,                 i); // borda de cima
        _enfileirarSeVazia(matrizTerritorio, foiAlcancada, fila, TAMANHO_GRADE - 1, i); // borda de baixo
        _enfileirarSeVazia(matrizTerritorio, foiAlcancada, fila, i,                 0); // borda esquerda
        _enfileirarSeVazia(matrizTerritorio, foiAlcancada, fila, i, TAMANHO_GRADE - 1); // borda direita
    }

    // Processa cada célula enfileirada e tenta espalhar a inundação para os vizinhos
    while (fila.length > 0) {
        // Retira a primeira célula da fila (BFS = ordem de chegada)
        const { lin, col } = fila.shift();

        // Tenta inundar as 4 células vizinhas — somente as 4 direções ortogonais
        // (sem diagonal, pois o jogo usa grade quadrada simples)
        _enfileirarSeVazia(matrizTerritorio, foiAlcancada, fila, lin - 1, col); // cima
        _enfileirarSeVazia(matrizTerritorio, foiAlcancada, fila, lin + 1, col); // baixo
        _enfileirarSeVazia(matrizTerritorio, foiAlcancada, fila, lin, col - 1); // esquerda
        _enfileirarSeVazia(matrizTerritorio, foiAlcancada, fila, lin, col + 1); // direita
    }

    // ── PASSO 3: Conquista células cercadas ───────────────────────────────────
    // Percorre toda a grade: qualquer célula VAZIA que a água não alcançou
    // estava cercada pelo território do jogador — agora ela pertence a ele!
    for (let lin = 0; lin < TAMANHO_GRADE; lin++) {
        for (let col = 0; col < TAMANHO_GRADE; col++) {
            if (matrizTerritorio[lin][col] === CELULA_VAZIA && !foiAlcancada[lin][col]) {
                // Vazia + não alcançada pela inundação = cercada = agora é BASE!
                matrizTerritorio[lin][col] = CELULA_BASE;
            }
        }
    }

    // ── PASSO 4: Limpa o rastro — a conquista foi concluída ──────────────────
    rastro.clear();
    estadoTerritorio.estaForaDaBase = false;
}

// Função auxiliar interna do Flood Fill:
// Tenta adicionar a célula (lin, col) na fila de inundação.
// Só adiciona se: (1) está dentro dos limites, (2) ainda não visitada, (3) é VAZIA.
function _enfileirarSeVazia(matrizTerritorio, foiAlcancada, fila, lin, col) {
    // Ignora coordenadas fora dos limites da grade (bordas dos cantos)
    if (lin < 0 || lin >= TAMANHO_GRADE || col < 0 || col >= TAMANHO_GRADE) return;

    // Ignora células já visitadas para evitar processamento repetido (loop infinito)
    if (foiAlcancada[lin][col]) return;

    // Base e rastro (já convertido para base no Passo 1) bloqueiam a inundação
    if (matrizTerritorio[lin][col] !== CELULA_VAZIA) return;

    // A inundação chegou aqui — marca e coloca na fila
    foiAlcancada[lin][col] = true;
    fila.push({ lin, col });
}

// ─── Função Principal de Atualização ─────────────────────────────────────────
//
// Chamada a cada frame de renderização para manter o território atualizado.
// Decide o que fazer com base na posição atual do jogador na grade.
//
// Parâmetros:
//   estadoTerritorio — objeto com matrizTerritorio, rastro, estaForaDaBase, etc.
//   jogador          — dados atuais do jogador (x, y, territoryX, territoryY)
//   configMundo      — configurações do mundo (mapRadius, initialTerritoryRadius)
//   state            — NOVO: estado completo de todos os jogadores (para detectar inimigos)
//   myId             — NOVO: ID do jogador local (para excluí-lo da lista de inimigos)
//
// Retorna: { morreu: boolean, celulasSubtraidas: Object|null }
//   morreu          — true se o jogador cruzou o próprio rastro (deve respawnar)
//   celulasSubtraidas — mapa {idInimigo: ["lin,col"]} de células a subtrair dos inimigos
//                       null se não houve interação com território inimigo
export function atualizarTerritorio(estadoTerritorio, jogador, configMundo, state, myId) {
    // Verifica se o jogador está dentro da sua base neste exato instante
    const emBase = _jogadorEstaEmBase(estadoTerritorio, jogador, configMundo);

    if (emBase) {
        // ── JOGADOR ESTÁ NA BASE ──────────────────────────────────────────────
        let celulasSubtraidas = null;

        // Se ele estava fora e voltou com rastro, executa o Flood Fill
        if (estadoTerritorio.estaForaDaBase && estadoTerritorio.rastro.size > 0) {
            // Retornou à base com rastro! Conquista o território cercado!
            _conquistarTerritorio(estadoTerritorio);

            // === TERRITÓRIO INIMIGO ===
            // Se o rastro passou por território inimigo, preparar dados para subtração.
            // Fazemos isso ANTES de limpar celulasInimigas.
            if (estadoTerritorio.celulasInimigas.size > 0) {
                celulasSubtraidas = {};
                for (const [id, celulaSet] of estadoTerritorio.celulasInimigas) {
                    // Converte o Set de strings para um Array para poder enviar via socket
                    celulasSubtraidas[id] = Array.from(celulaSet);
                }
                estadoTerritorio.celulasInimigas.clear();
            }
        }

        // Desliga o flag de "está fora da base" e reseta o rastro de posição
        estadoTerritorio.estaForaDaBase = false;
        // Reseta a posição anterior para que o Bresenham comece do zero na próxima saída
        estadoTerritorio.posicaoAnterior = null;
        // Limpa o histórico de grace period para que a próxima saída comece limpa
        estadoTerritorio.historicoCelulas.length = 0;

        return { morreu: false, celulasSubtraidas };

    } else {
        // ── JOGADOR ESTÁ FORA DA BASE ─────────────────────────────────────────
        // Liga o flag que mostra que o jogador está no território desconhecido
        estadoTerritorio.estaForaDaBase = true;

        // === TERRITÓRIO INIMIGO ===
        // Monta o objeto de inimigos (excluindo o jogador local) para detecção.
        // Se state não for fornecido (retrocompatibilidade), não faz detecção.
        const inimigos = (state && myId) ? _filtrarInimigos(state, myId) : null;

        // === RASTRO + AUTO-COLISÃO ===
        // Registra o rastro com Bresenham (sem gaps) e detecta auto-colisão
        const autoColisao = _registrarRastro(estadoTerritorio, jogador, configMundo, inimigos);

        if (autoColisao) {
            // === AUTO-COLISÃO ===
            // Jogador cruzou o próprio rastro — deve voltar ao spawn.
            // Limpa as células de rastro da grade antes de limpar o conjunto.
            // (precisamos limpar o conjunto depois, por isso iteramos primeiro)
            for (const chave of estadoTerritorio.rastro) {
                const [l, c] = chave.split(",").map(Number);
                estadoTerritorio.matrizTerritorio[l][c] = CELULA_VAZIA;
            }
            estadoTerritorio.rastro.clear();
            estadoTerritorio.celulasInimigas.clear();
            estadoTerritorio.historicoCelulas.length = 0; // limpa o grace period
            estadoTerritorio.estaForaDaBase = false;
            estadoTerritorio.posicaoAnterior = null;

            return { morreu: true, celulasSubtraidas: null };
        }

        return { morreu: false, celulasSubtraidas: null };
    }
}

// Filtra o estado geral de jogadores para retornar apenas os inimigos
// (todos exceto o jogador local), no formato {id: dadosJogador}.
function _filtrarInimigos(state, myId) {
    const inimigos = {};
    for (const [id, dados] of Object.entries(state)) {
        if (id !== myId) {
            inimigos[id] = dados;
        }
    }
    return inimigos;
}

// ─── Remoção de Território por Ação Inimiga ───────────────────────────────────
//
// === TERRITÓRIO INIMIGO ===
// Chamada quando o servidor notifica que outro jogador passou pelo nosso território
// e retornou à base — aquelas células devem ser removidas do nosso domínio.
//
// Parâmetros:
//   estado  — estado de território do jogador local
//   celulas — array de strings "lin,col" das células a serem removidas
export function limparCelulasTerritorio(estado, celulas) {
    for (const chave of celulas) {
        const [lin, col] = chave.split(",").map(Number);

        // Só remove células que realmente são BASE — não remove rastro nem vazio.
        // (garante que não desfazemos o estado de uma célula que já mudou)
        if (estado.matrizTerritorio[lin][col] === CELULA_BASE) {
            estado.matrizTerritorio[lin][col] = CELULA_VAZIA;
        }
    }
}
