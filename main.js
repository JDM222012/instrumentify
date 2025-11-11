// main.js — Instrumentify (client-side)
// Fully integrated: Spotify PKCE, parallel playlist fetch, legal sources, model separation, ZIP download

const CONFIG = {
  SPOTIFY_CLIENT_ID: "12816f1d032446ed85e1872ca5dc952b", // your Spotify client ID
  REDIRECT_URI: "https://jdm222012.github.io/instrumentify/", // must match Spotify dashboard
  SOUND_CLOUD_CLIENT_ID: "MaZ7bR62GvbulJgV8EUjQnHfbZGDEKaI",
  JAMENDO_CLIENT_ID: "e4cc60a9",
  MODEL_CDN_URL_TINY: "https://huggingface.co/yourname/instrumentify/resolve/main/htdemucs_tiny.onnx",
  MODEL_CDN_URL_MEDIUM: "https://huggingface.co/yourname/instrumentify/resolve/main/htdemucs_medium.onnx"
};

// ----- Global array to store processed tracks -----
const processedTracks = [];

// ----- 1️⃣ ZIP Button at top -----
const topBar = document.createElement("div");
topBar.style.margin = "10px 0";
topBar.innerHTML = `<button id="downloadAllZip">Download All as ZIP</button>`;
document.body.prepend(topBar);

// Download All ZIP handler
document.getElementById("downloadAllZip").onclick = async () => {
  if (processedTracks.length === 0) return alert("No tracks processed yet!");
  const zip = new JSZip();
  processedTracks.forEach(t => zip.file(t.name, t.blob));
  const content = await zip.generateAsync({ type: "blob" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(content);
  a.download = "Instrumentify_Playlist.zip";
  a.click();
};

// ----- 2️⃣ Theme selection -----
const modal = document.getElementById("theme-modal");
const app = document.getElementById("app");
const themeLink = document.getElementById("theme-stylesheet");
document.getElementById("btn-simple").onclick = () => {
  themeLink.href = "simple.css";
  modal.style.display = "none";
  app.hidden = false;
};
document.getElementById("btn-styled").onclick = () => {
  themeLink.href = "styled.css";
  modal.style.display = "none";
  app.hidden = false;
};

// ----- 3️⃣ Spotify OAuth PKCE -----
async function generateCodeVerifier(length = 64) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < length; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
  return text;
}
async function sha256(plain) {
  const data = new TextEncoder().encode(plain);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function spotifyLogin() {
  const verifier = await generateCodeVerifier();
  const challenge = await sha256(verifier);
  localStorage.setItem("spotify_code_verifier", verifier);

  const url = new URL("https://accounts.spotify.com/authorize");
  url.searchParams.set("client_id", CONFIG.SPOTIFY_CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", CONFIG.REDIRECT_URI);
  url.searchParams.set("scope", "playlist-read-private");
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("code_challenge", challenge);

  window.location.href = url;
}

async function getSpotifyToken(code) {
  const verifier = localStorage.getItem("spotify_code_verifier");
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: CONFIG.REDIRECT_URI,
    client_id: CONFIG.SPOTIFY_CLIENT_ID,
    code_verifier: verifier
  });

  const resp = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  return resp.json();
}

async function handleSpotifyCallback() {
  const params = new URLSearchParams(window.location.search);
  if (params.has("code")) {
    try {
      const token = await getSpotifyToken(params.get("code"));
      localStorage.setItem("spotify_access_token", token.access_token);
      history.replaceState({}, document.title, "/");
      await autoFetchPlaylist();
    } catch(e) { console.error("Spotify token error", e); }
  }
}
handleSpotifyCallback();

document.getElementById("btn-login").onclick = spotifyLogin;

// ----- 4️⃣ Playlist fetch -----
async function fetchPlaylistTracks(url) {
  const token = localStorage.getItem("spotify_access_token");
  if (!token) return alert("Please log in first.");
  const playlistId = url.split("/playlist/")[1]?.split("?")[0];
  const resp = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}/tracks`, {
    headers: { Authorization: "Bearer " + token }
  });
  const data = await resp.json();
  return data.items.map(i => ({ name: i.track.name, artist: i.track.artists[0].name }));
}

// Auto-fetch after login if playlist input exists
async function autoFetchPlaylist() {
  const input = document.getElementById("playlistInput").value.trim();
  if (input) await fetchPlaylistButton(input);
}

// ----- 5️⃣ Legal source finder -----
async function getSCClientID() {
  try {
    const resp = await fetch("https://soundcloud.com/");
    const text = await resp.text();
    const match = text.match(/client_id:"(\w+)"/);
    return match ? match[1] : null;
  } catch { return null; }
}

async function findTrackSource(title, artist) {
  const q = encodeURIComponent(`${artist} ${title}`);

  try { // SoundCloud
    const scClientID = CONFIG.SOUND_CLOUD_CLIENT_ID || await getSCClientID();
    if (scClientID) {
      const sc = await fetch(`https://api-v2.soundcloud.com/search/tracks?q=${q}&client_id=${scClientID}`);
      const scData = await sc.json();
      const downloadable = scData.collection.find(t => t.downloadable);
      if (downloadable) return downloadable.download_url + "?client_id=" + scClientID;
    }
  } catch {}
  try { // Jamendo
    const jm = await fetch(`https://api.jamendo.com/v3.0/tracks/?client_id=${CONFIG.JAMENDO_CLIENT_ID}&format=json&limit=1&search=${q}`);
    const jmData = await jm.json();
    if (jmData.results.length) return jmData.results[0].audio;
  } catch {}
  try { // ccMixter
    const cc = await fetch(`https://ccmixter.org/api/query?f=mp3&q=${q}&licenses=cc-by,cc-by-sa`);
    const ccData = await cc.json();
    if (ccData.length) return ccData[0].downloadUrl;
  } catch {}
  try { // FMA
    const fm = await fetch(`https://freemusicarchive.org/api/get/tracks.json?track_title=${q}`);
    const fmData = await fm.json();
    if (fmData.dataset?.length) return fmData.dataset[0].track_url;
  } catch {}
  return null;
}

