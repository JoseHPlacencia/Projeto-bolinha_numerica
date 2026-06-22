const DEFAULT_FEED_URL = "https://hub.vennperio.site/api/v1/announcements.json";
const HUB_URL = "https://hub.vennperio.site";
const CACHE_KEY = "vennperioAnnouncementsCache";
const DISMISSED_KEY = "vennperioDismissedAnnouncements";
const FETCH_TIMEOUT_MS = 3000;
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const MAINTENANCE_URGENCY_MS = 24 * 60 * 60 * 1000;
const MAX_DISMISSED_IDS = 50;
const ALLOWED_TYPES = new Set(["development", "update", "maintenance", "incident"]);
const ALLOWED_SEVERITIES = new Set(["info", "warning", "critical"]);
const CHANGE_CATEGORIES = new Set(["added", "changed", "fixed", "knownIssues"]);
const TYPE_LABELS = {
    development: "Desenvolvimento",
    incident: "Incidente",
    maintenance: "Manutenção",
    update: "Atualização"
};

export function createAnnouncementsPanel(root, options = {}) {
    if (!root) {
        return createEmptyController();
    }

    const elements = getPanelElements(root);
    const feedUrl = typeof options.feedUrl === "string" && options.feedUrl
        ? options.feedUrl
        : DEFAULT_FEED_URL;
    let currentFeed = readCachedFeed();
    let currentAnnouncement = null;
    let renderedAnnouncementKey = "";
    let lastRefreshAt = 0;
    let pendingRefresh = null;

    elements.dismissButton?.addEventListener("click", dismissCurrentAnnouncement);
    elements.toggleButton?.addEventListener("click", toggleAnnouncement);
    renderCurrentFeed();

    return {
        refresh
    };

    function refresh(refreshOptions = {}) {
        const force = Boolean(refreshOptions.force);
        const now = Date.now();

        if (pendingRefresh) {
            return pendingRefresh;
        }

        if (!force && now - lastRefreshAt < REFRESH_INTERVAL_MS) {
            renderCurrentFeed();
            return Promise.resolve(currentFeed);
        }

        lastRefreshAt = now;
        pendingRefresh = fetchAnnouncementsFeed(feedUrl)
            .then(feed => {
                currentFeed = feed;
                writeCachedFeed(feed);
                renderCurrentFeed();
                return feed;
            })
            .catch(() => {
                renderCurrentFeed();
                return currentFeed;
            })
            .finally(() => {
                pendingRefresh = null;
            });

        return pendingRefresh;
    }

    function renderCurrentFeed() {
        currentAnnouncement = selectAnnouncement(
            currentFeed,
            readDismissedAnnouncementIds(),
            Date.now()
        );

        if (!currentAnnouncement) {
            root.hidden = true;
            renderedAnnouncementKey = "";
            setExpanded(false);
            return;
        }

        renderAnnouncement(root, elements, currentAnnouncement);

        const announcementKey = `${currentAnnouncement.id}:${currentAnnouncement.severity}`;

        if (announcementKey !== renderedAnnouncementKey) {
            renderedAnnouncementKey = announcementKey;
            setExpanded(currentAnnouncement.severity === "critical");
        }
    }

    function dismissCurrentAnnouncement() {
        if (!currentAnnouncement || !canDismissAnnouncement(currentAnnouncement, Date.now())) {
            return;
        }

        const dismissedIds = readDismissedAnnouncementIds();

        dismissedIds.add(currentAnnouncement.id);
        writeDismissedAnnouncementIds(dismissedIds);
        renderCurrentFeed();
    }

    function toggleAnnouncement() {
        setExpanded(!root.classList.contains("is-expanded"));
    }

    function setExpanded(expanded) {
        root.classList.toggle("is-expanded", expanded);

        if (elements.content) {
            elements.content.hidden = !expanded;
        }

        if (elements.toggleButton) {
            elements.toggleButton.setAttribute("aria-expanded", String(expanded));
            elements.toggleButton.setAttribute(
                "aria-label",
                expanded ? "Minimizar comunicado" : "Expandir comunicado"
            );
        }
    }
}

