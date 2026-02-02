document.addEventListener("DOMContentLoaded", async () => {
  const nameEl = document.getElementById("candidate-name");
  const detailsEl = document.getElementById("details-content");
  const experiencesEl = document.getElementById("experiences-content");

  const data = await chrome.storage.local.get([
    "current_linkedin_id",
    "current_profile_name",
  ]);
  const profileId = data.current_linkedin_id;

  if (!profileId) {
    nameEl.innerText = "Aucun profil détecté";
    detailsEl.innerHTML = "Allez sur un profil LinkedIn pour commencer.";
    return;
  }

  nameEl.innerText = data.current_profile_name || "Profil détecté";

  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = btn.getAttribute("data-tab");
      document.querySelectorAll(".tab-content").forEach((content) => {
        content.style.display = "none";
      });
      document.getElementById(target).style.display = "block";
      document.querySelectorAll(".tab-btn").forEach((tab) => tab.classList.remove("active"));
      btn.classList.add("active");
    });
  });

  detailsEl.innerHTML = `<p>ID: <code>${profileId}</code></p><p>Prêt à générer des réponses.</p>`;

  chrome.runtime.sendMessage({ type: "GET_CANDIDATE_DATA", id: profileId }, (res) => {
    if (res && res.experiences) {
      experiencesEl.innerHTML = res.experiences
        .map((exp) => `<div><b>${exp.title}</b> chez ${exp.company}</div>`)
        .join("<br>");
    }
  });
});
