export function drawMapLayer(context, worldConfig) {
    context.beginPath();
    context.arc(0, 0, worldConfig.mapRadius, 0, Math.PI * 2);
    context.fillStyle = "#fff";
    context.fill();

    context.lineWidth = 15;
    context.strokeStyle = "#222";
    context.stroke();
}