async function fetchAnnouncementsFeed(feedUrl) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
        const response = await fetch(feedUrl, {
            cache: "no-cache",
            headers: {
                Accept: "application/json"
            },
            signal: controller.signal
        });

        if (!response.ok) {
            throw new Error(`Announcements request failed with HTTP ${response.status}.`);
        }

        return normalizeFeed(await response.json());
    } finally {
        window.clearTimeout(timeout);
    }
}

function normalizeFeed(value) {
    if (!value || typeof value !== "object" || value.schemaVersion !== 1) {
        throw new Error("Invalid announcements schema.");
    }

    const announcements = Array.isArray(value.announcements)
        ? value.announcements.map(normalizeAnnouncement).filter(Boolean)
        : [];

    return {
        schemaVersion: 1,
        announcements
    };
}

function normalizeAnnouncement(value) {
    if (!value
        || typeof value !== "object"
        || !isValidId(value.id)
        || !isBoundedText(value.version, 32)
        || !ALLOWED_TYPES.has(value.type)
        || !ALLOWED_SEVERITIES.has(value.severity)
        || !isOptionalBoundedText(value.title, 80)
        || !isOptionalBoundedText(value.message, 240)
        || !isOptionalStringList(value.highlights, 5, 120)
        || !isOptionalChanges(value.changes)
        || !isValidDate(value.publishedAt)
        || !isOptionalDate(value.startsAt)
        || !isOptionalDate(value.endsAt)
        || !isOptionalDate(value.expiresAt)
        || typeof value.dismissible !== "boolean"
        || typeof value.active !== "boolean") {
        return null;
    }

    return {
        active: value.active,
        details: isBoundedText(value.details, 1000) ? value.details.trim() : "",
        dismissible: value.dismissible,
        endsAt: value.endsAt || null,
        expiresAt: value.expiresAt || null,
        hasChangelog: hasChanges(value.changes),
        highlights: normalizeStringList(value.highlights).slice(0, 3),
        id: value.id,
        message: normalizeOptionalText(value.message),
        publishedAt: value.publishedAt,
        severity: value.severity,
        startsAt: value.startsAt || null,
        title: normalizeOptionalText(value.title),
        type: value.type,
        version: value.version.trim()
    };
}

function selectAnnouncement(feed, dismissedIds, now) {
    if (!feed || !Array.isArray(feed.announcements)) {
        return null;
    }

    return feed.announcements
        .filter(announcement => isAnnouncementVisible(announcement, dismissedIds, now))
        .sort((first, second) => Date.parse(second.publishedAt) - Date.parse(first.publishedAt))[0]
        || null;
}

function isAnnouncementVisible(announcement, dismissedIds, now) {
    if (!announcement.active
        || Date.parse(announcement.publishedAt) > now
        || (announcement.expiresAt && Date.parse(announcement.expiresAt) <= now)) {
        return false;
    }

    return !dismissedIds.has(announcement.id) || isAnnouncementUrgent(announcement, now);
}

function canDismissAnnouncement(announcement, now) {
    return announcement.dismissible && !isAnnouncementUrgent(announcement, now);
}

function isAnnouncementUrgent(announcement, now) {
    if (announcement.severity === "critical") {
        return true;
    }

    if (announcement.type !== "maintenance" || !announcement.startsAt) {
        return false;
    }

    const startsAt = Date.parse(announcement.startsAt);
    const endsAt = announcement.endsAt ? Date.parse(announcement.endsAt) : Infinity;

    return endsAt > now && startsAt <= now + MAINTENANCE_URGENCY_MS;
}

function renderAnnouncement(root, elements, announcement) {
    const canDismiss = canDismissAnnouncement(announcement, Date.now());

    root.dataset.severity = announcement.severity;
    root.hidden = false;
    elements.dismissButton.hidden = !canDismiss;
    elements.type.textContent = TYPE_LABELS[announcement.type] || "Comunicado";
    elements.version.textContent = announcement.version;
    elements.publishedAt.dateTime = announcement.publishedAt;
    elements.publishedAt.textContent = formatPublishedDate(announcement.publishedAt);
    renderOptionalText(elements.title, announcement.title);
    renderOptionalText(elements.message, announcement.message);
    renderHighlights(elements.highlights, announcement.highlights);
    elements.details.textContent = announcement.details;
    elements.details.hidden = !announcement.details;
    elements.link.href = `${HUB_URL}/#announcement-${encodeURIComponent(announcement.id)}`;
    elements.linkLabel.textContent = announcement.hasChangelog
        ? "Ver changelog completo"
        : "Ver comunicado completo";
}

