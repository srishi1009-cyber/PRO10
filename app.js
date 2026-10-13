"use strict";

/* ============================================================
   RISHI MUSIC — HIGH-CAPACITY ENGINE (800+ SONGS)
   - Zero-RAM on-demand audio streaming
   - Screen-off & background playback persistence
   - Strict Director filtering & random daily rotation
   - Never auto-replays songs marked "Played Today"
   - Virtual pagination for smooth 800+ track rendering
   ============================================================ */

/* 1. SERVICE WORKER */
if ("serviceWorker" in navigator) {
    window.addEventListener("load", function () {
        navigator.serviceWorker.register("./sw.js").catch(function (err) {
            console.error("[Rishi Music] SW Registration Failed:", err);
        });
    });
}

/* 2. INDEXEDDB WITH ON-DEMAND BLOB STREAMING */
const DB_NAME = "RishiMusicDB_v4";
const DB_VERSION = 1;
const STORE_NAME = "audio_library";
let db = null;

function initDB() {
    return new Promise(function (resolve, reject) {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = function (e) {
            const database = e.target.result;
            if (!database.objectStoreNames.contains(STORE_NAME)) {
                database.createObjectStore(STORE_NAME, { keyPath: "id" });
            }
        };
        request.onsuccess = function () {
            db = request.result;
            resolve(db);
        };
        request.onerror = function () {
            reject(request.error);
        };
    });
}

function getAllTracksMetadata() {
    return new Promise(function (resolve) {
        if (!db) return resolve([]);
        const tx = db.transaction([STORE_NAME], "readonly");
        const store = tx.objectStore(STORE_NAME);
        const metadata = [];
        const req = store.openCursor();

        req.onsuccess = function (e) {
            const cursor = e.target.result;
            if (cursor) {
                metadata.push({
                    id: cursor.value.id,
                    title: cursor.value.title,
                    director: cursor.value.director
                });
                cursor.continue();
            } else {
                resolve(metadata);
            }
        };
        req.onerror = function () {
            resolve([]);
        };
    });
}

function getTrackAudioBlob(id) {
    return new Promise(function (resolve, reject) {
        if (!db) return reject(new Error("DB closed"));
        const tx = db.transaction([STORE_NAME], "readonly");
        const store = tx.objectStore(STORE_NAME);
        const req = store.get(id);
        req.onsuccess = function () {
            resolve(req.result ? req.result.blob : null);
        };
        req.onerror = function () {
            reject(req.error);
        };
    });
}

function saveTracksBatch(trackList) {
    return new Promise(function (resolve, reject) {
        if (!db || !trackList.length) return resolve();
        const tx = db.transaction([STORE_NAME], "readwrite");
        const store = tx.objectStore(STORE_NAME);
        for (let i = 0; i < trackList.length; i++) {
            store.put(trackList[i]);
        }
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function (e) { reject(e); };
    });
}

function removeTrackFromDB(id) {
    return new Promise(function (resolve) {
        if (!db) return resolve();
        const tx = db.transaction([STORE_NAME], "readwrite");
        const store = tx.objectStore(STORE_NAME);
        store.delete(id);
        tx.oncomplete = function () { resolve(); };
    });
}

/* 3. APPLICATION STATE */
let tracks = [];
let currentTrackIndex = -1;
let currentBlobUrl = null;
let playHistory = [];
let userManuallyPaused = false;
let isSwitchingSong = false;
let activeEditingTrackId = null;
let deferredPrompt = null;
let pendingImportFiles = [];

// Virtual Pagination
const BATCH_SIZE = 40;
let renderedCount = 0;
let filteredTrackIndices = [];

