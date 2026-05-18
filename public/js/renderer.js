import { drawMapLayer as drawMap } from "./renderers/mapRenderer.js";
import { drawPlayerLayer } from "./renderers/playerRenderer.js";
import { drawTerritoryLayer } from "./renderers/territoryRenderer.js";
import { drawTrailLayer } from "./renderers/trailRenderer.js";
import { createViewportBounds } from "./renderers/viewportCulling.js";

export function createCanvasRenderer(canvas, gameConfig) {
    const context = canvas.getContext("2d");
    let viewportWidth = 0;
    let viewportHeight = 0;
    let canvasScale = 1;
    let pixelRatio = 1;
    let lastViewportBounds = null;

    return {
        getDebugState,
        renderWorld,
        resizeCanvas
    };

    function resizeCanvas() {
        let width = window.innerWidth;
        let height = window.innerHeight;
        const aspectRatio = width / height;

        if (aspectRatio < gameConfig.screen.minAspectRatio) {
            height = width / gameConfig.screen.minAspectRatio;
        } else if (aspectRatio > gameConfig.screen.maxAspectRatio) {
            width = height * gameConfig.screen.maxAspectRatio;
        }

        width = Math.round(width);
        height = Math.round(height);

        viewportWidth = width;
        viewportHeight = height;
        pixelRatio = getPixelRatio();

        canvas.width = Math.round(width * pixelRatio);
        canvas.height = Math.round(height * pixelRatio);
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;

        canvasScale = Math.min(
            width / gameConfig.screen.virtualWidth,
            height / gameConfig.screen.virtualHeight
        );
    }

    function renderWorld(state, currentPlayerId) {
        const currentPlayer = state.players[currentPlayerId];

        if (!currentPlayer) {
            return;
        }

        clearCanvas();
        applyViewportTransform();
        drawWorld(state, currentPlayer, currentPlayerId);
    }

    function drawWorld(state, currentPlayer, currentPlayerId) {
        const viewportBounds = createRenderViewportBounds(currentPlayer);

        context.save();
        context.translate(viewportWidth / 2, viewportHeight / 2);
        context.scale(canvasScale, canvasScale);
        context.translate(-currentPlayer.x, -currentPlayer.y);

        drawMap(context, gameConfig.world);
        drawTerritoryLayer(context, state, gameConfig, viewportBounds);
        drawTrailLayer(context, state, gameConfig, viewportBounds);
        drawPlayerLayer(context, state.players, currentPlayer, currentPlayerId, gameConfig, viewportBounds);
        context.restore();
    }

    function createRenderViewportBounds(currentPlayer) {
        const margin = Math.max(
            gameConfig.world.playerSize * 2,
            gameConfig.territory.baseBorderWidth * 8
        );

        lastViewportBounds = createViewportBounds(
            currentPlayer,
            viewportWidth,
            viewportHeight,
            canvasScale,
            margin
        );

        return lastViewportBounds;
    }

    function clearCanvas() {
        context.setTransform(1, 0, 0, 1, 0, 0);
        context.clearRect(0, 0, canvas.width, canvas.height);
    }

    function applyViewportTransform() {
        context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    }

    function getPixelRatio() {
        return window.devicePixelRatio || 1;
    }

    function getDebugState() {
        return {
            canvasHeight: canvas.height,
            canvasWidth: canvas.width,
            pixelRatio,
            viewportBounds: lastViewportBounds,
            viewportHeight,
            viewportWidth
        };
    }
}
