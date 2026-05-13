const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

/* ==================================================
   SERVIDOR HTTP + SOCKET
================================================== */
const app = express();
const servidorHttp = http.createServer(app);

const io = new Server(servidorHttp, {
    transports: ["websocket"],     // força websocket
    perMessageDeflate: false      // evita compressão em tempo real
});

app.use(express.static(path.join(__dirname, "public")));

/* ==================================================
   CONFIGURAÇÕES GERAIS
================================================== */
const porta = 3000;

/* ticks da lógica */
const tickRate = 60;
const intervaloTick = 1000 / tickRate;

/* snapshots enviados para clientes */
const snapshotRate = 30;
const intervaloSnapshot = 1000 / snapshotRate;

/* mapa */
const raioMapa = 1500;
const tamanhoJogador = 70;
const raioBase = 200;

/* movimento */
const velocidade = 10;
const poderRotacao = 0.1;

/* spawn */
const distanciaMinimaBases = raioBase * 3;
const maxTentativasSpawn = 500;

/* ==================================================
   INPUTS
================================================== */
const angulosTeclas = {
    arrowright: 0,
    d: 0,

    arrowdown: Math.PI / 2,
    s: Math.PI / 2,

    arrowleft: Math.PI,
    a: Math.PI,

    arrowup: -Math.PI / 2,
    w: -Math.PI / 2
};

/* todos jogadores conectados */
const jogadores = {};

/* ==================================================
   FUNÇÕES AUXILIARES
================================================== */

/* horário atual do servidor */
function obterTempoAtual() {
    return Date.now();
}

/* distância entre 2 pontos */
function calcularDistancia(x1, y1, x2, y2) {
    return Math.hypot(x1 - x2, y1 - y2);
}

/* rotação suave para menor caminho angular */
function interpolarAngulo(anguloAtual, anguloDestino, intensidade) {

    let diferenca = anguloDestino - anguloAtual;

    while (diferenca < -Math.PI) {
        diferenca += Math.PI * 2;
    }

    while (diferenca > Math.PI) {
        diferenca -= Math.PI * 2;
    }

    return anguloAtual + diferenca * intensidade;
}

/* ==================================================
   SISTEMA DE SPAWN
================================================== */

/* verifica se uma posição não invade outra base */
function posicaoSpawnValida(x, y) {

    for (const id in jogadores) {

        const jogador = jogadores[id];

        const distancia = calcularDistancia(
            x, y,
            jogador.baseX,
            jogador.baseY
        );

        if (distancia < distanciaMinimaBases) {
            return false;
        }
    }

    return true;
}

/* gera posição aleatória segura */
function gerarSpawn() {

    const raioMaximo =
        raioMapa - raioBase * 3 - tamanhoJogador / 2;

    for (let tentativa = 0;
         tentativa < maxTentativasSpawn;
         tentativa++) {

        const angulo = Math.random() * Math.PI * 2;
        const distancia = Math.sqrt(Math.random()) * raioMaximo;

        const x = Math.cos(angulo) * distancia;
        const y = Math.sin(angulo) * distancia;

        if (posicaoSpawnValida(x, y)) {
            return { x, y };
        }
    }

    /* fallback extremo */
    return { x: 0, y: 0 };
}

/* ==================================================
   CRIAÇÃO DE JOGADOR
================================================== */
function criarJogador(id) {

    const spawn = gerarSpawn();

    const matiz = Math.floor(Math.random() * 360);
    const cor = `hsl(${matiz},80%,50%)`;

    jogadores[id] = {
        id,

        x: spawn.x,
        y: spawn.y,

        angulo: Math.random() * Math.PI * 2,

        cor,

        baseX: spawn.x,
        baseY: spawn.y,

        movendo: false,
        teclas: []
    };
}

