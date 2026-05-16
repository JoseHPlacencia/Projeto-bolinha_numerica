export function desenharCamadaMinimap(canvas, estado, idJogadorAtual, configMundo) {
    const contexto = canvas.getContext("2d");
    const tamanho = canvas.width;
    const escala = (tamanho / 2) / configMundo.mapRadius;
    const centroX = tamanho / 2;
    const centroY = tamanho / 2;
    const jogadorAtual = estado[idJogadorAtual];

    contexto.clearRect(0, 0, tamanho, tamanho);
    contexto.save();

    contexto.beginPath();
    contexto.arc(centroX, centroY, centroX, 0, Math.PI * 2);
    contexto.clip();

    contexto.fillStyle = "rgba(0, 0, 0, 0.55)";
    contexto.fillRect(0, 0, tamanho, tamanho);

    contexto.beginPath();
    contexto.arc(centroX, centroY, configMundo.mapRadius * escala, 0, Math.PI * 2);
    contexto.fillStyle = "#d8d8d8";
    contexto.fill();

    if (jogadorAtual) {
        desenharAreaDominada(contexto, jogadorAtual, configMundo, centroX, centroY, escala);
        desenharPontoJogador(contexto, jogadorAtual, centroX, centroY, escala);
    }

    contexto.restore();

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
