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

    // Objeto que vai guardar todos os dados de território deste jogador
    const estado = {
        matrizTerritorio,
        rastro,
        estaForaDaBase
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

// ─── Registro do Rastro ───────────────────────────────────────────────────────

// Marca a célula onde o jogador está como CELULA_RASTRO, se ela estiver vazia.
// Chamada a cada frame enquanto o jogador está fora da base.
function _registrarRastro(estadoTerritorio, jogador, configMundo) {
    // Descobre em qual célula da grade o jogador está agora
    const { lin, col } = mundoParaGrade(jogador.x, jogador.y, configMundo);

    // Só registra rastro em células VAZIAS (não sobrescreve base nem rastro anterior)
    if (estadoTerritorio.matrizTerritorio[lin][col] === CELULA_VAZIA) {
        // Marca a célula como rastro na grade
        estadoTerritorio.matrizTerritorio[lin][col] = CELULA_RASTRO;

        // Salva a chave "lin,col" no conjunto para usar no Flood Fill depois
        estadoTerritorio.rastro.add(`${lin},${col}`);
    }
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
//   estadoTerritorio — objeto com matrizTerritorio, rastro, estaForaDaBase
//   jogador          — dados atuais do jogador (x, y, territoryX, territoryY)
//   configMundo      — configurações do mundo (mapRadius, initialTerritoryRadius)
export function atualizarTerritorio(estadoTerritorio, jogador, configMundo) {
    // Verifica se o jogador está dentro da sua base neste exato instante
    const emBase = _jogadorEstaEmBase(estadoTerritorio, jogador, configMundo);

    if (emBase) {
        // ── JOGADOR ESTÁ NA BASE ──────────────────────────────────────────────
        // Se ele estava fora e voltou com rastro, executa o Flood Fill
        if (estadoTerritorio.estaForaDaBase && estadoTerritorio.rastro.size > 0) {
            // Retornou à base com rastro! Conquista o território cercado!
            _conquistarTerritorio(estadoTerritorio);
        }

        // Desliga o flag de "está fora da base"
        estadoTerritorio.estaForaDaBase = false;

    } else {
        // ── JOGADOR ESTÁ FORA DA BASE ─────────────────────────────────────────
        // Liga o flag que mostra que o jogador está no território desconhecido
        estadoTerritorio.estaForaDaBase = true;

        // Registra o rastro na célula atual (só se ela estiver vazia)
        _registrarRastro(estadoTerritorio, jogador, configMundo);
    }
}
