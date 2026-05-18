// Importa as constantes de tipo de célula e o tamanho da grade do sistema de território.
// Esses mesmos valores são usados no minimapRenderer e no territorioSystem.
import { CELULA_BASE, CELULA_RASTRO, TAMANHO_GRADE } from "../territorioSystem.js";

// drawTerritoryLayer — desenha o território de todos os jogadores no mundo principal.
//
// Parâmetros novos (em relação à versão anterior):
//   estadoTerritorio — objeto { matrizTerritorio, rastro, estaForaDaBase } do jogador local
//                      Se for null, usa o círculo inicial para todos (modo antigo).
//   idJogadorLocal   — ID do jogador que está neste cliente (para saber quem usa a matriz)
export function drawTerritoryLayer(context, state, worldConfig, estadoTerritorio, idJogadorLocal) {
    for (const player of Object.values(state)) {
        // Se este jogador é o jogador local E a matriz de território já foi criada,
        // desenhamos as células individuais da grade em vez do círculo genérico
        if (player.id === idJogadorLocal && estadoTerritorio) {
            drawMatrizTerritorio(context, player, estadoTerritorio, worldConfig);
        } else {
            // Para outros jogadores (ou antes da grade existir), mantemos o círculo original
            drawInitialTerritory(context, player, worldConfig);
        }

        // Mantém o suporte a polígonos de território (infraestrutura existente)
        drawPlayerTerritory(context, player);
    }
}

function drawInitialTerritory(context, player, worldConfig) {
    context.globalAlpha = 0.66;
    context.fillStyle = player.color;

    context.beginPath();
    context.arc(
        player.territoryX,
        player.territoryY,
        worldConfig.initialTerritoryRadius,
        0,
        Math.PI * 2
    );
    context.fill();

    context.globalAlpha = 1;
    context.lineWidth = 6;
    context.strokeStyle = player.color;

    context.beginPath();
    context.arc(
        player.territoryX,
        player.territoryY,
        worldConfig.initialTerritoryRadius,
        0,
        Math.PI * 2
    );
    context.stroke();
}

function drawPlayerTerritory(context, player) {
    if (!Array.isArray(player.territory)) {
        return;
    }

    for (const polygon of player.territory) {
        drawPolygon(context, polygon, player.color);
    }
}

// ─── Renderização da Matriz de Território no Mundo Principal ─────────────────
//
// Percorre a grade de células do jogador e desenha cada uma delas
// nas coordenadas corretas do MUNDO DO JOGO (não do minimapa).
//
// Como funciona a conversão de célula → posição no mundo:
//   • O mundo vai de -mapRadius até +mapRadius em X e Y
//   • A grade tem TAMANHO_GRADE células em cada lado
//   • Tamanho de cada célula = (mapRadius * 2) / TAMANHO_GRADE unidades do mundo
//   • Posição X da célula (coluna) = coluna * tamanhoCelula - mapRadius
//   • Posição Y da célula (linha)  = linha  * tamanhoCelula - mapRadius
//
// Parâmetros:
//   context          — contexto 2D do canvas principal (já com a câmera aplicada)
//   player           — dados do jogador (cor, posição)
//   estadoTerritorio — objeto com a matrizTerritorio
//   worldConfig      — configurações do mundo (mapRadius)
function drawMatrizTerritorio(context, player, estadoTerritorio, worldConfig) {
    const { matrizTerritorio } = estadoTerritorio;

    // Calcula o tamanho de uma célula em unidades do mundo
    // Exemplo: mapa com diâmetro 3000 e 50 células → cada célula tem 60 unidades
    const tamanhoCelula = (worldConfig.mapRadius * 2) / TAMANHO_GRADE;

    // ── Primeira passagem: desenha todas as células de BASE ───────────────────
    // Usamos a cor do jogador com a mesma opacidade do círculo original (0.66)
    // para manter consistência visual com o resto do jogo
    context.globalAlpha = 0.66;
    context.fillStyle = player.color;

    for (let lin = 0; lin < TAMANHO_GRADE; lin++) {
        for (let col = 0; col < TAMANHO_GRADE; col++) {
            if (matrizTerritorio[lin][col] !== CELULA_BASE) continue;

            // Calcula a posição do canto superior esquerdo desta célula no mundo
            const x = col * tamanhoCelula - worldConfig.mapRadius;
            const y = lin * tamanhoCelula - worldConfig.mapRadius;

            // Desenha o quadrado da célula com o tamanho exato da célula
            context.fillRect(x, y, tamanhoCelula, tamanhoCelula);
        }
    }

    // ── Segunda passagem: desenha as células de RASTRO por cima ──────────────
    // O rastro usa branco com alta opacidade para se destacar sobre a base
    context.globalAlpha = 0.80;
    context.fillStyle = "#ffffff";

    for (let lin = 0; lin < TAMANHO_GRADE; lin++) {
        for (let col = 0; col < TAMANHO_GRADE; col++) {
            if (matrizTerritorio[lin][col] !== CELULA_RASTRO) continue;

            const x = col * tamanhoCelula - worldConfig.mapRadius;
            const y = lin * tamanhoCelula - worldConfig.mapRadius;

            context.fillRect(x, y, tamanhoCelula, tamanhoCelula);
        }
    }

    // ── Borda do território: contorno na cor do jogador ───────────────────────
    // Mantemos o mesmo contorno que o círculo original tinha (lineWidth 6, cor do jogador)
    // para preservar o estilo visual do projeto
    context.globalAlpha = 1;
    context.lineWidth = 3;
    context.strokeStyle = player.color;

    for (let lin = 0; lin < TAMANHO_GRADE; lin++) {
        for (let col = 0; col < TAMANHO_GRADE; col++) {
            if (matrizTerritorio[lin][col] !== CELULA_BASE) continue;

            // Só desenha borda na célula se ela tiver algum vizinho vazio ou de borda
            // Isso evita desenhar contornos internos entre células da mesma área
            if (!_temVizinhoVazio(matrizTerritorio, lin, col)) continue;

            const x = col * tamanhoCelula - worldConfig.mapRadius;
            const y = lin * tamanhoCelula - worldConfig.mapRadius;

            context.strokeRect(x, y, tamanhoCelula, tamanhoCelula);
        }
    }
}

// Verifica se a célula (lin, col) tem pelo menos um vizinho vazio (ou está na borda da grade).
// Usado para desenhar a borda do território apenas nas células externas.
function _temVizinhoVazio(matrizTerritorio, lin, col) {
    // Verifica os 4 vizinhos: cima, baixo, esquerda, direita
    const vizinhos = [
        [lin - 1, col],
        [lin + 1, col],
        [lin, col - 1],
        [lin, col + 1]
    ];

    for (const [vLin, vCol] of vizinhos) {
        // Célula fora da grade = borda do mapa = conta como vazia para o contorno
        if (vLin < 0 || vLin >= TAMANHO_GRADE || vCol < 0 || vCol >= TAMANHO_GRADE) {
            return true;
        }

        // Vizinho vazio = esta célula está na borda do território
        if (matrizTerritorio[vLin][vCol] === 0) {
            return true;
        }
    }

    return false;
}

function drawPolygon(context, polygon, color) {
    if (!Array.isArray(polygon) || polygon.length < 3) {
        return;
    }

    context.save();
    context.globalAlpha = 0.22;
    context.fillStyle = color;
    context.beginPath();
    context.moveTo(polygon[0].x, polygon[0].y);

    for (let index = 1; index < polygon.length; index++) {
        context.lineTo(polygon[index].x, polygon[index].y);
    }

    context.closePath();
    context.fill();
    context.restore();
}
