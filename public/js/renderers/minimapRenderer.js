// Importa as constantes de tipo de célula do sistema de território.
// Esses valores (0, 1, 2) identificam se uma célula é vazia, base ou rastro.
import { CELULA_BASE, CELULA_RASTRO, TAMANHO_GRADE } from "../territorioSystem.js";

// Tamanho (em pixels) de cada célula da grade no canvas do minimapa.
// O minimapa tem 150px e a grade tem TAMANHO_GRADE células → 150 / 50 = 3px por célula.
const TAMANHO_CELULA_MINIMAP = 150 / TAMANHO_GRADE;

// ─── Função Principal do Minimapa ────────────────────────────────────────────
//
// Parâmetros adicionados em relação à versão anterior:
//   estadoTerritorio — objeto { matrizTerritorio, rastro, estaForaDaBase }
//                      criado pelo territorioSystem.js
//                      Se for null (ainda carregando), usa o círculo de fallback.
export function desenharCamadaMinimap(canvas, estado, idJogadorAtual, configMundo, estadoTerritorio) {
    const contexto = canvas.getContext("2d");
    const tamanho = canvas.width;
    const escala = (tamanho / 2) / configMundo.mapRadius;
    const centroX = tamanho / 2;
    const centroY = tamanho / 2;
    const jogadorAtual = estado[idJogadorAtual];

    // Limpa o canvas inteiro antes de redesenhar
    contexto.clearRect(0, 0, tamanho, tamanho);
    contexto.save();

    // Aplica um recorte circular — tudo fora deste círculo não é desenhado
    contexto.beginPath();
    contexto.arc(centroX, centroY, centroX, 0, Math.PI * 2);
    contexto.clip();

    // Fundo escuro semi-transparente do minimapa
    contexto.fillStyle = "rgba(0, 0, 0, 0.55)";
    contexto.fillRect(0, 0, tamanho, tamanho);

    // Fundo cinza claro representando o mapa circular do mundo
    contexto.beginPath();
    contexto.arc(centroX, centroY, configMundo.mapRadius * escala, 0, Math.PI * 2);
    contexto.fillStyle = "#d8d8d8";
    contexto.fill();

    if (jogadorAtual) {
        // Se já temos a grade de território, desenhamos ela (modo novo, detalhado)
        // Caso contrário, desenhamos o círculo simples de fallback (modo antigo)
        if (estadoTerritorio) {
            desenharMatrizTerritorio(contexto, jogadorAtual.color, estadoTerritorio.matrizTerritorio);
        } else {
            // Fallback: mantém o círculo original caso o território ainda não esteja pronto
            desenharAreaDominada(contexto, jogadorAtual, configMundo, centroX, centroY, escala);
        }

        // Ponto do jogador sempre desenhado por cima, em qualquer modo
        desenharPontoJogador(contexto, jogadorAtual, centroX, centroY, escala);
    }

    contexto.restore();

    // Borda circular branca do minimapa (desenhada por último, por cima de tudo)
    contexto.beginPath();
    contexto.arc(centroX, centroY, centroX - 1, 0, Math.PI * 2);
    contexto.lineWidth = 2;
    contexto.strokeStyle = "rgba(255, 255, 255, 0.55)";
    contexto.stroke();
}

function desenharAreaDominada(contexto, jogador, configMundo, centroX, centroY, escala) {
    const territorioX = centroX + jogador.territoryX * escala;
    const territorioY = centroY + jogador.territoryY * escala;
    const raioTerritorio = Math.max(3, configMundo.initialTerritoryRadius * escala);

    contexto.globalAlpha = 0.45;
    contexto.beginPath();
    contexto.arc(territorioX, territorioY, raioTerritorio, 0, Math.PI * 2);
    contexto.fillStyle = jogador.color;
    contexto.fill();
    contexto.globalAlpha = 1;
}

function desenharPontoJogador(contexto, jogador, centroX, centroY, escala) {
    const posX = centroX + jogador.x * escala;
    const posY = centroY + jogador.y * escala;

    contexto.beginPath();
    contexto.arc(posX, posY, 5, 0, Math.PI * 2);
    contexto.fillStyle = jogador.color;
    contexto.fill();

    contexto.lineWidth = 1.5;
    contexto.strokeStyle = "#fff";
    contexto.stroke();
}

// ─── Renderização da Grade de Território ──────────────────────────────────────
//
// Percorre a matrizTerritorio e desenha um pequeno quadrado colorido
// para cada célula que não esteja vazia (base ou rastro).
//
// Parâmetros:
//   contexto          — contexto 2D do canvas do minimapa
//   corJogador        — cor HSL do jogador (ex: "hsl(120,80%,50%)")
//   matrizTerritorio  — grade 2D [linha][coluna] com valores 0, 1 ou 2
function desenharMatrizTerritorio(contexto, corJogador, matrizTerritorio) {
    // Percorre todas as linhas da grade (eixo Y)
    for (let lin = 0; lin < TAMANHO_GRADE; lin++) {
        // Percorre todas as colunas da grade (eixo X)
        for (let col = 0; col < TAMANHO_GRADE; col++) {
            const tipoCelula = matrizTerritorio[lin][col];

            // Células vazias (valor 0) não são desenhadas — o fundo cinza já aparece
            if (tipoCelula === CELULA_BASE) {
                // Célula de base: desenha na cor do jogador com opacidade moderada
                contexto.globalAlpha = 0.60;
                contexto.fillStyle = corJogador;

                // Posição do quadrado no canvas:
                // coluna * tamanho da célula = posição X em pixels
                // linha  * tamanho da célula = posição Y em pixels
                contexto.fillRect(
                    col * TAMANHO_CELULA_MINIMAP,
                    lin * TAMANHO_CELULA_MINIMAP,
                    TAMANHO_CELULA_MINIMAP,
                    TAMANHO_CELULA_MINIMAP
                );

            } else if (tipoCelula === CELULA_RASTRO) {
                // Célula de rastro: desenha em branco com alta opacidade
                // O branco contrasta bem com qualquer cor de jogador
                contexto.globalAlpha = 0.90;
                contexto.fillStyle = "#ffffff";

                contexto.fillRect(
                    col * TAMANHO_CELULA_MINIMAP,
                    lin * TAMANHO_CELULA_MINIMAP,
                    TAMANHO_CELULA_MINIMAP,
                    TAMANHO_CELULA_MINIMAP
                );
            }
        }
    }

    // Restaura a opacidade padrão para não afetar outros elementos desenhados depois
    contexto.globalAlpha = 1;
}