/* 4. DOM REFERENCES */
const audio = document.getElementById("audioEl");
const tracksContainer = document.getElementById("tracksContainer");
const searchInput = document.getElementById("searchInput");
const directorFilter = document.getElementById("directorFilter");
const importBtn = document.getElementById("importBtn");
const fileSelector = document.getElementById("fileSelector");
const mainPlayBtn = document.getElementById("mainPlayBtn");
const mainPlayIcon = document.getElementById("mainPlayIcon");
const prevBtn = document.getElementById("prevBtn");
const nextBtn = document.getElementById("nextBtn");
const progressBar = document.getElementById("progressBar");
const currentTimeEl = document.getElementById("currentTime");
const durationEl = document.getElementById("duration");
const dockTitle = document.getElementById("dockTitle");
const dockSubtitle = document.getElementById("dockSubtitle");
const installBar = document.getElementById("installBar");
const installTriggerBtn = document.getElementById("installTriggerBtn");

// Modals
const editModal = document.getElementById("editModal");
const editTitleInput = document.getElementById("editTitleInput");
const editDirectorInput = document.getElementById("editDirectorInput");
const cancelEditBtn = document.getElementById("cancelEditBtn");
const saveEditBtn = document.getElementById("saveEditBtn");

const bulkDirectorModal = document.getElementById("bulkDirectorModal");
const bulkDirectorInput = document.getElementById("bulkDirectorInput");
const skipBulkDirectorBtn = document.getElementById("skipBulkDirectorBtn");
const saveBulkDirectorBtn = document.getElementById("saveBulkDirectorBtn");

