export async function loadGameConfig() {
    const response = await fetch("/game-config");

    if (!response.ok) {
        throw new Error(`Config request failed with status ${response.status}`);
    }

    return response.json();
}
