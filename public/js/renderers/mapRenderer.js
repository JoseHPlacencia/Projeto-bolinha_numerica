export function drawMapLayer(context, worldConfig) {
    const borderWidth = 15;

    context.beginPath();
    context.arc(0, 0, worldConfig.mapRadius, 0, Math.PI * 2);
    context.fillStyle = "#fff";
    context.fill();

    context.beginPath();
    context.arc(0, 0, worldConfig.mapRadius + borderWidth / 2, 0, Math.PI * 2);
    context.lineWidth = borderWidth;
    context.strokeStyle = "#222";
    context.stroke();
}