function getPanelElements(root) {
    return {
        content: root.querySelector("#announcementContent"),
        details: root.querySelector("#announcementDetails"),
        dismissButton: root.querySelector("#dismissAnnouncementButton"),
        highlights: root.querySelector("#announcementHighlights"),
        link: root.querySelector("#announcementLink"),
        linkLabel: root.querySelector("#announcementLinkLabel"),
        message: root.querySelector("#announcementMessage"),
        publishedAt: root.querySelector("#announcementPublishedAt"),
        title: root.querySelector("#announcementTitle"),
        toggleButton: root.querySelector("#announcementToggleButton"),
        type: root.querySelector("#announcementType"),
        version: root.querySelector("#announcementVersion")
    };
}

function renderOptionalText(element, value) {
    if (!element) {
        return;
    }

    element.textContent = value;
    element.hidden = !value;
}

function renderHighlights(element, highlights) {
    if (!element) {
        return;
    }

    element.replaceChildren(...highlights.map(highlight => {
        const item = document.createElement("li");

        item.textContent = highlight;
        return item;
    }));
    element.hidden = highlights.length === 0;
}

function formatPublishedDate(value) {
    try {
        return new Intl.DateTimeFormat("pt-BR", {
            dateStyle: "medium"
        }).format(new Date(value));
    } catch {
        return "";
    }
}

function readCachedFeed() {
    try {
        const cachedValue = localStorage.getItem(CACHE_KEY);

        return cachedValue ? normalizeFeed(JSON.parse(cachedValue)) : null;
    } catch {
        return null;
    }
}

function writeCachedFeed(feed) {
    try {
        localStorage.setItem(CACHE_KEY, JSON.stringify(feed));
    } catch {
        // The live feed remains usable when storage is unavailable.
    }
}

function readDismissedAnnouncementIds() {
    try {
        const value = JSON.parse(localStorage.getItem(DISMISSED_KEY) || "[]");

        return new Set(Array.isArray(value) ? value.filter(isValidId) : []);
    } catch {
        return new Set();
    }
}

function writeDismissedAnnouncementIds(ids) {
    try {
        localStorage.setItem(
            DISMISSED_KEY,
            JSON.stringify([...ids].slice(-MAX_DISMISSED_IDS))
        );
    } catch {
        // Dismissal remains optional when storage is unavailable.
    }
}

function isValidId(value) {
    return typeof value === "string"
        && value.length <= 80
        && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

function isBoundedText(value, maxLength) {
    return typeof value === "string"
        && value.trim().length > 0
        && value.length <= maxLength;
}

function isOptionalBoundedText(value, maxLength) {
    return value === undefined
        || value === null
        || (typeof value === "string" && value.length <= maxLength);
}

function normalizeOptionalText(value) {
    return typeof value === "string" ? value.trim() : "";
}

function isOptionalStringList(value, maxItems, maxLength) {
    return value === undefined
        || (Array.isArray(value)
            && value.length > 0
            && value.length <= maxItems
            && value.every(item => isBoundedText(item, maxLength)));
}

function normalizeStringList(value) {
    return Array.isArray(value) ? value.map(item => item.trim()) : [];
}

function isOptionalChanges(value) {
    if (value === undefined) {
        return true;
    }

    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return false;
    }

    const entries = Object.entries(value);

    return entries.length > 0 && entries.every(([category, items]) => (
        CHANGE_CATEGORIES.has(category)
        && isOptionalStringList(items, 50, 240)
    ));
}

function hasChanges(value) {
    return value
        && typeof value === "object"
        && Object.values(value).some(items => Array.isArray(items) && items.length > 0);
}

function isValidDate(value) {
    return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isOptionalDate(value) {
    return value === null || value === undefined || isValidDate(value);
}

function createEmptyController() {
    return {
        refresh() {
            return Promise.resolve(null);
        }
    };
}
