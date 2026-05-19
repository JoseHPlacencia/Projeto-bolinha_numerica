// Importa as constantes de tipo de célula e o tamanho da grade do sistema de território.
// Esses mesmos valores são usados no minimapRenderer e no territorioSystem.
import { CELULA_BASE, CELULA_RASTRO, TAMANHO_GRADE } from "../territorioSystem.js";

// drawTerritoryLayer — desenha o território de todos os jogadores no mundo principal.
//
// === FIX 4: ORDEM DE RENDERIZAÇÃO ===
// Inimigos são desenhados PRIMEIRO (camada de baixo).
// O jogador local é desenhado POR ÚLTIMO (camada de cima).
// Resultado: quando o jogador local conquista área inimiga, sua cor cobre
// imediatamente a cor do inimigo — sem sobreposição visual.
//
// Parâmetros:
//   estadoTerritorio — objeto { matrizTerritorio, rastro, estaForaDaBase } do jogador local
//                      Se for null, usa o círculo inicial para todos (modo antigo).
//   idJogadorLocal   — ID do jogador que está neste cliente (para saber quem usa a matriz)
export function drawTerritoryLayer(context, state, worldConfig, estadoTerritorio, idJogadorLocal) {
    // ── Passo 1: Inimigos primeiro (ficam embaixo) ────────────────────────────
    // Desenha o círculo de território de cada jogador que NÃO é o local.
    // Como são desenhados antes, serão cobertos pelo território do jogador local.
    for (const player of Object.values(state)) {
        if (player.id === idJogadorLocal) continue; // pula o jogador local neste passo

        // Para inimigos, mantemos o círculo original (a grade deles vive no cliente deles)
        drawInitialTerritory(context, player, worldConfig);

        // Mantém o suporte a polígonos de território (infraestrutura existente)
        drawPlayerTerritory(context, player);
    }

    // ── Passo 2: Jogador local por cima (cobre o território inimigo) ──────────
    // Ao ser desenhado por último, o território local aparece sobre qualquer
    // área inimiga onde o jogador tenha expandido — efeito "instantâneo".
    const jogadorLocal = state[idJogadorLocal];

    if (jogadorLocal) {
        if (estadoTerritorio) {
            // Usa a grade de células detalhada (com rastro e base reais)
            drawMatrizTerritorio(context, jogadorLocal, estadoTerritorio, worldConfig);
        } else {
            // Fallback: círculo simples antes da grade ser criada (primeiros frames)
            drawInitialTerritory(context, jogadorLocal, worldConfig);
        }
        drawPlayerTerritory(context, jogadorLocal);
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

    // ── Passo 0: Apaga território inimigo subjacente (substituição direta) ───────
    // Círculos inimigos são desenhados antes com globalAlpha 0.66; se apenas
    // desenharmos o território local com o mesmo alpha, as cores se mesclam
    // visualmente em vez de substituir. O retângulo branco sólido "reseta" o
    // pixel para o fundo branco do mapa, garantindo que a cor local seja a única
    // a aparecer nas células já conquistadas.
    context.globalAlpha = 1.0;
    context.fillStyle = "#ffffff";

    for (let lin = 0; lin < TAMANHO_GRADE; lin++) {
        for (let col = 0; col < TAMANHO_GRADE; col++) {
            if (matrizTerritorio[lin][col] !== CELULA_BASE) continue;
            const x = col * tamanhoCelula - worldConfig.mapRadius;
            const y = lin * tamanhoCelula - worldConfig.mapRadius;
            context.fillRect(x, y, tamanhoCelula, tamanhoCelula);
        }
    }

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

    // ── Segunda passagem: desenha as células de RASTRO ───────────────────────
    //
    // === FIX 1: COR DO RASTRO ===
    // Problema anterior: fillStyle = "#ffffff" (branco) sobre mapa branco (#fff)
    // → o rastro existia na grade mas era INVISÍVEL na tela principal.
    //
    // Correção: usa a cor do jogador com opacidade TOTAL (1.0) para o rastro.
    // • Na tela principal (fundo branco): agora visível como cor sólida do jogador
    // • Visualmente distinguível da BASE (que usa 0.66 de opacidade)
    // • Uma borda branca interna destaca cada bloco de rastro como "em andamento"
    context.globalAlpha = 1.0;
    context.fillStyle = player.color;

    for (let lin = 0; lin < TAMANHO_GRADE; lin++) {
        for (let col = 0; col < TAMANHO_GRADE; col++) {
            if (matrizTerritorio[lin][col] !== CELULA_RASTRO) continue;

            const x = col * tamanhoCelula - worldConfig.mapRadius;
            const y = lin * tamanhoCelula - worldConfig.mapRadius;

            context.fillRect(x, y, tamanhoCelula, tamanhoCelula);
        }
    }

    // Borda branca interna nos blocos de rastro — diferencia visualmente de BASE.
    // A margem de 4px cria um "frame" branco dentro de cada bloco de rastro.
    context.globalAlpha = 0.55;
    context.strokeStyle = "#ffffff";
    context.lineWidth = 3;

    for (let lin = 0; lin < TAMANHO_GRADE; lin++) {
        for (let col = 0; col < TAMANHO_GRADE; col++) {
            if (matrizTerritorio[lin][col] !== CELULA_RASTRO) continue;

            const x = col * tamanhoCelula - worldConfig.mapRadius;
            const y = lin * tamanhoCelula - worldConfig.mapRadius;
            const margem = 4;

            // strokeRect inset de 4px: cria borda branca DENTRO do bloco colorido
            context.strokeRect(x + margem, y + margem, tamanhoCelula - margem * 2, tamanhoCelula - margem * 2);
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
