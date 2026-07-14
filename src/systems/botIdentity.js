const BOT_ID_PREFIX = "bot:";

function isBotPlayer(player) {
    return Boolean(player && (player.isBot || String(player.id || "").startsWith(BOT_ID_PREFIX)));
}

module.exports = {
    BOT_ID_PREFIX,
    isBotPlayer
};
