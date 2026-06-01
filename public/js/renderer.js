import { drawMapLayer as drawMap } from "./renderers/mapRenderer.js";
import { drawNumberLayer } from "./renderers/numberRenderer.js";
import { drawPlayerLayer } from "./renderers/playerRenderer.js";
import { drawTerritoryLayer } from "./renderers/territoryRenderer.js";
import { drawTrailLayer } from "./renderers/trailRenderer.js";
import { createViewportBounds } from "./renderers/viewportCulling.js";

<<<<<<< HEAD
=======
export function createCanvasViewportLayout(gameConfig, rawWidth, rawHeight, rawPixelRatio = 1) {
    let width = Number.isFinite(rawWidth) && rawWidth > 0
        ? rawWidth
        : gameConfig.screen.virtualWidth;
    let height = Number.isFinite(rawHeight) && rawHeight > 0
        ? rawHeight
        : gameConfig.screen.virtualHeight;
    const aspectRatio = width / height;

    if (aspectRatio < gameConfig.screen.minAspectRatio) {
        height = width / gameConfig.screen.minAspectRatio;
    } else if (aspectRatio > gameConfig.screen.maxAspectRatio) {
        width = height * gameConfig.screen.maxAspectRatio;
    }

    width = Math.round(width);
    height = Math.round(height);

    const pixelRatio = Number.isFinite(rawPixelRatio) && rawPixelRatio > 0
        ? rawPixelRatio
        : 1;

    return {
        canvasHeight: Math.round(height * pixelRatio),
        canvasWidth: Math.round(width * pixelRatio),
        height,
        pixelRatio,
        scale: Math.min(
            width / gameConfig.screen.virtualWidth,
            height / gameConfig.screen.virtualHeight
        ),
        width
    };
}

>>>>>>> 70aca42 (teste)
export function createCanvasRenderer(canvas, gameConfig) {
    const context = canvas.getContext("2d");
    let viewportWidth = 0;
    let viewportHeight = 0;
    let canvasScale = 1;
    let pixelRatio = 1;
    let lastViewportBounds = null;

    return {
        getDebugState,
<<<<<<< HEAD
=======
        getViewportState,
>>>>>>> 70aca42 (teste)
        renderWorld,
        resizeCanvas
    };

<<<<<<< HEAD
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
=======
    function resizeCanvas(layout = null) {
        const nextLayout = layout || createCanvasViewportLayout(
            gameConfig,
            getWindowWidth(),
            getWindowHeight(),
            getPixelRatio()
        );

        viewportWidth = nextLayout.width;
        viewportHeight = nextLayout.height;
        pixelRatio = nextLayout.pixelRatio;

        canvas.width = nextLayout.canvasWidth;
        canvas.height = nextLayout.canvasHeight;

        if (canvas.style) {
            canvas.style.width = `${nextLayout.width}px`;
            canvas.style.height = `${nextLayout.height}px`;
        }

        canvasScale = nextLayout.scale;
>>>>>>> 70aca42 (teste)
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
<<<<<<< HEAD
        drawNumberLayer(context, state);
=======
        drawNumberLayer(context, state.numbers && state.numbers.nums, viewportBounds);
>>>>>>> 70aca42 (teste)
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

<<<<<<< HEAD
    function getPixelRatio() {
        return window.devicePixelRatio || 1;
=======
    function getWindowWidth() {
        return typeof window !== "undefined" && Number.isFinite(window.innerWidth)
            ? window.innerWidth
            : gameConfig.screen.virtualWidth;
    }

    function getWindowHeight() {
        return typeof window !== "undefined" && Number.isFinite(window.innerHeight)
            ? window.innerHeight
            : gameConfig.screen.virtualHeight;
    }

    function getPixelRatio() {
        return typeof window !== "undefined" && Number.isFinite(window.devicePixelRatio)
            ? window.devicePixelRatio || 1
            : 1;
>>>>>>> 70aca42 (teste)
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
<<<<<<< HEAD
=======

    function getViewportState() {
        return {
            width: viewportWidth,
            height: viewportHeight,
            scale: canvasScale
        };
    }
>>>>>>> 70aca42 (teste)
}