/* ==================================================
   MOVIMENTO
================================================== */
function atualizarJogador(jogador) {

    if (!jogador.movendo) {
        return;
    }

    /* altera direção conforme última tecla pressionada */
    if (jogador.teclas.length > 0) {

        const ultimaTecla =
            jogador.teclas[jogador.teclas.length - 1];

        const anguloDesejado =
            angulosTeclas[ultimaTecla];

        jogador.angulo = interpolarAngulo(
            jogador.angulo,
            anguloDesejado,
            poderRotacao
        );
    }

    /* vetor movimento */
    let velocidadeX =
        Math.cos(jogador.angulo) * velocidade;

    let velocidadeY =
        Math.sin(jogador.angulo) * velocidade;

    let proximoX = jogador.x + velocidadeX;
    let proximoY = jogador.y + velocidadeY;

    const distanciaCentro =
        Math.hypot(proximoX, proximoY);

    const limiteMapa =
        raioMapa - tamanhoJogador / 2;

    /* colisão com borda circular */
    if (distanciaCentro > limiteMapa) {

        const normalX = proximoX / distanciaCentro;
        const normalY = proximoY / distanciaCentro;

        const produtoEscalar =
            velocidadeX * normalX +
            velocidadeY * normalY;

        /* remove componente contra parede */
        if (produtoEscalar > 0) {

            velocidadeX -= produtoEscalar * normalX;
            velocidadeY -= produtoEscalar * normalY;

            /* gira jogador acompanhando deslizamento */
            if (Math.hypot(
                velocidadeX,
                velocidadeY
            ) > 0.1) {

                jogador.angulo = Math.atan2(
                    velocidadeY,
                    velocidadeX
                );
            }
        }

        const novaDistancia =
            Math.hypot(
                jogador.x + velocidadeX,
                jogador.y + velocidadeY
            );

        const proporcao =
            limiteMapa / novaDistancia;

        jogador.x =
            (jogador.x + velocidadeX) * proporcao;

        jogador.y =
            (jogador.y + velocidadeY) * proporcao;

    } else {

        jogador.x = proximoX;
        jogador.y = proximoY;
    }
}

/* ==================================================
   SOCKET CONNECTION
================================================== */
io.on("connection", socket => {

    criarJogador(socket.id);

    /* tecla pressionada */
    socket.on("inputDown", tecla => {

        const jogador = jogadores[socket.id];
        if (!jogador) return;

        if (
            angulosTeclas[tecla] !== undefined &&
            !jogador.teclas.includes(tecla)
        ) {
            jogador.teclas.push(tecla);
        }

        jogador.movendo = true;
    });

    /* tecla solta */
    socket.on("inputUp", tecla => {

        const jogador = jogadores[socket.id];
        if (!jogador) return;

        jogador.teclas =
            jogador.teclas.filter(
                t => t !== tecla
            );
    });

    /* desconexão */
    socket.on("disconnect", () => {
        delete jogadores[socket.id];
    });
});

/* ==================================================
   LOOP DE LÓGICA
================================================== */
setInterval(() => {

    for (const id in jogadores) {
        atualizarJogador(jogadores[id]);
    }

}, intervaloTick);

/* ==================================================
   ENVIO DE SNAPSHOTS
================================================== */
setInterval(() => {

    const jogadoresSnapshot = {};

    for (const id in jogadores) {

        const jogador = jogadores[id];

        jogadoresSnapshot[id] = {
            id: jogador.id,

            x: jogador.x,
            y: jogador.y,

            angulo: jogador.angulo,

            cor: jogador.cor,

            baseX: jogador.baseX,
            baseY: jogador.baseY
        };
    }

    /* volatile:
       se atrasar, descarta snapshot antigo */
    io.volatile.emit("estado", {
        tempo: obterTempoAtual(),
        jogadores: jogadoresSnapshot
    });

}, intervaloSnapshot);

/* ==================================================
   INICIAR SERVIDOR
================================================== */
servidorHttp.listen(porta, () => {
    console.log(
        `Servidor rodando em http://localhost:${porta}`
    );
});