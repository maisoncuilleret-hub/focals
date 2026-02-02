// popup.js
console.log("🔥 [FOCALS-POPUP] Le script est chargé !");

async function refreshUI() {
  console.log("🔍 [FOCALS-POPUP] Lecture du stockage...");

  const data = await chrome.storage.local.get([
    "current_linkedin_id",
    "current_profile_name",
  ]);

  console.log("📦 [FOCALS-POPUP] Données trouvées :", data);

  const app = document.getElementById("app"); // Vérifie que cet ID existe dans popup.html

  if (data.current_linkedin_id) {
    app.innerHTML = `
      <div style="padding:15px; font-family:sans-serif;">
        <h2 style="color:#0073b1; margin-top:0;">${data.current_profile_name || "Profil trouvé"}</h2>
        <p style="font-size:12px; color:#666;">ID: ${data.current_linkedin_id}</p>
        <hr>
        <p style="color:green; font-weight:bold;">✅ Prêt à l'emploi</p>
      </div>
    `;
  } else {
    app.innerHTML = `<p style="padding:20px;">Ouvrez un profil LinkedIn pour commencer.</p>`;
  }
}

// Lancer au démarrage
document.addEventListener("DOMContentLoaded", refreshUI);

// Écouter les mises à jour en direct (si le scraper finit pendant que la popup est ouverte)
chrome.storage.onChanged.addListener((changes) => {
  if (changes.current_linkedin_id) {
    console.log("♻️ [FOCALS-POPUP] Mise à jour détectée !");
    refreshUI();
  }
});