// ----- 6️⃣ Hardware-aware model selection -----
async function selectModel(userChoice = "auto") {
  if (userChoice === "tiny") return CONFIG.MODEL_CDN_URL_TINY;
  if (userChoice === "medium") return CONFIG.MODEL_CDN_URL_MEDIUM;

  const gl = document.createElement("canvas").getContext("webgl");
  const info = gl?.getExtension("WEBGL_debug_renderer_info");
  const renderer = info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : "CPU";
  const hasStrongGPU = /(RTX|RX|Apple|Arc|Vega|GTX 16|M1|M2)/i.test(renderer);
  const cpuCores = navigator.hardwareConcurrency || 4;
  return hasStrongGPU || cpuCores >= 8 ? CONFIG.MODEL_CDN_URL_MEDIUM : CONFIG.MODEL_CDN_URL_TINY;
}

// ----- 7️⃣ Run separation -----
async function runModelOnBuffer(arrayBuffer, modelUrl) {
  const session = await ort.InferenceSession.create(modelUrl);
  const audioTensor = new ort.Tensor("float32", new Float32Array(arrayBuffer), [1, arrayBuffer.length]);
  const output = await session.run({ input: audioTensor });
  return output.output.data.buffer;
}

// ----- 8️⃣ Fetch playlist and load ASAP -----
async function fetchPlaylistButton(url) {
  const tracks = await fetchPlaylistTracks(url);
  const area = document.getElementById("playlistArea");
  area.innerHTML = "";

  // Prepare track divs
  tracks.forEach(track => {
    const div = document.createElement("div");
    div.className = "track";
    div.textContent = `🎵 ${track.artist} — ${track.name}`;
    area.appendChild(div);
  });

  // Fetch sources in parallel
  const sources = await Promise.all(tracks.map(t => findTrackSource(t.name, t.artist)));

  sources.forEach((src, i) => {
    const div = area.children[i];
    if (src) {
      const btn = document.createElement("button");
      btn.textContent = "Make Instrumental";
      btn.onclick = async () => {
        btn.disabled = true;
        btn.textContent = "Processing...";
        const audioResp = await fetch(src);
        const buf = await audioResp.arrayBuffer();
        const modelUrl = await selectModel(document.getElementById("separationQuality").value);
        const instrumental = await runModelOnBuffer(buf, modelUrl);
        const blob = new Blob([instrumental], { type: "audio/wav" });
        processedTracks.push({
          name: `${tracks[i].artist} - ${tracks[i].name} (Instrumental).wav`,
          blob
        });
        btn.textContent = "Done ✅";
      };
      div.appendChild(btn);
    } else {
      div.innerHTML += " — ❌ No legal source found";
    }
  });
}

// ----- 9️⃣ Attach fetch button -----
document.getElementById("fetchPlaylist").onclick = async () => {
  const url = document.getElementById("playlistInput").value.trim();
  if (!url) return alert("Enter a Spotify playlist URL.");
  await fetchPlaylistButton(url);
};
