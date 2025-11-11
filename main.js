// main.js — Instrumentify (client-side)
//
// Fill the CONFIG keys before deploying.
// Works with Spotify PKCE auth + legal download sources + ONNX-based demixing.

const CONFIG = {
  SPOTIFY_CLIENT_ID: "YOUR_SPOTIFY_CLIENT_ID_HERE", // from https://developer.spotify.com/dashboard
  REDIRECT_URI: window.location.origin + "/",        // Must match your GitHub Pages domain
  SOUND_CLOUD_CLIENT_ID: "YOUR_SOUNDCLOUD_ID_HERE",
  JAMENDO_CLIENT_ID: "YOUR_JAMENDO_ID_HERE",
  PIXABAY_API_KEY: "YOUR_PIXABAY_KEY_HERE",

  MODEL_CDN_URL_TINY: "https://huggingface.co/yourname/instrumentify/resolve/main/htdemucs_tiny.onnx",
  MODEL_CDN_URL_MEDIUM: "https://huggingface.co/yourname/instrumentify/resolve/main/htdemucs_medium.onnx"
};

// ----- 1️⃣ UI Theme Picker -----
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

// ----- 2️⃣ Spotify OAuth PKCE flow -----
async function generateCodeVerifier(length) {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < length; i++) text += possible.charAt(Math.floor(Math.random() * possible.length));
  return text;
}
async function sha256(plain) {
  const encoder = new TextEncoder();
  const data = encoder.encode(plain);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function spotifyLogin() {
  const verifier = await generateCodeVerifier(64);
  const challenge = await sha256(verifier);
  localStorage.setItem("spotify_code_verifier", verifier);

  const url = new URL("https://accounts.spotify.com/authorize");
  url.searchParams.set("client_id", CONFIG.SPOTIFY_CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", CONFIG.REDIRECT_URI);
  url.searchParams.set("scope", "playlist-read-private");
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("code_challenge", challenge);
  window.location = url;
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
    const token = await getSpotifyToken(params.get("code"));
    localStorage.setItem("spotify_access_token", token.access_token);
    history.replaceState({}, document.title, "/");
  }
}
handleSpotifyCallback();

document.getElementById("btn-login").onclick = spotifyLogin;

// ----- 3️⃣ Playlist fetching -----
async function fetchPlaylistTracks(url) {
  const token = localStorage.getItem("spotify_access_token");
  if (!token) return alert("Please log in with Spotify first.");
  const playlistId = url.split("/playlist/")[1]?.split("?")[0];
  const resp = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}/tracks`, {
    headers: { Authorization: "Bearer " + token }
  });
  const data = await resp.json();
  return data.items.map(i => ({
    name: i.track.name,
    artist: i.track.artists[0].name
  }));
}

// ----- 4️⃣ Legal source finder -----
async function findTrackSource(title, artist) {
  const q = encodeURIComponent(`${artist} ${title}`);

  // 1️⃣ SoundCloud
  try {
    const sc = await fetch(`https://api-v2.soundcloud.com/search/tracks?q=${q}&client_id=${CONFIG.SOUND_CLOUD_CLIENT_ID}`);
    const scData = await sc.json();
    const downloadable = scData.collection.find(t => t.downloadable);
    if (downloadable) return downloadable.download_url + "?client_id=" + CONFIG.SOUND_CLOUD_CLIENT_ID;
  } catch (e) {}

  // 2️⃣ Jamendo
  try {
    const jm = await fetch(`https://api.jamendo.com/v3.0/tracks/?client_id=${CONFIG.JAMENDO_CLIENT_ID}&format=json&limit=1&search=${q}`);
    const jmData = await jm.json();
    if (jmData.results.length) return jmData.results[0].audio;
  } catch (e) {}

  // 3️⃣ Pixabay
  try {
    const px = await fetch(`https://pixabay.com/api/audio/?key=${CONFIG.PIXABAY_API_KEY}&q=${q}`);
    const pxData = await px.json();
    if (pxData.hits.length) return pxData.hits[0].audio;
  } catch (e) {}

  // 4️⃣ FMA (no key needed)
  try {
    const fm = await fetch(`https://freemusicarchive.org/api/get/tracks.json?track_title=${q}`);
    const fmData = await fm.json();
    if (fmData.dataset && fmData.dataset.length) return fmData.dataset[0].track_url;
  } catch (e) {}

  return null;
}

// ----- 5️⃣ Hardware-aware model selection -----
async function selectModel(userChoice = "auto") {
  if (userChoice === "tiny") return CONFIG.MODEL_CDN_URL_TINY;
  if (userChoice === "medium") return CONFIG.MODEL_CDN_URL_MEDIUM;

  const gl = document.createElement("canvas").getContext("webgl");
  const info = gl ? gl.getExtension("WEBGL_debug_renderer_info") : null;
  const renderer = info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : "CPU";
  const hasStrongGPU = /(RTX|RX|Apple|Arc|Vega|GTX 16|M1|M2)/i.test(renderer);
  const cpuCores = navigator.hardwareConcurrency || 4;
  return hasStrongGPU || cpuCores >= 8 ? CONFIG.MODEL_CDN_URL_MEDIUM : CONFIG.MODEL_CDN_URL_TINY;
}

// ----- 6️⃣ Run separation -----
async function runModelOnBuffer(arrayBuffer, modelUrl) {
  const session = await ort.InferenceSession.create(modelUrl);
  const audioTensor = new ort.Tensor("float32", new Float32Array(arrayBuffer), [1, arrayBuffer.length]);
  const output = await session.run({ input: audioTensor });
  // Simplified demo; real Demucs models output stems separately.
  return output.output.data.buffer;
}

// ----- 7️⃣ Main playlist handler -----
document.getElementById("fetchPlaylist").onclick = async () => {
  const url = document.getElementById("playlistInput").value.trim();
  if (!url) return alert("Enter a Spotify playlist URL.");
  const tracks = await fetchPlaylistTracks(url);
  const area = document.getElementById("playlistArea");
  area.innerHTML = "";

  for (const track of tracks) {
    const div = document.createElement("div");
    div.className = "track";
    div.textContent = `🎵 ${track.artist} — ${track.name}`;
    area.appendChild(div);

    const src = await findTrackSource(track.name, track.artist);
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
        const blob = new Blob([instrumental]);
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `${track.artist} - ${track.name} (Instrumental).wav`;
        a.click();
        btn.textContent = "Done ✅";
      };
      div.appendChild(btn);
    } else {
      div.innerHTML += " — ❌ No legal source found";
    }
  }
};