/* 5. STRICT DAILY ROTATION ENGINE */
function getTodayDateString() {
    const d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

function getDailyLog() {
    const today = getTodayDateString();
    try {
        const raw = localStorage.getItem("rishi_daily_plays_v4");
        let parsed = raw ? JSON.parse(raw) : null;
        if (!parsed || parsed.date !== today || !Array.isArray(parsed.playedIds)) {
            parsed = { date: today, playedIds: [] };
            localStorage.setItem("rishi_daily_plays_v4", JSON.stringify(parsed));
        }
        return parsed;
    } catch (e) {
        return { date: today, playedIds: [] };
    }
}

function saveDailyLog(log) {
    try {
        localStorage.setItem("rishi_daily_plays_v4", JSON.stringify(log));
    } catch (e) {
        console.warn("Storage error:", e);
    }
}

function markSongAsPlayed(songId) {
    const log = getDailyLog();
    if (!log.playedIds.includes(songId)) {
        log.playedIds.push(songId);
    }
    saveDailyLog(log);
    renderTrackList(false);
}

// Strictly respects selected director and excludes already-played songs
function getNextUnplayedIndex() {
    if (tracks.length === 0) return -1;

    const selectedDirector = directorFilter ? directorFilter.value : "ALL";
    const log = getDailyLog();
    const playedSet = new Set(log.playedIds);

    // Filter track pool by selected director
    let poolIndices = [];
    for (let i = 0; i < tracks.length; i++) {
        const matchesDirector = (selectedDirector === "ALL" || tracks[i].director === selectedDirector);
        if (matchesDirector) {
            poolIndices.push(i);
        }
    }

    if (poolIndices.length === 0) return -1;

    // Filter out songs played today
    let unplayed = poolIndices.filter(function (idx) {
        return !playedSet.has(tracks[idx].id) && idx !== currentTrackIndex;
    });

    // Halts auto-play if all songs in this selection were played today
    if (unplayed.length === 0) {
        return -1;
    }

    const rand = Math.floor(Math.random() * unplayed.length);
    return unplayed[rand];
}

/* 6. MEDIA SESSION & BACKGROUND AUDIO CONTINUITY */
function updateMediaSession(track) {
    if (!("mediaSession" in navigator) || !track) return;
    try {
        navigator.mediaSession.metadata = new MediaMetadata({
            title: track.title,
            artist: track.director,
            album: "Rishi Music"
        });

        navigator.mediaSession.setActionHandler("play", function () {
            userManuallyPaused = false;
            playCurrentTrack();
        });

        navigator.mediaSession.setActionHandler("pause", function () {
            pauseCurrentTrack();
        });

        navigator.mediaSession.setActionHandler("nexttrack", function () {
            userManuallyPaused = false;
            advanceToNextTrack();
        });

        navigator.mediaSession.setActionHandler("previoustrack", function () {
            userManuallyPaused = false;
            playPreviousTrack();
        });

        navigator.mediaSession.setActionHandler("seekto", function (e) {
            if (e.seekTime && Number.isFinite(e.seekTime)) {
                audio.currentTime = e.seekTime;
            }
        });
    } catch (e) {
        console.warn("MediaSession error:", e);
    }
}

/* 7. PLAYBACK PIPELINE */
async function loadTrackSource(index) {
    if (index < 0 || index >= tracks.length) return false;

    currentTrackIndex = index;
    const track = tracks[currentTrackIndex];

    if (currentBlobUrl) {
        URL.revokeObjectURL(currentBlobUrl);
        currentBlobUrl = null;
    }

    const blob = await getTrackAudioBlob(track.id);
    if (!blob) {
        console.error("Audio data missing for track:", track);
        return false;
    }

    currentBlobUrl = URL.createObjectURL(blob);

    audio.pause();
    audio.src = currentBlobUrl;

    dockTitle.textContent = track.title;
    dockSubtitle.textContent = track.director;
    currentTimeEl.textContent = "0:00";
    durationEl.textContent = "0:00";
    progressBar.value = 0;

    updateMediaSession(track);
    renderTrackList(false);
    return true;
}

async function playCurrentTrack() {
    if (currentTrackIndex === -1 && tracks.length > 0) {
        const firstIdx = getNextUnplayedIndex();
        if (firstIdx === -1) {
            alert("All songs in this selection have been played today! Tap any song voluntarily to replay.");
            return;
        }
        await loadTrackSource(firstIdx);
    }

    const track = tracks[currentTrackIndex];
    if (!track) return;

    userManuallyPaused = false;

    try {
        await audio.play();
        setPlayIconState(true);
        if ("mediaSession" in navigator) {
            navigator.mediaSession.playbackState = "playing";
        }
        renderTrackList(false);
    } catch (error) {
        console.warn("Playback prevented or deferred:", error);
        setPlayIconState(false);
    }
}

function pauseCurrentTrack() {
    userManuallyPaused = true;
    audio.pause();
    setPlayIconState(false);
    if ("mediaSession" in navigator) {
        navigator.mediaSession.playbackState = "paused";
    }
    renderTrackList(false);
}

// Immediate asynchronous handover keeps background pipeline active
async function advanceToNextTrack() {
    if (isSwitchingSong || tracks.length === 0) return;
    isSwitchingSong = true;
    userManuallyPaused = false;

    if (currentTrackIndex !== -1) {
        playHistory.push(currentTrackIndex);
        if (playHistory.length > 50) playHistory.shift();
    }

    const nextIndex = getNextUnplayedIndex();
    if (nextIndex === -1) {
        pauseCurrentTrack();
        dockTitle.textContent = "Finished for today";
        dockSubtitle.textContent = "All songs played. Tap any song voluntarily to replay.";
        isSwitchingSong = false;
        return;
    }

    const loaded = await loadTrackSource(nextIndex);
    if (loaded) {
        await playCurrentTrack();
    }
    isSwitchingSong = false;
}

async function playPreviousTrack() {
    if (tracks.length === 0) return;
    userManuallyPaused = false;

    if (audio.currentTime > 3) {
        audio.currentTime = 0;
        await playCurrentTrack();
        return;
    }

    if (playHistory.length > 0) {
        const prevIdx = playHistory.pop();
        await loadTrackSource(prevIdx);
        await playCurrentTrack();
    } else {
        audio.currentTime = 0;
        await playCurrentTrack();
    }
}

/* 8. NATIVE AUDIO EVENT LISTENERS */
audio.addEventListener("ended", function () {
    if (userManuallyPaused || isSwitchingSong) return;
    const currentTrack = tracks[currentTrackIndex];
    if (currentTrack) {
        markSongAsPlayed(currentTrack.id);
    }
    advanceToNextTrack();
});

audio.addEventListener("error", function () {
    if (userManuallyPaused || isSwitchingSong) return;
    advanceToNextTrack();
});

// Auto-resumes if background audio focus is briefly interrupted
audio.addEventListener("pause", function () {
    if (!userManuallyPaused && !audio.ended && !isSwitchingSong) {
        setTimeout(function () {
            if (!userManuallyPaused && audio.paused) {
                audio.play().catch(() => {});
            }
        }, 400);
    }
});

audio.addEventListener("timeupdate", function () {
    if (!audio.duration) return;
    progressBar.value = (audio.currentTime / audio.duration) * 100;
    currentTimeEl.textContent = formatTime(audio.currentTime);
    durationEl.textContent = formatTime(audio.duration);
});

progressBar.addEventListener("input", function () {
    if (audio.duration) {
        audio.currentTime = (Number(progressBar.value) / 100) * audio.duration;
    }
});

function formatTime(sec) {
    if (!Number.isFinite(sec) || sec < 0) return "0:00";
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return m + ":" + String(s).padStart(2, "0");
}

function setPlayIconState(isPlaying) {
    if (!mainPlayIcon) return;
    if (isPlaying) {
        mainPlayIcon.innerHTML = `<rect x="6" y="4" width="4" height="16" fill="#ffffff"></rect><rect x="14" y="4" width="4" height="16" fill="#ffffff"></rect>`;
    } else {
        mainPlayIcon.innerHTML = `<polygon points="6,4 20,12 6,20"></polygon>`;
    }
}

/* 9. VIRTUAL PAGINATION (EFFICIENT RENDERING FOR 800+ TRACKS) */
function computeFilteredList() {
    const query = String(searchInput.value || "").trim().toLowerCase();
    const filter = directorFilter.value || "ALL";

    filteredTrackIndices = [];
    for (let i = 0; i < tracks.length; i++) {
        const t = tracks[i];
        const matchSearch = t.title.toLowerCase().includes(query) || t.director.toLowerCase().includes(query);
        const matchDirector = filter === "ALL" || t.director === filter;
        if (matchSearch && matchDirector) {
            filteredTrackIndices.push(i);
        }
    }
}

function appendTrackCards(count) {
    const log = getDailyLog();
    const playedSet = new Set(log.playedIds);
    const endIndex = Math.min(renderedCount + count, filteredTrackIndices.length);

    for (let i = renderedCount; i < endIndex; i++) {
        const idx = filteredTrackIndices[i];
        const track = tracks[idx];
        const isCurrent = idx === currentTrackIndex;
        const isPlaying = isCurrent && !audio.paused;
        const isPlayedToday = playedSet.has(track.id);

        const card = document.createElement("div");
        card.className = "track-card" + (isCurrent ? " active" : "") + (isPlayedToday ? " played-today" : "");

        card.innerHTML = `
            <div class="track-main">
                <span class="music-glyph">♬</span>
                <div class="track-text">
                    <div class="track-name">${track.title}</div>
                    <div class="track-sub">
                        ${track.director}
                        ${isPlayedToday ? '<span class="daily-status"> Played Today</span>' : ""}
                    </div>
                </div>
            </div>
            <div class="track-actions">
                <button class="edit-btn" data-action="edit" data-id="${track.id}">Edit</button>
                <button class="delete-btn" data-action="delete" data-id="${track.id}">🗑</button>
                <button class="card-play-btn" data-action="play" data-idx="${idx}">
                    ${isPlaying ? '<svg viewBox="0 0 24 24"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>' : '<svg viewBox="0 0 24 24"><polygon points="6,4 20,12 6,20"></polygon></svg>'}
                </button>
            </div>
        `;
        tracksContainer.appendChild(card);
    }
    renderedCount = endIndex;
}

function renderTrackList(resetList = true) {
    if (!tracksContainer) return;

    if (resetList) {
        computeFilteredList();
        tracksContainer.innerHTML = "";
        renderedCount = 0;
    }

    if (tracks.length === 0) {
        tracksContainer.innerHTML = `
            <div class="empty-state">
                Your library is empty.<br>
                Click <strong>+ Import Track</strong> above to add songs.
            </div>
        `;
        return;
    }

    if (resetList) {
        appendTrackCards(BATCH_SIZE);
    } else {
        const cards = tracksContainer.querySelectorAll(".track-card");
        const log = getDailyLog();
        const playedSet = new Set(log.playedIds);

        cards.forEach((card, domIdx) => {
            const trackIdx = filteredTrackIndices[domIdx];
            if (trackIdx !== undefined) {
                const track = tracks[trackIdx];
                const isCurrent = trackIdx === currentTrackIndex;
                const isPlayedToday = playedSet.has(track.id);

                card.className = "track-card" + (isCurrent ? " active" : "") + (isPlayedToday ? " played-today" : "");
                const playBtn = card.querySelector(".card-play-btn");
                if (playBtn) {
                    playBtn.innerHTML = (isCurrent && !audio.paused)
                        ? '<svg viewBox="0 0 24 24"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>'
                        : '<svg viewBox="0 0 24 24"><polygon points="6,4 20,12 6,20"></polygon></svg>';
                }
            }
        });
    }
}

// Scroll to stream in cards lazily
window.addEventListener("scroll", function () {
    if (window.innerHeight + window.scrollY >= document.body.offsetHeight - 500) {
        if (renderedCount < filteredTrackIndices.length) {
            appendTrackCards(BATCH_SIZE);
        }
    }
});

function updateDirectorDropdown() {
    const cur = directorFilter.value || "ALL";
    const dirs = Array.from(new Set(tracks.map(function (t) { return t.director; }))).filter(Boolean).sort();
    directorFilter.innerHTML = '<option value="ALL">ALL DIRECTORS</option>';
    dirs.forEach(function (d) {
        const opt = document.createElement("option");
        opt.value = d;
        opt.textContent = d;
        directorFilter.appendChild(opt);
    });
    directorFilter.value = Array.from(directorFilter.options).some(function (o) { return o.value === cur; }) ? cur : "ALL";
}

/* 10. CARD ACTIONS, EDIT & VOLUNTARY PLAY */
tracksContainer.addEventListener("click", async function (e) {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    e.stopPropagation();

    const action = btn.dataset.action;

    if (action === "play") {
        const idx = Number(btn.dataset.idx);

        if (idx === currentTrackIndex) {
            if (audio.paused) await playCurrentTrack();
            else pauseCurrentTrack();
        } else {
            // Voluntary replay permitted for any song
            await loadTrackSource(idx);
            await playCurrentTrack();
        }
    } else if (action === "edit") {
        const track = tracks.find(function (t) { return t.id === btn.dataset.id; });
        if (!track) return;
        activeEditingTrackId = track.id;
        editTitleInput.value = track.title;
        editDirectorInput.value = track.director;
        editModal.classList.add("open");
    } else if (action === "delete") {
        const track = tracks.find(function (t) { return t.id === btn.dataset.id; });
        if (!track || !confirm(`Delete "${track.title}"?`)) return;

        await removeTrackFromDB(track.id);
        const idx = tracks.indexOf(track);
        if (idx === currentTrackIndex) {
            audio.pause();
            currentTrackIndex = -1;
            dockTitle.textContent = "No track playing";
            dockSubtitle.textContent = "Select a song from your library";
            setPlayIconState(false);
        }
        tracks.splice(idx, 1);
        updateDirectorDropdown();
        renderTrackList(true);
    }
});

cancelEditBtn.addEventListener("click", function () {
    editModal.classList.remove("open");
    activeEditingTrackId = null;
});

saveEditBtn.addEventListener("click", async function () {
    if (!activeEditingTrackId) return;
    const track = tracks.find(function (t) { return t.id === activeEditingTrackId; });
    if (!track) return;

    const t = editTitleInput.value.trim();
    const d = editDirectorInput.value.trim();
    if (!t) return alert("Title cannot be empty.");

    track.title = t;
    track.director = d || "UNKNOWN DIRECTOR";

    const blob = await getTrackAudioBlob(track.id);
    await saveTracksBatch([{ id: track.id, title: track.title, director: track.director, blob: blob }]);

    if (tracks[currentTrackIndex]?.id === track.id) {
        dockTitle.textContent = track.title;
        dockSubtitle.textContent = track.director;
    }
    editModal.classList.remove("open");
    activeEditingTrackId = null;
    updateDirectorDropdown();
    renderTrackList(true);
});

/* 11. BULK IMPORT ENGINE */
importBtn.addEventListener("click", function () { 
    fileSelector.value = "";
    fileSelector.click(); 
});

fileSelector.addEventListener("change", function (e) {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;

    pendingImportFiles = files;

    if (bulkDirectorModal) {
        bulkDirectorInput.value = "";
        bulkDirectorModal.classList.add("open");
    } else {
        const entered = prompt("Enter Music Director for selected song(s):", "UNKNOWN DIRECTOR");
        processImportQueue(entered && entered.trim() ? entered.trim() : "UNKNOWN DIRECTOR");
    }
});

if (skipBulkDirectorBtn) {
    skipBulkDirectorBtn.addEventListener("click", function () {
        bulkDirectorModal.classList.remove("open");
        processImportQueue("UNKNOWN DIRECTOR");
    });
}

if (saveBulkDirectorBtn) {
    saveBulkDirectorBtn.addEventListener("click", function () {
        const directorName = bulkDirectorInput.value.trim() || "UNKNOWN DIRECTOR";
        bulkDirectorModal.classList.remove("open");
        processImportQueue(directorName);
    });
}

async function processImportQueue(musicDirector) {
    if (!pendingImportFiles.length) return;

    importBtn.disabled = true;
    const total = pendingImportFiles.length;
    let savedCount = 0;
    const CHUNK_SIZE = 15;

    for (let i = 0; i < total; i += CHUNK_SIZE) {
        const chunk = pendingImportFiles.slice(i, i + CHUNK_SIZE);
        const batchRecords = [];

        for (let j = 0; j < chunk.length; j++) {
            const f = chunk[j];
            const trackRecord = {
                id: "track_" + Date.now() + "_" + Math.random().toString(36).substring(2, 9),
                title: f.name.replace(/\.[^.]+$/, ""),
                director: musicDirector,
                blob: f
            };
            batchRecords.push(trackRecord);
            tracks.push({ id: trackRecord.id, title: trackRecord.title, director: trackRecord.director });
            savedCount++;
        }

        importBtn.textContent = `Saving (${savedCount}/${total})...`;
        await saveTracksBatch(batchRecords);
        await new Promise(r => setTimeout(r, 40));
    }

    pendingImportFiles = [];
    importBtn.disabled = false;
    importBtn.textContent = "+ Import Track";
    fileSelector.value = "";
    updateDirectorDropdown();
    renderTrackList(true);
}

/* 12. BOTTOM CONTROLS */
mainPlayBtn.addEventListener("click", async function () {
    if (audio.paused) await playCurrentTrack();
    else pauseCurrentTrack();
});
prevBtn.addEventListener("click", playPreviousTrack);
nextBtn.addEventListener("click", advanceToNextTrack);

searchInput.addEventListener("input", function () {
    renderTrackList(true);
});

directorFilter.addEventListener("change", function () {
    renderTrackList(true);
});

/* 13. PWA INSTALL BANNER */
window.addEventListener("beforeinstallprompt", function (e) {
    e.preventDefault();
    deferredPrompt = e;
    if (installBar) installBar.style.display = "flex";
});

installTriggerBtn.addEventListener("click", async function () {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const res = await deferredPrompt.userChoice;
    if (res.outcome === "accepted" && installBar) {
        installBar.style.display = "none";
    }
    deferredPrompt = null;
});

/* INITIALIZE */
initDB().then(async function () {
    tracks = await getAllTracksMetadata();
    updateDirectorDropdown();
    renderTrackList(true);
});